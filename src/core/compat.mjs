/**
 * Device availability checks.
 *
 * Some eNSP models are only stubs in the device catalogue: the entry exists, you
 * can drop it on the canvas and save the topology, but the vendor image behind it
 * is not installed. Placing one is not a soft failure — **the client opens the
 * topology, paints it, and then exits by itself**, so the launch looks successful
 * for a few seconds and everything downstream fails with a confusing
 * "console never answered".
 *
 * That is exactly what happens here with `USG6000V`: `res/items.xml` declares it
 * as `<executable isplugin="1" path="ngfw\ngfw_Plugin.dll"/>`, the plugin DLL is
 * present, and `plugin/ngfw/DataBase/` is empty — the `.vdi` the plugin's VirtualBox
 * template points at was never installed. `USG5500` is retired outright
 * ("eNSP don't maintained this device any more, just keep it.") and has no image
 * either.
 *
 * Rather than guess, this module reads the catalogue and checks the files each
 * plugin model actually needs, so a topology can be rejected *before* the client is
 * started.
 *
 * @module dsh-ensp/compat
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { resolveEnspRoot } from './paths.mjs'

/** Last-resort install root, used only when nothing on this machine can be found. */
export const DEFAULT_ENSP_ROOT = 'E:\\Huawei\\eNSP'

/**
 * Human wording for a plugin model whose image is missing.
 *
 * The *paths* are never taken from here: they are read out of the VirtualBox
 * templates that ship with the installation, so a machine that keeps eNSP
 * somewhere else still gets the right answer. The relative path below is only a
 * name to print in the message, and the reason text is what the user reads.
 */
const PLUGIN_ASSETS = {
  USG6000V: {
    rel: 'plugin/ngfw/DataBase/vfw_usg.vdi',
    why: 'NGFW 镜像未安装（eNSP 安装时需勾选 USG6000V 组件）',
  },
}

/** Models the vendor has withdrawn; usable only if an image happens to exist. */
const RETIRED = {
  USG5500: 'eNSP 已停止维护 USG5500，安装包不再附带镜像，请改用 USG6000V',
}

/**
 * Static notes about devices that need an extra image, for documentation.
 *
 * Kept independent of the local installation so generated docs say the same thing
 * on every machine; `probeDevice` is the machine-specific check.
 */
export const IMAGE_NOTES = {
  USG6000V:
    '需要 eNSP 安装时勾选 USG6000V 组件（NGFW 镜像，约 1 GB）。缺镜像时 eNSP 会打开拓扑后自行退出，' +
    '`ensp up` 会在启动前直接报错说明缺什么。',
  USG5500: 'eNSP 已停止维护该机型，安装包不再附带镜像，建议改用 USG6000V。',
}

/**
 * Device notes for a list of models, as `[model, note]` pairs.
 *
 * @param {string[]} models
 * @returns {Array<[string, string]>}
 */
export function imageNotesFor(models) {
  return [...new Set(models)].filter((m) => IMAGE_NOTES[m]).map((m) => [m, IMAGE_NOTES[m]])
}

/** `<HardDisk ... location="...">` inside a VirtualBox machine template. */
const MEDIA_TAG = /<HardDisk\b[^>]*\blocation="([^"]+)"/g

const TEMPLATE_EXT = new Set(['.vbox', '.xml'])

const mediaCache = new Map()

/**
 * Every file a plugin model's VirtualBox template points at, as absolute paths.
 *
 * The plugin models (NE40E, NE5000E, NE9000, CX, CE6800, CE12800, USG6000V) each
 * ship a VirtualBox machine template whose `<HardDisk location="...">` is relative
 * to that template. The disk itself lives in a `Database` directory next to the
 * plugin, but the exact spelling (`Database` vs `DataBase`) and the number of `..`
 * differ per plugin, so the path is read out of the template every time instead of
 * being reconstructed. A machine that installed eNSP somewhere else therefore gets
 * the same answer as this one.
 *
 * Templates under a `backup` directory are ignored: they are stale copies kept by
 * the vendor, and one of them (`vfw_usg_for_vbox4.0`) points at a layout no current
 * installation has.
 *
 * @param {string} model
 * @param {{root?: string}} [options]
 * @returns {string[]} absolute media paths, empty when the model has no template
 */
export function pluginMediaFiles(model, options = {}) {
  const root = options.root ?? resolveEnspRoot() ?? DEFAULT_ENSP_ROOT
  const entry = readCatalogue(root).get(model)
  if (!entry?.plugin || !entry.pluginPath) return []

  const key = `${root}\u0000${entry.pluginPath}`
  if (mediaCache.has(key)) return mediaCache.get(key)

  const dll = path.join(root, 'plugin', entry.pluginPath.split('\\').join('/'))
  const found = []
  for (const template of templatesUnder(path.dirname(dll))) {
    let xml = ''
    try {
      xml = readFileSync(template, 'utf8')
    } catch {
      continue
    }
    for (const m of xml.matchAll(MEDIA_TAG)) {
      found.push(path.resolve(path.dirname(template), m[1]))
    }
  }

  const unique = [...new Set(found)]
  mediaCache.set(key, unique)
  return unique
}

/**
 * Collect `.vbox` / `.xml` templates below `dir`, skipping vendor backups.
 *
 * @param {string} dir
 * @returns {string[]}
 */
function templatesUnder(dir) {
  const out = []
  const walk = (current) => {
    let entries = []
    try {
      entries = readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === 'backup') continue
        walk(full)
      } else if (TEMPLATE_EXT.has(path.extname(entry.name).toLowerCase())) {
        out.push(full)
      }
    }
  }
  walk(dir)
  return out
}

const cache = new Map()

/**
 * Parse `res/items.xml` into `{ model: { plugin, pluginPath, needRegister } }`.
 *
 * @param {string} root eNSP install directory
 * @returns {Map<string, {plugin: boolean, pluginPath: string, needRegister: boolean}>}
 */
function readCatalogue(root) {
  const file = path.join(root, 'res', 'items.xml')
  if (cache.has(file)) return cache.get(file)

  const table = new Map()
  let xml = ''
  try {
    xml = readFileSync(file, 'utf8')
  } catch {
    cache.set(file, table)
    return table
  }

  for (const m of xml.matchAll(/<model name="([^"]+)">([\s\S]*?)<\/model>/g)) {
    const body = m[2]
    const exe = /<executable isplugin="(\d)" path="([^"]*)"/.exec(body)
    const reg = /<needRegister>(\d+)<\/needRegister>/.exec(body)
    table.set(m[1], {
      plugin: exe ? exe[1] === '1' : false,
      pluginPath: exe ? exe[2] : '',
      needRegister: reg ? reg[1] === '1' : false,
    })
  }
  cache.set(file, table)
  return table
}

/**
 * Derive the install root from an explicit executable path.
 *
 * Falls back to the resolved install root, then to the historical default, so a
 * caller that has no path at hand still gets a usable directory rather than
 * silently reading the wrong catalogue.
 */
export function rootFromExe(exe) {
  if (exe) return path.dirname(exe)
  return resolveEnspRoot() ?? DEFAULT_ENSP_ROOT
}

/**
 * Can this model actually be started on this machine?
 *
 * `root` defaults to the installation found on this machine, not to a fixed
 * path. A hardcoded `E:\Huawei\eNSP` made every check on a machine with a
 * normal install read the wrong catalogue and look for device images that
 * were never there, so a correctly installed USG6000V was reported missing.
 *
 * @param {string} model
 * @param {{root?: string}} [options]
 * @returns {{model: string, available: boolean, reason?: string}}
 */
export function probeDevice(model, options = {}) {
  const root = options.root ?? resolveEnspRoot() ?? DEFAULT_ENSP_ROOT
  const entry = readCatalogue(root).get(model)

  if (entry?.plugin && entry.pluginPath) {
    const dll = path.join(root, 'plugin', entry.pluginPath.split('\\').join('/'))
    if (!existsSync(dll)) {
      return { model, available: false, reason: `插件缺失：${path.relative(root, dll)}` }
    }
  }

  // Checked before the catalogue entry on purpose: the assets a model needs are a
  // property of the model, not of the catalogue file. A machine with no eNSP
  // installed at all still cannot start a USG6000V, and answering "available"
  // because items.xml was unreadable would be the exact false negative this module
  // exists to prevent.
  const note = PLUGIN_ASSETS[model]
  if (note) {
    // Fall back to the documented relative path when no template survives, so an
    // installation whose template was deleted but whose image is in place still
    // starts instead of being blocked on a missing file that is right there.
    const media = pluginMediaFiles(model, { root })
    const candidates = media.length ? media : [path.join(root, note.rel)]
    if (!candidates.some((file) => existsSync(file))) {
      return { model, available: false, reason: note.why, missing: note.rel }
    }
  } else if (entry?.plugin) {
    // Every other plugin model is judged the same way, from its own template. Only
    // the wording differs, because there is no hand-written sentence for it.
    const media = pluginMediaFiles(model, { root })
    if (media.length && !media.some((file) => existsSync(file))) {
      const named = media.map((file) => path.relative(root, file)).join(', ')
      return {
        model,
        available: false,
        reason: `设备镜像未安装：缺少 ${named}`,
        missing: named,
      }
    }
  }

  if (RETIRED[model] && !hasAnyImage(root, model)) {
    return { model, available: false, reason: RETIRED[model] }
  }

  // Unknown models are the caller's problem (a topology naming them is a different
  // error), so stay permissive rather than blocking every lab on a stale catalogue.
  return { model, available: true }
}

/**
 * Does any VirtualBox image under the eNSP tree look like it belongs to `model`?
 *
 * Used only for retired models, where the catalogue says nothing about the image.
 *
 * @param {string} root
 * @param {string} model
 */
function hasAnyImage(root, model) {
  const stem = model.toLowerCase()
  const candidates = [
    path.join(root, 'vboxserver'),
    path.join(root, 'plugin'),
  ]
  for (const dir of candidates) {
    if (!existsSync(dir)) continue
    if (existsSync(path.join(dir, stem))) return true
  }
  return false
}

/**
 * Check every device in a parsed topology.
 *
 * @param {{devices: Array<{name: string, model: string}>}} topo
 * @param {{root?: string}} [options]
 * @returns {{ok: boolean, blocked: Array<{name: string, model: string, reason: string}>, checked: string[]}}
 */
export function checkTopologySupport(topo, options = {}) {
  const blocked = []
  for (const device of topo.devices ?? []) {
    const result = probeDevice(device.model, options)
    if (!result.available) {
      blocked.push({ name: device.name, model: device.model, reason: result.reason })
    }
  }
  return {
    ok: blocked.length === 0,
    blocked,
    checked: [...new Set((topo.devices ?? []).map((d) => d.model))].sort(),
  }
}

/**
 * Build the error text for a blocked topology.
 *
 * Names the device, the model and what is missing, then says what to do. Repeated
 * models are grouped so a five-firewall lab prints one explanation, not five.
 *
 * @param {{blocked: Array<{name: string, model: string, reason: string}>}} report
 * @returns {string}
 */
export function describeBlocked(report) {
  const byModel = new Map()
  for (const item of report.blocked) {
    const group = byModel.get(item.model) ?? { reason: item.reason, names: [] }
    group.names.push(item.name)
    byModel.set(item.model, group)
  }
  const lines = [...byModel].map(
    ([model, { reason, names }]) => `  ${model} (${names.join(', ')}): ${reason}`,
  )
  return (
    'topology uses devices this eNSP installation cannot start:\n' +
    lines.join('\n') +
    '\n\nThis is not a bug in the topology: eNSP opens it, renders it, then quits. ' +
    'Install the missing device image in eNSP (工具 → 注册设备, or reinstall eNSP with ' +
    'the device component selected), or remove those devices from the topology.'
  )
}

/** Forget cached catalogue and template reads (tests, and after installing a device image). */
export function clearCatalogueCache() {
  cache.clear()
  mediaCache.clear()
}

/**
 * Every plugin model this installation knows about, sorted.
 *
 * Read out of `res/items.xml`, so it grows and shrinks with the installation
 * instead of being a list maintained here.
 *
 * @param {{root?: string}} [options]
 * @returns {string[]}
 */
export function pluginModels(options = {}) {
  const root = options.root ?? resolveEnspRoot() ?? DEFAULT_ENSP_ROOT
  return [...readCatalogue(root)]
    .filter(([, entry]) => entry.plugin && entry.pluginPath)
    .map(([model]) => model)
    .sort()
}

/**
 * What a plugin model needs on disk, and what of that is actually there.
 *
 * `media` is derived from the model's own VirtualBox template, so the answer holds
 * on any machine regardless of where eNSP is installed. `target` is where an image
 * has to go if one is missing: the first path the template names.
 *
 * @param {string} model
 * @param {{root?: string}} [options]
 * @returns {{model: string, plugin: boolean, target: string|null,
 *   media: Array<{path: string, present: boolean, relative: string}>, ready: boolean}}
 */
export function pluginMediaPlan(model, options = {}) {
  const root = options.root ?? resolveEnspRoot() ?? DEFAULT_ENSP_ROOT
  const entry = readCatalogue(root).get(model)
  const template = pluginMediaFiles(model, { root })
  const media = template.map((file) => ({
    path: file,
    relative: path.relative(root, file),
    present: existsSync(file),
  }))
  return {
    model,
    plugin: Boolean(entry?.plugin),
    target: media.length ? media[0].path : null,
    media,
    ready: media.some((item) => item.present),
  }
}

/**
 * Put a device image where this machine's eNSP expects it.
 *
 * The destination is not passed in: it is the path the model's VirtualBox template
 * already points at, which is the only place the emulator will look. Copying
 * elsewhere and hoping is how people end up with a firewall that opens a topology
 * and then quits. The plugin's `system.ini` is updated as well when it has an
 * `ImgFile` line, because that is what the plugin reads for single-image models.
 *
 * @param {string} model
 * @param {string} source image file to install
 * @param {{root?: string, overwrite?: boolean}} [options]
 * @returns {{model: string, target: string, bytes: number, iniUpdated: boolean}}
 */
export function installPluginMedia(model, source, options = {}) {
  const root = options.root ?? resolveEnspRoot() ?? DEFAULT_ENSP_ROOT
  if (!existsSync(source)) throw new Error(`the image file does not exist: ${source}`)

  const plan = pluginMediaPlan(model, { root })
  if (!plan.plugin) throw new Error(`${model} is not a plugin model in this eNSP installation`)
  if (!plan.target) {
    throw new Error(
      `${model} has no VirtualBox template under ${root}, so there is nowhere to put an image. ` +
        'The installation looks incomplete; reinstall eNSP.',
    )
  }
  if (plan.ready && !options.overwrite) {
    return { model, target: plan.target, bytes: 0, iniUpdated: false }
  }

  mkdirSync(path.dirname(plan.target), { recursive: true })
  copyFileSync(source, plan.target)

  // `<plugin>/System/system.ini` carries `ImgFile =` for the plugins that boot a
  // single image, and an empty value there is why a correctly placed image can
  // still leave the device unusable.
  const iniUpdated = updateImgFile(path.join(root, 'plugin', pluginDir(plan.target, root) ?? '', 'System', 'system.ini'), path.basename(plan.target))

  mediaCache.clear()
  cache.clear()
  return { model, target: plan.target, bytes: statSync(plan.target).size, iniUpdated }
}

/** The plugin directory an image sits under (`plugin/<name>/...`), or null. */
function pluginDir(file, root) {
  const relative = path.relative(path.join(root, 'plugin'), file)
  if (relative.startsWith('..')) return null
  return relative.split(path.sep)[0]
}

/**
 * Point `ImgFile` in a plugin `system.ini` at a file that now exists.
 *
 * Left alone when the file or the key is absent: some plugin versions do not use
 * it, and inventing a section would be worse than doing nothing.
 *
 * @param {string} ini
 * @param {string} value
 * @returns {boolean} whether the file was changed
 */
function updateImgFile(ini, value) {
  if (!ini || !existsSync(ini)) return false
  let text = ''
  try {
    text = readFileSync(ini, 'utf8')
  } catch {
    return false
  }
  if (!/^ImgFile\s*=/m.test(text)) return false
  const next = text.replace(/^ImgFile\s*=.*$/m, `ImgFile = ${value}`)
  if (next === text) return false
  try {
    writeFileSync(ini, next)
    return true
  } catch {
    return false
  }
}
