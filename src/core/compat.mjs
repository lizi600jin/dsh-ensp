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

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

import { resolveEnspRoot } from './paths.mjs'

/** Default install root; override with `DSH_ENSP_EXE`'s directory or the `root` option. */
export const DEFAULT_ENSP_ROOT = 'E:\\Huawei\\eNSP'

/**
 * Files a plugin device needs beyond its catalogue entry.
 *
 * `USG6000V`'s VirtualBox template (`plugin/ngfw/tools/ngfw/vfw_usg_for_vbox5.0.vbox`)
 * carries `<HardDisk ... location="../../DataBase/vfw_usg.vdi"/>`, which resolves to
 * `plugin/ngfw/DataBase/vfw_usg.vdi` relative to that template.
 */
const PLUGIN_ASSETS = {
  USG6000V: [
    {
      rel: 'plugin/ngfw/DataBase/vfw_usg.vdi',
      why: 'NGFW 镜像未安装（eNSP 安装时需勾选 USG6000V 组件）',
    },
  ],
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
 * @param {string} model
 * @param {{root?: string}} [options]
 * @returns {{model: string, available: boolean, reason?: string}}
 */
export function probeDevice(model, options = {}) {
  const root = options.root ?? DEFAULT_ENSP_ROOT
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
  for (const asset of PLUGIN_ASSETS[model] ?? []) {
    if (!existsSync(path.join(root, asset.rel))) {
      return { model, available: false, reason: asset.why }
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

/** Forget cached catalogue reads (tests, and after installing a device image). */
export function clearCatalogueCache() {
  cache.clear()
}
