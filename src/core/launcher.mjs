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
import os from 'node:os'
import path from 'node:path'

import { calibrateAnchors, DEFAULT_ANCHORS } from './calibrate.mjs'
import { checkTopologySupport, describeBlocked, rootFromExe } from './compat.mjs'
import { readTopology } from './topology.mjs'

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
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint flags);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }

  /** PID that owns a window handle. */
  public static uint PidOf(IntPtr h) {
    if (h == IntPtr.Zero) return 0;
    uint p; GetWindowThreadProcessId(h, out p); return p;
  }

  /**
   * PID of the top-level window that would receive a click at (x, y).
   *
   * This is how occlusion is detected: a click goes to whatever window owns the
   * pixel, not to the window we think we are driving. When another application
   * covers eNSP the returned PID is that application's, so the caller can refuse
   * to click instead of silently clicking the wrong window.
   */
  public static uint OwnerPidAt(int x, int y) {
    var pt = new POINT(); pt.X = x; pt.Y = y;
    IntPtr h = WindowFromPoint(pt);
    if (h == IntPtr.Zero) return 0;
    IntPtr root = GetAncestor(h, 2); // GA_ROOT
    return PidOf(root != IntPtr.Zero ? root : h);
  }

  /** Display name of a PID, for error messages. Never throws. */
  public static string ProcessNameOf(uint pid) {
    try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; }
    catch { return "pid " + pid; }
  }

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

/**
 * PID of a *live* eNSP client, or null.
 *
 * eNSP leaves zombie processes behind: the process object survives with
 * `Threads.Count === 0` and holds the client's single-instance lock, so a new
 * launch inherits an empty canvas. Such a PID must never be reused.
 *
 * @returns {number|null}
 */
export function enspPid() {
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      'Get-Process eNSP_Client -ErrorAction SilentlyContinue | ' +
        'Where-Object { $_.Threads.Count -gt 0 } | ' +
        'Select-Object -First 1 -ExpandProperty Id',
    ],
    { encoding: 'utf8', windowsHide: true },
  )
  const pid = Number((r.stdout || '').trim())
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/**
 * Is this window handle still valid and owned by a live process?
 *
 * @param {string} hwnd
 * @returns {boolean}
 */
export function windowAlive(hwnd) {
  const r = runPowerShell(
    `$h = [IntPtr]::new([int64]${hwnd})
     if (-not [EnspWin]::IsWindow($h)) { 'no'; exit 0 }
     $owned = Get-Process eNSP_Client -ErrorAction SilentlyContinue | Where-Object { $_.Threads.Count -gt 0 }
     if ($owned) { 'yes' } else { 'no' }`,
    { timeoutMs: 20000 },
  )
  return r.ok && r.stdout.trim().endsWith('yes')
}

/** Every eNSP client PID, including zero-thread zombies. */
export function enspPids() {
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', 'Get-Process eNSP_Client -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id'],
    { encoding: 'utf8', windowsHide: true },
  )
  return (r.stdout || '')
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
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
export async function launchEnsp({ topology, exspPath, readyTimeoutMs = 120000 } = {}) {
  const exe = exspPath ?? process.env.DSH_ENSP_EXE ?? 'E:\\Huawei\\eNSP\\eNSP_Client.exe'
  const target = topology ? path.resolve(topology) : null

  // Reject topologies whose devices have no installed image *before* starting the
  // client. Opening one otherwise looks fine for a few seconds — eNSP paints the
  // canvas and then exits by itself, which surfaces later as a pile of
  // "console never answered" errors that point at the wrong thing.
  if (target) {
    const parsed = await readTopology(target)
    const support = checkTopologySupport(parsed, { root: rootFromExe(exe) })
    if (!support.ok) throw new Error(describeBlocked(support))
  }

  // Reuse an existing window only when it renders something; a blank window is a
  // dead instance that would otherwise be reported as success.
  const existing = enspPid()
  if (existing) {
    const hwnd = locateWindow(existing)
    if (hwnd && (!target || topologyRendered(hwnd))) {
      return { pid: existing, hwnd, reused: true, rendered: Boolean(hwnd) }
    }
    if (hwnd && target) {
      // A live window showing nothing: reopen the file in it first.
      reopenTopology(target)
      if (await waitForRender(hwnd, { attempts: 6, intervalMs: 2500 })) {
        return { pid: existing, hwnd, reused: true, rendered: true }
      }
    }
    // Give up on it: stale clients hold eNSP's single-instance lock and make every
    // new window open blank.
    killAllClients()
    await sleep(2500)
  }

  /** Launch once and wait for a frame window. */
  const boot = async () => {
    startDetached(exe, target)
    const started = Date.now()
    const deadline = started + readyTimeoutMs
    while (Date.now() < deadline) {
      const pid = enspPid()
      if (pid) {
        const hwnd = locateWindow(pid)
        if (hwnd) return { pid, hwnd, waitMs: Date.now() - started }
      }
      await sleep(250)
    }
    return null
  }

  // Up to three attempts: the client occasionally opens with an empty canvas on a
  // cold start, and a clean relaunch always renders. Verified empirically.
  for (let attempt = 1; attempt <= 3; attempt++) {
    const booted = await boot()
    if (!booted) {
      killAllClients()
      await sleep(1500)
      continue
    }
    if (!target) return { ...booted, reused: false, rendered: true }
    if (await waitForRender(booted.hwnd, { attempts: 6, intervalMs: 2000 })) {
      return { ...booted, reused: false, rendered: true }
    }
    // Blank canvas: tear the instance down and try again from a clean state.
    killAllClients()
    await sleep(2500)
  }

  throw new Error(
    'eNSP opened but never rendered the topology after 3 attempts. ' +
      'Close every eNSP window and retry; a leftover client holds the single-instance lock.',
  )
}

/**
 * Force-terminate every eNSP client process.
 *
 * Zombie processes (zero threads) cannot be killed by any API; they linger until
 * the OS reaps them. This reports what survived so the caller can decide whether
 * retrying is worthwhile.
 *
 * @returns {{killed: boolean, survivors: number[]}}
 */
function killAllClients() {
  spawnSync('taskkill', ['/F', '/IM', 'eNSP_Client.exe'], { windowsHide: true, encoding: 'utf8' })
  return { killed: true, survivors: enspPids() }
}

/**
 * Poll until the canvas actually shows the topology.
 *
 * @param {string} hwnd
 * @param {{attempts?: number, intervalMs?: number}} [options]
 * @returns {Promise<boolean>}
 */
async function waitForRender(hwnd, { attempts = 6, intervalMs = 2000 } = {}) {
  for (let i = 0; i < attempts; i++) {
    await sleep(intervalMs)
    if (topologyRendered(hwnd)) return true
  }
  return false
}

/**
 * Start the client so that it outlives this Node process.
 *
 * `spawn(..., {detached:true})` is not enough on Windows: eNSP is a GUI application
 * that terminates when the console session that launched it goes away. Going
 * through `cmd /c start` hands ownership to the shell, which is what a double-click
 * in Explorer does, and the client then survives its launcher.
 *
 * @param {string} exe
 * @param {string|null} [topology]
 */
function startDetached(exe, topology) {
  // Win32_Process.Create via WMI is the only launch path measured to leave the
  // client fully independent of this Node process:
  //
  //   spawn(..., {detached:true})  -> client dies with its launcher
  //   cmd /c start                 -> client dies with its launcher
  //   Start-Process -WindowStyle Hidden -> client exits before creating a window
  //   Start-Process (visible)      -> unreliable when called from a hidden shell
  //   WMI Win32_Process.Create     -> survives; returns the real PID
  //
  // The client must outlive the tool call, otherwise every follow-up (start
  // devices, push config) finds a dead console.
  const cmdline = topology ? `"${exe}" "${topology}"` : `"${exe}"`

  // Two launch paths, tried in order. WMI is the cleanest when it works: one
  // call, a real PID, and the client owns no parent. On some machines WMI
  // refuses the request outright with `ReturnValue 8` (the process could not be
  // started, usually a permissions or token change); `Start-Process -PassThru`
  // from the same hidden PowerShell then works and the client still outlives it.
  const attempts = [
    `
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine = '${cmdline.replace(/'/g, "''")}'
}
if ($r.ReturnValue -ne 0) { 'ERR ' + $r.ReturnValue; exit 0 }
'pid=' + $r.ProcessId
`,
    `
$p = Start-Process -FilePath '${exe.replace(/'/g, "''")}'${topology ? ` -ArgumentList '${topology.replace(/'/g, "''")}'` : ''} -PassThru
'pid=' + $p.Id
`,
  ]

  const failures = []
  for (const body of attempts) {
    const r = runPowerShell(body, { timeoutMs: 30000 })
    if (r.ok) {
      const m = /pid=(\d+)/.exec(r.stdout)
      if (m) return Number(m[1])
    }
    failures.push(r.stdout || r.stderr || `exit ${r.status}`)
  }
  throw new Error(`could not launch eNSP: ${failures.join(' / ')}`)
}

/**
 * Ask the running client to open a topology again.
 *
 * A second instance is normally refused, so this relaunches the client with the
 * same file; the window handle changes and the caller re-locates it.
 *
 * @param {string} topology
 */
function reopenTopology(topology) {
  const exe = process.env.DSH_ENSP_EXE ?? 'E:\\Huawei\\eNSP\\eNSP_Client.exe'
  startDetached(exe, topology)
}

/**
 * Take a screenshot of the client's canvas, cropped to the drawing area.
 *
 * Used by `topologyRendered` and by the probe diagnostics. The canvas excludes the
 * left device palette and the toolbar, so anything found inside it came from the
 * open topology.
 *
 * @param {string} hwnd
 * @returns {string} absolute path to the PNG, or '' on failure
 */
export function captureCanvas(hwnd) {
  const out = path.join(os.tmpdir(), `dsh-ensp-canvas-${Date.now()}.png`)
  const r = runPowerShell(
    `
$h = [IntPtr]::new([int64]${hwnd})
[void][EnspWin]::FocusWindow($h)
Start-Sleep -Milliseconds 900
$wr = New-Object EnspWin+RECT
[void][EnspWin]::GetWindowRect($h, [ref]$wr)
$w = $wr.R - $wr.L; $ht = $wr.B - $wr.T
if ($w -lt 400 -or $ht -lt 300) { 'ERR small'; exit 0 }
Add-Type -AssemblyName System.Drawing
$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($wr.L, $wr.T, 0, 0, $bmp.Size)
$bmp.Save('${out.replace(/\\/g, '\\\\')}', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose(); $g.Dispose()
'ok'
`,
    { timeoutMs: 40000 },
  )
  return r.ok ? out : ''
}

/**
 * Does the open topology show devices on the canvas?
 *
 * eNSP paints with DirectX, so there is no window tree to query. Two independent
 * signals are combined, because either alone is weak:
 *
 *   1. **Icon colour.** Device icons are a saturated blue on a pale canvas; the
 *      empty canvas has no such pixels.
 *   2. **Link lines.** Rendered links are near-black thin strokes across the canvas.
 *
 * This is the check that gates "the topology actually opened". Callers retry on a
 * negative result rather than reporting success for a blank window.
 *
 * @param {string} hwnd
 * @returns {boolean}
 */
export function topologyRendered(hwnd) {
  const png = captureCanvas(hwnd)
  if (!png) return false
  const r = runPowerShell(
    `
Add-Type -AssemblyName System.Drawing
$bmp = [System.Drawing.Bitmap]::FromFile('${png.replace(/\\/g, '\\\\')}')
$w = $bmp.Width; $ht = $bmp.Height
# Canvas only: skip the palette column and the toolbar band.
$x0 = [int]($w * 0.22); $x1 = [int]($w * 0.97)
$y0 = [int]($ht * 0.10); $y1 = [int]($ht * 0.92)
$icon = 0; $dark = 0
for ($y = $y0; $y -lt $y1; $y += 2) {
  for ($x = $x0; $x -lt $x1; $x += 2) {
    $c = $bmp.GetPixel($x, $y)
    if ($c.B -gt 140 -and ($c.B - $c.R) -gt 55 -and ($c.B - $c.G) -gt 25) { $icon++ }
    elseif ($c.R -lt 90 -and $c.G -lt 90 -and $c.B -lt 90) { $dark++ }
  }
}
$bmp.Dispose()
'icon=' + $icon + ' dark=' + $dark
`,
    { timeoutMs: 40000 },
  )
  if (!r.ok) return false
  const m = /icon=(\d+) dark=(\d+)/.exec(r.stdout)
  if (!m) return false
  const icon = Number(m[1])
  const dark = Number(m[2])
  // A rendered lab shows dozens of icon pixels and a few hundred link pixels.
  return icon >= 15 && dark >= 40
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
 * Is the eNSP window covered by something else?
 *
 * Calibration reads the screen, so an occluded window produces a screenshot of
 * whatever is on top of it and the measured anchors are garbage. Rather than
 * clicking on a guess, probe several points of the window frame and report the
 * first foreign process that owns one of them.
 *
 * @param {string} hwnd
 * @returns {{occluded: boolean, by?: string, at?: string}}
 */
export function checkOcclusion(hwnd) {
  const r = runPowerShell(
    `
$h = [IntPtr]::new([int64]${hwnd})
$rect = New-Object EnspWin+RECT
[void][EnspWin]::GetWindowRect($h, [ref]$rect)
$self = [EnspWin]::PidOf($h)
$w = $rect.R - $rect.L
$hg = $rect.B - $rect.T
# A grid rather than a handful of points: partial coverage of the toolbar strip
# is exactly the case that corrupts calibration, and it is easy to miss when
# only the middle of the window is sampled.
$xs = @(0.5, 0.2, 0.35, 0.65, 0.8)
$ys = @(0.06, 0.25, 0.5, 0.75)
foreach ($fy in $ys) {
  foreach ($fx in $xs) {
    $px = $rect.L + [int]($w * $fx)
    $py = $rect.T + [int]($hg * $fy)
    $owner = [EnspWin]::OwnerPidAt($px, $py)
    if ($owner -ne 0 -and $owner -ne $self) {
      'OCCLUDED ' + $px + ',' + $py + ' ' + $owner + ' ' + [EnspWin]::ProcessNameOf($owner)
      return
    }
  }
}
'clear'
`,
    { timeoutMs: 20000 },
  )
  const text = r.stdout.split('\n').filter(Boolean).pop() || ''
  if (text.startsWith('OCCLUDED')) {
    const f = text.split(' ')
    return { occluded: true, at: f[1], by: `${f[3] ?? ''} (${f[4] ?? 'unknown'})`.trim() }
  }
  return { occluded: false }
}

/**
 * Click the "start all devices" toolbar button.
 *
 * Coordinates are **window-relative** and were measured against the client's
 * 1280×800 layout; the toolbar is a fixed strip whose origin does not move with
 * the window. See `docs/UI-ANCHORS.md` for how they were obtained and how to
 * re-measure after an eNSP or DPI change.
 *
 * ## The click is verified, not assumed
 *
 * A synthetic click lands on whichever window owns the pixel. When another
 * application covers eNSP the mouse events go there and eNSP never sees them,
 * yet every step reports success and the caller then waits for devices that
 * were never started. That failure was observed for real (a full-screen VMware
 * window sitting on top). So the owner of the pixel is looked up with
 * `WindowFromPoint` first: if it is not the eNSP process, no click is sent and
 * the error names the process that is in the way.
 *
 * @param {string} hwnd
 * @param {{button?: 'start'|'stop', anchors?: object}} [options]
 * @returns {{ok: boolean, clicked: boolean, detail: string, occludedBy?: string}}
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
$self = [EnspWin]::PidOf($h)
$owner = [EnspWin]::OwnerPidAt($cx, $cy)
if ($owner -ne 0 -and $owner -ne $self) {
  'OCCLUDED ' + $cx + ',' + $cy + ' ' + $owner + ' ' + [EnspWin]::ProcessNameOf($owner)
  exit 3
}
[EnspWin]::Click($cx, $cy)
$after = [EnspWin]::OwnerPidAt($cx, $cy)
if ($after -ne 0 -and $after -ne $self) {
  'STOLEN ' + $cx + ',' + $cy + ' ' + $after + ' ' + [EnspWin]::ProcessNameOf($after)
  exit 4
}
'clicked ' + $cx + ',' + $cy
`,
    { timeoutMs: 20000 },
  )
  const detail = r.stdout.split('\n').filter(Boolean).pop() || r.stderr || ''
  const fields = detail.split(' ')
  if (fields[0] === 'OCCLUDED' || fields[0] === 'STOLEN') {
    const who = `${fields[3] ?? ''} (${fields[4] ?? 'unknown'})`.trim()
    return {
      ok: false,
      clicked: false,
      occludedBy: who,
      detail:
        `eNSP is covered by another window at ${fields[1]}: ${who}. ` +
        'The mouse events would go to that window, so nothing was clicked. ' +
        'Bring eNSP to the front (restore it from the taskbar) and try again.',
    }
  }
  return { ok: r.ok, clicked: r.ok, detail }
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
  // The window must still exist: a stale handle means the client already exited,
  // and clicking a dead handle does nothing while reporting success below.
  if (!hwnd || !windowAlive(hwnd)) {
    throw new Error('eNSP window is gone; reopen the topology before starting devices')
  }

  report({ phase: 'calibrate', hwnd })
  // Calibration photographs the screen, so an occluded window yields anchors
  // measured on the wrong pixels. Check first, and say who is in the way.
  const occlusion = checkOcclusion(hwnd)
  if (occlusion.occluded) {
    throw new Error(
      `eNSP is covered by ${occlusion.by} at ${occlusion.at}, so its toolbar cannot be located or clicked. ` +
        'Windows does not let another process raise a foreign window, so this has to be fixed by hand: ' +
        'minimise or close the window that is on top, bring eNSP to the front, then run the command again.',
    )
  }

  let anchors
  try {
    anchors = calibrateAnchors(hwnd)
  } catch (error) {
    anchors = { ...DEFAULT_ANCHORS, method: 'default', detail: { reason: error.message } }
  }

  // A default anchor means calibration failed, and an unmeasured click can land on
  // any toolbar control (including the one that closes the document). Refuse
  // instead of guessing.
  if (anchors.method !== 'measured') {
    throw new Error(
      `toolbar calibration failed (${anchors.detail?.reason ?? 'unknown'}). ` +
        'Make sure the eNSP window is visible and run ensp_probe to re-measure.',
    )
  }
  report({ phase: 'calibrated', method: anchors.method, detail: anchors.detail })

  report({ phase: 'focus', hwnd })
  const focused = focusEnsp(hwnd)
  if (!focused) report({ phase: 'focus-failed', hwnd })

  report({ phase: 'click', button: 'start', anchor: anchors.start })
  const click = clickToolbar(hwnd, { button: 'start', anchors })
  if (!click.clicked) {
    // Never fall through to waiting on consoles: without a click no device will
    // ever boot, and a long wait would hide the real cause.
    throw new Error(click.detail || 'the start button could not be clicked')
  }

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
