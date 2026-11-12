/**
 * Locate the eNSP client and VBoxManage.
 *
 * Both used to be hardcoded to `E:\`, which made every machine with a normal
 * install fail at launch. The lookup order is:
 *
 *   1. an explicit override (CLI flag, plugin config, or function argument)
 *   2. `DSH_ENSP_EXE` / `ENSP_EXE` / `DSH_VBOX`
 *   3. the Windows install registry
 *   4. the usual install roots
 *   5. `where` on PATH (VBoxManage only)
 *
 * Every candidate that was tried is reported on failure, so a wrong override
 * produces a message that says what was looked at instead of a bare ENOENT.
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

/** Registry keys an installer may have written the install root to. */
const ENSP_REGISTRY = [
  ['HKLM\\SOFTWARE\\Huawei\\eNSP', 'InstallPath'],
  ['HKLM\\SOFTWARE\\WOW6432Node\\Huawei\\eNSP', 'InstallPath'],
  ['HKLM\\SOFTWARE\\Huawei\\eNSP', 'InstallDir'],
]

/** Install roots seen on real machines, most common first. */
const ENSP_ROOTS = [
  'C:\\Program Files\\Huawei\\eNSP',
  'C:\\Program Files (x86)\\Huawei\\eNSP',
  'D:\\Huawei\\eNSP',
  'E:\\Huawei\\eNSP',
]

/** Where VirtualBox installs itself, most common first. */
const VBOX_PATHS = [
  'C:\\Program Files\\Oracle\\VirtualBox\\VBoxManage.exe',
  'C:\\Program Files (x86)\\Oracle\\VirtualBox\\VBoxManage.exe',
  'D:\\VirtualBox\\VBoxManage.exe',
  'E:\\VirtualBox\\VBoxManage.exe',
]

const isWindows = process.platform === 'win32'

/** True when the path exists and is a file. Never throws. */
function isFile(candidate) {
  if (!candidate) return false
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

/** Read one string value out of the registry, or null. */
function registryValue(key, name) {
  if (!isWindows) return null
  const r = spawnSync('reg', ['query', key, '/v', name], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0 || !r.stdout) return null
  const m = new RegExp(`${name}\\s+REG_\\w+\\s+(.+)`).exec(r.stdout)
  return m ? m[1].trim() : null
}

/** Expand `%VAR%` and strip surrounding quotes from a registry value. */
function cleanRoot(value) {
  if (!value) return null
  const unquoted = value.trim().replace(/^"|"$/g, '')
  const expanded = unexpanded(unquoted)
  return expanded || null
}

/** Expand Windows environment variables without depending on the shell. */
function unexpanded(value) {
  return value.replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole)
}

/** Every candidate eNSP client path, in lookup order, with its source. */
export function enspCandidates(override) {
  const out = []
  if (override) out.push({ path: override, source: 'override' })
  for (const name of ['DSH_ENSP_EXE', 'ENSP_EXE']) {
    const v = process.env[name]
    if (v) out.push({ path: v, source: name })
  }
  for (const [key, name] of ENSP_REGISTRY) {
    const root = cleanRoot(registryValue(key, name))
    if (root) out.push({ path: path.join(root, 'eNSP_Client.exe'), source: `${key}\\${name}` })
  }
  for (const root of ENSP_ROOTS) out.push({ path: path.join(root, 'eNSP_Client.exe'), source: 'install root' })
  return out
}

/** Every candidate VBoxManage path, in lookup order, with its source. */
export function vboxCandidates(override) {
  const out = []
  if (override) out.push({ path: override, source: 'override' })
  if (process.env.DSH_VBOX) out.push({ path: process.env.DSH_VBOX, source: 'DSH_VBOX' })
  if (isWindows) {
    const r = spawnSync('where', ['VBoxManage.exe'], { encoding: 'utf8', windowsHide: true })
    const first = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0]
    if (first) out.push({ path: first, source: 'PATH' })
  }
  for (const p of VBOX_PATHS) out.push({ path: p, source: 'install root' })
  return out
}

/** First existing candidate, or null. */
function firstExisting(candidates) {
  for (const c of candidates) if (isFile(c.path)) return c
  return null
}

/**
 * Resolve the eNSP client executable.
 *
 * @param {string} [override] - explicit path from a flag or plugin config
 * @returns {{path: string, source: string, tried: string[]}}
 * @throws when nothing exists
 */
export function resolveEnspExe(override) {
  // An explicit path is a statement of intent, not a hint. Falling back to some
  // other installation would run a different eNSP than the one that was asked
  // for, and the user would see a working launch on the machine they pointed at
  // and a mystery on the machine they meant.
  if (override && !isFile(override)) {
    throw new Error(
      `the eNSP client path given does not exist: ${override}\n`
        + 'Check the path, or drop --exe to let the tool search for an installation.',
    )
  }
  const candidates = enspCandidates(override)
  const hit = firstExisting(candidates)
  if (hit) return { path: hit.path, source: hit.source, tried: candidates.map((c) => c.path) }
  const tried = candidates.map((c) => `  ${c.path}  (${c.source})`).join('\n')
  throw new Error(
    `eNSP client not found. Looked at:\n${tried}\n\n`
      + 'Pass --exe, set DSH_ENSP_EXE, or configure the plugin, with the full path to eNSP_Client.exe. '
      + 'Installing eNSP to its default location also works.',
  )
}

/**
 * Resolve VBoxManage.
 *
 * @param {string} [override]
 * @returns {{path: string, source: string, tried: string[]}}
 * @throws when nothing exists
 */
export function resolveVBoxManage(override) {
  if (override && !isFile(override)) {
    throw new Error(
      `the VBoxManage path given does not exist: ${override}\n`
        + 'Check the path, or drop --vbox to let the tool search for an installation.',
    )
  }
  const candidates = vboxCandidates(override)
  const hit = firstExisting(candidates)
  if (hit) return { path: hit.path, source: hit.source, tried: candidates.map((c) => c.path) }
  const tried = candidates.map((c) => `  ${c.path}  (${c.source})`).join('\n')
  throw new Error(
    `VBoxManage.exe not found. Looked at:\n${tried}\n\n`
      + 'Pass --vbox, set DSH_VBOX, or add the VirtualBox install directory to PATH.',
  )
}

/**
 * Resolve the eNSP install root, which holds `res/items.xml` and the plugins.
 *
 * Derived from the client path when it can be found, so a machine that launches
 * successfully also has a correct catalogue path.
 *
 * @param {{exe?: string, root?: string}} [options]
 * @returns {string|null}
 */
export function resolveEnspRoot(options = {}) {
  if (options.root && fs.existsSync(options.root)) return options.root
  if (options.exe) return path.dirname(options.exe)
  const hit = firstExisting(enspCandidates())
  return hit ? path.dirname(hit.path) : null
}

/** Non-throwing probe used by `doctor`, which reports instead of raising. */
export function probePaths({ exe, vbox } = {}) {
  const ensp = firstExisting(enspCandidates(exe))
  const box = firstExisting(vboxCandidates(vbox))
  return {
    ensp: ensp ? { ok: true, path: ensp.path, source: ensp.source } : { ok: false, path: null },
    vbox: box ? { ok: true, path: box.path, source: box.source } : { ok: false, path: null },
  }
}
