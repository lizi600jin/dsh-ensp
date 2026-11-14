/**
 * Acceptance checks: what "this lab works" actually means, expressed as facts.
 *
 * A scenario's `steps[].verify` field names a command to look at, which is a
 * hint for a human, not a pass/fail test. This module turns the important ones
 * into assertions: run a command on a device, then decide from the output
 * whether the lab reached the intended state.
 *
 * Assertions are deliberately small and textual:
 *
 *   { contains: 'Full' }        output must contain the literal text
 *   { notContains: 'Init' }     output must not contain it
 *   { matches: /^\\s*Up/m }      output must match the pattern
 *   { minLines: 2 }             output must have at least N non-empty lines
 *
 * Textual checks are honest about their limits: they prove the device reports a
 * state, not that packets flow. Checks that really need packets use `ping` and
 * assert on its summary line, which is the only place VRP reports loss.
 *
 * @module dsh-ensp/acceptance
 */

import { queryDevice } from './provision.mjs'
import { SCENARIOS } from './presets.mjs'
import { readTopology } from './topology.mjs'

/**
 * Per-scenario assertions. `on` is the device name from the blueprint, so a
 * console port can be resolved from the running topology.
 *
 * Only scenarios whose outcome is unambiguous from a single `display` command
 * get curated checks. Everything else falls back to smoke checks built from
 * `steps[].verify` (see `planFor`).
 */
export const EXPECTATIONS = {
  'vlan-access': [
    // `minLines: 3` used to stand here, but a switch that has never been
    // configured already lists VLAN 1, so it passed on a blank device. An
    // untagged member alone is not enough either: every port starts as an
    // untagged member of VLAN 1. What proves the lab is a member of a VLAN other
    // than 1.
    {
      id: 'port-in-configured-vlan',
      on: 'SW1',
      command: 'display vlan',
      expect: { matches: /^(?!\s*1\s)(\d+)\s+common[^\n]*UT:GE\d\/0\/\d+\(U\)/m },
    },
    // `contains: 'U'` matched the table header `U: Up;` and the `UT:` prefix, so
    // it proved nothing either. Two access ports must carry the same non-default
    // VLAN, which is what puts the two PCs in one broadcast domain.
    {
      id: 'access-ports-share-vlan',
      on: 'SW1',
      command: 'display port vlan active',
      expect: { matches: /GE\d\/0\/\d+\s+access\s+(?!1\s)(\d+)[\s\S]{0,600}?GE\d\/0\/\d+\s+access\s+\1/ },
    },
  ],
  'trunk-interconnect': [
    { id: 'trunk-up', on: 'SW1', command: 'display interface brief | include up', expect: { minLines: 2 } },
  ],
  'vlanif-routing': [
    { id: 'vlanif-up', on: 'SW1', command: 'display ip interface brief', expect: { matches: /Vlanif\d+\s+up/ } },
    { id: 'route-present', on: 'SW1', command: 'display ip routing-table', expect: { matches: /\/2[0-9]\s+Static|Direct/ } },
  ],
  'stp-rstp': [
    { id: 'stp-running', on: 'SW1', command: 'display stp brief', expect: { minLines: 2 } },
    { id: 'one-root', on: 'SW1', command: 'display stp brief', expect: { matches: /ROOT/ } },
  ],
  'link-aggregation': [
    { id: 'eth-trunk-up', on: 'SW1', command: 'display eth-trunk', expect: { matches: /Up/ } },
  ],
  'static-route': [
    { id: 'static-in-table', on: 'R1', command: 'display ip routing-table protocol static', expect: { minLines: 2 } },
  ],
  'rip': [
    { id: 'rip-neighbour', on: 'R1', command: 'display rip 1 neighbor', expect: { minLines: 2 } },
    { id: 'rip-route', on: 'R1', command: 'display ip routing-table protocol rip', expect: { minLines: 2 } },
  ],
  'ospf-single': [
    { id: 'neighbour-full', on: 'R1', command: 'display ospf peer brief', expect: { contains: 'Full' } },
    { id: 'ospf-route', on: 'R1', command: 'display ip routing-table protocol ospf', expect: { minLines: 2 } },
  ],
  'ospf-multi-area': [
    { id: 'neighbour-full', on: 'R1', command: 'display ospf peer brief', expect: { contains: 'Full' } },
    { id: 'inter-area-route', on: 'R1', command: 'display ip routing-table protocol ospf', expect: { matches: /OSPF_ASE|OSPF|\/2[0-9]/ } },
  ],
  'ospf-stub-nssa': [
    { id: 'neighbour-full', on: 'R1', command: 'display ospf peer brief', expect: { contains: 'Full' } },
    { id: 'stub-area', on: 'R1', command: 'display ospf brief', expect: { matches: /Stub|NSSA/i } },
  ],
  'bgp-ebgp-ibgp': [
    { id: 'bgp-established', on: 'R1', command: 'display bgp peer', expect: { contains: 'Established' } },
    { id: 'bgp-route', on: 'R1', command: 'display bgp routing-table', expect: { minLines: 3 } },
  ],
  'bgp-route-reflector': [
    { id: 'bgp-established', on: 'RR', command: 'display bgp peer', expect: { contains: 'Established' } },
    { id: 'reflected-route', on: 'RR', command: 'display bgp routing-table', expect: { minLines: 3 } },
  ],
  'dhcp': [
    { id: 'pool-exists', on: 'R1', command: 'display ip pool', expect: { minLines: 2 } },
  ],
  'nat': [
    { id: 'nat-enabled', on: 'R1', command: 'display nat outbound', expect: { matches: /ACL|acl/i } },
  ],
  'acl-filter': [
    { id: 'acl-defined', on: 'R1', command: 'display acl all', expect: { minLines: 2 } },
  ],
  'aaa-local': [
    { id: 'user-exists', on: 'R1', command: 'display aaa local-user', expect: { minLines: 3 } },
  ],
  'isis-multi-level': [
    { id: 'isis-neighbour', on: 'R1', command: 'display isis peer', expect: { contains: 'Up' } },
    { id: 'isis-route', on: 'R1', command: 'display isis route', expect: { minLines: 3 } },
  ],
  'ipv6': [
    { id: 'ipv6-address', on: 'R1', command: 'display ipv6 interface brief', expect: { contains: '2001' } },
    { id: 'ipv6-route', on: 'R1', command: 'display ipv6 routing-table', expect: { minLines: 3 } },
  ],
  'vrrp-basics': [
    // The blueprint is SW1/SW2/ACC/PC1 with SW1 as the master (.252) and SW2 as the
    // backup (.253). These used to say R1/R2, which no longer resolves to anything
    // wrong-looking now that resolveDevice keeps to the same device family, but the
    // right names are the switches themselves.
    { id: 'vrrp-master', on: 'SW1', command: 'display vrrp', expect: { contains: 'Master' } },
    { id: 'vrrp-backup', on: 'SW2', command: 'display vrrp', expect: { contains: 'Backup' } },
  ],
  'ospfv3-ipv6': [
    { id: 'ospfv3-neighbour', on: 'R1', command: 'display ospfv3 peer', expect: { contains: 'Full' } },
  ],
  'multicast-pim-sm': [
    { id: 'pim-neighbour', on: 'R1', command: 'display pim neighbor', expect: { minLines: 2 } },
    { id: 'rp-set', on: 'R1', command: 'display pim rp-info', expect: { minLines: 2 } },
  ],
  'mpls-basic': [
    // The blueprint is four routers R1..R4 with no PE among them, so asking PE1 for
    // its LDP sessions was asking a device that does not exist. LDP runs on every
    // hop here; the first router's peer and session tables are the evidence.
    { id: 'ldp-session', on: 'R1', command: 'display mpls ldp session', expect: { minLines: 2 } },
    { id: 'ldp-peer', on: 'R1', command: 'display mpls ldp peer', expect: { minLines: 2 } },
  ],
  'mpls-l3vpn': [
    { id: 'vpnv4-peer', on: 'PE1', command: 'display bgp vpnv4 all peer', expect: { contains: 'Established' } },
    { id: 'vrf-route', on: 'PE1', command: 'display ip routing-table vpn-instance vpn1', expect: { minLines: 3 } },
  ],
  'stack-istack': [
    { id: 'stack-members', on: 'SW1', command: 'display stack', expect: { minLines: 3 } },
  ],
  'dhcp-snooping': [
    { id: 'snooping-on', on: 'SW1', command: 'display dhcp snooping', expect: { matches: /enable|Enable/ } },
  ],
  'qos-basics': [
    { id: 'qos-policy', on: 'R1', command: 'display traffic policy user-defined', expect: { minLines: 3 } },
  ],
  'port-security': [
    { id: 'port-security-on', on: 'SW1', command: 'display port-security', expect: { matches: /enable|Enable/ } },
  ],
  'super-vlan': [
    { id: 'super-vlan', on: 'SW1', command: 'display vlan', expect: { minLines: 4 } },
  ],
  'network-management': [
    { id: 'snmp-agent', on: 'R1', command: 'display snmp-agent sys-info', expect: { minLines: 2 } },
  ],

  // `ppp-hdlc` was previously smoke only, and the blueprint put the two links on GE
  // ports where `link-protocol ppp` is rejected outright. Both checks below were run
  // against a corrected blueprint on the Router model with real Serial ports.
  'ppp-hdlc': [
    // The Serial ports ship with PPP as their encapsulation, so the HDLC side is the
    // one that changes: blank reads `PPP`, after `link-protocol hdlc` it reads
    // `nonstandard HDLC`.
    { id: 'hdlc-encapsulation', on: 'R1', command: 'display interface Serial0/0/1', expect: { contains: 'nonstandard HDLC' } },
    // CHAP leaves a line in the running configuration; a blank interface has none.
    { id: 'chap-authentication', on: 'R1', command: 'display current-configuration interface Serial0/0/0', expect: { contains: 'ppp authentication-mode chap' } },
  ],

  // `arp-security` on S5700: `display arp anti-attack configuration all` answers with
  // fifty lines whether or not anything is configured, and the only line that changes
  // is the rate-limit switch inside the Global configuration block.
  'arp-security': [
    { id: 'rate-limit-enabled', on: 'SW1', command: 'display arp anti-attack configuration all', expect: { contains: 'arp anti-attack rate-limit enable' } },
  ],

  // `spine-leaf-vxlan` cannot assert its overlay half: eNSP's S5700 answers
  // `Unrecognized command` to `display nve`, `display bridge-domain` and
  // `display vxlan vni`, and there is no `it does not support VXLAN` to configure.
  // The underlay half does work, so these three check that instead.
  'spine-leaf-vxlan': [
    { id: 'underlay-ospf', on: 'LEAF1', command: 'display ospf brief', expect: { contains: 'OSPF Process' } },
    // A blank switch has no LoopBack0 at all and answers `Wrong parameter`.
    { id: 'vtep-loopback', on: 'LEAF1', command: 'display interface LoopBack0', expect: { contains: 'current state' } },
    // A blank switch reports one VLAN; any leaf carrying a tenant segment reports more.
    { id: 'tenant-vlans', on: 'LEAF1', command: 'display vlan', expect: { notContains: 'The total number of vlans is : 1' } },
  ],

  // The scenarios below used to fall through to smoke checks, which reported a pass
  // without reading anything. Every assertion here was picked by running its command
  // twice on a real device of the same model, once blank and once after configuring
  // that feature, and keeping only the ones that fail on the blank run and pass on
  // the configured one. A `contains` aimed at a table header fails that test and was
  // dropped unless the header itself only appears once the feature exists.
  //
  // What these prove is that the feature was configured. They do not prove that
  // neighbours converged, which needs the whole topology up and is what the curated
  // scenarios with `Established` or `Full` assertions check.
  'mstp-load-balance': [
    // A blank switch reports the revision level as 0 and its region name as its own
    // MAC, so both readings survive a wrong answer unless the default is excluded.
    { id: 'region-configured', on: 'CORE1', command: 'display stp region-configuration', expect: { matches: /Revision level\s*:\s*[1-9]/ } },
    // A blank switch answers `Info: No instance information is available.`; mapping
    // VLANs to instances replaces that with the instance table.
    { id: 'instance-mapped', on: 'CORE1', command: 'display stp instance 1 brief', expect: { notContains: 'No instance information' } },
    // The blank table has a header and no rows. A forwarding port is a row.
    { id: 'port-forwarding', on: 'CORE1', command: 'display stp brief', expect: { contains: 'FORWARDING' } },
  ],
  'port-isolation': [
    // Blank: the command answers with nothing but its own echo. Configured: it lists
    // the ports carrying `port-isolate enable`.
    { id: 'isolate-group', on: 'SW1', command: 'display port-isolate group all', expect: { contains: 'isolate group' } },
  ],
  'ospf-lsa-types': [
    { id: 'process-running', on: 'R1', command: 'display ospf brief', expect: { contains: 'OSPF Process' } },
    { id: 'lsdb-present', on: 'R1', command: 'display ospf lsdb', expect: { contains: 'Link State Database' } },
  ],
  'ospf-virtual-link': [
    { id: 'process-running', on: 'R1', command: 'display ospf brief', expect: { contains: 'OSPF Process' } },
  ],
  'ospf-troubleshooting': [
    // A peer pair appears here as soon as both sides are configured, whatever state
    // it is in. `Full` would need the whole lab up, which this scenario is about
    // diagnosing rather than reaching.
    { id: 'peer-discovered', on: 'R1', command: 'display ospf peer', expect: { contains: 'Router ID' } },
    { id: 'interface-in-area', on: 'R1', command: 'display ospf interface', expect: { contains: 'Area:' } },
  ],
  'bgp-attributes': [
    { id: 'peer-configured', on: 'R1', command: 'display bgp peer', expect: { contains: 'Local AS number' } },
  ],
  'bgp-aggregation': [
    { id: 'peer-configured', on: 'R1', command: 'display bgp peer', expect: { contains: 'Local AS number' } },
  ],
  'bgp-troubleshooting': [
    { id: 'peer-configured', on: 'R1', command: 'display bgp peer', expect: { contains: 'Local AS number' } },
    { id: 'peer-detail', on: 'R1', command: 'display bgp peer verbose', expect: { contains: 'BGP Peer is' } },
  ],
  'route-policy-pbr': [
    { id: 'prefix-list', on: 'R1', command: 'display ip ip-prefix', expect: { contains: 'Prefix-list' } },
    { id: 'route-policy', on: 'R1', command: 'display route-policy', expect: { contains: 'Route-policy' } },
  ],
  'ipsec-vpn': [
    { id: 'policy-defined', on: 'R1', command: 'display ipsec policy', expect: { contains: 'IPSec policy' } },
  ],
  'bfd-fast-convergence': [
    { id: 'session-configured', on: 'R1', command: 'display bfd session all', expect: { contains: 'PeerIpAddr' } },
    { id: 'session-detail', on: 'R1', command: 'display bfd session all verbose', expect: { contains: 'Session MIndex' } },
  ],
  'dual-homed-isp': [
    { id: 'bfd-configured', on: 'R1', command: 'display bfd session all', expect: { contains: 'PeerIpAddr' } },
  ],
  'ipsec-gre-tunnel': [
    { id: 'ospf-peer', on: 'R1', command: 'display ospf peer', expect: { contains: 'Router ID' } },
  ],
  // The AC ships with no capwap source, which reads `Source interface : -`. Pointing
  // it at a Vlanif is the first real step of both WLAN scenarios and the only
  // reading here that differs before and after.
  'wlan-basic': [
    { id: 'capwap-source', on: 'AC', command: 'display capwap configuration', expect: { matches: /Source interface\s*:\s*vlanif/i } },
  ],
  'wlan-roaming': [
    { id: 'capwap-source', on: 'AC', command: 'display capwap configuration', expect: { matches: /Source interface\s*:\s*vlanif/i } },
  ],

  // The campus scenario needs a USG6000V for its edge firewall, which this machine
  // does not have, so its full lab cannot be built here. Its switches can be, and
  // the two checks below were measured on a pair of S5700s the same way as the rest:
  // blank first, then after configuring that feature. The VRRP check gates on the
  // group existing rather than on its state, because a single configured router
  // stays in Initialize until a peer answers.
  'campus-network': [
    // A blank switch reports one VLAN; a core carrying the user segments reports more.
    { id: 'user-vlans', on: 'CORE1', command: 'display vlan', expect: { notContains: 'The total number of vlans is : 1' } },
    // A blank switch answers `Info: No VRRP backup group is configured with a virtual IPv4 address.`
    { id: 'gateway-vrrp', on: 'CORE1', command: 'display vrrp', expect: { contains: 'Master IP' } },
  ],
}

/** Longest useful slice of a command's output kept for a report. */
const SNIPPET = 400

/** A line that is nothing but a VRP prompt, in whatever view the device sits. */
const PROMPT_ONLY = /^[<\[][\w~./:-]*[>\]]$/

/**
 * Strip what the console always echoes back, so assertions see device data only.
 *
 * A reply for a command that printed nothing is the command itself followed by
 * the prompt. Counting lines without removing those two made `minLines: 2`
 * satisfied by silence, which is how thirteen curated checks came to pass on a
 * router nobody had configured.
 *
 * @param {string} output raw reply from the console
 * @param {string} [command] the command that produced it
 * @returns {string}
 */
export function withoutEcho(output, command) {
  const lines = String(output || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
  while (lines.length && lines[0].trim() === '') lines.shift()
  if (command && lines.length && lines[0].trim() === command.trim()) lines.shift()
  while (lines.length && (lines[lines.length - 1].trim() === '' || PROMPT_ONLY.test(lines[lines.length - 1].trim()))) {
    lines.pop()
  }
  return lines.join('\n')
}

/**
 * Decide one assertion against a command's output.
 *
 * An empty `expect` means nobody wrote an assertion, which is not the same thing
 * as a passing one. It returns `pass: null` so a report can say "unverified"
 * instead of counting it as a success.
 *
 * @param {string} output raw reply from the console
 * @param {object} [expect]
 * @param {string} [command] the command that produced the output, used to drop its echo
 * @returns {{pass: boolean|null, asserted: boolean, why: string}}
 */
export function evaluateAssertion(output, expect = {}, command) {
  const text = withoutEcho(output, command)
  const checks = []
  if (expect.contains !== undefined) {
    checks.push({ ok: text.includes(expect.contains), why: `contains "${expect.contains}"` })
  }
  if (expect.notContains !== undefined) {
    checks.push({ ok: !text.includes(expect.notContains), why: `does not contain "${expect.notContains}"` })
  }
  if (expect.matches !== undefined) {
    const re = expect.matches instanceof RegExp ? expect.matches : new RegExp(expect.matches, 'm')
    checks.push({ ok: re.test(text), why: `matches ${re}` })
  }
  if (expect.minLines !== undefined) {
    const n = text.split('\n').filter((l) => l.trim()).length
    checks.push({ ok: n >= expect.minLines, why: `at least ${expect.minLines} non-empty lines (got ${n})` })
  }
  if (!checks.length) {
    return { pass: null, asserted: false, why: 'no assertion: this command only had to run' }
  }
  const failed = checks.filter((c) => !c.ok)
  return {
    pass: failed.length === 0,
    asserted: true,
    why: (failed.length ? failed : checks).map((c) => (c.ok ? '' : 'not ') + c.why).join('; '),
  }
}

/**
 * Resolve a curated check's device name against the devices that actually exist.
 *
 * Curated plans name devices the way the shipped blueprints do: R1, R2, R3. A lab
 * built from somebody else's topology calls them RA/RB/RC, LSW1/LSW2, or anything
 * at all, so a name that is not there gets mapped onto the device playing the same
 * role: same leading letters, position taken from the trailing number.
 *
 * The mapping is deliberately restricted to devices of the same kind. An earlier
 * version fell back to plain position, which turned `R1` into `ACC` on a lab whose
 * switches are SW1/SW2/ACC/PC1 and then reported the result as a passing check of
 * the VRRP master. When no device of that kind exists the name is returned
 * unchanged so the caller reports a missing device instead of a wrong one.
 */
export function resolveDevice(on, available = []) {
  const names = [...available].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  if (!names.length) return on
  if (names.includes(on)) return on
  const prefix = /^[A-Za-z]+/.exec(on)?.[0]?.toUpperCase()
  const family = prefix ? names.filter((n) => n.toUpperCase().startsWith(prefix)) : []
  if (!family.length) return on
  const numbered = /(\d+)$/.exec(on)
  const index = numbered ? Math.max(0, Number(numbered[1]) - 1) : 0
  return family[Math.min(index, family.length - 1)]
}

/**
 * Build the acceptance plan for a scenario.
 *
 * Curated expectations win. Otherwise the scenario's `steps[].verify` commands
 * become smoke checks: the command has to run without a VRP error. Smoke checks
 * carry `asserted: false` because no output pattern was written for them, so a
 * report can count them separately instead of calling them passes.
 */
export function planFor(id, { devices } = {}) {
  const scenario = SCENARIOS[id]
  if (!scenario) throw new Error(`unknown scenario: ${id}`)
  const curated = EXPECTATIONS[id]
  if (curated && curated.length) {
    return {
      scenario: id,
      title: scenario.title,
      source: 'curated',
      checks: curated.map((c) => ({ ...c, on: resolveDevice(c.on, devices), kind: 'assert', asserted: true })),
    }
  }
  // A scenario's `devices` field is prose ("3~4 台路由器"), never device names, so
  // without a running topology there is nobody to run the command against. Leave
  // `on` undefined and let the runner report that instead of inventing a name.
  const first = devices && devices.length ? devices[0] : undefined
  // Several steps put two commands in one verify string separated by " / ". Slashes
  // inside an interface name are part of the command, so only a slash surrounded by
  // spaces is a separator. Dedupe after splitting, because two different steps can
  // both end up asking for the same command.
  const commands = [
    ...new Set(
      (scenario.steps || [])
        .map((s) => s.verify)
        .filter(Boolean)
        .flatMap((raw) =>
          String(raw)
            .split(/\s+\/\s+/)
            .map((c) => c.trim())
            .filter(Boolean),
        ),
    ),
  ]
  const checks = commands.map((command, i) => ({
    id: `smoke-${i + 1}`,
    on: first,
    command,
    kind: 'smoke',
    asserted: false,
    expect: {},
  }))
  return { scenario: id, title: scenario.title, source: 'smoke', checks }
}

/** Does this scenario have curated (strict) assertions rather than smoke checks? */
export function hasChecks(id) {
  return Boolean(EXPECTATIONS[id] && EXPECTATIONS[id].length)
}

/** Map device name → console port from a parsed topology. */
export function consolePorts(topology) {
  const map = new Map()
  for (const d of topology?.devices ?? []) {
    if (d.comPort) map.set(d.name, Number(d.comPort))
  }
  return map
}

/**
 * Run a scenario's acceptance plan against a live lab.
 *
 * @param {object} options
 * @param {string} options.id            scenario id
 * @param {string} [options.topology]    path to the running .topo (for ports)
 * @param {Map<string,number>} [options.ports] explicit device → port map
 * @param {number} [options.timeoutMs]   per-command timeout
 * @param {number} [options.waitMs]      how long a failing assertion may keep being retried
 * @param {number} [options.intervalMs]  delay between those retries
 * @param {Function} [options.query]     override the console query (tests)
 * @param {Function} [options.onProgress]
 */
export async function runAcceptance(options = {}) {
  const { id, topology, timeoutMs = 25000, waitMs = 60000, intervalMs = 3000, onProgress } = options
  // Injectable so the convergence loop can be tested without a live lab.
  const query = options.query ?? queryDevice
  let ports = options.ports
  let parsed
  if (!ports) {
    if (!topology) throw new Error('runAcceptance needs either a topology path or a ports map')
    parsed = await readTopology(topology)
    ports = consolePorts(parsed)
  }
  const plan = planFor(id, { devices: parsed ? [...ports.keys()] : [...(ports?.keys() ?? [])] })
  const results = []
  for (const check of plan.checks) {
    const port = check.on === undefined ? undefined : ports.get(check.on)
    onProgress?.({ phase: 'check', id: check.id, device: check.on })
    if (!port) {
      results.push({
        ...check,
        device: check.on,
        pass: false,
        why:
          check.on === undefined
            ? 'no device to run this on: the plan was built without a topology'
            : `no console port for device "${check.on}"`,
        snippet: '',
      })
      continue
    }
    let res
    try {
      res = await query({ port, command: check.command, timeoutMs })
    } catch (err) {
      results.push({ ...check, device: check.on, pass: false, why: `command failed: ${err.message}`, snippet: '' })
      continue
    }
    const output = res?.output || ''
    // A console that never opened is a different failure from a command that ran and
    // printed the wrong thing. Saying "not contains Full" when nothing answered sends
    // the reader looking at OSPF instead of at the device that is not running.
    const unreachable = res?.ok === false
    const errored = /(^|\n)\s*(Error|Unrecognized command|Incomplete command|Wrong parameter|Too many parameters)/.test(output)
    let verdict = unreachable
      ? { pass: false, asserted: true, why: `console unreachable: ${res.error || 'no answer'}` }
      : errored
        ? { pass: false, asserted: true, why: 'VRP rejected the command' }
        : evaluateAssertion(output, check.expect, check.command)

    // Routing protocols converge after the command returns, not before it. A single
    // snapshot taken two seconds after `ensp apply` reports "not contains Full" for a
    // session that reaches Full ten seconds later, which reads as a broken lab. Retry
    // the assertion itself, never a rejected command and never a dead console, and
    // never a check that had no assertion to start with.
    let waited = 0
    let lastOutput = output
    while (verdict.pass === false && !unreachable && !errored && waited < waitMs) {
      onProgress?.({ phase: 'retry', id: check.id, device: check.on, waited, why: verdict.why })
      const nap = Math.min(intervalMs, waitMs - waited)
      await new Promise((r) => setTimeout(r, nap))
      waited += nap
      let again
      try {
        again = await query({ port, command: check.command, timeoutMs })
      } catch (err) {
        verdict = { pass: false, asserted: true, why: `command failed: ${err.message}` }
        break
      }
      if (again?.ok === false) {
        verdict = { pass: false, asserted: true, why: `console unreachable: ${again.error || 'no answer'}` }
        break
      }
      lastOutput = again?.output || ''
      verdict = evaluateAssertion(lastOutput, check.expect, check.command)
    }
    results.push({
      ...check,
      device: check.on,
      pass: verdict.pass,
      asserted: verdict.asserted,
      why: verdict.why,
      waitedMs: waited,
      snippet: lastOutput.trim().slice(0, SNIPPET),
    })
  }
  const failed = results.filter((r) => r.pass === false)
  const unverified = results.filter((r) => r.pass === null)
  return {
    scenario: plan.scenario,
    title: plan.title,
    source: plan.source,
    // `ok` answers "did anything contradict the intended state". A lab that was
    // never asserted against did not contradict it, but it was not verified either,
    // so it reports null rather than a green light.
    ok: failed.length ? false : unverified.length ? null : true,
    verified: results.length - unverified.length,
    unverified: unverified.length,
    total: results.length,
    passed: results.length - failed.length - unverified.length,
    failed: failed.length,
    results,
  }
}

/** Render an acceptance report for a terminal. */
export function formatAcceptance(report) {
  const lines = [`${report.scenario} · ${report.title}`, `(${report.source} checks)`]
  for (const r of report.results) {
    const mark = r.pass === true ? 'pass' : r.pass === null ? 'skip' : 'FAIL'
    lines.push(
      `[${mark}] ${r.id} on ${r.on}: ${r.command}` +
        (r.pass === true && r.waitedMs ? ` (converged after ${Math.round(r.waitedMs / 1000)}s)` : '') +
        (r.pass === true ? '' : `\n         ${r.why}`) +
        (process.env.ENSP_VERBOSE && r.snippet ? `\n         ${r.snippet.replace(/\n/g, '\n         ')}` : ''),
    )
  }
  lines.push('')
  if (report.ok === true) {
    lines.push(`accepted: ${report.passed}/${report.total} checks passed`)
  } else if (report.ok === false) {
    lines.push(`rejected: ${report.failed}/${report.total} checks failed`)
  } else {
    lines.push(
      `unverified: ${report.unverified}/${report.total} checks had no assertion, ` +
        `${report.passed} passed. Nothing contradicted the expected state, but no output was checked either.`,
    )
  }
  return lines.join('\n')
}
