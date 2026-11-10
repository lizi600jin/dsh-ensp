/**
 * Toolbar anchor calibration.
 *
 * ## The DPI trap (root cause of every coordinate bug in this project)
 *
 * This machine runs at **150 % scaling**, and that broke coordinate handling in a
 * way that produced confident, wrong answers:
 *
 *   | call site                       | frame                     | value for the window |
 *   |---------------------------------|---------------------------|----------------------|
 *   | `GetWindowRect` in a DPI-unaware process | logical (scaled)  | 213,133  1280x800 |
 *   | `GetWindowRect` after `SetProcessDPIAware` | physical        | 320,200  1920x1200 |
 *   | `CopyFromScreen`                | always physical pixels    | 1920x1200 image      |
 *
 * Mixing them silently shifts every click by the scale factor: a "measured"
 * (1099,151) looked plausible but landed on blank toolbar, and a click that
 * seemed to work was actually a coincidence.
 *
 * **Rule: this module declares DPI awareness first and then uses only physical
 * pixels.** `launcher.clickToolbar` does the same, so anchors from here are
 * directly usable there.
 *
 * ## Anchors
 *
 * Window-physical-relative, measured on eNSP 1.2 at 1920x1200 physical:
 *   start ("开启设备", green triangle) and stop ("停止设备", red square) are the
 *   transport pair at the right end of the toolbar.
 *
 * The calibration searches a band rather than a single row, because the toolbar's
 * y offset inside the window depends on title-bar height and DPI.
 *
 * @module dsh-ensp/calibrate
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Fallback anchors in **physical** pixels, window-relative.
 * Derived from the measured 150 % layout; correct on this class of machine and
 * close enough elsewhere that the band search normally overrides them.
 */
export const DEFAULT_ANCHORS = {
  start: { x: 987, y: 226 },
  stop: { x: 1049, y: 228 },
}

/**
 * Cache of measured anchors.
 *
 * Calibration costs a screenshot plus a PowerShell round trip (~1.3 s). The result
 * only changes when the window size changes, so caching it by geometry turns the
 * second and later runs into an instant decision. `resetCalibrationCache()` exists
 * for the case where a user re-runs after changing DPI or eNSP version.
 */
const anchorCache = new Map()

/**
 * `hwnd -> geometry` memo. Learning the cache key costs a PowerShell round trip
 * (~1.4 s), so we remember it per window handle: a window does not change size
 * between our own calls.
 */
const geometryByHwnd = new Map()

/**
 * On-disk cache.
 *
 * Calibration is invoked from short-lived processes (the CLI, each MCP tool call),
 * so a memory-only cache never hits. The window geometry is a stable key, and a
 * stale file can only cause a wrong click if the user changed DPI *and* the window
 * size stayed identical — `refresh: true` covers that case.
 */
const CACHE_FILE = path.join(tmpdir(), 'dsh-ensp-anchors.json')

function loadDiskCache() {
  try {
    return JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function saveDiskCache(cache) {
  try {
    mkdirSync(path.dirname(CACHE_FILE), { recursive: true })
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2))
  } catch {
    /* a cache that cannot be written is not an error */
  }
}

/** Forget every cached measurement, in memory and on disk. */
export function resetCalibrationCache() {
  anchorCache.clear()
  saveDiskCache({})
}

/** Band to search, physical pixels, window-relative. */
const BAND = { yMin: 40, yMax: 130, xMin: 20, xMax: 1900 }

/**
 * Capture the window and locate the coloured transport buttons.
 *
 * @param {string} hwnd
 */
function scanToolbar(hwnd) {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Cap {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@

# Must precede every measurement: makes GetWindowRect report physical pixels,
# matching what CopyFromScreen captures and what SetCursorPos expects.
[void][Cap]::SetProcessDPIAware()

$h = [IntPtr]::new([int64]${hwnd})
if (-not [Cap]::IsWindow($h)) { 'ERR: bad window handle'; exit 0 }
$wasIconic = [Cap]::IsIconic($h)
[void][Cap]::ShowWindow($h, 9)
[void][Cap]::SetForegroundWindow($h)
Start-Sleep -Milliseconds 1100

$wr = New-Object Cap+RECT
[void][Cap]::GetWindowRect($h, [ref]$wr)
$w = $wr.R - $wr.L; $ht = $wr.B - $wr.T
if ($w -lt 400 -or $ht -lt 300) { 'ERR: window too small ' + $w + 'x' + $ht; exit 0 }

$bmp = New-Object System.Drawing.Bitmap $w, $ht
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($wr.L, $wr.T, 0, 0, $bmp.Size)

$yMin = ${BAND.yMin}; $yMax = [Math]::Min(${BAND.yMax}, $ht - 1)
$xMin = ${BAND.xMin}; $xMax = [Math]::Min(${BAND.xMax}, $w - 1)
$hits = @()
for ($y = $yMin; $y -le $yMax; $y++) {
  for ($x = $xMin; $x -le $xMax; $x++) {
    $c = $bmp.GetPixel($x, $y)
    $isGreen = ($c.G -ge 90) -and (($c.G - $c.R) -ge 35) -and (($c.G - $c.B) -ge 25)
    $isRed   = ($c.R -ge 140) -and (($c.R - $c.G) -ge 60) -and (($c.R - $c.B) -ge 50)
    if ($isGreen) { $hits += [pscustomobject]@{ x=$x; y=$y; kind='g' } }
    elseif ($isRed) { $hits += [pscustomobject]@{ x=$x; y=$y; kind='r' } }
  }
}
$bmp.Dispose(); $g.Dispose()

function Clusters($pts, $kind) {
  $sel = @($pts | Where-Object { $_.kind -eq $kind })
  if ($sel.Count -eq 0) { return @() }
  $xs = $sel | Sort-Object x | Select-Object -ExpandProperty x -Unique
  if ($xs.Count -eq 0) { return @() }
  $groups = @(); $cur = @($xs[0])
  for ($i = 1; $i -lt $xs.Count; $i++) {
    if (($xs[$i] - $xs[$i-1]) -le 4) { $cur += $xs[$i] }
    else { $groups += ,$cur; $cur = @($xs[$i]) }
  }
  $groups += ,$cur
  $out = @()
  foreach ($grp in $groups) {
    if ($grp.Count -lt 8) { continue }
    $mnx = ($grp | Measure-Object -Minimum).Minimum
    $mxx = ($grp | Measure-Object -Maximum).Maximum
    $sub = @($sel | Where-Object { $_.x -ge $mnx -and $_.x -le $mxx })
    $mny = ($sub | Measure-Object -Property y -Minimum).Minimum
    $mxy = ($sub | Measure-Object -Property y -Maximum).Maximum
    $cw = $mxx - $mnx + 1
    $chh = $mxy - $mny + 1
    # A transport button is a compact block, roughly square, 15..45 px.
    if ($cw -lt 15 -or $cw -gt 45 -or $chh -lt 15 -or $chh -gt 45) { continue }
    $out += [pscustomobject]@{
      x = [int](($mnx + $mxx) / 2); y = [int](($mny + $mxy) / 2)
      w = [int]$cw; h = [int]$chh
    }
  }
  return $out
}

[pscustomobject]@{
  winW = $w; winH = $ht; wasIconic = $wasIconic
  green = @(Clusters $hits 'g')
  red   = @(Clusters $hits 'r')
} | ConvertTo-Json -Compress -Depth 4
`
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 90000,
    windowsHide: true,
  })
  const stdout = (r.stdout || '').trim()
  if (!stdout || stdout.startsWith('ERR')) {
    return { ok: false, green: [], red: [], error: stdout || r.stderr.slice(0, 300) || 'scan failed' }
  }
  try {
    const data = JSON.parse(stdout.split('\n').pop())
    return {
      ok: true,
      green: (data.green || []).filter(Boolean),
      red: (data.red || []).filter(Boolean),
      winW: data.winW,
      winH: data.winH,
      wasIconic: Boolean(data.wasIconic),
    }
  } catch (error) {
    return { ok: false, green: [], red: [], error: `bad scan payload: ${error.message}` }
  }
}

/**
 * Run a PowerShell snippet that has the `Cap` type (and therefore DPI awareness)
 * available. Kept local so calibration does not depend on the launcher module.
 */
function runPowerShell(body, { timeoutMs = 30000 } = {}) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class Cap {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@ -ErrorAction Stop
[void][Cap]::SetProcessDPIAware()
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
 * Locate the transport buttons.
 *
 * The stop square always sits just right of the play triangle, so we anchor on
 * the green one and take the nearest red cluster to its right; that pairing is
 * stable even when other green/red glyphs exist elsewhere in the toolbar.
 *
 * @param {string} hwnd
 * @param {{useDefaultsOnFailure?: boolean}} [options]
 */
export function calibrateAnchors(hwnd, { useDefaultsOnFailure = true, refresh = false } = {}) {
  let geometry
  if (!refresh && geometryByHwnd.has(hwnd)) {
    geometry = { ok: true, stdout: geometryByHwnd.get(hwnd) }
  } else {
    geometry = runPowerShell(
      `$r = New-Object Cap+RECT
       [void][Cap]::GetWindowRect([IntPtr]::new([int64]${hwnd}), [ref]$r)
       '' + ($r.R-$r.L) + 'x' + ($r.B-$r.T)`,
    )
    if (geometry.ok) geometryByHwnd.set(hwnd, geometry.stdout)
  }
  // Normalise hard: PowerShell returns CRLF and may append a BOM, and an unstable
  // key silently disables the cache.
  const key = geometry.ok
    ? geometry.stdout.replace(/[\uFEFF\r\n]+/g, ' ').trim().split(/\s+/).pop() || null
    : null

  if (!refresh && key) {
    const memoryHit = anchorCache.get(key)
    if (memoryHit) return { ...memoryHit, detail: { ...memoryHit.detail, cached: 'memory' } }
    const diskHit = loadDiskCache()[key]
    if (diskHit) {
      anchorCache.set(key, diskHit)
      return { ...diskHit, detail: { ...diskHit.detail, cached: 'disk' } }
    }
  }

  const scan = scanToolbar(hwnd)
  if (scan.ok && scan.green.length) {
    const start = scan.green.sort((a, b) => b.x - a.x)[0]
    const stop =
      scan.red
        .filter((c) => c.x > start.x && c.x - start.x < 130)
        .sort((a, b) => a.x - b.x)[0] ?? null
    const result = {
      start: { x: start.x, y: start.y },
      stop: stop ? { x: stop.x, y: stop.y } : { ...DEFAULT_ANCHORS.stop },
      method: 'measured',
      wasIconic: scan.wasIconic,
      detail: {
        window: `${scan.winW}x${scan.winH}`,
        greenClusters: scan.green.length,
        redClusters: scan.red.length,
        pickedStart: start,
        pickedStop: stop,
      },
    }
    if (key) {
      anchorCache.set(key, result)
      saveDiskCache({ ...loadDiskCache(), [key]: result })
    }
    return result
  }
  if (!useDefaultsOnFailure) {
    throw new Error(`could not locate toolbar buttons: ${scan.error ?? 'no green cluster'}`)
  }
  return {
    start: { ...DEFAULT_ANCHORS.start },
    stop: { ...DEFAULT_ANCHORS.stop },
    method: 'default',
    detail: {
      reason: scan.error ?? 'no button-sized green cluster on the toolbar',
      greenClusters: scan.green?.length ?? 0,
      redClusters: scan.red?.length ?? 0,
      window: scan.ok ? `${scan.winW}x${scan.winH}` : null,
    },
  }
}

/**
 * Report anchors without clicking — used by `ensp probe`.
 * @param {string} hwnd
 */
export function inspectAnchors(hwnd) {
  const scan = scanToolbar(hwnd)
  return {
    ok: scan.ok,
    window: scan.ok ? `${scan.winW}x${scan.winH}` : null,
    wasIconic: scan.wasIconic,
    green: scan.green ?? [],
    red: scan.red ?? [],
    resolved: scan.ok ? calibrateAnchors(hwnd) : null,
    defaults: DEFAULT_ANCHORS,
    error: scan.error,
  }
}
