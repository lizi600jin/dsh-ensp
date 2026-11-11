/**
 * Regression tests for the pieces that were actually broken during development.
 *
 * These are deliberately narrow: each case corresponds to a real failure that cost
 * debugging time, so a future refactor cannot silently reintroduce it.
 *
 * Run with `npm test` (node:test, no dependencies).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { viewOf, hostnameOf, hasPagerMarker } from '../src/core/console.mjs'
import { parseScript } from '../src/core/provision.mjs'
import {
  interfaceName,
  interfaceIndex,
  parseTopology,
  serialiseTopology,
} from '../src/core/topology.mjs'
import { buildTopology, twoPcLab, MODEL_SPECS, vrpToFlatIndex } from '../src/core/build.mjs'
import { planFor, resolveDevice, hasChecks } from '../src/core/acceptance.mjs'

test('viewOf: hostnames containing hyphens are still system view', () => {
  // Real failure: `[R1-TEST]` was classified as a sub-view because it contains a
  // dash, so the driver tried to `quit` out of system view and corrupted the batch.
  assert.equal(viewOf('<R1>'), 'user')
  assert.equal(viewOf('[R1]'), 'system')
  assert.equal(viewOf('[R1-TEST]'), 'system')
  assert.equal(viewOf('[R1-GigabitEthernet0/0/1]'), 'sub')
  assert.equal(viewOf('[R1-TEST-GigabitEthernet0/0/1]'), 'sub')
  assert.equal(viewOf('[Huawei]'), 'system')
  assert.equal(viewOf('[Huawei-acl-adv-3000]'), 'sub')
  assert.equal(viewOf('[R1-ospf-1]'), 'sub')
  assert.equal(viewOf(null), null)
})

test('viewOf: a known hostname disambiguates first-segment matches', () => {
  assert.equal(viewOf('[R1-TEST]', 'R1-TEST'), 'system')
  assert.equal(viewOf('[R1-TEST-GigabitEthernet0/0/1]', 'R1-TEST'), 'sub')
})

test('hostnameOf extracts the device name from any prompt', () => {
  assert.equal(hostnameOf('<R1>'), 'R1')
  assert.equal(hostnameOf('[R1]'), 'R1')
  assert.equal(hostnameOf('[R1-GigabitEthernet0/0/1]'), 'R1')
  assert.equal(hostnameOf('[Huawei-acl-adv-3000]'), 'Huawei')
})

test('parseScript skips comments and blanks but keeps line numbers', () => {
  const script = ['! header', 'system-view', '', '# hash comment', ' vlan 10 ', ' quit'].join('\n')
  assert.deepEqual(parseScript(script), [
    { line: 2, command: 'system-view' },
    { line: 5, command: 'vlan 10' },
    { line: 6, command: 'quit' },
  ])
})

test('interfaceName/interfaceIndex round-trip per model', () => {
  for (const [model, spec] of Object.entries(MODEL_SPECS)) {
    for (let i = 0; i < Math.min(spec.count, 8); i++) {
      const name = `${spec.vrp}${i + spec.base}`
      assert.equal(interfaceName(model, i), name, `${model} index ${i}`)
      assert.equal(interfaceIndex(model, name), i, `${model} ${name}`)
    }
  }
})

test('PC declares GE in the file while its CLI port is Ethernet0/0/1', () => {
  // Established by surveying all 40 bundled eNSP samples: a PC's `<interface>`
  // says `interfacename="GE"` (8/8 files), yet the CLI port is Ethernet0/0/1.
  // The file vocabulary and the VRP vocabulary differ for this model.
  const topo = buildTopology().add('PC1', 'PC', { x: 10, y: 10 }).finish()
  const out = serialiseTopology(topo)
  assert.match(out, /model="PC"/)
  assert.match(out, /interfacename="GE" count="1"/)
  // …but a link to the PC must resolve to the Ethernet CLI name.
  assert.equal(vrpToFlatIndex('PC', 'Ethernet0/0/1'), 0)
  assert.equal(vrpToFlatIndex('PC', 'GigabitEthernet0/0/1'), null)
})

test('AR2220 needs two interface groups so GE0/0/1..2 exist', () => {
  // A single count="3" makes eNSP render an empty canvas with no error.
  const topo = buildTopology().add('R1', 'AR2220', { x: 10, y: 10 }).finish()
  const out = serialiseTopology(topo)
  assert.match(out, /interfacename="GE" count="1"/)
  assert.match(out, /interfacename="GE" count="2"/)
  assert.doesNotMatch(out, /interfacename="GE" count="3"/)
})

test('flat interface indices follow the surveyed per-model mapping', () => {
  const cases = [
    ['S5700', 'GigabitEthernet0/0/1', 0],
    ['S5700', 'GigabitEthernet0/0/24', 23],
    ['AR2220', 'GigabitEthernet0/0/0', 0],
    ['AR2220', 'GigabitEthernet0/0/2', 2],
    ['AR1220', 'GigabitEthernet0/0/1', 1],
    ['AR1220', 'Ethernet0/0/0', 2],
    ['AR1220', 'Ethernet0/0/7', 9],
    ['PC', 'Ethernet0/0/1', 0],
  ]
  for (const [model, port, expected] of cases) {
    assert.equal(vrpToFlatIndex(model, port), expected, `${model} ${port}`)
  }
})

test('serialiseTopology emits eNSP-compatible structure', () => {
  const topo = twoPcLab({ vlan: 10, subnet: '192.168.10' })
  const out = serialiseTopology(topo)

  assert.match(out, /^<\?xml version="1\.0" encoding="UNICODE" \?>/)
  assert.match(out, /<topo version="1\.2\.00\.390">/)
  // Native files use self-closing empty elements.
  assert.match(out, /<shapes \/>/)
  assert.match(out, /<txttips \/>/)
  // Attribute order must match eNSP's writer for clean diffs.
  assert.match(
    out,
    /<dev id="[^"]+" name="SW1" model="S5700" settings="" com_port="2000" bootmode="1" cx="300\.000000" cy="120\.000000" edit_left="327" edit_top="174">/,
  )
  // edit_left = cx + 27, edit_top = cy + 54.
  assert.match(out, /cx="300\.000000" cy="120\.000000" edit_left="327" edit_top="174"/)
})

test('cable anchors use the icon box measured from eNSP samples', () => {
  // The icon box is not centred on (cx, cy): it spans cx-16.2 .. cx+70.2 and
  // cy-16.2 .. cy+70.2, so its centre is (cx+27, cy+27). Using height/2 (+43)
  // places anchors outside the icon; eNSP then drops the entire <lines> block and
  // renders an empty canvas with no error.
  const topo = twoPcLab()
  const out = serialiseTopology(topo)

  // PC1 at (180,320): right edge = 180 + 70.2, centre = 320 + 27.
  assert.match(out, /srcBoundRect_X="250\.200000" srcBoundRect_Y="347\.000000"/)
  // SW1 at (300,120): left edge = 300 - 16.2, centre = 120 + 27.
  assert.match(out, /tarBoundRect_X="283\.800000" tarBoundRect_Y="147\.000000"/)
  // The old, wrong values must never come back.
  assert.doesNotMatch(out, /BoundRect_Y="363\.000000"/)
  assert.doesNotMatch(out, /BoundRect_Y="163\.000000"/)
})

test('twoPcLab wires both PCs into the switch on the right ports', () => {
  const topo = twoPcLab()
  const names = topo.devices.map((d) => d.name)
  assert.deepEqual(names, ['SW1', 'PC1', 'PC2'])
  assert.equal(topo.devices.find((d) => d.name === 'SW1').comPort, 2000)
  assert.equal(topo.devices.find((d) => d.name === 'PC1').comPort, 0)
  assert.equal(topo.links.length, 2)
})

test('parseTopology reads back what serialiseTopology wrote', () => {
  const written = serialiseTopology(twoPcLab())
  const parsed = parseTopology(written)
  assert.equal(parsed.devices.length, 3)
  assert.equal(parsed.links.length, 2)
  const sw = parsed.devices.find((d) => d.name === 'SW1')
  assert.equal(sw.comPort, 2000)
  assert.equal(sw.model, 'S5700')
  const pcLink = parsed.links.find((l) => l.srcName === 'PC1')
  assert.equal(pcLink.srcPort, 'Ethernet0/0/1')
  assert.equal(pcLink.dstPort, 'GigabitEthernet0/0/1')
})

test('buildTopology rejects interfaces the model does not have', () => {
  // An AR2220 stops at GE0/0/2; asking for GE0/0/5 must fail loudly instead of
  // writing an out-of-range index that eNSP silently ignores.
  assert.throws(
    () =>
      buildTopology()
        .add('R1', 'AR2220')
        .add('SW1', 'S5700')
        .link('R1', 'GigabitEthernet0/0/5', 'SW1', 'GigabitEthernet0/0/1'),
    /no interface/,
  )
  // A PC has no GigabitEthernet port at all.
  assert.throws(
    () =>
      buildTopology()
        .add('PC1', 'PC')
        .add('SW1', 'S5700')
        .link('PC1', 'GigabitEthernet0/0/1', 'SW1', 'GigabitEthernet0/0/1'),
    /no interface/,
  )
})

test('buildTopology rejects duplicate device names', () => {
  assert.throws(() => buildTopology().add('SW1', 'S5700').add('SW1', 'S5700'), /duplicate/)
})

test('DSH tool definitions satisfy the harness schema contract', async () => {
  // Two rules that each fail activation with a schema complaint rather than a
  // stack trace, so they are worth pinning here:
  //   1. `parameters` is a flat field map, not a JSON Schema with `properties`.
  //   2. `output.schema` must not leave `required: true` on a leaf; the marker is
  //      hoisted into an object-level `required` array by `obj()`.
  const registered = []
  const ctx = { tools: { register: (def) => (registered.push(def), () => {}) } }
  const plugin = await import('../src/dsh/index.mjs')
  plugin.apply(ctx)

  assert.equal(registered.length, 14, 'expected 14 tools')

  const violations = (node, path = 's') => {
    const bad = []
    if (node === null || typeof node !== 'object') return bad
    if (Array.isArray(node)) {
      node.forEach((n, i) => bad.push(...violations(n, `${path}[${i}]`)))
      return bad
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === 'required' && v === true) bad.push(`${path}.required=true`)
      else if (k === 'required' && !Array.isArray(v)) bad.push(`${path}.required-not-array`)
      else bad.push(...violations(v, `${path}.${k}`))
    }
    return bad
  }

  for (const tool of registered) {
    assert.ok(tool.name, 'tool needs a name')
    assert.ok(tool.description, `${tool.name} needs a description`)
    assert.equal(typeof tool.execute, 'function', `${tool.name} needs execute`)
    assert.ok(!tool.parameters?.properties, `${tool.name} parameters must be flat`)
    assert.ok(tool.output?.schema, `${tool.name} needs output.schema`)
    assert.equal(typeof tool.output.render, 'function', `${tool.name} needs output.render`)
    assert.deepEqual(violations(tool.output.schema), [], `${tool.name} schema has leaf required markers`)
  }
})

test('generated topology renders (documents the zombie-process trap)', async () => {
  // Every value below is asserted against eNSP's own samples, not guessed.
  // The comment records the two failure modes that produced an empty canvas:
  //
  //   1. interface <interface> grouping must match the model exactly
  //   2. cable anchors use the icon box (cx-16.2..cx+70.2), centre = cy+27
  //
  // A third cause is environmental and cannot be tested here: a zero-thread eNSP
  // zombie holds the single-instance lock, so the new window draws nothing.
  // `launcher.enspPid()` filters those out and `launchEnsp` verifies rendering.
  const topo = twoPcLab({ vlan: 10 })
  const xml = serialiseTopology(topo)

  // switches declare 24 GE ports in one group; PCs declare 1 GE port
  assert.match(xml, /<interface sztype="Ethernet" interfacename="GE" count="24" \/>/)
  assert.match(xml, /<interface sztype="Ethernet" interfacename="GE" count="1" \/>/)

  // anchors sit on the measured icon box, not on cx+height/2
  const anchors = [...xml.matchAll(/BoundRect_Y="([\d.]+)"/g)].map((m) => Number(m[1]))
  assert.ok(anchors.includes(347.0), 'PC1 link anchor y = 320 + 27')
  assert.ok(anchors.includes(147.0), 'SW1 link anchor y = 120 + 27')

  // the file must be parseable back
  assert.equal(parseTopology(xml).devices.length, 3)
})

/* ------------------------------------------------------------------ presets */

test('scenario catalogue is complete and internally consistent', async () => {
  // The catalogue is the product's main surface for teaching; a malformed entry
  // shows up as a broken `ensp preset` listing rather than a crash, so it needs a
  // test of its own. `validateScenarios` is the same function the doc generator
  // runs before writing docs/SCENARIOS.md.
  const { validateScenarios } = await import('../scripts/gen-scenarios-doc.mjs')
  assert.deepEqual(validateScenarios(), [])

  const { SCENARIOS, SCENARIO_IDS, byLevel } = await import('../src/core/presets.mjs')
  assert.equal(SCENARIO_IDS.length, Object.keys(SCENARIOS).length)

  const groups = byLevel()
  assert.equal(
    groups.basic.length + groups.intermediate.length + groups.advanced.length,
    SCENARIO_IDS.length,
    'every scenario falls in exactly one level bucket',
  )
})

test('every scenario can be rendered as a skeleton brief', async () => {
  const { SCENARIO_IDS, renderScenario, searchScenarios } = await import('../src/core/presets.mjs')
  for (const id of SCENARIO_IDS) {
    const brief = renderScenario(id)
    assert.ok(brief.includes('## 配置顺序'), `${id}: missing step list`)
    assert.ok(brief.includes('## 易错点'), `${id}: missing pitfalls section`)
    assert.ok(brief.length > 200, `${id}: brief is too short to be useful`)
  }
  // search must reach the newly added advanced scenarios, not just the old ones
  const hits = searchScenarios('mpls').map((h) => h.id)
  assert.ok(hits.includes('mpls-basic'))
  assert.ok(hits.includes('mpls-l3vpn'))
})

/* -------------------------------------------------------------------- labs */

test('every topology blueprint builds a parseable .topo', async () => {
  const { LABS, LAB_IDS, buildScenarioTopology } = await import('../src/core/labs.mjs')
  const { SCENARIOS } = await import('../src/core/presets.mjs')
  assert.ok(LAB_IDS.length > 0)

  for (const id of LAB_IDS) {
    // a blueprint without a matching scenario is unreachable from the CLI
    assert.ok(SCENARIOS[id], `blueprint "${id}" has no scenario of the same id`)

    const topo = buildScenarioTopology(id)
    assert.ok(topo.devices.length >= 2, `${id}: too few devices`)
    assert.ok(topo.links.length >= 1, `${id}: no links`)

    // round-tripping proves the interface indices actually resolve against the
    // model table; a wrong group declaration shows up here rather than in eNSP
    const back = parseTopology(serialiseTopology(topo))
    assert.equal(back.devices.length, topo.devices.length, `${id}: device count changed on reparse`)
    assert.equal(back.links.length, topo.links.length, `${id}: link count changed on reparse`)

    // Console ports must be distinct or eNSP cannot open them all. PCs carry no
    // console (eNSP gives them com_port 0), so they are not part of the check.
    const ports = back.devices.map((d) => d.comPort).filter((p) => p > 0)
    assert.equal(new Set(ports).size, ports.length, `${id}: duplicate console port`)
  }
})

test('blueprint addressing stays inside the documented ranges', async () => {
  const { LAB_IDS, labAddressing, labDevices } = await import('../src/core/labs.mjs')
  for (const id of LAB_IDS) {
    assert.ok(labDevices(id).length >= 2, `${id}: device summary too short`)
    for (const row of labAddressing(id)) {
      // both IPv4 (10.0.12.1/24) and IPv6 (2001:db8:12::1/64) appear here
      assert.match(row.ip, /^[0-9a-fA-F:.]+\/\d+$/, `${id}: bad address "${row.ip}"`)
    }
  }
})

test('device availability is checked before the client is started', async () => {
  const { probeDevice, checkTopologySupport, describeBlocked, clearCatalogueCache } = await import(
    '../src/core/compat.mjs'
  )
  clearCatalogueCache()

  // Models with no plugin dependency must never be blocked by the probe; a false
  // positive here would make every ordinary lab unusable.
  for (const model of ['AR2220', 'S5700', 'AC6005', 'PC']) {
    assert.equal(probeDevice(model).available, true, `${model} wrongly reported unavailable`)
  }

  // The report has to name the offending device and say what to do about it.
  const report = checkTopologySupport({
    devices: [
      { name: 'SW1', model: 'S5700' },
      { name: 'FW1', model: 'USG6000V' },
      { name: 'FW2', model: 'USG6000V' },
    ],
  })
  assert.equal(report.ok, false)
  assert.deepEqual(
    report.blocked.map((b) => b.name).sort(),
    ['FW1', 'FW2'],
    'only the firewalls should be blocked',
  )
  assert.deepEqual(report.checked, ['S5700', 'USG6000V'])

  // Repeated models collapse into one explanation rather than one line per device.
  const text = describeBlocked(report)
  assert.match(text, /USG6000V \(FW1, FW2\)/)
  assert.match(text, /镜像|组件/)
  assert.doesNotMatch(text, /cannot start:\s*$/)
})

test('availability does not depend on the catalogue being readable', async () => {
  // The bug this guards: probeDevice used to return early with "available" when
  // items.xml could not be read, so on a machine without eNSP (every CI runner) a
  // USG6000V topology passed the preflight and then failed at start time. The
  // assets a model needs are a property of the model, not of the catalogue file.
  const { probeDevice, clearCatalogueCache } = await import('../src/core/compat.mjs')
  clearCatalogueCache()
  const nowhere = { root: 'Z:/definitely/not/an/ensp/install' }
  assert.equal(probeDevice('USG6000V', nowhere).available, false)
  assert.equal(probeDevice('USG5500', nowhere).available, false)
  // Models that need no extra image stay usable even with no install on disk.
  for (const model of ['AR2220', 'S5700', 'PC']) {
    assert.equal(probeDevice(model, nowhere).available, true, `${model} wrongly blocked`)
  }
})

test('a fully supported topology passes the availability check', async () => {
  const { checkTopologySupport } = await import('../src/core/compat.mjs')
  const { buildScenarioTopology } = await import('../src/core/labs.mjs')
  const topo = buildScenarioTopology('ospf-single')
  const report = checkTopologySupport(topo)
  assert.equal(report.ok, true, `unexpected blockers: ${JSON.stringify(report.blocked)}`)
  assert.deepEqual(report.blocked, [])
})

test('a refused click reports the occluding process instead of succeeding', () => {
  // The bug this guards: a synthetic click lands on whatever window owns the
  // pixel, so an occluded eNSP received nothing while clickToolbar said ok.
  // clickToolbar now returns {ok:false, clicked:false, occludedBy} in that case,
  // and startAllDevices throws rather than waiting on consoles that will never
  // open. Only the pure shape of that contract is asserted here, because the
  // real path needs a live eNSP and a second window on top of it.
  const source = readFileSync(new URL('../src/core/launcher.mjs', import.meta.url), 'utf8')
  assert.match(source, /WindowFromPoint/, 'the click point owner must be queried')
  assert.match(source, /GetAncestor/, 'the point must be resolved to its top-level window')
  assert.match(source, /occludedBy/, 'a blocked click must name the blocking process')
  assert.match(source, /if \(!click\.clicked\)/, 'startAllDevices must abort when the click was refused')
})

test('calibration refuses to run on an occluded window', () => {
  const source = readFileSync(new URL('../src/core/launcher.mjs', import.meta.url), 'utf8')
  const body = source.slice(source.indexOf('export async function startAllDevices'))
  assert.match(body, /checkOcclusion\(hwnd\)/, 'the window must be checked for occlusion before calibrating')
  assert.ok(
    body.indexOf('checkOcclusion(hwnd)') < body.indexOf('calibrateAnchors(hwnd)'),
    'the occlusion check must come before calibration reads the screen',
  )
})

test('acceptance assertions actually distinguish pass from fail', async () => {
  // A verification layer that passes everything is worse than none, so pin the
  // judgement itself: a real `display ospf peer brief` must pass, a session that
  // never reached Full must fail, and a silent command must not be mistaken for
  // success.
  const { evaluateAssertion } = await import('../src/core/acceptance.mjs')
  const full = [
    'Area Id           Interface                Neighbor id      State',
    '0.0.0.0           GigabitEthernet0/0/0     2.2.2.2          Full',
  ].join('\n')
  const stuck = [
    'Area Id           Interface                Neighbor id      State',
    '0.0.0.0           GigabitEthernet0/0/0     2.2.2.2          ExStart',
  ].join('\n')

  assert.equal(evaluateAssertion(full, { contains: 'Full' }).pass, true)
  assert.equal(evaluateAssertion(stuck, { contains: 'Full' }).pass, false)
  assert.equal(evaluateAssertion('', { minLines: 2 }).pass, false)
  assert.equal(evaluateAssertion(full, { notContains: 'ExStart' }).pass, true)
  assert.equal(evaluateAssertion(full, { matches: /Full\s*$/m }).pass, true)
  assert.match(evaluateAssertion(stuck, { contains: 'Full' }).why, /Full/)
})

test('every scenario gets a verification plan, curated or smoke', async () => {
  // planFor must never return nothing: a scenario without hand-written asserts
  // falls back to the commands its own steps already name.
  const { planFor, hasChecks, EXPECTATIONS } = await import('../src/core/acceptance.mjs')
  const { SCENARIO_IDS } = await import('../src/core/presets.mjs')

  const curated = SCENARIO_IDS.filter((id) => hasChecks(id))
  assert.ok(curated.length >= 20, `expected curated checks for many scenarios, got ${curated.length}`)

  for (const id of SCENARIO_IDS) {
    const plan = planFor(id)
    assert.ok(plan.checks.length > 0, `${id}: plan must contain at least one check`)
    for (const check of plan.checks) {
      assert.ok(check.command, `${id}: check needs a command`)
      assert.ok(check.on, `${id}: check needs a target device`)
      assert.equal(check.kind, hasChecks(id) ? 'assert' : 'smoke', `${id}: wrong check kind`)
    }
  }
  for (const [id, checks] of Object.entries(EXPECTATIONS)) {
    assert.ok(SCENARIO_IDS.includes(id), `${id}: curated checks for unknown scenario`)
    assert.ok(checks.length > 0, `${id}: curated list must not be empty`)
  }
})

test('doctor reports a fix for every failing check', async () => {
  // The whole point of doctor is to say what to do next, so a check without a
  // fix (or a good reason) is a dead end for the user.
  const { doctor, formatDoctor } = await import('../src/core/doctor.mjs')
  const report = doctor({ deep: false, models: ['AR2220', 'USG6000V'] })

  assert.ok(Array.isArray(report.checks) && report.checks.length >= 6)
  for (const check of report.checks) {
    assert.ok(['pass', 'warn', 'fail'].includes(check.status), `${check.id}: bad status`)
    assert.ok(check.detail, `${check.id}: needs a detail line`)
    if (check.status !== 'pass') assert.ok(check.fix, `${check.id}: a non-passing check needs a fix`)
  }
  // USG6000V has no image on a stock install, so it must be called out.
  const images = report.checks.find((c) => c.id === 'device-images')
  assert.ok(images, 'device images must be checked when models are supplied')
  assert.match(formatDoctor(report), /device-images/i)
})

test('an unreachable console is reported as such, not as a failed assertion', async () => {
  // Real failure in the first version: verify pointed at a topology whose devices
  // were never started, and reported "not contains Full" on every check. That sends
  // the reader into OSPF while the actual problem is that nothing is listening.
  const source = readFileSync(new URL('../src/core/acceptance.mjs', import.meta.url), 'utf8')
  assert.match(source, /res\?\.ok === false/, 'queryDevice ok:false must be detected')
  assert.match(source, /console unreachable/, 'that case must be named in the verdict')
})

test('a converging lab passes instead of being reported as broken', async () => {
  // Second real failure, seen against a live three-router lab: `ensp apply` returns
  // before OSPF converges, so a single snapshot said "not contains Full" for a
  // neighbour that reached Full ten seconds later. The assertion itself has to be
  // retried; a command VRP rejected and a console that never answered are not
  // retryable, because waiting cannot fix either.
  const { runAcceptance } = await import('../src/core/acceptance.mjs')
  let calls = 0
  const report = await runAcceptance({
    id: 'ospf-single',
    ports: new Map([['R1', 2000]]),
    waitMs: 900,
    intervalMs: 100,
    query: async ({ command }) => {
      calls++
      // ospf-single asserts on two commands: the peer state and the OSPF routes.
      if (/peer/i.test(command)) {
        return calls >= 3
          ? { ok: true, output: 'Neighbor id 2.2.2.2 State Full' }
          : { ok: true, output: 'Neighbor id 2.2.2.2 State 2-Way' }
      }
      return calls >= 3
        ? { ok: true, output: 'Destination/Mask Proto Pre Cost NextHop Interface\n2.2.2.2/32 OSPF 10 1 10.0.12.2 GE0/0/0' }
        : { ok: true, output: 'Route Flags: R - relay' }
    },
  })
  assert.equal(report.ok, true, 'a neighbour that reaches Full must not be reported as broken')
  assert.equal(report.results[0].pass, true)
  assert.ok(report.results[0].waitedMs > 0, 'the passing check must record that it had to wait')
  assert.ok(calls >= 3, 'the assertion must have been retried')
})

test('a rejected command is not retried', async () => {
  const { runAcceptance } = await import('../src/core/acceptance.mjs')
  let calls = 0
  const report = await runAcceptance({
    id: 'ospf-single',
    ports: new Map([['R1', 2000]]),
    waitMs: 900,
    intervalMs: 100,
    query: async () => {
      calls++
      return { ok: true, output: "Error: Unrecognized command found at '^' position." }
    },
  })
  assert.equal(report.ok, false)
  // One query per check and no retries: waiting cannot turn a rejected command
  // into a passing one, so a rejected command must not enter the retry loop.
  assert.equal(calls, report.results.length, 'a rejected command must not be retried')
  assert.match(report.results[0].why, /rejected/)
})

test('the legacy Router model exposes its ports in VRP order', async () => {
  // Teaching material uses `Router` heavily (43 of 190 devices in the ICVE corpus)
  // while eNSP's own samples never do, so the model table simply lacked it. The
  // order below was read off a live device with `display interface brief`.
  const { describePorts, portCount, vrpToFlatIndex: toIndex, flatIndexToVrp } = await import(
    '../src/core/models.mjs'
  )
  assert.equal(portCount('Router'), 10)
  assert.equal(
    describePorts('Router'),
    'Ethernet0/0/0..1, GigabitEthernet0/0/0..3, Serial0/0/0..3',
  )
  assert.equal(toIndex('Router', 'Ethernet0/0/0'), 0)
  assert.equal(toIndex('Router', 'GigabitEthernet0/0/0'), 2)
  assert.equal(toIndex('Router', 'Serial0/0/0'), 6)
  assert.equal(flatIndexToVrp('Router', 6), 'Serial0/0/0')
  assert.equal(flatIndexToVrp('Router', 99), null)
  assert.equal(portCount('Client'), 1, 'a Client is a single-port web client')
})

test('a device with added hardware uses its own declared port layout', async () => {
  // Real failure: a NAT lab mounts a serial card on an AR2220, so flat index 3 is
  // Serial0/0/0 there. Trusting the stock model table left two links unresolved.
  const xml = `<?xml version="1.0" encoding="UNICODE" ?>
<topo version="1.2.00.390">
  <devices>
    <dev id="A" name="AR1" model="AR2220" com_port="2000" bootmode="1" cx="0" cy="0">
      <slot number="slot17" isMainBoard="1">
        <interface sztype="Ethernet" interfacename="GE" count="1" />
        <interface sztype="Ethernet" interfacename="GE" count="2" />
        <interface sztype="Serial" interfacename="Serial" count="2" />
      </slot>
    </dev>
    <dev id="B" name="AR2" model="AR2220" com_port="2001" bootmode="1" cx="200" cy="0">
      <slot number="slot17" isMainBoard="1">
        <interface sztype="Ethernet" interfacename="GE" count="1" />
        <interface sztype="Ethernet" interfacename="GE" count="2" />
        <interface sztype="Serial" interfacename="Serial" count="2" />
      </slot>
    </dev>
  </devices>
  <lines>
    <line srcDeviceID="A" destDeviceID="B">
      <interfacePair lineName="Serial" srcIndex="3" tarIndex="3" />
    </line>
  </lines>
</topo>`
  const topo = parseTopology(xml)
  assert.equal(topo.links.length, 1)
  assert.equal(topo.links[0].srcPort, 'Serial0/0/0', 'the file, not the model table, says what index 3 is')
  assert.equal(topo.links[0].dstPort, 'Serial0/0/0')
  assert.equal(topo.devices[0].interfaces, 5, 'the declared count includes the mounted card')
})

test('every port in the ICVE fixture corpus resolves to a CLI name', async () => {
  // The fixture corpus is 18 topologies from a real teaching course: 190 devices,
  // 185 links, and two models (Router, Client) that eNSP's own samples never use.
  // Keeping them means a future model-table edit that breaks legacy hardware fails
  // here instead of on a student's topology.
  const { readdir, readFile } = await import('node:fs/promises')
  const { join, dirname } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'icve')
  const files = (await readdir(dir)).filter((f) => f.endsWith('.topo')).sort()
  assert.equal(files.length, 18, 'the fixture corpus must stay complete')

  let devices = 0
  let links = 0
  let consoles = 0
  const seen = new Set()
  for (const file of files) {
    const text = (await readFile(join(dir, file), 'utf8')).replace(/^\uFEFF/, '')
    const topo = parseTopology(text)
    devices += topo.devices.length
    links += topo.links.length
    consoles += topo.devices.filter((d) => d.comPort).length
    for (const d of topo.devices) seen.add(d.model)
    for (const l of topo.links) {
      assert.ok(l.srcPort, `${file}: ${l.srcName} index ${l.srcIndex} has no CLI port`)
      assert.ok(l.dstPort, `${file}: ${l.dstName} index ${l.dstIndex} has no CLI port`)
    }
    // Serialising what we parsed must preserve both counts.
    const round = parseTopology(serialiseTopology(topo))
    assert.equal(round.devices.length, topo.devices.length, `${file}: device count changed`)
    assert.equal(round.links.length, topo.links.length, `${file}: link count changed`)
  }
  assert.equal(devices, 190)
  assert.equal(links, 185)
  assert.equal(consoles, 87)
  assert.ok(seen.has('Router'), 'the corpus must keep exercising the legacy Router model')
  assert.ok(seen.has('Client'), 'the corpus must keep exercising the Client model')
})

test('a pager stop is recognised as unfinished output', () => {
  // Real transcript shape: the page break lands mid-transcript and the rest of
  // the answer only arrives after a keypress. Treating that as the end of the
  // output silently drops configuration lines, which then look like they were
  // never applied.
  assert.equal(hasPagerMarker('  ---- More ----'), true)
  assert.equal(hasPagerMarker(' interface Serial0/0/0\n  ---- More ----\n'), true)
  assert.equal(hasPagerMarker('[RA]'), false)
  assert.equal(hasPagerMarker('interface Serial0/0/0\n[RA-Serial0/0/0]'), false)
  assert.equal(hasPagerMarker(''), false)
})

test('curated checks follow the devices a foreign topology actually has', async () => {
  // The shipped blueprints name devices R1/R2/R3. A lab downloaded from a course
  // platform names them RA/RB/RC, and reporting `no console port for device "R1"`
  // on a perfectly healthy lab sends the reader chasing a typo instead of the lab.
  assert.equal(resolveDevice('R1', ['RA', 'RB', 'RC']), 'RA')
  assert.equal(resolveDevice('R2', ['RA', 'RB', 'RC']), 'RB')
  assert.equal(resolveDevice('R9', ['RA', 'RB']), 'RB', 'out of range clamps to the last device')
  assert.equal(resolveDevice('R1', []), 'R1', 'with nothing to map onto, keep the name')
  assert.equal(resolveDevice('RA', ['RA', 'RB']), 'RA', 'an exact match wins')
  const plan = planFor('rip', { devices: ['RC', 'RA', 'RB'] })
  assert.equal(plan.source, 'curated')
  assert.equal(hasChecks('rip'), true)
  assert.deepEqual([...new Set(plan.checks.map((c) => c.on))], ['RA'], 'checks land on the first device by natural order')
})
