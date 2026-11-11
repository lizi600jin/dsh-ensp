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
    { id: 'vlans-exist', on: 'SW1', command: 'display vlan', expect: { minLines: 3 } },
    { id: 'port-in-vlan', on: 'SW1', command: 'display port vlan active', expect: { contains: 'U' } },
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
    { id: 'vrrp-master', on: 'R1', command: 'display vrrp', expect: { contains: 'Master' } },
    { id: 'vrrp-backup', on: 'R2', command: 'display vrrp', expect: { contains: 'Backup' } },
  ],
  'ospfv3-ipv6': [
    { id: 'ospfv3-neighbour', on: 'R1', command: 'display ospfv3 peer', expect: { contains: 'Full' } },
  ],
  'multicast-pim-sm': [
    { id: 'pim-neighbour', on: 'R1', command: 'display pim neighbor', expect: { minLines: 2 } },
    { id: 'rp-set', on: 'R1', command: 'display pim rp-info', expect: { minLines: 2 } },
  ],
  'mpls-basic': [
    { id: 'mpls-enabled', on: 'PE1', command: 'display mpls ldp session', expect: { minLines: 2 } },
    { id: 'ldp-peer', on: 'PE1', command: 'display mpls ldp peer', expect: { minLines: 2 } },
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
}

/** Longest useful slice of a command's output kept for a report. */
const SNIPPET = 400

/**
 * Decide one assertion against a command's output.
 * @returns {{pass: boolean, why: string}}
 */
export function evaluateAssertion(output, expect = {}) {
  const text = String(output || '')
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
  if (!checks.length) return { pass: true, why: 'no assertion (command must merely succeed)' }
  const failed = checks.filter((c) => !c.ok)
  return {
    pass: failed.length === 0,
    why: (failed.length ? failed : checks).map((c) => (c.ok ? '' : 'not ') + c.why).join('; '),
  }
}

/**
 * Resolve a curated check's device name against the devices that actually exist.
 *
 * Curated plans name devices the way the shipped blueprints do: R1, R2, R3. A lab
 * built from somebody else's topology calls them RA/RB/RC, LSW1/LSW2, or anything
 * at all. Reporting `no console port for device "R1"` on a healthy lab is worse
 * than useless, so fall back to the device that plays the same role: the number in
 * the name picks the position (R1 first, R2 second), and a name without a number
 * picks the first console device.
 */
export function resolveDevice(on, available = []) {
  const names = [...available].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  if (!names.length) return on
  if (names.includes(on)) return on
  const numbered = /(\d+)$/.exec(on)
  const index = numbered ? Math.max(0, Number(numbered[1]) - 1) : 0
  return names[Math.min(index, names.length - 1)]
}

/**
 * Build the acceptance plan for a scenario.
 *
 * Curated expectations win. Otherwise the scenario's `steps[].verify` commands
 * become smoke checks: the command has to run without a VRP error, which still
 * catches a lab that was never configured.
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
      checks: curated.map((c) => ({ ...c, on: resolveDevice(c.on, devices), kind: 'assert' })),
    }
  }
  const first = (devices && devices.length && devices[0]) || scenario.devices?.split(/[、,，\s]+/)[0]
  const commands = [...new Set((scenario.steps || []).map((s) => s.verify).filter(Boolean))]
  const checks = commands.flatMap((raw) =>
    String(raw)
      .split('/')
      .map((c) => c.trim())
      .filter(Boolean)
      .map((command, i) => ({
        id: `smoke-${i + 1}`,
        on: first,
        command,
        kind: 'smoke',
        expect: {},
      })),
  )
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
    const port = ports.get(check.on)
    onProgress?.({ phase: 'check', id: check.id, device: check.on })
    if (!port) {
      results.push({
        ...check,
        device: check.on,
        pass: false,
        why: `no console port for device "${check.on}"`,
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
      ? { pass: false, why: `console unreachable: ${res.error || 'no answer'}` }
      : errored
        ? { pass: false, why: 'VRP rejected the command' }
        : evaluateAssertion(output, check.expect)

    // Routing protocols converge after the command returns, not before it. A single
    // snapshot taken two seconds after `ensp apply` reports "not contains Full" for a
    // session that reaches Full ten seconds later, which reads as a broken lab. Retry
    // the assertion itself, never a rejected command and never a dead console.
    let waited = 0
    let lastOutput = output
    while (!verdict.pass && !unreachable && !errored && waited < waitMs) {
      onProgress?.({ phase: 'retry', id: check.id, device: check.on, waited, why: verdict.why })
      const nap = Math.min(intervalMs, waitMs - waited)
      await new Promise((r) => setTimeout(r, nap))
      waited += nap
      let again
      try {
        again = await query({ port, command: check.command, timeoutMs })
      } catch (err) {
        verdict = { pass: false, why: `command failed: ${err.message}` }
        break
      }
      if (again?.ok === false) {
        verdict = { pass: false, why: `console unreachable: ${again.error || 'no answer'}` }
        break
      }
      lastOutput = again?.output || ''
      verdict = evaluateAssertion(lastOutput, check.expect)
    }
    results.push({
      ...check,
      device: check.on,
      pass: verdict.pass,
      why: verdict.why,
      waitedMs: waited,
      snippet: lastOutput.trim().slice(0, SNIPPET),
    })
  }
  const failed = results.filter((r) => !r.pass)
  return {
    scenario: plan.scenario,
    title: plan.title,
    source: plan.source,
    ok: failed.length === 0,
    total: results.length,
    passed: results.length - failed.length,
    results,
  }
}

/** Render an acceptance report for a terminal. */
export function formatAcceptance(report) {
  const lines = [`${report.scenario} — ${report.title}`, `(${report.source} checks)`]
  for (const r of report.results) {
    lines.push(
      `[${r.pass ? 'pass' : 'FAIL'}] ${r.id} on ${r.on}: ${r.command}` +
        (r.pass && r.waitedMs ? ` (converged after ${Math.round(r.waitedMs / 1000)}s)` : '') +
        (r.pass ? '' : `\n         ${r.why}`) +
        (process.env.ENSP_VERBOSE && r.snippet ? `\n         ${r.snippet.replace(/\n/g, '\n         ')}` : ''),
    )
  }
  lines.push('')
  lines.push(
    report.ok
      ? `accepted: ${report.passed}/${report.total} checks passed`
      : `rejected: ${report.total - report.passed}/${report.total} checks failed`,
  )
  return lines.join('\n')
}
