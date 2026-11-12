/**
 * Topology construction helpers.
 *
 * Building a `.topo` by hand is error-prone because eNSP validates a surprising
 * amount of derived state on load. The rules below were reverse-engineered from
 * files eNSP itself wrote and confirmed by opening generated topologies
 * (`docs/UI-ANCHORS.md` records the surrounding experiments):
 *
 * | Rule | Value |
 * |---|---|
 * | XML declaration | says `encoding="UNICODE"`, file is actually UTF-8 |
 * | `edit_left` / `edit_top` | `cx + 27` / `cy + 54` |
 * | attribute order | `id name model settings com_port bootmode cx cy edit_left edit_top` |
 * | switch interfaces | one slot, `interfacename="GE"`, index base 1 |
 * | PC / Server interfaces | `interfacename="Ethernet"`, index base 1 |
 * | router / firewall interfaces | `interfacename="GE"`, index base 0 |
 * | cable anchors | on the icon's bounding box: `x-16.2` / `x+70.2`, `y-16.2` / `y+70.2` |
 *
 * Two mistakes cost real debugging time and are called out in the code:
 * declaring PC interfaces as `GE` (eNSP silently renders an empty canvas) and
 * omitting `system_mac` handling (the attribute is absent from native files).
 *
 * @module dsh-ensp/build
 */

import { randomUUID } from 'node:crypto'

import {
  MODEL_SPECS,
  ICON,
  describePorts,
  vrpToFlatIndex,
} from './models.mjs'
import { serialiseTopology } from './topology.mjs'

// Re-exported so callers that only need the table plus the builder keep one
// import. The authoritative definitions live in models.mjs.
export { MODEL_SPECS, ICON, vrpToFlatIndex, flatIndexToVrp } from './models.mjs'

/**
 * `settings` blob eNSP writes for a simulated PC. Empty for every other model.
 * Without it eNSP still shows the PC but with no address, which breaks the
 * "ping between the two PCs" step.
 */
function pcSettings({ ip = '192.168.10.1', mask = '255.255.255.0', gateway = '192.168.10.254', mac, dhcp = false } = {}) {
  const macAddr = mac ?? `54-89-98-${Array.from({ length: 3 }, () =>
    Math.floor(Math.random() * 256).toString(16).toUpperCase().padStart(2, '0')).join('-')}`
  // A DHCP client must not carry a static address, or eNSP keeps using it and the
  // pool is never exercised. -simpc_dhcp_state 1 is what makes the PC ask.
  const addressing = dhcp
    ? ' -simpc_ip 0.0.0.0  -simpc_mask 0.0.0.0  -simpc_gateway 0.0.0.0'
    : ` -simpc_ip ${ip}  -simpc_mask ${mask}  -simpc_gateway ${gateway}`
  return (
    `${addressing}  -simpc_mac ${macAddr}` +
    '  -simpc_mc_dstip 0.0.0.0  -simpc_mc_dstmac 00-00-00-00-00-00' +
    '  -simpc_dns1 0.0.0.0  -simpc_dns2 0.0.0.0' +
    '  -simpc_ipv6 ::  -simpc_prefix 128  -simpc_gatewayv6 ::' +
    `  -simpc_dhcp_state ${dhcp ? 1 : 0}  -simpc_dhcpv6_state 0  -simpc_dns_auto_state 0 `
  )
}

/**
 * Fluent topology builder.
 */
export class TopologyBuilder {
  #devices = []
  #links = []
  #nextComPort

  constructor({ firstComPort = 2000 } = {}) {
    this.#nextComPort = firstComPort
  }

  /**
   * Add a device.
   *
   * @param {string} name
   * @param {string} model - key of {@link MODEL_SPECS}
   * @param {{x?: number, y?: number, comPort?: number|null, bootmode?: number,
   *   pc?: {ip?: string, mask?: string, gateway?: string, mac?: string}}} [options]
   */
  add(name, model, options = {}) {
    const spec = MODEL_SPECS[model]
    if (!spec) throw new Error(`unknown model "${model}"; known: ${Object.keys(MODEL_SPECS).join(', ')}`)
    if (this.#devices.some((d) => d.name === name)) throw new Error(`duplicate device name "${name}"`)

    const comPort =
      options.comPort !== undefined
        ? options.comPort
        : spec.console
          ? this.#nextComPort++
          : 0

    this.#devices.push({
      id: randomUUID(),
      name,
      model,
      settings: model === 'PC' ? pcSettings(options.pc).trim() : '',
      comPort,
      bootmode: options.bootmode ?? 1,
      x: options.x ?? 100,
      y: options.y ?? 100,
    })
    return this
  }

  /**
   * Connect two devices using **VRP interface names** (what you type on the CLI).
   *
   * @param {string} aName
   * @param {string} aPort e.g. `GigabitEthernet0/0/1` or `Ethernet0/0/1`
   * @param {string} bName
   * @param {string} bPort
   * @param {{media?: string}} [options]
   */
  link(aName, aPort, bName, bPort, options = {}) {
    const a = this.#devices.find((d) => d.name === aName)
    const b = this.#devices.find((d) => d.name === bName)
    if (!a) throw new Error(`no device "${aName}"`)
    if (!b) throw new Error(`no device "${bName}"`)

    const ai = this.#vrpToIndex(a, aPort)
    const bi = this.#vrpToIndex(b, bPort)

    this.#links.push({
      srcId: a.id,
      dstId: b.id,
      srcIndex: ai,
      dstIndex: bi,
      media: options.media ?? 'Copper',
    })
    return this
  }

  /** Map a VRP interface name to the flat slot index eNSP stores. */
  #vrpToIndex(device, port) {
    const spec = MODEL_SPECS[device.model]
    if (!spec) throw new Error(`unknown model "${device.model}"`)
    const index = vrpToFlatIndex(device.model, port)
    if (index === null) {
      // Firewalls and PCs override the CLI family, so the shared helper is the
      // only reliable way to describe what this model actually accepts.
      const all = describePorts(device.model)
      throw new Error(
        `${device.name} (${device.model}) has no interface ${port}; expected one of: ${all}`,
      )
    }
    return index
  }

  finish() {
    return {
      devices: this.#devices.map((d) => ({ ...d })),
      links: this.#links.map((l) => ({ ...l })),
    }
  }

  toXml() {
    return serialiseTopology(this.finish())
  }
}

/** Start a builder. */
export function buildTopology(options) {
  return new TopologyBuilder(options)
}

/**
 * Deterministic grid layout.
 * @param {object} topo
 */
export function autoLayout(topo, { columns = 4, paddingX = 220, paddingY = 200, originX = 120, originY = 80 } = {}) {
  topo.devices.forEach((device, i) => {
    device.x = originX + (i % columns) * paddingX
    device.y = originY + Math.floor(i / columns) * paddingY
  })
  return topo
}

/**
 * Two PCs on one Layer-2 switch — the smallest lab that proves the whole chain
 * (generate → open → boot → configure → verify).
 *
 * @param {{vlan?: number, subnet?: string}} [options]
 */
export function twoPcLab({ vlan = 10, subnet = '192.168.10' } = {}) {
  const topo = buildTopology({ firstComPort: 2000 })
    .add('SW1', 'S5700', { x: 300, y: 120 })
    .add('PC1', 'PC', { x: 180, y: 320, pc: { ip: `${subnet}.1`, gateway: `${subnet}.254` } })
    .add('PC2', 'PC', { x: 420, y: 320, pc: { ip: `${subnet}.2`, gateway: `${subnet}.254` } })
    .link('PC1', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/1')
    .link('PC2', 'Ethernet0/0/1', 'SW1', 'GigabitEthernet0/0/2')
    .finish()

  topo.meta = { vlan, subnet, pc1: `${subnet}.1`, pc2: `${subnet}.2` }
  return topo
}

/**
 * Switch configuration for {@link twoPcLab}: both ports into one VLAN, plus the
 * matching Vlanif.
 *
 * The Vlanif is not decoration. `twoPcLab` gives both PCs a gateway, so a lab
 * without a Vlanif is a lab whose PCs cannot reach their own gateway, and any
 * follow-up command that assumes the interface exists (`interface Vlanif10`)
 * fails with "The VLAN does not exist". Creating the VLAN alone does not create
 * its interface; VRP only does that when asked.
 *
 * @param {{vlan?: number, subnet?: string}} [options]
 */
export function twoPcLabConfig({ vlan = 10, subnet = '192.168.10' } = {}) {
  return [
    'system-view',
    `vlan ${vlan}`,
    ' quit',
    `interface Vlanif${vlan}`,
    ` ip address ${subnet}.254 255.255.255.0`,
    ' quit',
    'interface GigabitEthernet0/0/1',
    ' port link-type access',
    ` port default vlan ${vlan}`,
    ' quit',
    'interface GigabitEthernet0/0/2',
    ' port link-type access',
    ` port default vlan ${vlan}`,
    ' quit',
    'return',
  ].join('\n')
}
