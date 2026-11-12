/**
 * Configuration push engine.
 *
 * This is the part that has to behave like an attentive human at the console
 * rather than a script that fires commands into a socket.
 *
 * ## Rules the engine follows
 *
 * 1. **One command at a time.** Nothing is pipelined: a batch is only ever sent
 *    after the previous command's prompt has come back, so an error can never
 *    race ahead of the report about it.
 * 2. **Any error stops the batch.** When VRP rejects a line the remaining lines
 *    almost always fail too, and every extra failure buries the real cause. The
 *    first failure is returned with its transcript and the line number.
 * 3. **The view is read back, not assumed.** Before a config block runs the
 *    session must actually sit in system view; after each block we re-read the
 *    prompt, and if a stray `quit` popped one level too far we re-enter instead
 *    of letting the whole rest of the script land in the wrong place.
 * 4. **Idempotent by intent.** Comment-only and blank lines are skipped; `save`
 *    is opt-in because writing flash on every run is both slow and noisy.
 *
 * @module dsh-ensp/provision
 */

import { openConsole } from './console.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Errors that mean "the device is already in the state you asked for".
 *
 * Re-running the same configuration is the normal way to work: change one line,
 * apply again, look at the effect. VRP answers the unchanged lines with an error,
 * and aborting the batch there makes the tool unusable for that loop. These
 * specific replies are recorded as no-ops instead. Everything else still stops
 * the batch, because a genuine rejection means the rest of the script is
 * probably landing on the wrong object.
 */
const IDEMPOTENT_RE =
  /already exists|The VLAN already exists|address already exists|The object already exists|has already been created|is already configured|The route already exists|The ACL rule already exists/i

/**
 * Whether a VRP error means "this line is already in effect".
 *
 * Exported so the behaviour can be tested without a device: the distinction
 * between "already there" and "rejected" is the whole point of a re-runnable
 * apply, and it is easy to widen the pattern until real failures are swallowed.
 *
 * @param {string} message
 * @returns {boolean}
 */
export function isIdempotentError(message) {
  return IDEMPOTENT_RE.test(String(message ?? ''))
}

/**
 * Split a configuration script into executable lines.
 *
 * eNSP config files use `!` for comments and `#` in some exports, so both are
 * treated as comments. Trailing whitespace and stray CRs are removed.
 *
 * @param {string} text
 * @returns {Array<{line: number, command: string}>}
 */
export function parseScript(text) {
  const out = []
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    if (!trimmed) continue
    if (trimmed.startsWith('!') || trimmed.startsWith('#')) continue
    out.push({ line: i + 1, command: trimmed })
  }
  return out
}

/**
 * Push one configuration script to one device.
 *
 * @param {object} options
 * @param {string} options.device - device name, for reporting
 * @param {number} options.port - console port
 * @param {string} options.script - the configuration text
 * @param {boolean} [options.save=false] - run `save` and confirm at the end
 * @param {number} [options.commandTimeoutMs=20000]
 * @param {boolean} [options.stopOnError=true]
 * @param {(event: object) => void} [options.onProgress]
 * @returns {Promise<{
 *   device: string, ok: boolean, applied: number, total: number,
 *   failedAt: {line: number, command: string, error: string, output: string}|null,
 *   saved: boolean, transcript: Array<object>, durationMs: number
 * }>}
 */
export async function pushConfig({
  device,
  port,
  script,
  save = false,
  commandTimeoutMs = 20000,
  stopOnError = true,
  onProgress,
}) {
  const started = Date.now()
  const report = (e) => onProgress?.(e)
  const commands = parseScript(script)
  const transcript = []

  let session
  try {
    session = await openConsole({ port, label: device })
    await sleep(300)
    await session.prepare()

    // Enter system view using the observed prompt, never a counter.
    const enter = await session.ensureSystemView()
    if (!enter.ok) {
      return {
        device,
        ok: false,
        applied: 0,
        total: commands.length,
        failedAt: {
          line: 1,
          command: 'system-view',
          error: 'could not enter system view',
          output: enter.output,
        },
        saved: false,
        transcript,
        durationMs: Date.now() - started,
      }
    }

    let applied = 0
    for (const { line, command } of commands) {
      // A script that starts with `system-view` is normal, and so is one that does
      // not. Because we already entered system view above, a leading `system-view`
      // would be rejected ("Unrecognized command") and abort the batch. Treat it as
      // idempotent: skip it when we are already in the right place.
      if (/^system-view$/i.test(command) && session.view === 'system') {
        applied += 1
        transcript.push({ line, command, ok: true, skipped: 'already in system view', output: '' })
        report?.({ phase: 'command', device, line, command, ok: true, skipped: true })
        continue
      }
      // Likewise `return` from system view is a no-op noise source.
      if (/^return$/i.test(command) && session.view === 'system') {
        applied += 1
        transcript.push({ line, command, ok: true, skipped: 'already at top of system view', output: '' })
        report?.({ phase: 'command', device, line, command, ok: true, skipped: true })
        continue
      }
      // Guard against view drift: a previous `quit` may have dropped us out.
      if (session.view === 'user') {
        const back = await session.ensureSystemView()
        if (!back.ok) {
          return {
            device,
            ok: false,
            applied,
            total: commands.length,
            failedAt: {
              line,
              command,
              error: 'lost system view before this command and could not recover',
              output: back.output,
            },
            saved: false,
            transcript,
            durationMs: Date.now() - started,
          }
        }
        report({ phase: 'recover-view', device, line })
      }

      const result = await session.exec(command, { timeoutMs: commandTimeoutMs })
      transcript.push({
        line,
        command,
        ok: result.ok,
        view: result.view,
        prompt: result.prompt,
        error: result.error,
        output: result.output.slice(-2000),
      })
      report({ phase: 'command', device, line, command, ok: result.ok, view: result.view })

      if (!result.ok && isIdempotentError(result.error)) {
        // Already in the requested state. Count it so the totals stay meaningful,
        // and keep the transcript honest about what the device actually said.
        applied += 1
        transcript[transcript.length - 1].skipped = 'already in the requested state'
        report({ phase: 'command', device, line, command, ok: true, skipped: true, view: result.view })
        continue
      }

      if (!result.ok) {
        if (stopOnError) {
          return {
            device,
            ok: false,
            applied,
            total: commands.length,
            failedAt: {
              line,
              command,
              error: result.error ?? 'command failed',
              output: result.output,
            },
            saved: false,
            transcript,
            durationMs: Date.now() - started,
          }
        }
      } else {
        applied += 1
      }
    }

    let saved = false
    if (save) {
      await session.toUserView()
      const r = await session.exec('save', { timeoutMs: 30000, answer: 'y' })
      // `save` asks for confirmation and sometimes a filename; the console driver
      // answers once, then the second Enter accepts the default file name.
      if (/\[Y\/N\]|\(y\/n\)/i.test(r.output)) {
        await session.exec('y', { timeoutMs: 15000 })
      }
      saved = /successfully|saved/i.test(r.output) || r.ok
      transcript.push({ line: 0, command: 'save', ok: saved, output: r.output.slice(-800) })
    }

    return {
      device,
      ok: true,
      applied,
      total: commands.length,
      failedAt: null,
      saved,
      transcript,
      durationMs: Date.now() - started,
    }
  } catch (error) {
    return {
      device,
      ok: false,
      applied: 0,
      total: commands.length,
      failedAt: { line: 0, command: '', error: error.message, output: '' },
      saved: false,
      transcript,
      durationMs: Date.now() - started,
    }
  } finally {
    session?.close()
  }
}

/**
 * Push configuration to many devices, with a bounded concurrency.
 *
 * Devices are independent, so a failure on one does not stop the others.
 *
 * @param {object} options
 * @param {Array<{device: string, port: number, script: string}>} options.targets
 * @param {number} [options.concurrency=3]
 * @param {(event: object) => void} [options.onProgress]
 * @returns {Promise<Array<object>>}
 */
export async function pushConfigMany({ targets, concurrency = 3, onProgress, ...rest }) {
  const results = []
  const queue = [...targets]
  onProgress?.({ phase: 'batch-start', devices: queue.length })

  async function worker() {
    for (;;) {
      const target = queue.shift()
      if (!target) return
      onProgress?.({ phase: 'device-start', device: target.device })
      const result = await pushConfig({ ...rest, ...target, onProgress })
      results.push(result)
      onProgress?.({
        phase: 'device-done',
        device: result.device,
        ok: result.ok,
        applied: result.applied,
        total: result.total,
      })
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, targets.length) }, worker)
  await Promise.all(workers)
  onProgress?.({ phase: 'batch-done', ok: results.filter((r) => r.ok).length, total: results.length })
  return results
}

/**
 * Run a read-only command on a device and return its output.
 *
 * @param {{port: number, command: string, timeoutMs?: number}} options
 * @returns {Promise<{ok: boolean, output: string, error: string|null}>}
 */
export async function queryDevice({ port, command, timeoutMs = 25000 }) {
  let session
  try {
    session = await openConsole({ port })
    await sleep(250)
    await session.prepare()
    const r = await session.exec(command, { timeoutMs })
    return { ok: r.ok, output: r.output, error: r.error }
  } catch (error) {
    return { ok: false, output: '', error: error.message }
  } finally {
    session?.close()
  }
}

/**
 * Poll a device until a predicate accepts its command output, or time runs out.
 *
 * Routing protocols converge asynchronously: right after `ospf 1` is committed a
 * peering sits in ExStart/Exchange/Loading for a while, and a single query taken
 * too early reads as "failed" when it is merely "not finished". Waiting a fixed
 * number of seconds either wastes time or is still too short on a slow machine,
 * so every convergence assertion in this package goes through this helper.
 *
 * @param {{
 *   port: number,
 *   command: string,
 *   until: (output: string) => boolean,
 *   timeoutMs?: number,
 *   intervalMs?: number,
 *   probeTimeoutMs?: number,
 * }} options
 * @returns {Promise<{ok: boolean, converged: boolean, output: string, attempts: number, waitedMs: number}>}
 */
export async function waitForOutput({
  port,
  command,
  until,
  timeoutMs = 120000,
  intervalMs = 3000,
  probeTimeoutMs = 20000,
}) {
  const started = Date.now()
  let attempts = 0
  let output = ''
  while (Date.now() - started < timeoutMs) {
    attempts += 1
    const r = await queryDevice({ port, command, timeoutMs: probeTimeoutMs })
    if (r.ok) output = r.output
    if (r.ok && until(r.output)) {
      return { ok: true, converged: true, output, attempts, waitedMs: Date.now() - started }
    }
    await sleep(intervalMs)
  }
  return {
    ok: false,
    converged: false,
    output,
    attempts,
    waitedMs: Date.now() - started,
  }
}

/**
 * Wait until an OSPF adjacency reaches Full on `port`, optionally naming the peer.
 *
 * @param {{port: number, neighbourId?: string, timeoutMs?: number}} options
 */
export async function waitForOspfFull({ port, neighbourId, timeoutMs = 120000 }) {
  const r = await waitForOutput({
    port,
    command: 'display ospf peer brief',
    until: (out) =>
      out
        .split('\n')
        .filter((l) => /\bFull\b/.test(l))
        .some((l) => !neighbourId || l.includes(neighbourId)),
    timeoutMs,
  })
  return { ...r, neighbourId: neighbourId || null }
}

/**
 * Wait until a prefix shows up in the OSPF routing table on `port`.
 *
 * @param {{port: number, prefix: string, timeoutMs?: number}} options
 */
export async function waitForOspfRoute({ port, prefix, timeoutMs = 120000 }) {
  return waitForOutput({
    port,
    command: 'display ip routing-table protocol ospf',
    until: (out) => out.includes(prefix),
    timeoutMs,
  })
}
