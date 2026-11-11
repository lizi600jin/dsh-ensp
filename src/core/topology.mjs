/**
 * eNSP `.topo` reader/writer.
 *
 * The format is a flat XML document that eNSP itself writes, with three parts
 * that matter to us:
 *
 *   <devices>  one <dev> per device: name, model, com_port, canvas position
 *   <lines>    one <line> per cable, each holding an <interfacePair>
 *   <shapes>   purely decorative annotations
 *
 * Two field quirks were established by experiment and are load-bearing:
 *
 * - `edit_left` / `edit_top` are derived, not independent: `edit_left = cx + 27`
 *   and `edit_top = cy + 54`. Writing them consistently is what keeps a
 *   generated file openable instead of corrupt.
 * - Interface indices inside `<interfacePair>` are **flat indices over the
 *   slot's declared interface list**, starting at 0, not `a/b/c` strings. A
 *   model declares `count` interfaces in `<slot>` order and the index walks that
 *   list, which is why this module carries a port table per model.
 *
 * @module dsh-ensp/topology
 */

import { readFile, writeFile } from 'node:fs/promises'

import {
  MODEL_SPECS,
  GEOMETRY,
  portCount,
  portsFromDeclarations,
  flatIndexToVrp,
  vrpToFlatIndex,
} from './models.mjs'

/**
 * Icon bounding box, measured from every cable anchor in eNSP's own samples.
 *
 * The box is **not** centred on (cx, cy): it runs from `cx - 16.2` to
 * `cx + 70.2` horizontally, so its centre is `cx + 27`, not `cx + 43`. Using
 * `height / 2` puts the anchor outside the icon and eNSP then rejects the whole
 * `<lines>` block, which shows up as an empty canvas with no error message.
 *
 * Frequencies across the bundled samples: (+70.2,+27.0) x35, (-16.2,+27.0) x35,
 * (+27.0,+70.2) x29, (+27.0,-16.2) x27.
 */
const ICON = {
  left: -16.2,
  right: 70.2,
  top: -16.2,
  bottom: 70.2,
  centerX: 27.0,
  centerY: 27.0,
}

/**
 * Resolve a flat interface index into a VRP interface name for a model.
 *
 * Thin wrapper over {@link flatIndexToVrp} so the parsing code and the builder
 * share one table.
 *
 * @param {string} model
 * @param {number} index
 * @returns {string|null}
 */
export function interfaceName(model, index) {
  return flatIndexToVrp(model, index)
}

/**
 * Inverse of {@link interfaceName}.
 *
 * @param {string} model
 * @param {string} name
 * @returns {number|null} flat index, or null when the name does not belong to the model
 */
export function interfaceIndex(model, name) {
  return vrpToFlatIndex(model, name)
}

/** Decode one attribute from a tag's raw text. */
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`))
  return m ? m[1] : null
}

/**
 * Parse a `.topo` document.
 *
 * @param {string} xml
 * @returns {{version: string|null, devices: Array<{
 *   id: string, name: string, model: string, comPort: number|null,
 *   bootmode: number, x: number, y: number, interfaces: number }>,
 *   links: Array<{srcId: string, dstId: string, srcIndex: number, dstIndex: number,
 *   media: string, srcName: string, dstName: string, srcPort: string|null, dstPort: string|null}>}}
 */
export function parseTopology(xml) {
  const version = attr(xml.match(/<topo[^>]*>/)?.[0] ?? '', 'version')

  const devices = []
  const portsById = new Map()
  for (const m of xml.matchAll(/<dev\b([^>]*)>([\s\S]*?)<\/dev>/g)) {
    const head = m[1]
    const body = m[2]
    const model = attr(head, 'model')
    // The device's own <interface> block is the authoritative port layout: a lab
    // can mount extra cards (a serial card on an AR2220, for instance), and then
    // the flat indices no longer match the stock model table.
    const declarations = [...body.matchAll(/<interface\b([^>]*)\/?>/g)].map((decl) => {
      const tag = decl[1]
      const firstNumber = attr(tag, 'firstnumber')
      return {
        sztype: attr(tag, 'sztype') ?? 'Ethernet',
        name: attr(tag, 'interfacename') ?? 'GE',
        count: Number(attr(tag, 'count') ?? 0),
        firstNumber: firstNumber === null ? null : Number(firstNumber),
      }
    })
    const declared = declarations.reduce((sum, x) => sum + x.count, 0)
    const ports = portsFromDeclarations(declarations, model)
    const id = attr(head, 'id')
    if (id) portsById.set(id, ports)
    devices.push({
      id,
      name: attr(head, 'name'),
      model,
      comPort: Number(attr(head, 'com_port') ?? 0) || null,
      bootmode: Number(attr(head, 'bootmode') ?? 0),
      x: Number(attr(head, 'cx') ?? 0),
      y: Number(attr(head, 'cy') ?? 0),
      interfaces: declared || portCount(model),
    })
  }

  const byId = new Map(devices.map((d) => [d.id, d]))
  const links = []
  for (const m of xml.matchAll(/<line\b([^>]*)>([\s\S]*?)<\/line>/g)) {
    const head = m[1]
    const body = m[2]
    const pair = body.match(/<interfacePair\b([^>]*)>/)?.[1] ?? ''
    const srcId = attr(head, 'srcDeviceID')
    const dstId = attr(head, 'destDeviceID')
    const src = byId.get(srcId)
    const dst = byId.get(dstId)
    const srcIndex = Number(attr(pair, 'srcIndex') ?? 0)
    const dstIndex = Number(attr(pair, 'tarIndex') ?? 0)
    links.push({
      srcId,
      dstId,
      srcIndex,
      dstIndex,
      media: attr(pair, 'lineName') ?? 'Copper',
      srcName: src?.name ?? null,
      dstName: dst?.name ?? null,
      srcPort: src ? (portsById.get(srcId)?.[srcIndex] ?? interfaceName(src.model, srcIndex)) : null,
      dstPort: dst ? (portsById.get(dstId)?.[dstIndex] ?? interfaceName(dst.model, dstIndex)) : null,
    })
  }

  return { version, devices, links }
}

/**
 * Read and parse a `.topo` file.
 *
 * eNSP writes a UTF-8 file while its XML declaration says `encoding="UNICODE"`,
 * so we ignore the declaration and decode as UTF-8, stripping a BOM if present.
 *
 * @param {string} file
 */
export async function readTopology(file) {
  const raw = await readFile(file)
  const text = raw.toString('utf8').replace(/^\uFEFF/, '')
  return { ...parseTopology(text), file }
}

/**
 * Build the `<devices>` block exactly as eNSP writes it.
 *
 * Attribute order matters for byte-level diffing against native files, and
 * `system_mac` must be absent (native files only include it for a few models).
 */
function renderDevices(devices) {
  const rows = devices.map((d) => {
    const spec = MODEL_SPECS[d.model] ?? { groups: [['Ethernet', 'GE', 24]] }
    const editLeft = Math.round(d.x + GEOMETRY.editLeftOffset)
    const editTop = Math.round(d.y + GEOMETRY.editTopOffset)
    const settings = d.settings ?? ''
    const interfaces = spec.groups
      .map(([sztype, name, count]) =>
        `                <interface sztype="${sztype}" interfacename="${name}" count="${count}" />`)
      .join('\n')
    return (
      `        <dev id="${d.id}" name="${d.name}" model="${d.model}" settings="${settings}" ` +
      `com_port="${d.comPort ?? 0}" bootmode="${d.bootmode ?? 1}" ` +
      `cx="${d.x.toFixed(6)}" cy="${d.y.toFixed(6)}" ` +
      `edit_left="${editLeft}" edit_top="${editTop}">\n` +
      `            <slot number="slot17" isMainBoard="1">\n` +
      `${interfaces}\n` +
      `            </slot>\n` +
      `        </dev>`
    )
  })
  return `    <devices>\n${rows.join('\n')}\n    </devices>`
}

/**
 * Serialise a topology back to `.topo` XML.
 *
 * Cable anchors must sit on the device icon's bounding box, which eNSP computes as
 * a fixed offset from the device's canvas position. Putting them anywhere else
 * makes eNSP draw the link from the wrong point (or drop it).
 *
 * @param {{devices: Array<object>, links: Array<object>}} topo
 * @returns {string}
 */
export function serialiseTopology(topo) {
  const byId = new Map(topo.devices.map((d) => [d.id, d]))

  const lines = topo.links.map((l) => {
    const src = byId.get(l.srcId)
    const dst = byId.get(l.dstId)
    if (!src || !dst) throw new Error(`link references unknown device: ${l.srcId} -> ${l.dstId}`)

    // Anchor on the facing sides: right edge of the source, left edge of the target,
    // both at the icon's true vertical centre.
    const sx = src.x + ICON.right
    const sy = src.y + ICON.centerY
    const tx = dst.x + ICON.left
    const ty = dst.y + ICON.centerY

    return (
      `        <line srcDeviceID="${src.id}" destDeviceID="${dst.id}">\n` +
      `            <interfacePair lineName="${l.media ?? 'Copper'}" ` +
      `srcIndex="${l.srcIndex}" srcBoundRectIsMoved="0" ` +
      `srcBoundRect_X="${sx.toFixed(6)}" srcBoundRect_Y="${sy.toFixed(6)}" ` +
      `srcOffset_X="0.000000" srcOffset_Y="0.000000" ` +
      `tarIndex="${l.dstIndex}" tarBoundRectIsMoved="0" ` +
      `tarBoundRect_X="${tx.toFixed(6)}" tarBoundRect_Y="${ty.toFixed(6)}" ` +
      `tarOffset_X="0.000000" tarOffset_Y="0.000000" />\n` +
      `        </line>`
    )
  })

  return (
    `<?xml version="1.0" encoding="UNICODE" ?>\n` +
    `<topo version="1.2.00.390">\n` +
    `${renderDevices(topo.devices)}\n` +
    `    <lines>\n${lines.join('\n')}\n    </lines>\n` +
    `    <shapes />\n` +
    `    <txttips />\n` +
    `</topo>\n`
  )
}

/**
 * Write a topology to disk.
 * @param {string} file
 * @param {object} topo
 */
export async function writeTopology(file, topo) {
  await writeFile(file, serialiseTopology(topo), 'utf8')
  return file
}

/**
 * Summarise a topology for display: device count, link count, console map.
 *
 * @param {{devices: Array<object>, links: Array<object>}} topo
 */
export function summarise(topo) {
  return {
    devices: topo.devices.length,
    links: topo.links.length,
    consoles: Object.fromEntries(
      topo.devices.filter((d) => d.comPort).map((d) => [d.name, d.comPort]),
    ),
    byModel: topo.devices.reduce((acc, d) => {
      acc[d.model] = (acc[d.model] ?? 0) + 1
      return acc
    }, {}),
  }
}
