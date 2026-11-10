/**
 * eNSP launcher: open a topology, start its devices, and hand the desktop back.
 *
 * ## Why this drives the GUI at all
 *
 * Starting devices has no API. It was tested exhaustively and ruled out:
 *
 * | Approach                        | Result                                              |
 * |---------------------------------|-----------------------------------------------------|
 * | `bootmode="1"` in the .topo     | devices still stay off                               |
 * | VBoxManage `startvm` on a clone | VM runs, but no console: AR_Base has `uart1="off"`   |
 * | eNSP control port (65514/7301)  | refuses connections / undocumented protocol          |
 * | writing `WM_COMMAND` ids        | eNSP crashes; the toolbar has no enumerable ids      |
 *
 * eNSP's console is **not** on the VM's serial port — a guest agent dials back to
 * a `-consoleip/-consoleport` pair that only the eNSP client allocates. So the
 * client must be the one to start devices, and the only way to ask it is the
 * "Start all devices" toolbar button.
 *
 * ## Readiness is measured, never guessed
 *
 * Boot time varies enormously between models, images and host load, so **no fixed
 * timeout decides success**. Each device is polled on its own console port until
 * VRP actually answers with a prompt; a device that never answers is reported as
 * such instead of being assumed ready. The overall deadline only bounds how long
 * we are willing to wait, and it is generous.
 *
 * @module dsh-ensp/launcher
 */

import { spawn, spawnSync } from 'node:child_process'
import net from 'node:net'

import { calibrateAnchors, DEFAULT_ANCHORS } from './calibrate.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Does the host currently listen on `port`? */
function listens(port, host = '127.0.0.1', timeoutMs = 1200) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port })
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.once('timeout', () => done(false))
  })
}

/** PowerShell one-liner that lists eNSP's own listening console ports. */
function listenPortsScript() {
  return (
    'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ' +
    'Where-Object { $_.LocalPort -ge 2000 -and $_.LocalPort -le 2100 } | ' +
    'ForEach-Object { $_.LocalPort } | Sort-Object -Unique'
  )
}

/** Snapshot of ports currently listening in the eNSP console range. */
function consolePortsSnapshot() {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', listenPortsScript()], {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (r.status !== 0) return []
  return (r.stdout || '')
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 2000 && n <= 2100)
}

/**
 * Win32 helper source. Kept in one place because Add-Type is expensive and the
 * same C# is reused for locating, focusing and clicking.
 */
const WIN32_SOURCE = String.raw`
using System;
using System.Text;
using System.Runtime.InteropServices;

public class EnspWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  // Declaring DPI awareness makes GetWindowRect/SetCursorPos use physical pixels,
  // matching the calibration screenshot. Without it every click is scaled by the
  // monitor factor (150% here) and lands in the wrong place.
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }

  public static IntPtr FindMain(uint pid) {
    IntPtr found = IntPtr.Zero;
    IntPtr fallback = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p != pid) return true;
      var sb = new StringBuilder(256); GetClassNameW(h, sb, 256);
      if (!sb.ToString().StartsWith("Afx:")) return true;
      RECT r; GetWindowRect(h, out r);
      int w = r.R - r.L, hgt = r.B - r.T;
      // Normal case: the full frame. A minimised frame collapses to a small
      // rect (e.g. 237x39), so keep the first Afx window as a fallback and
      // prefer the large one when it exists.
      if (w > 400 && hgt > 300) { found = h; return false; }
      if (fallback == IntPtr.Zero) fallback = h;
      return true;
    }, IntPtr.Zero);
    return found != IntPtr.Zero ? found : fallback;
  }

  public static bool FocusWindow(IntPtr h) {
    IntPtr fg = GetForegroundWindow();
    uint dummy;
    uint fgt = GetWindowThreadProcessId(fg, out dummy);
    uint myt = GetCurrentThreadId();
    AttachThreadInput(myt, fgt, true);
    ShowWindow(h, 9);            // SW_RESTORE
    BringWindowToTop(h);
    bool ok = SetForegroundWindow(h);
    AttachThreadInput(myt, fgt, false);
    return ok;
  }

  public static void InitDpi() {
    SetProcessDPIAware();
  }

  public static void Click(int x, int y) {
    // A synthetic click must look human enough for MFC to accept it: move first,
    // settle, then hold the button down long enough to be past the double-click
    // timer's lower bound. The previous 110 ms press was silently ignored.
    SetCursorPos(x, y);
    System.Threading.Thread.Sleep(150);
    mouse_event(0x0002, 0, 0, 0, IntPtr.Zero);   // LEFTDOWN
    System.Threading.Thread.Sleep(90);
    mouse_event(0x0004, 0, 0, 0, IntPtr.Zero);   // LEFTUP
    System.Threading.Thread.Sleep(120);
    // Second, slightly offset move to force an WM_MOUSEMOVE on the button.
    SetCursorPos(x + 1, y);
    System.Threading.Thread.Sleep(60);
    SetCursorPos(x, y);
  }
}
`

/** Run a PowerShell snippet that uses the helper above. */
function runPowerShell(body, { timeoutMs = 30000 } = {}) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${WIN32_SOURCE}
'@ -ErrorAction Stop
[EnspWin]::InitDpi()
${body}
`
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  })
  return { ok: r.status === 0, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() }
}

/** PID of the running eNSP client, or null. */
export function enspPid() {
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', '(Get-Process eNSP_Client -ErrorAction SilentlyContinue | Select-Object -First 1).Id'],
    { encoding: 'utf8', windowsHide: true },
  )
  const pid = Number((r.stdout || '').trim())
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/**
 * Launch the eNSP client, optionally opening a topology.
 *
 * @param {object} [options]
 * @param {string} [options.topology] - absolute path to a `.topo` file
 * @param {string} [options.exspPath] - override the client executable
 * @param {number} [options.readyTimeoutMs=90000] - how long to wait for the window to exist
 * @returns {Promise<{pid: number, hwnd: string}>}
 */
export async function launchEnsp({ topology, exspPath, readyTimeoutMs = 90000 } = {}) {
  const exe = exspPath ?? process.env.DSH_ENSP_EXE ?? 'E:\\Huawei\\eNSP\\eNSP_Client.exe'
  const already = enspPid()
  if (already) {
    const hwnd = locateWindow(already)
    if (hwnd) return { pid: already, hwnd, reused: true }
  }

  const args = topology ? [topology] : []
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()

  // Poll tightly: eNSP creates its frame before it finishes painting, and every
  // second spent here is dead time the caller cannot overlap with anything.
  const started = Date.now()
  const deadline = started + readyTimeoutMs
  let pid = null
  let hwnd = null
  while (Date.now() < deadline) {
    pid = enspPid()
    if (pid) {
      hwnd = locateWindow(pid)
      if (hwnd) return { pid, hwnd, waitMs: Date.now() - started }
    }
    await sleep(250)
  }
  throw new Error(
    `eNSP window did not appear within ${readyTimeoutMs} ms` +
      (pid ? ` (pid ${pid} started but no frame window)` : ' (process never started)'),
  )
}

/**
 * Locate the eNSP main frame window for a PID.
 * @param {number} pid
 * @returns {string|null} the HWND as a decimal string (JS has no uintptr type)
 */
export function locateWindow(pid) {
  const r = runPowerShell(`[EnspWin]::FindMain([uint32]${pid}).ToString()`, { timeoutMs: 20000 })
  if (!r.ok) return null
  const value = r.stdout.split(/\s+/).pop()
  return value && value !== '0' ? value : null
}

/**
 * Bring eNSP to the foreground so its toolbar can be clicked.
 *
 * Focus is unavoidable: driving the toolbar while the window is occluded or
 * minimised was observed to kill the process. The caller is expected to
 * {@link minimiseEnsp} afterwards so the user gets the desktop back.
 *
 * @param {string} hwnd
 * @returns {boolean} whether the window ended up in front
 */
export function focusEnsp(hwnd) {
  const r = runPowerShell(
    `
$h = [IntPtr]::new([int64]${hwnd})
$ok = [EnspWin]::FocusWindow($h)
Start-Sleep -Milliseconds 250
($ok -and ([EnspWin]::GetForegroundWindow() -eq $h)).ToString()
`,
    { timeoutMs: 20000 },
  )
  return r.ok && r.stdout.split(/\s+/).pop() === 'True'
}

/**
 * Minimise the eNSP window, handing the desktop back to the user.
 * @param {string} hwnd
 */
export function minimiseEnsp(hwnd) {
  runPowerShell(
    `[EnspWin]::ShowWindow([IntPtr]::new([int64]${hwnd}), 6) | Out-Null; 'ok'`,
    { timeoutMs: 15000 },
  )
}

/**
 * Click the "start all devices" toolbar button.
 *
 * Coordinates are **window-relative** and were measured against the client's
 * 1280×800 layout; the toolbar is a fixed strip whose origin does not move with
 * the window. See `docs/UI-ANCHORS.md` for how they were obtained and how to
 * re-measure after an eNSP or DPI change.
 *
 * @param {string} hwnd
 * @param {{button?: 'start'|'stop', offsets?: {start: [number, number], stop: [number, number]}}} [options]
 */
export function clickToolbar(hwnd, options = {}) {
  const { button = 'start' } = options
  const anchors = options.anchors ?? {
    start: { x: DEFAULT_ANCHORS.start.x, y: DEFAULT_ANCHORS.start.y },
    stop: { x: DEFAULT_ANCHORS.stop.x, y: DEFAULT_ANCHORS.stop.y },
  }
  const { x: ox, y: oy } = anchors[button] ?? anchors.start
  const r = runPowerShell(
    `
$h = [IntPtr]::new([int64]${hwnd})
$rect = New-Object EnspWin+RECT
[void][EnspWin]::GetWindowRect($h, [ref]$rect)
# Anchors are measured in the SAME frame as the window rect (origin = window
# top-left, title bar included), which is also the frame the calibration
# screenshot uses. Do not add a client-area offset here.
$cx = $rect.L + ${ox}
$cy = $rect.T + ${oy}
[EnspWin]::Click($cx, $cy)
'clicked ' + $cx + ',' + $cy
`,
    { timeoutMs: 20000 },
  )
  return { ok: r.ok, detail: r.stdout.split('\n').pop() || r.stderr }
}

/**
 * Wait until one device console answers VRP with a prompt.
 *
 * Readiness means "the device replied", not "enough time has passed".
 *
 * @param {object} options
 * @param {number} options.port - console TCP port from the .topo
 * @param {number} [options.timeoutMs=180000] - per-device ceiling, generous on purpose
 * @param {number} [options.pollMs=1500]
 * @returns {Promise<{port: number, ready: boolean, prompt: string|null, waitedMs: number, error?: string}>}
 */
export async function waitForConsole({ port, timeoutMs = 180000, pollMs = 1500 }) {
  const started = Date.now()
  let lastError = null
  while (Date.now() - started < timeoutMs) {
    if (await listens(port)) {
      // Port is open; now prove VRP is actually talking on it.
      const answer = await new Promise((resolve) => {
        const socket = net.createConnection({ host: '127.0.0.1', port })
        let buf = ''
        const finish = (value) => {
          socket.destroy()
          resolve(value)
        }
        socket.setEncoding('utf8')
        socket.setTimeout(4000)
        socket.on('connect', () => setTimeout(() => socket.write('\r'), 400))
        socket.on('data', (chunk) => {
          buf += chunk
          // A prompt at the end of the buffer means VRP is alive.
          if (/[<\[][\w~\-./:]*[>\]]\s*$/.test(buf.replace(/\r/g, ''))) {
            const prompt = (buf.match(/[<\[][\w~\-./:]*[>\]]/g) || []).pop() ?? null
            finish({ prompt })
          }
        })
        socket.on('error', (e) => finish({ error: e.message }))
        socket.on('timeout', () => finish({ error: 'no reply' }))
      })
      if (answer.prompt) {
        return { port, ready: true, prompt: answer.prompt, waitedMs: Date.now() - started }
      }
      lastError = answer.error ?? 'no prompt yet'
    }
    await sleep(pollMs)
  }
  return {
    port,
    ready: false,
    prompt: null,
    waitedMs: Date.now() - started,
    error: lastError ?? 'console never opened',
  }
}

/**
 * Start every device of a topology and verify each one individually.
 *
 * The sequence is: focus → click start → **poll each console until it answers**.
 * Devices are verified concurrently so a slow model does not serialise the wait,
 * and the result distinguishes "all ready" from "some never came up" so a caller
 * can act on the difference.
 *
 * @param {object} options
 * @param {Array<{name: string, comPort: number|null}>} options.devices
 * @param {string} options.hwnd
 * @param {number} [options.perDeviceTimeoutMs=180000]
 * @param {boolean} [options.minimise=true] - restore the desktop as soon as the
 *   click has been delivered (devices keep booting in the background)
 * @param {(event: object) => void} [options.onProgress]
 * @returns {Promise<{clicked: boolean, devices: Array<object>, allReady: boolean}>}
 */
export async function startAllDevices({
  devices,
  hwnd,
  perDeviceTimeoutMs = 180000,
  minimise = true,
  onProgress,
}) {
  const report = (event) => onProgress?.(event)
  const targets = devices.filter((d) => d.comPort)

  const before = new Set(consolePortsSnapshot())

  // Locate the toolbar buttons by colour instead of trusting hard-coded pixels;
  // this survives eNSP upgrades, DPI changes and different display sizes.
  report({ phase: 'calibrate', hwnd })
  let anchors
  try {
    anchors = calibrateAnchors(hwnd)
  } catch (error) {
    anchors = { ...DEFAULT_ANCHORS, method: 'default', detail: { reason: error.message } }
  }
  report({ phase: 'calibrated', method: anchors.method, detail: anchors.detail })

  report({ phase: 'focus', hwnd })
  const focused = focusEnsp(hwnd)
  if (!focused) report({ phase: 'focus-failed', hwnd })

  report({ phase: 'click', button: 'start', anchor: anchors.start })
  const click = clickToolbar(hwnd, { button: 'start', anchors })

  // Hand the desktop back immediately; boot continues without the window.
  if (minimise) {
    minimiseEnsp(hwnd)
    report({ phase: 'minimised' })
  }

  report({ phase: 'wait', devices: targets.length })
  const results = await Promise.all(
    targets.map(async (device) => {
      const outcome = await waitForConsole({ port: device.comPort, timeoutMs: perDeviceTimeoutMs })
      report({ phase: 'device', name: device.name, ...outcome })
      return { name: device.name, model: device.model, ...outcome }
    }),
  )

  const after = new Set(consolePortsSnapshot())
  const newPorts = [...after].filter((p) => !before.has(p))

  return {
    clicked: click.ok,
    clickDetail: click.detail,
    anchors,
    focused,
    newPorts,
    devices: results,
    allReady: results.length > 0 && results.every((r) => r.ready),
    ready: results.filter((r) => r.ready).length,
    total: results.length,
  }
}

/**
 * Stop every device (red square next to the green triangle).
 * @param {string} hwnd
 */
export function stopAllDevices(hwnd, options = {}) {
  let anchors = options.anchors
  if (!anchors) {
    try {
      anchors = calibrateAnchors(hwnd)
    } catch {
      anchors = { ...DEFAULT_ANCHORS, method: 'default', detail: {} }
    }
  }
  const focused = focusEnsp(hwnd)
  const result = clickToolbar(hwnd, { button: 'stop', anchors })
  return { focused, anchors, ...result }
}
