/**
 * Authoritative interface table for every eNSP model this project supports.
 *
 * This table used to be duplicated: `build.mjs` carried one copy for the topology
 * builder and `topology.mjs` carried another for the serialiser and index maths.
 * The two drifted, and the drift was not cosmetic — the serialiser's copy never
 * learned that firewalls number their ports as `GigabitEthernet1/0/x`, so
 * `ensp_build_topology` refused every `GigabitEthernet1/0/0` a caller passed in.
 * A single table removes that whole class of bug.
 *
 * Group layout is **not** cosmetic either. eNSP rebuilds a device's port list from
 * the `<interface>` elements verbatim; declaring one `count="3"` group on an
 * AR2220 does not expand to GE0/0/0 + GE0/0/1..2, and the device silently fails to
 * render (empty canvas, no error). The groupings below were counted across all 40
 * bundled sample topologies — see `docs/ENSP-FORMAT.md`.
 *
 * Group tuple: `[sztype, interfacename, count, firstNumber, cliPrefix]`.
 *
 * @module dsh-ensp/models
 */

export const MODEL_SPECS = {
  // 24 GE ports in one group, numbering from 1.
  S5700: {
    groups: [['Ethernet', 'GE', 24, 1]],
    base: 1,
    vrp: 'GigabitEthernet0/0/',
    console: true,
  },
  // 22 fast ports (Ethernet0/0/1..22) then 2 gigabit (GE0/0/1..2).
  S3700: {
    groups: [['Ethernet', 'Ethernet', 22, 1], ['Ethernet', 'GE', 2, 1]],
    base: 1,
    vrp: 'Ethernet0/0/',
    console: true,
  },
  // GE0/0/0, then GE0/0/1..2 — the split is required, and the second group starts
  // numbering at 1, not 0.
  AR2220: {
    groups: [['Ethernet', 'GE', 1, 0], ['Ethernet', 'GE', 2, 1]],
    base: 0,
    vrp: 'GigabitEthernet0/0/',
    console: true,
  },
  AR2240: {
    groups: [['Ethernet', 'GE', 4, 0]],
    base: 0,
    vrp: 'GigabitEthernet0/0/',
    console: true,
  },
  // GE0/0/0..1 then Ethernet0/0/0..7 — two CLI families in one slot.
  AR1220: {
    groups: [['Ethernet', 'GE', 2, 0], ['Ethernet', 'Ethernet', 8, 0]],
    base: 0,
    vrp: 'GigabitEthernet0/0/',
    console: true,
  },
  // Firewalls number their CLI ports from 1/0/0 while eNSP stores them from index
  // 0, so the CLI prefix is stated explicitly. Guessing it from the eNSP prefix
  // produces `GigabitEthernet0/0/x` and rejects every real firewall interface.
  USG5500: {
    groups: [['Ethernet', 'GE', 9, 0, 'GigabitEthernet1/0/']],
    base: 0,
    vrp: 'GigabitEthernet1/0/',
    console: true,
  },
  USG6000V: {
    groups: [['Ethernet', 'GE', 9, 0, 'GigabitEthernet1/0/']],
    base: 0,
    vrp: 'GigabitEthernet1/0/',
    console: true,
  },
  AC6005: {
    groups: [['Ethernet', 'GE', 8, 1]],
    base: 1,
    vrp: 'GigabitEthernet0/0/',
    console: true,
  },
  // Lab builds from teaching material (the 18 ICVE topologies) use the legacy
  // `Router` model far more than any AR: 43 of 190 devices. Its port list is two
  // fast Ethernet, four gigabit, four serial ports, and the CLI keeps the same
  // order — verified by booting one and reading `display interface brief`.
  // `Router` and `Client` are `isplugin="0"` in eNSP's items.xml, so they are
  // built in; a machine "missing" them is not out of date.
  Router: {
    groups: [
      ['Ethernet', 'Ethernet', 2, 0, 'Ethernet0/0/'],
      ['Ethernet', 'GE', 4, 0],
      ['Serial', 'Serial', 4, 0, 'Serial0/0/'],
    ],
    base: 0,
    vrp: 'Ethernet0/0/',
    console: true,
  },
  // A web client: one Ethernet port, no console.
  Client: {
    groups: [['Ethernet', 'Ethernet', 1, 0, 'Ethernet0/0/']],
    base: 0,
    vrp: 'Ethernet0/0/',
    console: false,
  },
  // PC and Server declare `interfacename="GE"` in the file but expose
  // `Ethernet0/0/1` on the CLI. eNSP's file vocabulary and VRP's differ here.
  PC: {
    groups: [['Ethernet', 'GE', 1, 1, 'Ethernet0/0/']],
    base: 1,
    vrp: 'Ethernet0/0/',
    console: false,
  },
  Server: {
    groups: [['Ethernet', 'GE', 1, 1, 'Ethernet0/0/']],
    base: 1,
    vrp: 'Ethernet0/0/',
    console: false,
  },
  Cloud: {
    groups: [['Ethernet', 'Ethernet', 3, 0]],
    base: 0,
    vrp: 'Ethernet0/0/',
    console: false,
  },
  // Wireless endpoints: no console, one uplink.
  AP6050: {
    groups: [['Ethernet', 'GE', 2, 1]],
    base: 1,
    vrp: 'GigabitEthernet0/0/',
    console: true,
  },
  STA: { groups: [], base: 0, vrp: '', console: false },
  Laptop: {
    groups: [['Ethernet', 'Ethernet', 1, 1, 'Ethernet0/0/']],
    base: 1,
    vrp: 'Ethernet0/0/',
    console: false,
  },
}

/** Every model name this module knows. */
export const MODEL_NAMES = Object.keys(MODEL_SPECS)

/** Canvas geometry constants, taken from eNSP's own writer. */
export const GEOMETRY = { editLeftOffset: 27, editTopOffset: 54 }

/**
 * Icon bounding box, measured from every cable anchor in eNSP's own samples.
 *
 * The box is **not** centred on (cx, cy): it runs from `cx - 16.2` to
 * `cx + 70.2`, so its centre is `cx + 27`, not `cx + 43`. Using `height / 2`
 * puts the anchor outside the icon and eNSP then discards the whole `<lines>`
 * block, which shows up as an empty canvas with no error.
 *
 * Frequencies across the bundled samples: (+70.2,+27.0) x35, (-16.2,+27.0) x35,
 * (+27.0,+70.2) x29, (+27.0,-16.2) x27.
 */
export const ICON = { w: 86, h: 86, left: -16.2, right: 70.2, top: -16.2, bottom: 70.2 }

/**
 * CLI namespace for one interface group.
 *
 * The eNSP file and VRP disagree in two places: PC/Server store `GE` but expose
 * `Ethernet`, and firewalls store `GE` but number from `GigabitEthernet1/0/`.
 * The model spec states those overrides by position; everything else follows from
 * the declared interface name.
 */
function cliPrefixForGroup(sztype, enspPrefix, model, groupIndex) {
  const override = MODEL_SPECS[model]?.groups?.[groupIndex]?.[4]
  if (override) return override
  if (enspPrefix === 'GE' || sztype === 'GE') return 'GigabitEthernet0/0/'
  if (sztype === 'Serial' || enspPrefix === 'Serial') return 'Serial0/0/'
  return 'Ethernet0/0/'
}

/**
 * Build a port list from a device's own `<interface>` declarations.
 *
 * This matters for labs that add hardware: a stock AR2220 has no serial ports, but
 * a NAT lab in the ICVE corpus mounts a serial card, so flat index 3 is
 * `Serial0/0/0` there and `GigabitEthernet0/0/3` on a stock unit. The file states
 * the real layout, so the file wins over the model table.
 *
 * @param {Array<{sztype: string, name: string, count: number, firstNumber: number|null}>} declarations
 * @param {string} model
 * @returns {string[]} CLI port name per flat index, in declaration order
 */
export function portsFromDeclarations(declarations, model) {
  if (!declarations?.length) return []
  const base = MODEL_SPECS[model]?.base ?? 0
  const ports = []
  declarations.forEach((d, groupIndex) => {
    const first = d.firstNumber ?? base
    const cli = cliPrefixForGroup(d.sztype, d.name, model, groupIndex)
    for (let i = 0; i < d.count; i += 1) ports.push(`${cli}${first + i}`)
  })
  return ports
}

/**
 * Resident interface declarations of a model, as `{sztype, name, count, firstNumber}`.
 *
 * Callers use this when they need to emit the `<interface>` block for a device.
 */
export function declarationsFor(model) {
  return (MODEL_SPECS[model]?.groups ?? []).map(([sztype, name, count, firstNumber]) => ({
    sztype,
    name,
    count,
    firstNumber: firstNumber ?? null,
  }))
}

/** Total declared interface count for a model. */
export function portCount(model) {
  const spec = MODEL_SPECS[model]
  if (!spec) return 0
  return spec.groups.reduce((sum, group) => sum + group[2], 0)
}

/** CLI prefix for an eNSP interface-name group, when the group does not state one. */
export function cliPrefixFor(enspPrefix) {
  return enspPrefix === 'GE' ? 'GigabitEthernet0/0/' : 'Ethernet0/0/'
}

/** Human-readable list of a model's ports, for error messages. */
export function describePorts(model) {
  const spec = MODEL_SPECS[model]
  if (!spec) return '(unknown model)'
  if (!spec.groups.length) return '(no interfaces)'
  return spec.groups
    .map((group) => {
      const [, enspPrefix, count, firstNumber, cliOverride] = group
      const first = firstNumber ?? spec.base
      const cli = cliOverride ?? cliPrefixFor(enspPrefix)
      return `${cli}${first}..${first + count - 1}`
    })
    .join(', ')
}

/**
 * Resolve a VRP interface name to the flat index eNSP stores.
 *
 * The flat index walks every declared group, so on an AR1220 index 2 is the first
 * `Ethernet` port, not `GE0/0/2`.
 *
 * @param {string} model
 * @param {string} port e.g. `GigabitEthernet0/0/1`
 * @returns {number|null}
 */
export function vrpToFlatIndex(model, port) {
  const spec = MODEL_SPECS[model]
  if (!spec) return null

  let offset = 0
  for (const group of spec.groups) {
    const [, enspPrefix, count, firstNumber, cliOverride] = group
    const first = firstNumber ?? spec.base
    const cli = cliOverride ?? cliPrefixFor(enspPrefix)
    if (port.startsWith(cli)) {
      const tail = port.slice(cli.length)
      if (/^\d+$/.test(tail)) {
        const n = Number(tail) - first
        if (n >= 0 && n < count) return offset + n
      }
    }
    offset += count
  }
  return null
}

/**
 * Inverse of {@link vrpToFlatIndex}.
 *
 * @param {string} model
 * @param {number} index
 * @returns {string|null}
 */
export function flatIndexToVrp(model, index) {
  const spec = MODEL_SPECS[model]
  if (!spec) return null

  let remaining = index
  for (const group of spec.groups) {
    const [, enspPrefix, count, firstNumber, cliOverride] = group
    const first = firstNumber ?? spec.base
    const cli = cliOverride ?? cliPrefixFor(enspPrefix)
    if (remaining < count) return `${cli}${remaining + first}`
    remaining -= count
  }
  return null
}
