/**
 * Machine usable configuration derived from a lab blueprint.
 *
 * A blueprint already carries the addressing plan: which device, which port,
 * which address. That table was written for a reader to copy from. This module
 * turns the same table into a VRP script so `ensp` can apply it without a human
 * retyping sixteen interface blocks.
 *
 * The scope is deliberately the addressing plan and nothing else. Routing
 * protocols, ACLs, VRRP groups and the rest stay in the scenario steps: those
 * are what the exercise is about, and inventing a canonical answer for them
 * would turn the skeleton into a paste-ready dump, which is the one thing the
 * presets are built to avoid.
 *
 * @module dsh-ensp/labconfig
 */

import { LABS } from './labs.mjs'

/**
 * Turn the blueprint addressing table into one VRP script per device.
 *
 * @param {string} id scenario id
 * @returns {{device: string, script: string, interfaces: number}[]}
 */
export function labConfigs(id) {
  const spec = LABS[id]
  if (!spec) return []

  /** @type {Map<string, string[]>} */
  const byDevice = new Map()
  for (const row of spec.addressing ?? []) {
    const commands = byDevice.get(row.device) ?? []
    // Interface names go in verbatim: the blueprint stores them exactly as the
    // CLI accepts them (`LoopBack0`, `Vlanif10`, `GigabitEthernet0/0/1`).
    commands.push(`interface ${row.port}`, ` ${addressCommand(row.ip)}`, ' quit')
    byDevice.set(row.device, commands)
  }

  return [...byDevice].map(([device, body]) => {
    const script = ['system-view', ...body, 'return'].join('\n')
    return { device, script, interfaces: body.length / 3 }
  })
}

/**
 * One script per scenario, devices separated by a comment line.
 *
 * @param {string} id
 * @returns {string} empty when the blueprint has no addressing plan
 */
export function labConfigScript(id) {
  return labConfigs(id)
    .map((entry) => [`# ${entry.device}`, entry.script].join('\n'))
    .join('\n\n')
}

/** Whether this scenario has any addressing to apply. */
export function hasLabConfig(id) {
  return (LABS[id]?.addressing?.length ?? 0) > 0
}

/** How many blueprints carry an addressing plan. */
export function countLabConfigs() {
  return Object.keys(LABS).filter((id) => hasLabConfig(id)).length
}

/**
 * Prefix length to a dotted mask.
 *
 * @param {number} bits
 * @returns {string}
 */
export function maskFromPrefix(bits) {
  // `0xffffffff << 32` is `0xffffffff << 0` in JavaScript, because the shift
  // count is taken modulo 32, so /0 has to be answered before the shift.
  if (bits === 0) return '0.0.0.0'
  const value = (0xffffffff << (32 - bits)) >>> 0
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join('.')
}

/**
 * One `ip address` (or `ipv6 address`) command for a CIDR row.
 *
 * @param {string} cidr e.g. `10.0.12.1/24` or `2001:db8:12::1/64`
 * @returns {string}
 */
export function addressCommand(cidr) {
  const at = String(cidr).lastIndexOf('/')
  if (at < 0) throw new Error(`addressing row "${cidr}" has no prefix length`)
  const address = cidr.slice(0, at)
  const bits = Number(cidr.slice(at + 1))
  if (!Number.isInteger(bits) || bits < 0 || bits > 128) {
    throw new Error(`addressing row "${cidr}" has a prefix that is not a number`)
  }
  if (address.includes(':')) return `ipv6 address ${address}/${bits}`
  return `ip address ${address} ${maskFromPrefix(bits)}`
}
