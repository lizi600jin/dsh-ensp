/**
 * VRP console driver.
 *
 * The whole point of this module is to behave like a careful human at the
 * terminal rather than a dumb `write()` loop:
 *
 * - every command is acknowledged by the device's **prompt reappearing**, not by
 *   an arbitrary sleep, so we never run ahead of the device;
 * - the prompt is re-read after every command and is the single source of truth
 *   for "which view am I in" — we never maintain a counter that can drift;
 * - any error token aborts the caller's sequence immediately and hands back the
 *   raw transcript, so the failure can be reported with context instead of
 *   silently cascading into dozens of follow-on failures.
 *
 * Two device quirks shaped this design, both found the hard way on real eNSP:
 *
 * 1. `\r\n` breaks interactive prompts. The extra LF is consumed by the *next*
 *    `[Y/N]` question and silently accepts its default answer. We send `\r` only.
 * 2. A stray `quit` pops one view too many and every following command then lands
 *    in the wrong view, failing in a confusing cascade. We therefore re-read the
 *    prompt and, when the caller asked for a view we are no longer in, re-enter
 *    it instead of assuming.
 *
 * @module dsh-ensp/console
 */

import net from 'node:net'

/** Prompt shapes: `<host>` user view, `[host]` system view, `[host-sub]` sub-view. */
const PROMPT_RE = /[<\[][\w~\-./:]*[>\]]\s*$/

/** Upstream tokens that mean "this command did not take effect". */
const ERROR_RE =
  /(?:^|\n)\s*(?:Error:|Unrecognized command|Incomplete command|Wrong parameter found|Too many parameters|Ambiguous command|Invalid input|Permission denied)/i

/** A `[Y/N]`-style confirmation waiting for an answer. */
const CONFIRM_RE = /(?:\[Y\/N\]|\(y\/n\)|\[y\/n\]|continue\?|Are you sure)/i

/**
 * VRP's pager marker. `screen-length 0 temporary` normally turns paging off, but
 * it is a user-view command: issued from a sub-view it is rejected, and on some
 * builds it is rejected even in user view. When the pager is still on, a long
 * `display` command stops at this marker and the rest of the output is simply
 * missing — which reads as "the configuration is not there" when it is.
 */
const PAGER_RE = /---- More ----\s*$/

/** Cap the number of pages we will advance for one command. */
const MAX_PAGES = 200

const VIEW = {
  user: 'user',
  system: 'system',
  sub: 'sub',
}

/**
 * Classify a prompt string into a view level.
 *
 * `[host]` is system view and `[host-interface]` is a sub-view, but the hostname
 * itself may contain hyphens (`R1-TEST`), so "contains a dash" is not a valid
 * test. VRP's shape is: the *last* dash-separated segment names a view whose
 * first segment matches the hostname. We therefore compare against the hostname
 * captured from the user-view prompt rather than guessing from punctuation alone.
 *
 * @param {string|null} prompt
 * @param {string|null} [hostname] - known device hostname, when available
 * @returns {'user'|'system'|'sub'|null}
 */
export function viewOf(prompt, hostname = null) {
  if (!prompt) return null
  if (prompt.startsWith('<')) return VIEW.user
  if (!prompt.startsWith('[')) return null
  const inner = prompt.slice(1, -1)
  if (!hostname) {
    // Without a known hostname, a sub-view is only assumed when the trailing
    // segment looks like an interface or protocol name, not a bare word.
    return /-(?:GigabitEthernet|Ethernet|Serial|Vlanif|Tunnel|LoopBack|NULL|ospf|bgp|isis|acl|vlan|area|region)/i.test(
      inner,
    )
      ? VIEW.sub
      : VIEW.system
  }
  return inner === hostname ? VIEW.system : VIEW.sub
}

/** Extract the hostname from any prompt. */
export function hostnameOf(prompt) {
  if (!prompt) return null
  const inner = prompt.slice(1, -1)
  if (prompt.startsWith('<')) return inner
  // Slice at the first dash that introduces a *view* keyword. A plain split on '-'
  // is wrong because hostnames themselves may contain dashes (`R1-TEST`).
  const m = inner.match(
    // No \b here: `GigabitEthernet0/0/1` has no word boundary between 't' and '0',
    // so a boundary assertion silently fails. Match the keyword directly instead.
    /^(.*?)-(?:GigabitEthernet|Ethernet|Serial|Vlanif|Tunnel|LoopBack|NULL|ospf|bgp|isis|acl|vlan|area|region)/i,
  )
  if (m && m[1]) return m[1]
  // No recognised view keyword: a bare `[name]` is system view for that name,
  // while `[name-sub]` is a sub-view whose hostname is the part before the last dash
  // only when the tail is not itself a plausible continuation of the name.
  return inner
}

/**
 * Does this transcript end on a pager stop rather than a prompt?
 *
 * Exported because "the output stops at `---- More ----`" is the difference
 * between "the device has nothing more to say" and "we are about to lose the rest
 * of the answer", and that distinction deserves a test of its own.
 *
 * @param {string} text
 * @returns {boolean}
 */
export function hasPagerMarker(text) {
  return PAGER_RE.test(String(text ?? '').trimEnd())
}

/**
 * Remove pager markers from a transcript collected across several pages.
 *
 * VRP prints `---- More ----` where the page broke and then continues on the next
 * page. The continuation is kept as its own line: page breaks land on line
 * boundaries in practice, and a spurious break inside a line is harmless, while
 * gluing two lines together would corrupt `^keyword` style assertions.
 *
 * This is only a fallback: {@link ConsoleSession#prepare} normally turns paging
 * off before any output is read.
 *
 * @param {string} text
 * @returns {string}
 */
function stitchPages(text) {
  const out = []
  for (const line of text.split('\n')) {
    const m = line.match(/^(.*?)---- More ----(.*)$/)
    if (!m) {
      out.push(line)
      continue
    }
    const head = m[1].trimEnd()
    if (head) out.push(head)
    const tail = m[2].trimStart()
    if (tail) out.push(tail)
  }
  return out.join('\n')
}

/** Strip ANSI escapes and trailing whitespace from a transcript chunk. */
function clean(text) {
  return text
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
}

/**
 * One interactive session against a device console.
 *
 * Construct with {@link openConsole}; do not call the constructor directly.
 */
export class ConsoleSession {
  #socket
  #buf = ''
  #prompt = null
  #hostname = null
  #closed = false
  #closeReason = null
  #waiters = new Set()

  /**
   * @param {net.Socket} socket
   * @param {string} label - device name, used in diagnostics only
   */
  constructor(socket, label) {
    this.#socket = socket
    this.label = label
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      this.#buf += chunk
      for (const waiter of this.#waiters) waiter()
    })
    socket.on('close', () => {
      this.#closed = true
      this.#closeReason ??= 'the console connection was closed by the device'
      for (const waiter of this.#waiters) waiter()
    })
    socket.on('error', (err) => {
      this.#closed = true
      this.#closeReason ??= `console error: ${err?.message ?? err}`
      for (const waiter of this.#waiters) waiter()
    })
  }

  /** @returns {string|null} the prompt as last observed. */
  get prompt() {
    return this.#prompt
  }

  /**
   * The hostname learned from the user-view prompt.
   *
   * Internal callers must pass it to `viewOf`. Without it a hostname containing a
   * dash (`SW2-ACCESS`) makes every system-view prompt look like a sub-view, and
   * the config engine ends up retrying quit/system-view instead of working.
   *
   * @returns {string|null}
   */
  get hostname() {
    return this.#hostname
  }

  /** @returns {'user'|'system'|'sub'|null} */
  get view() {
    return viewOf(this.#prompt, this.#hostname)
  }

  /** @returns {boolean} */
  get closed() {
    return this.#closed
  }

  /** @returns {string|null} why the console closed, when it closed unexpectedly. */
  get closeReason() {
    return this.#closeReason
  }

  /**
   * Wait until `predicate()` is true, a new chunk arrives, or the timeout fires.
   * @param {() => boolean} predicate
   * @param {number} timeoutMs
   */
  #waitUntil(predicate, timeoutMs) {
    return new Promise((resolve) => {
      if (predicate()) return resolve(true)
      let done = false
      const finish = (ok) => {
        if (done) return
        done = true
        this.#waiters.delete(check)
        clearTimeout(timer)
        resolve(ok)
      }
      const check = () => {
        if (predicate()) finish(true)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      this.#waiters.add(check)
    })
  }

  /**
   * Read until the device is quiet at a fresh prompt, or the timeout expires.
   *
   * Quiet is defined as "prompt seen and no further bytes for `settleMs`", which
   * covers both fast commands and the slow ones that print a warning after the
   * prompt has already been drawn.
   *
   * @param {number} timeoutMs
   * @param {number} settleMs
   * @returns {Promise<string>} the transcript produced since the buffer was last cleared
   */
  async #readToPrompt(timeoutMs, settleMs = 60, echo = null) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (this.#closed) break
      const text = clean(this.#buf)
      // A confirmation question wins over a stale prompt: answer it explicitly.
      if (CONFIRM_RE.test(text.split('\n').slice(-3).join('\n'))) break
      const sawEcho = !echo || text.includes(echo)
      // A pager stop is a terminal state too: nothing more will arrive until we
      // send a key, so waiting for a prompt here would burn the whole timeout.
      if (sawEcho && (PROMPT_RE.test(text) || PAGER_RE.test(text.trimEnd()))) {
        const before = this.#buf.length
        await this.#waitUntil(() => this.#buf.length !== before || this.#closed, settleMs)
        if (this.#buf.length === before) break
      } else {
        // Poll the buffer rather than sleeping a fixed slice: most commands reply
        // in a few milliseconds, and waiting 200 ms per line dominates the runtime
        // of a 300-line config.
        await this.#waitUntil(() => {
          if (this.#closed) return true
          const now = clean(this.#buf)
          if (echo && !now.includes(echo)) return false
          return PROMPT_RE.test(now) || PAGER_RE.test(now.trimEnd())
        }, 25)
      }
    }
    const text = clean(this.#buf)
    this.#buf = ''
    // The *last* prompt in the transcript is the current one. Matching with an
    // `m` anchor and taking the first hit returns a prompt from the middle of the
    // output, which is how a reply that still carried the previous prompt made the
    // session believe it stood one view higher than it did.
    const promptAt = [...text.matchAll(/[<\[][\w~\-./:]*[>\]]/g)].pop()
    if (promptAt) {
      this.#prompt = promptAt[0].trim()
      // Learn the hostname the first time we see the user-view prompt; it is the
      // only reliable anchor for telling `[R1-TEST]` (system) from `[R1-TEST-GE0/0/0]`.
      this.#hostname ??= hostnameOf(this.#prompt)
    }
    return text
  }

  /** Write one line using CR only, then collect the response. */
  #line(text) {
    this.#socket.write(text + '\r')
  }

  /**
   * Send one command and report exactly what happened.
   *
   * @param {string} command
   * @param {object} [options]
   * @param {number} [options.timeoutMs=15000]
   * @param {string} [options.answer] - reply to a `[Y/N]` confirmation
   * @returns {Promise<{command: string, ok: boolean, error: string|null,
   *   prompt: string|null, view: string|null, output: string}>}
   */
  async exec(command, options = {}) {
    const { timeoutMs = 15000, answer = 'y' } = options

    // `interface X` / `vlan N` / `acl N` transition into a new view. The device
    // echoes the new prompt, but a prompt identical to the previous one (e.g. two
    // consecutive commands inside the same interface) can be satisfied by the
    // *previous* prompt still sitting in the buffer. Requiring the echo of the
    // command itself before accepting the prompt closes that race.
    const entersView = /^(?:interface|vlan|acl|ospf|isis|bgp|aaa|user-interface|wlan|ip pool|security-policy|firewall zone)\b/i.test(
      command,
    )

    this.#buf = ''
    this.#line(command)
    // VRP echoes the command before it answers. Requiring that echo makes the
    // prompt trustworthy: otherwise a prompt left over from the previous command
    // can satisfy the match and the caller then acts on the wrong view.
    const echo = command.split(/\s+/)[0]
    let output = await this.#readToPrompt(timeoutMs, entersView ? 200 : 60, echo)

    // Answer at most one confirmation round; `save` and `reset` both use one.
    if (CONFIRM_RE.test(output) && !PROMPT_RE.test(output.trimEnd())) {
      this.#line(answer)
      output += await this.#readToPrompt(timeoutMs)
    }

    // Walk the pager to the end. A page ends at `---- More ----` with no prompt,
    // so the command is not finished and the remaining output would be lost.
    let pages = 0
    while (PAGER_RE.test(output.trimEnd()) && pages < MAX_PAGES && !this.#closed) {
      pages += 1
      this.#buf = ''
      this.writeRaw(' ')
      output += await this.#readToPrompt(timeoutMs)
    }
    // The marker sits inline where the page broke: VRP prints `---- More ----`
    // followed by the rest of the line it interrupted. Stitch that tail back onto
    // the previous line so the caller sees what paging disabled would have shown.
    if (pages > 0) output = stitchPages(output)

    // A console that closed mid-command produced no output, and no output looks
    // exactly like a command that succeeded and printed nothing. Report the
    // closed socket instead of handing the caller a silent empty success.
    if (this.#closed) {
      return {
        command,
        ok: false,
        error: this.#closeReason || 'the console connection closed before the reply arrived',
        prompt: this.#prompt,
        view: this.view,
        output,
      }
    }

    const errorMatch = output.match(ERROR_RE)
    const prompt = this.#prompt
    return {
      command,
      ok: !errorMatch,
      error: errorMatch ? errorMatch[1] ?? errorMatch[0].trim() : null,
      prompt,
      view: this.view,
      output,
    }
  }

  /**
   * Make sure the session sits in system view.
   *
   * Called before a config batch and after any detected view drift. Uses the
   * observed prompt only — never a running counter.
   *
   * @returns {Promise<{ok: boolean, output: string}>}
   */
  async ensureSystemView() {
    if (!this.#prompt) await this.prime()
    const view = this.view
    if (view === VIEW.system) return { ok: true, output: '' }
    if (view === VIEW.sub) {
      // One `quit` from a sub-view lands in system view.
      const r = await this.exec('quit')
      if (!r.ok) return { ok: false, output: r.output }
      if (this.view === VIEW.system) return { ok: true, output: r.output }
    }
    if (this.view === VIEW.user) {
      const r = await this.exec('system-view')
      return { ok: r.ok && this.view === VIEW.system, output: r.output }
    }
    return { ok: false, output: `unrecognised prompt: ${this.#prompt}` }
  }

  /**
   * Return to user view from any depth.
   *
   * `return` is the documented one-shot form and is what a human types when they
   * have lost track of the view stack, so we prefer it over repeated `quit`.
   */
  async toUserView() {
    if (this.view === VIEW.user) return { ok: true, output: '' }
    const r = await this.exec('return', { timeoutMs: 20000 })
    return { ok: r.ok && this.view === VIEW.user, output: r.output }
  }

  /**
   * Enable command paging off so long `display` output arrives in one piece.
   *
   * Failures are non-fatal on purpose: `screen-length 0 temporary` is a user-view
   * command and is rejected from a sub-view, and some builds reject it outright.
   * `exec` pages through `---- More ----` stops on its own, so the only cost of a
   * rejection here is a few extra round trips.
   */
  async prepare() {
    if (!this.#prompt) await this.prime()
    if (this.view === VIEW.user) await this.exec('screen-length 0 temporary', { timeoutMs: 8000 })
    return this
  }

  /**
   * Wake the console and capture the current prompt.
   *
   * A freshly attached console may buffer nothing at all, so the session has no
   * idea which view it is in until the device speaks. Sending a bare CR is what a
   * human does to see where they are; the echoed prompt then tells us.
   *
   * @param {number} [timeoutMs=8000]
   * @returns {Promise<string|null>} the prompt observed
   */
  async prime(timeoutMs = 8000) {
    if (this.#prompt) return this.#prompt
    this.#buf = ''
    this.#line('')
    await this.#readToPrompt(timeoutMs)
    return this.#prompt
  }

  /** Write raw bytes without waiting for a prompt (used by probes). */
  writeRaw(text) {
    this.#socket.write(text)
  }

  /** Current buffered transcript, without clearing it. */
  peek() {
    return this.#buf
  }

  /** Close the session. */
  close() {
    this.#closed = true
    try {
      this.#socket.destroy()
    } catch {
      /* already gone */
    }
  }
}

/**
 * Open a console session to one device.
 *
 * @param {object} options
 * @param {number} options.port - the `com_port` recorded in the .topo
 * @param {string} [options.host='127.0.0.1']
 * @param {string} [options.label] - device name for diagnostics
 * @param {number} [options.timeoutMs=10000]
 * @returns {Promise<ConsoleSession>}
 */
export function openConsole({ port, host = '127.0.0.1', label, timeoutMs = 10000 }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port })
    const onError = (error) => {
      socket.destroy()
      reject(new Error(`cannot open console ${host}:${port}${label ? ` (${label})` : ''}: ${error.message}`))
    }
    socket.once('error', onError)
    socket.once('connect', () => {
      socket.off('error', onError)
      socket.setNoDelay(true)
      resolve(new ConsoleSession(socket, label ?? `${host}:${port}`))
    })
    socket.setTimeout(timeoutMs, () => onError(new Error('connect timeout')))
  })
}

/**
 * Probe a console port without keeping a session.
 *
 * @param {{port: number, host?: string, timeoutMs?: number}} options
 * @returns {Promise<{port: number, reachable: boolean, prompt: string|null, error?: string}>}
 */
export async function probeConsole({ port, host = '127.0.0.1', timeoutMs = 6000 }) {
  let session
  try {
    session = await openConsole({ port, host, timeoutMs })
    await new Promise((r) => setTimeout(r, 250))
    session.writeRaw('\r')
    await new Promise((r) => setTimeout(r, 900))
    const text = session.peek()
    const prompt = (clean(text).match(/[<\[][\w~\-./:]*[>\]]/g) || []).pop() ?? null
    return { port, reachable: true, prompt }
  } catch (error) {
    return { port, reachable: false, prompt: null, error: error.message }
  } finally {
    session?.close()
  }
}
