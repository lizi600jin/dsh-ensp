/**
 * Environment self-check.
 *
 * Every failure this project has hit in the field was an environment problem
 * masquerading as a code problem: a missing device image made eNSP quit after
 * rendering, a window covered by another application swallowed every click, and
 * a non-interactive session accepted `SendInput` while never delivering it. All
 * three look identical from the outside — "nothing happened".
 *
 * `doctor()` turns those into explicit, checkable facts before a lab starts, and
 * every failing check carries the fix in the same object. It never starts eNSP.
 *
 * @module dsh-ensp/doctor
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { checkTopologySupport, probeDevice } from './compat.mjs'
import { DEFAULT_ANCHORS, calibrateAnchors } from './calibrate.mjs'
import { enspPid, locateWindow } from './launcher.mjs'

export const DEFAULT_ENSP_EXE = 'E:\\Huawei\\eNSP\\eNSP_Client.exe'
export const DEFAULT_VBOX = 'E:\\VirtualBox\\VBoxManage.exe'

const MIN_FREE_MEMORY_MB = 1024

/** PowerShell helper that answers "does synthetic input reach this session?". */
const INPUT_PROBE = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class EnspInputProbe {
  [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO p);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint n, INPUT[] inputs, int cb);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("kernel32.dll")] public static extern bool ProcessIdToSessionId(uint pid, out uint sid);

  public static uint Tick() {
    var l = new LASTINPUTINFO(); l.cbSize = 8;
    if (!GetLastInputInfo(ref l)) return 0;
    return l.dwTime;
  }

  public static string Run() {
    uint before = Tick();
    var moves = new INPUT[2];
    moves[0].type = 0; moves[0].u.mi.dx = 1;  moves[0].u.mi.dy = 0; moves[0].u.mi.dwFlags = 0x0001;
    moves[1].type = 0; moves[1].u.mi.dx = -1; moves[1].u.mi.dy = 0; moves[1].u.mi.dwFlags = 0x0001;
    uint sent = SendInput(2, moves, Marshal.SizeOf(typeof(INPUT)));
    int err = Marshal.GetLastWin32Error();
    System.Threading.Thread.Sleep(120);
    uint after = Tick();
    uint myPid = (uint)System.Diagnostics.Process.GetCurrentProcess().Id;
    uint mySession;
    ProcessIdToSessionId(myPid, out mySession);
    return string.Format("sent={0};err={1};tickBefore={2};tickAfter={3};changed={4};session={5};consoleSession={6};foreground={7}",
      sent, err, before, after, (before != 0 && before != after) ? "true" : "false",
      mySession, WTSGetActiveConsoleSessionId(), GetForegroundWindow());
  }
}
'@
[EnspInputProbe]::Run()
`

/**
 * Can this process deliver synthetic mouse/keyboard input to the session?
 *
 * The probe sends two opposing 1-pixel mouse moves (net cursor movement zero)
 * and compares the session's last-input tick before and after. `SendInput`
 * returning a non-zero count only means the API accepted the call; the tick is
 * what proves it reached the input queue.
 */
export function probeInputInjection({ timeoutMs = 30000 } = {}) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command', INPUT_PROBE], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
  })
  if (r.error) {
    return { ok: false, reason: 'probe-failed', detail: String(r.error.message || r.error) }
  }
  if (r.status !== 0) {
    return { ok: false, reason: 'probe-failed', detail: (r.stderr || r.stdout || '').trim().slice(0, 400) }
  }
  const line = (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean).pop() || ''
  const field = (k) => {
    const m = line.match(new RegExp(k + '=([^;]*)'))
    return m ? m[1] : ''
  }
  const changed = field('changed') === 'true'
  return {
    ok: changed,
    sent: Number(field('sent') || 0),
    tickChanged: changed,
    session: field('session'),
    consoleSession: field('consoleSession'),
    foreground: field('foreground'),
    raw: line,
  }
}

/**
 * Free physical memory in MB, or null when it cannot be read.
 *
 * On Windows Win32_OperatingSystem is the accurate number, but it needs
 * PowerShell. Everything else (and any Windows box where PowerShell is not on
 * PATH) falls back to os.freemem(), so the check still says something useful
 * instead of giving up on the platform it happens to run on.
 */
export function freeMemoryMb() {
  if (process.platform === 'win32') {
    const r = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_OperatingSystem | ForEach-Object { [int]($_.FreePhysicalMemory / 1024) }",
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 },
    )
    if (r.status === 0) {
      const n = Number((r.stdout || '').trim())
      if (Number.isFinite(n) && n > 0) return n
    }
  }
  const fallback = Math.floor(os.freemem() / (1024 * 1024))
  return Number.isFinite(fallback) && fallback > 0 ? fallback : null
}

/** Ports in eNSP's console range that are already listening. */
export function busyConsolePorts() {
  const r = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | " +
        'Where-Object { $_.LocalPort -ge 2000 -and $_.LocalPort -le 2100 } | ' +
        'ForEach-Object { $_.LocalPort } | Sort-Object -Unique',
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 },
  )
  if (r.status !== 0) return []
  return (r.stdout || '')
    .split(/\s+/)
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 2000 && n <= 2100)
}

function check(id, status, detail, fix) {
  return fix ? { id, status, detail, fix } : { id, status, detail }
}

/**
 * Run every environment check.
 *
 * @param {object} [options]
 * @param {string} [options.exe]     eNSP client path
 * @param {string} [options.vbox]    VBoxManage path
 * @param {string} [options.root]    eNSP installation root (defaults to exe dir)
 * @param {string[]} [options.models] device models the run needs
 * @param {boolean} [options.deep]   also run the input probe (slow: ~2 s)
 */
export function doctor(options = {}) {
  const exe = options.exe || DEFAULT_ENSP_EXE
  const vbox = options.vbox || DEFAULT_VBOX
  const root = options.root || path.dirname(exe)
  const deep = options.deep !== false
  const checks = []

  // 1. eNSP client present
  const exeOk = fs.existsSync(exe)
  checks.push(
    check(
      'ensp-installed',
      exeOk ? 'pass' : 'fail',
      exeOk ? exe : `not found: ${exe}`,
      exeOk
        ? undefined
        : 'Install eNSP, or pass --exe with the real path to eNSP_Client.exe.',
    ),
  )

  // 2. VirtualBox present (eNSP cannot boot a single device without it)
  const vboxOk = fs.existsSync(vbox)
  checks.push(
    check(
      'virtualbox',
      vboxOk ? 'pass' : 'fail',
      vboxOk ? vbox : `not found: ${vbox}`,
      vboxOk ? undefined : 'Install VirtualBox 5.2.x, which ships with eNSP.',
    ),
  )

  // 3. Device images for the models this scenario needs
  if (options.models && options.models.length) {
    const missing = []
    for (const model of [...new Set(options.models)]) {
      const p = probeDevice(model, { root })
      if (!p.available) missing.push(`${model}: ${p.reason}`)
    }
    checks.push(
      check(
        'device-images',
        missing.length === 0 ? 'pass' : 'fail',
        missing.length === 0 ? `${[...new Set(options.models)].join(', ')} all present` : missing.join('; '),
        missing.length === 0
          ? undefined
          : 'Reinstall eNSP with the missing device component selected, or remove those devices from the topology.',
      ),
    )
  }

  // 4. Console port range has room
  const busy = busyConsolePorts()
  checks.push(
    check(
      'console-ports',
      busy.length === 0 ? 'pass' : 'warn',
      busy.length === 0 ? '2000-2100 free' : `already listening: ${busy.join(', ')}`,
      busy.length === 0
        ? undefined
        : 'Another eNSP instance is holding these ports. Stop it first, or the new topology will bind elsewhere and consoles will time out.',
    ),
  )

  // 5. Synthetic input reaches the session (the decisive check)
  if (deep) {
    const input = probeInputInjection()
    checks.push(
      check(
        'input-injection',
        input.ok ? 'pass' : 'fail',
        input.ok
          ? 'synthetic mouse input reached the input queue'
          : input.reason === 'probe-failed'
            ? `probe failed: ${input.detail}`
            : `SendInput accepted ${input.sent} event(s) but the session last-input tick did not change (session ${input.session}, console session ${input.consoleSession})`,
        input.ok
          ? undefined
          : 'Run the tool elevated (as administrator) from an interactive desktop session. A normal-integrity process cannot inject mouse input into eNSP, which runs at high integrity, and services or scheduled tasks cannot inject input at all.',
      ),
    )
  }

  // 6. Memory headroom: each AR_Base needs 256 MB, WLAN images 530-650 MB
  const free = freeMemoryMb()
  if (free === null) {
    checks.push(
      check(
        'memory',
        'warn',
        'could not read free physical memory',
        'Check free memory yourself (Task Manager on Windows) and keep at least 1 GB spare; a device needs ~256 MB to boot.',
      ),
    )
  } else {
    const okMem = free >= MIN_FREE_MEMORY_MB
    checks.push(
      check(
        'memory',
        okMem ? 'pass' : 'warn',
        `${free} MB free (each router needs ~256 MB)`,
        okMem ? undefined : 'Close some applications; devices may boot very slowly or fail to start.',
      ),
    )
  }

  // 7. Calibration anchors. The static defaults are only a fallback for a window we
  // could not photograph, so comparing them to each other proves nothing. When eNSP
  // is open, measure the live window instead and say which method produced it.
  const hwnd = options.hwnd ?? (options.live === false ? null : safeWindow())
  if (hwnd) {
    try {
      const anchors = calibrateAnchors(hwnd, { refresh: true })
      const measured = anchors.method === 'measured'
      checks.push(
        check(
          'anchors',
          measured ? 'pass' : 'warn',
          `${anchors.method}: start (${anchors.start.x},${anchors.start.y}) stop (${anchors.stop.x},${anchors.stop.y})`,
          measured
            ? undefined
            : 'The toolbar could not be located by colour, so the cached fallback is in use. ' +
              'Bring eNSP to the front and run `ensp probe`.',
        ),
      )
    } catch (error) {
      checks.push(check('anchors', 'warn', `not measured: ${error.message}`, 'Run `ensp probe` with eNSP visible.'))
    }
  } else {
    const a = DEFAULT_ANCHORS.start
    const b = DEFAULT_ANCHORS.stop
    checks.push(
      check(
        'anchors',
        b.x > a.x ? 'pass' : 'fail',
        `fallback start (${a.x},${a.y}) stop (${b.x},${b.y}); eNSP not open, nothing measured`,
        b.x > a.x ? undefined : 'Fallback anchors are inconsistent; run `ensp probe`.',
      ),
    )
  }

  const failed = checks.filter((c) => c.status === 'fail')
  const warned = checks.filter((c) => c.status === 'warn')
  return {
    ok: failed.length === 0,
    checks,
    failed: failed.map((c) => c.id),
    warned: warned.map((c) => c.id),
  }
}

/**
 * The eNSP window, if one is open. Best effort: doctor must still work when eNSP is
 * not installed, not running, or running as a zombie without threads.
 */
function safeWindow() {
  try {
    return locateWindow(enspPid()) ?? null
  } catch {
    return null
  }
}

/** Render a doctor report for a terminal. */
export function formatDoctor(report) {
  const mark = { pass: 'ok  ', warn: 'warn', fail: 'FAIL' }
  const lines = []
  for (const c of report.checks) {
    lines.push(`[${mark[c.status] || c.status}] ${c.id}: ${c.detail}`)
    if (c.fix) lines.push(`         fix: ${c.fix}`)
  }
  lines.push('')
  lines.push(
    report.ok
      ? `environment ok${report.warned.length ? ` (${report.warned.length} warning(s))` : ''}`
      : `environment is not ready: ${report.failed.join(', ')}`,
  )
  return lines.join('\n')
}

/** Convenience wrapper used by the CLI, MCP server and plugin. */
export function checkEnvironment(options = {}) {
  const report = doctor(options)
  return { ...report, text: formatDoctor(report) }
}

/**
 * Models a topology needs, so `doctor()` can check the right images.
 * Accepts a parsed topology (from `readTopology`).
 */
export function modelsOf(topology) {
  const devices = topology?.devices ?? []
  return [...new Set(devices.map((d) => d.model))].sort()
}

/** Free-memory constant, exported so tests can assert against it. */
export { MIN_FREE_MEMORY_MB }
