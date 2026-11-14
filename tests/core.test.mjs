/**
 * Regression tests for the pieces that were actually broken during development.
 *
 * These are deliberately narrow: each case corresponds to a real failure that cost
 * debugging time, so a future refactor cannot silently reintroduce it.
 *
 * Run with `npm test` (node:test, no dependencies).
 */

import assert from 'node:assert/strict'
import { readFileSync, existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { conform } from '../src/dsh/index.mjs'

import { EventEmitter } from 'node:events'

import { ConsoleSession, viewOf, hostnameOf, hasPagerMarker } from '../src/core/console.mjs'
import { parseScript, isIdempotentError } from '../src/core/provision.mjs'
import {
  interfaceName,
  interfaceIndex,
  parseTopology,
  serialiseTopology,
} from '../src/core/topology.mjs'
import { buildTopology, twoPcLab, twoPcLabConfig, MODEL_SPECS, vrpToFlatIndex } from '../src/core/build.mjs'
import { planFor, resolveDevice, hasChecks, evaluateAssertion } from '../src/core/acceptance.mjs'
import {
  addressCommand,
  countLabConfigs,
  hasLabConfig,
  labConfigScript,
  labConfigs,
  maskFromPrefix,
} from '../src/core/labconfig.mjs'
import { LAB_IDS, labAddressing } from '../src/core/labs.mjs'
import { buildDocx, zip } from '../src/core/docx.mjs'
import { buildReportBlocks, collectEvidence, writeReport } from '../src/core/report.mjs'
import { docxText } from '../src/core/ooxml.mjs'

// Source-shape assertions match on newlines, so the file has to be read the same
// way on every machine. A Windows checkout with core.autocrlf gives CRLF, which
// silently breaks any pattern that spans a line break.
function sourceOf(relative) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
}

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

  assert.equal(registered.length, 17, 'expected 17 tools')

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

test('the MCP and DSH tool tables stay in step', async () => {
  // Both front ends publish the same operations, so a rename, a reorder or a
  // reworded parameter has to happen once and reach both. Before `tools.mjs`
  // the two tables were written out separately and had already drifted (the
  // order differed, and a couple of argument descriptions contradicted each
  // other), which is why this compares the published order rather than the set.
  const captured = []
  const { apply } = await import('../src/dsh/index.mjs')
  apply({ tools: { register: (def) => (captured.push(def), () => {}) } })

  const { TOOLS } = await import('../src/mcp/server.mjs')

  assert.equal(TOOLS.length, 17, 'expected 17 tools')
  assert.deepEqual(captured.map((t) => t.name), TOOLS.map((t) => t.name))

  for (const dshTool of captured) {
    const mcpTool = TOOLS.find((t) => t.name === dshTool.name)
    assert.ok(mcpTool, `${dshTool.name} is missing from the MCP table`)
    assert.equal(dshTool.description, mcpTool.description, `${dshTool.name} descriptions diverged`)
    assert.deepEqual(
      Object.keys(dshTool.parameters ?? {}),
      Object.keys(mcpTool.inputSchema.properties ?? {}),
      `${dshTool.name} argument names or their order diverged`,
    )
  }
})

test('tool parameter schemas are not shared between the two front ends', async () => {
  // The specs are a module-level table: handing the same node objects to both
  // adapters would let either of them mutate the other's schema, so each side
  // must hold its own copy.
  const captured = []
  const { apply } = await import('../src/dsh/index.mjs')
  apply({ tools: { register: (def) => (captured.push(def), () => {}) } })

  const { TOOLS } = await import('../src/mcp/server.mjs')

  const dshNode = captured[0].parameters.topology
  const mcpNode = TOOLS[0].inputSchema.properties.topology
  assert.notStrictEqual(dshNode, mcpNode)
  assert.deepEqual(dshNode, mcpNode, 'the copies must still carry the same schema')
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

test('plugin images are found from the template, not from a fixed path', async () => {
  // The bug this guards: only USG6000V had a hand-written image path, so every
  // other plugin model (NE40E, NE5000E, NE9000, CX, CE6800, CE12800) was reported
  // as available on machines where its disk image had never been installed. eNSP
  // then opens the topology, paints it, and quits, which reads as a console that
  // never answered.
  const { probeDevice, pluginMediaFiles, clearCatalogueCache } = await import(
    '../src/core/compat.mjs'
  )
  const install = mkdtempSync(join(tmpdir(), 'ensp-media-'))
  const exe = join(install, 'eNSP_Client.exe')
  const previous = process.env.DSH_ENSP_EXE
  try {
    mkdirSync(join(install, 'res'), { recursive: true })
    mkdirSync(join(install, 'plugin', 'ne', 'Tools', 'svrp'), { recursive: true })
    mkdirSync(join(install, 'plugin', 'ne', 'Database'), { recursive: true })
    writeFileSync(exe, '')
    writeFileSync(join(install, 'plugin', 'ne', 'SVRP_Plugin_NE.dll'), '')
    writeFileSync(
      join(install, 'res', 'items.xml'),
      '<model name="NE40E"><executable isplugin="1" path="ne\\SVRP_Plugin_NE.dll"/></model>',
    )
    writeFileSync(
      join(install, 'plugin', 'ne', 'Tools', 'svrp', 'NE40E.xml'),
      '<VirtualBox><HardDisk location="../../Database/NE40E.img"/></VirtualBox>',
    )
    clearCatalogueCache()
    process.env.DSH_ENSP_EXE = exe

    const media = pluginMediaFiles('NE40E')
    assert.equal(media.length, 1, 'the template should name exactly one disk image')
    assert.ok(
      media[0].endsWith(join('plugin', 'ne', 'Database', 'NE40E.img')),
      `resolved to ${media[0]}`,
    )
    assert.equal(
      probeDevice('NE40E').available,
      false,
      'an uninstalled NE40E image must block the topology',
    )

    writeFileSync(join(install, 'plugin', 'ne', 'Database', 'NE40E.img'), '')
    assert.equal(probeDevice('NE40E').available, true, 'a present image must not block')

    // A machine-local install keeps working: none of this depends on where eNSP is.
    assert.equal(probeDevice('AR2220').available, true)
  } finally {
    if (previous === undefined) delete process.env.DSH_ENSP_EXE
    else process.env.DSH_ENSP_EXE = previous
    clearCatalogueCache()
    rmSync(install, { recursive: true, force: true })
  }
})

test('a missing device image can be installed where the template points', async () => {
  // What the user has to do by hand otherwise: find where this particular
  // installation keeps its images, copy the file there, and fix ImgFile in the
  // plugin system.ini. The destination comes from the template, never from a
  // hardcoded path.
  const { pluginMediaPlan, pluginModels, installPluginMedia, probeDevice, clearCatalogueCache } =
    await import('../src/core/compat.mjs')
  const install = mkdtempSync(join(tmpdir(), 'ensp-image-'))
  const previous = process.env.DSH_ENSP_EXE
  try {
    mkdirSync(join(install, 'res'), { recursive: true })
    mkdirSync(join(install, 'plugin', 'ngfw', 'tools', 'ngfw'), { recursive: true })
    mkdirSync(join(install, 'plugin', 'ngfw', 'System'), { recursive: true })
    writeFileSync(join(install, 'eNSP_Client.exe'), '')
    writeFileSync(join(install, 'plugin', 'ngfw', 'ngfw_Plugin.dll'), '')
    writeFileSync(
      join(install, 'res', 'items.xml'),
      '<model name="USG6000V"><executable isplugin="1" path="ngfw\\ngfw_Plugin.dll"/></model>',
    )
    writeFileSync(
      join(install, 'plugin', 'ngfw', 'tools', 'ngfw', 'vfw_usg.vbox'),
      '<VirtualBox><HardDisk location="../../DataBase/vfw_usg.vdi"/></VirtualBox>',
    )
    writeFileSync(join(install, 'plugin', 'ngfw', 'System', 'system.ini'), '[SYSTEM]\nImgFile = \n')
    const image = join(install, 'downloaded.vdi')
    writeFileSync(image, 'x'.repeat(1024))

    clearCatalogueCache()
    process.env.DSH_ENSP_EXE = join(install, 'eNSP_Client.exe')

    assert.deepEqual(pluginModels(), ['USG6000V'], 'the catalogue should name the plugin model')
    assert.equal(pluginMediaPlan('USG6000V').ready, false)
    assert.equal(probeDevice('USG6000V').available, false)

    const result = installPluginMedia('USG6000V', image)
    assert.equal(result.bytes, 1024)
    assert.ok(result.target.endsWith(join('DataBase', 'vfw_usg.vdi')), `target was ${result.target}`)
    assert.equal(result.iniUpdated, true, 'ImgFile should point at the installed image')
    assert.equal(pluginMediaPlan('USG6000V').ready, true)
    assert.equal(probeDevice('USG6000V').available, true)

    // Installing again is a no-op, which matters for anyone scripting this.
    assert.equal(installPluginMedia('USG6000V', image).bytes, 0)
  } finally {
    if (previous === undefined) delete process.env.DSH_ENSP_EXE
    else process.env.DSH_ENSP_EXE = previous
    clearCatalogueCache()
    rmSync(install, { recursive: true, force: true })
  }
})

test('the default install root comes from this machine, not from a fixed path', async () => {
  // The bug this guards: probeDevice defaulted to `E:\Huawei\eNSP`. On a machine
  // that installs eNSP anywhere else the probe read a directory that does not
  // exist, so the NGFW image was reported missing even when it was installed, and
  // a perfectly usable USG6000V lab was blocked for no reason.
  const { probeDevice, clearCatalogueCache } = await import('../src/core/compat.mjs')
  const install = mkdtempSync(join(tmpdir(), 'ensp-root-'))
  const exe = join(install, 'eNSP_Client.exe')
  const previous = process.env.DSH_ENSP_EXE
  try {
    mkdirSync(join(install, 'res'), { recursive: true })
    mkdirSync(join(install, 'plugin', 'ngfw', 'DataBase'), { recursive: true })
    writeFileSync(exe, '')
    writeFileSync(join(install, 'plugin', 'ngfw', 'ngfw.dll'), '')
    writeFileSync(join(install, 'plugin', 'ngfw', 'DataBase', 'vfw_usg.vdi'), '')
    writeFileSync(
      join(install, 'res', 'items.xml'),
      '<model name="USG6000V"><executable isplugin="1" path="ngfw/ngfw.dll"/></model>',
    )
    clearCatalogueCache()
    process.env.DSH_ENSP_EXE = exe

    // No `root` argument: the probe has to find the installation by itself.
    assert.equal(
      probeDevice('USG6000V').available,
      true,
      'probeDevice ignored the install location on this machine',
    )
  } finally {
    if (previous === undefined) delete process.env.DSH_ENSP_EXE
    else process.env.DSH_ENSP_EXE = previous
    clearCatalogueCache()
    rmSync(install, { recursive: true, force: true })
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
  const source = sourceOf('../src/core/launcher.mjs')
  assert.match(source, /WindowFromPoint/, 'the click point owner must be queried')
  assert.match(source, /GetAncestor/, 'the point must be resolved to its top-level window')
  assert.match(source, /occludedBy/, 'a blocked click must name the blocking process')
  assert.match(source, /if \(!click\.clicked\)/, 'startAllDevices must abort when the click was refused')
})

test('calibration refuses to run on an occluded window', () => {
  const source = sourceOf('../src/core/launcher.mjs')
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
  // falls back to the commands its own steps already name. Those checks carry no
  // target device when the plan is built without a topology, because a scenario's
  // `devices` field is prose and not a device list.
  const { planFor, hasChecks, EXPECTATIONS } = await import('../src/core/acceptance.mjs')
  const { SCENARIO_IDS } = await import('../src/core/presets.mjs')

  const curated = SCENARIO_IDS.filter((id) => hasChecks(id))
  assert.ok(curated.length >= 20, `expected curated checks for many scenarios, got ${curated.length}`)

  for (const id of SCENARIO_IDS) {
    const plan = planFor(id)
    assert.ok(plan.checks.length > 0, `${id}: plan must contain at least one check`)
    for (const check of plan.checks) {
      assert.ok(check.command, `${id}: check needs a command`)
      assert.equal(check.kind, hasChecks(id) ? 'assert' : 'smoke', `${id}: wrong check kind`)
      assert.equal(check.asserted, hasChecks(id), `${id}: asserted flag must match the check kind`)
      if (hasChecks(id)) assert.ok(check.on, `${id}: a curated check needs a target device`)
    }
    // With a topology in hand, smoke checks do get a device to run on.
    const withDevices = planFor(id, { devices: ['DEV1', 'DEV2'] })
    for (const check of withDevices.checks) {
      if (check.kind === 'smoke') assert.equal(check.on, 'DEV1', `${id}: smoke checks run on the first available device`)
    }
  }
  for (const [id, checks] of Object.entries(EXPECTATIONS)) {
    assert.ok(SCENARIO_IDS.includes(id), `${id}: curated checks for unknown scenario`)
    assert.ok(checks.length > 0, `${id}: curated list must not be empty`)
  }
})

test('smoke checks admit they assert nothing instead of reporting a pass', async () => {
  // The failure this pins: a lab that was never configured answered every command,
  // no expectation was attached, and the report said "6/6 checks passed".
  const { runAcceptance, formatAcceptance } = await import('../src/core/acceptance.mjs')
  const factory = async () => ({ ok: true, output: '#\n port link-type access\n ---- More ----\n' })
  const report = await runAcceptance({
    id: 'firewall-zones',
    ports: new Map([['FW1', 2000], ['R-TRUST', 2001]]),
    query: factory,
    waitMs: 0,
  })
  assert.equal(report.ok, null, 'an unasserted lab cannot be reported as ok')
  assert.equal(report.passed, 0, 'nothing passed, because nothing was asserted')
  assert.equal(report.unverified, report.total)
  assert.ok(report.results.every((r) => r.pass === null && r.asserted === false))
  assert.match(formatAcceptance(report), /unverified:/)
  assert.doesNotMatch(formatAcceptance(report), /checks passed/)

  // A curated scenario on the same dead lab must still fail, so the change did not
  // just turn every report grey.
  const curated = await runAcceptance({
    id: 'ospf-single',
    ports: new Map([['R1', 2000], ['R2', 2000], ['R3', 2000]]),
    query: factory,
    waitMs: 0,
  })
  assert.equal(curated.ok, false)
  assert.ok(curated.failed > 0)
})

test('smoke plans keep interface names whole and use unique check ids', async () => {
  const { planFor } = await import('../src/core/acceptance.mjs')

  // The smoke builder used to split `verify` on every `/`, which turned
  // `display interface GigabitEthernet0/0/0 | include MTU` into three commands.
  // Scenario assertions now carry their commands verbatim, so the slash survives on
  // the curated path, and the smoke path only splits on a spaced separator.
  const curated = planFor('ppp-hdlc', { devices: ['R1'] })
  const serial = curated.checks.find((c) => c.command.includes('Serial0/0/1'))
  assert.ok(serial, 'the serial interface command must survive planning')
  assert.equal(serial.command, 'display interface Serial0/0/1')

  // Every remaining smoke scenario: a spaced ` / ` in the steps is the only thing
  // that may be split, and each piece has to be a command rather than a fragment.
  for (const id of ['firewall-zones', 'firewall-hrp']) {
    const plan = planFor(id, { devices: ['CORE1'] })
    const ids = plan.checks.map((c) => c.id)
    assert.equal(new Set(ids).size, ids.length, `${id}: check ids must be unique, got ${ids.join(', ')}`)
    for (const check of plan.checks) {
      assert.match(check.command, /^display /, `${id}: "${check.command}" is a fragment, not a command`)
      assert.doesNotMatch(check.command, /^\d+$/, `${id}: "${check.command}" is a split index`)
    }
  }
})

test('curated checks name devices that exist in their own blueprint', async () => {
  // `resolveDevice` used to map by position, so `R1` on a lab whose devices are
  // SW1/SW2/ACC silently became ACC and the report called it a passing VRRP master
  // check. Names that are not in the blueprint must be treated as a bug, not mapped.
  const { EXPECTATIONS } = await import('../src/core/acceptance.mjs')
  const { buildScenarioTopology } = await import('../src/core/labs.mjs')
  for (const [id, checks] of Object.entries(EXPECTATIONS)) {
    const names = buildScenarioTopology(id).devices.map((d) => d.name)
    for (const check of checks) {
      assert.ok(
        names.includes(check.on),
        `${id}: check "${check.id}" targets "${check.on}", which is not in [${names.join(', ')}]`,
      )
    }
  }
})

test('doctor reports a fix for every failing check', async () => {
  // The whole point of doctor is to say what to do next, so a check without a
  // fix (or a good reason) is a dead end for the user.
  const { doctor, formatDoctor } = await import('../src/core/doctor.mjs')
  const report = doctor({ deep: false, models: ['AR2220', 'USG6000V'] })

  // `skip` means the check could not measure anything (the toolbar anchors with no
  // eNSP running). It must say so and offer a way to measure, rather than compare a
  // fallback against itself and call that a pass.
  assert.ok(Array.isArray(report.checks) && report.checks.length >= 6)
  for (const check of report.checks) {
    assert.ok(['pass', 'warn', 'fail', 'skip'].includes(check.status), `${check.id}: bad status`)
    assert.ok(check.detail, `${check.id}: needs a detail line`)
    if (check.status !== 'pass') assert.ok(check.fix, `${check.id}: a non-passing check needs a fix`)
  }
  assert.deepEqual(
    report.skipped,
    report.checks.filter((c) => c.status === 'skip').map((c) => c.id),
    'the skipped list must name exactly the skipped checks',
  )
  // USG6000V has no image on a stock install, so it must be called out.
  const images = report.checks.find((c) => c.id === 'device-images')
  assert.ok(images, 'device images must be checked when models are supplied')
  assert.match(formatDoctor(report), /device-images/i)
})

test('an unreachable console is reported as such, not as a failed assertion', async () => {
  // Real failure in the first version: verify pointed at a topology whose devices
  // were never started, and reported "not contains Full" on every check. That sends
  // the reader into OSPF while the actual problem is that nothing is listening.
  const source = sourceOf('../src/core/acceptance.mjs')
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

test('a second interface group continues the numbering instead of restarting', async () => {
  // Real failure, found in a generated report: an AR2220 declares GE count="1" and
  // then GE count="2", and both groups were numbered from the model base, so flat
  // index 1 came back as GigabitEthernet0/0/0. Every link into the second group was
  // then labelled with the first group's port, and the report table printed a
  // R1-to-R3 cable as GE0/0/0 on both ends while the real far end was GE0/0/1.
  const xml = `<?xml version="1.0" encoding="UNICODE" ?>
<topo version="1.2.00.390">
  <devices>
    <dev id="A" name="R1" model="AR2220" com_port="2000" bootmode="1" cx="0" cy="0">
      <slot number="slot17" isMainBoard="1">
        <interface sztype="Ethernet" interfacename="GE" count="1" />
        <interface sztype="Ethernet" interfacename="GE" count="2" />
      </slot>
    </dev>
    <dev id="B" name="R3" model="AR2220" com_port="2002" bootmode="1" cx="200" cy="0">
      <slot number="slot17" isMainBoard="1">
        <interface sztype="Ethernet" interfacename="GE" count="1" />
        <interface sztype="Ethernet" interfacename="GE" count="2" />
      </slot>
    </dev>
  </devices>
  <lines>
    <line srcDeviceID="A" destDeviceID="B">
      <interfacePair lineName="Copper" srcIndex="1" tarIndex="1" />
    </line>
  </lines>
</topo>`
  const topo = parseTopology(xml)
  assert.equal(topo.links[0].srcPort, 'GigabitEthernet0/0/1')
  assert.equal(topo.links[0].dstPort, 'GigabitEthernet0/0/1')

  const { portsFromDeclarations, flatIndexToVrp } = await import('../src/core/models.mjs')
  const declarations = [
    { sztype: 'Ethernet', name: 'GE', count: 1, firstNumber: null },
    { sztype: 'Ethernet', name: 'GE', count: 2, firstNumber: null },
  ]
  assert.deepEqual(portsFromDeclarations(declarations, 'AR2220'), [
    'GigabitEthernet0/0/0',
    'GigabitEthernet0/0/1',
    'GigabitEthernet0/0/2',
  ])
  // The two paths to a port name must agree, or the report and the driver disagree.
  for (const model of ['AR2220', 'AR1220', 'Router', 'S3700', 'S5700', 'USG6000V', 'PC']) {
    const { MODEL_SPECS: specs } = await import('../src/core/models.mjs')
    const decls = specs[model].groups.map((g) => ({
      sztype: g[0],
      name: g[1],
      count: g[2],
      firstNumber: null,
    }))
    const fromFile = portsFromDeclarations(decls, model)
    fromFile.forEach((port, index) => {
      assert.equal(port, flatIndexToVrp(model, index), `${model} index ${index}`)
    })
  }
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

// ---------------------------------------------------------------------------
// Regressions for the six defects reported from a second machine
// (dsh-ensp-问题报告.md). Each test pins the symptom, not the implementation.
// ---------------------------------------------------------------------------

test('a system-view prompt with a dashed hostname is not mistaken for a sub-view', () => {
  // Reported symptom: the config engine kept issuing quit/system-view against a
  // device named `SW2-ACCESS`, so commands landed one view too high. Without a
  // known hostname the punctuation-only guess sees a dash and says "sub-view".
  assert.equal(viewOf('[SW2-ACCESS]', 'SW2-ACCESS'), 'system')
  assert.equal(viewOf('[SW2-ACCESS-GigabitEthernet0/0/1]', 'SW2-ACCESS'), 'sub')
  assert.equal(viewOf('[CORE-01]', 'CORE-01'), 'system')
  assert.equal(viewOf('[R1-TEST]', 'R1-TEST'), 'system')
  // The hostname is recoverable from the user-view prompt, which is how the
  // session learns it before it has to judge a bracketed prompt.
  assert.equal(hostnameOf('<SW2-ACCESS>'), 'SW2-ACCESS')
  assert.equal(hostnameOf('[SW2-ACCESS-GigabitEthernet0/0/1]'), 'SW2-ACCESS')
})

test('the console session only accepts a prompt after the command echo', () => {
  // Reported symptom: `apply` printed 16/16 while Vlanif10 was never created.
  // A prompt left over from the previous command satisfied the prompt match, so
  // the caller read a stale view and the next command went into a sub-view.
  const source = sourceOf('../src/core/console.mjs')
  assert.match(source, /#readToPrompt\(timeoutMs, settleMs = 60, echo = null\)/, 'echo parameter must exist')
  assert.match(source, /const sawEcho = !echo \|\| text\.includes\(echo\)/, 'prompt match must require the echo')
  assert.match(source, /const echo = command\.split\(/, 'exec must derive the echo from the command')
  // The old soft retry is gone: it read one more window and moved on regardless.
  assert.ok(!/if \(!echoed\) \{/.test(source), 'the soft echo retry must not come back')
})

test('re-running a configuration treats "already exists" as a no-op, not a failure', () => {
  // Reported symptom: the second `apply` always stopped at the first IP address
  // or VLAN with "already exists", which makes the normal edit-and-rerun loop
  // impossible.
  assert.equal(isIdempotentError('Error: The address already exists.'), true)
  assert.equal(isIdempotentError('Error: The VLAN already exists.'), true)
  assert.equal(isIdempotentError('Error: The route already exists.'), true)
  // A genuine rejection must still stop the batch, otherwise real mistakes hide.
  assert.equal(isIdempotentError("Error: Unrecognized command found at '^' position."), false)
  assert.equal(isIdempotentError('Error: Wrong parameter found at ^ position.'), false)
  assert.equal(isIdempotentError(''), false)
  assert.equal(isIdempotentError(null), false)
})

test('the two-PC preset creates the gateway interface the PCs point at', () => {
  // Reported symptom: `interface Vlanif20` failed with "The VLAN does not exist"
  // because the preset created the VLAN but never its Vlanif, while the topology
  // gave both PCs a gateway on that subnet.
  const topo = twoPcLab({ vlan: 10, subnet: '192.168.10' })
  const config = twoPcLabConfig({ vlan: 10, subnet: '192.168.10' })
  assert.match(config, /^vlan 10$/m)
  assert.match(config, /^interface Vlanif10$/m, 'the VLAN needs its interface')
  assert.match(config, /^ ip address 192\.168\.10\.254 255\.255\.255\.0$/m)
  // Every PC gateway must be an address the config actually assigns.
  const gateways = topo.devices
    .map((d) => /-simpc_gateway\s+(\S+)/.exec(d.settings ?? '')?.[1])
    .filter((g) => g && g !== '0.0.0.0')
  assert.ok(gateways.length >= 2, 'the preset gives both PCs a gateway')
  for (const gateway of gateways) assert.ok(config.includes(gateway), `gateway ${gateway} is configured`)
})

test('the vlan-access checks fail on a switch that was never configured', () => {
  // Reported symptom: the checks passed on a blank device. `minLines: 3` was
  // satisfied by VLAN 1 alone, and `contains: 'U'` matched the header `U: Up;`.
  const inVlan = { matches: /^(?!\s*1\s)(\d+)\s+common[^\n]*UT:GE\d\/0\/\d+\(U\)/m }
  // A blank switch already lists VLAN 1 with both ports untagged, which is what
  // the reported check let through.
  const blank = '1    common  default  UT:GE0/0/1(U)   GE0/0/2(U)\n'
  assert.equal(evaluateAssertion(blank, inVlan).pass, false, 'VLAN 1 alone is not a configured lab')

  const configured = '1    common  default\n10   common  default  UT:GE0/0/1(U)   GE0/0/2(U)\n'
  assert.equal(evaluateAssertion(configured, inVlan).pass, true)

  const header = 'U: Up;  D: Down;  TG: Tagged;  UT: Untagged;\nGE0/0/1  access  1  U: 1\nGE0/0/2  access  1  U: 1'
  assert.equal(evaluateAssertion(header, { contains: 'U' }).pass, true, 'the old check proves the point: it matches the legend')
})

test('every DSH tool output satisfies its own schema on an empty branch', () => {
  // Reported symptom: all 14 tools returned INVALID_TOOL_OUTPUT because branches
  // that returned nothing left required keys missing. `conform` fills those keys
  // with the empty value for their type, and must never overwrite a real value.
  const schema = {
    type: 'object',
    required: ['device', 'ok', 'count', 'items', 'detail', 'error'],
    properties: {
      device: { type: 'string' },
      ok: { type: 'boolean' },
      count: { type: 'number' },
      items: { type: 'array' },
      detail: { type: 'object' },
      error: { type: 'string' },
    },
  }
  assert.deepEqual(conform(schema, { device: 'SW1', ok: true }), {
    device: 'SW1',
    ok: true,
    count: 0,
    items: [],
    detail: {},
    error: '',
  })
  // A branch that did return a value keeps it, including a failure description.
  const reported = conform(schema, { device: 'SW1', ok: false, error: 'boom' })
  assert.equal(reported.ok, false)
  assert.equal(reported.error, 'boom')
  // Values that are not objects pass through untouched.
  assert.equal(conform(schema, 'plain'), 'plain')
  assert.equal(conform(null, 7), 7)
})

test('exec ignores a prompt that arrived before its own command echo', async () => {
  // The reported defect, reproduced without a device. `apply` sent `system-view`,
  // got an answer whose prompt belonged to the *previous* command, decided it was
  // in a sub-view, and sent `quit`; every following line then went one view too
  // high while the batch still reported success.
  class FakeSocket extends EventEmitter {
    setEncoding() {}
    destroy() {}
    write(text) {
      this.sent.push(text)
      this.onWrite?.(text)
    }
    constructor() {
      super()
      this.sent = []
    }
  }

  const socket = new FakeSocket()
  const session = new ConsoleSession(socket, 'SW2-ACCESS')
  session.prime = async () => '<SW2-ACCESS>'

  // First command: the reply is the old prompt alone, then the real answer.
  socket.onWrite = (text) => {
    if (!/^vlan 10\r$/.test(text)) return
    // A leftover prompt from an earlier command reaches us first. It is a
    // sub-view prompt, and taking it seriously is exactly the bug.
    setTimeout(() => socket.emit('data', '[SW2-ACCESS-GigabitEthernet0/0/1]'), 5)
    setTimeout(() => socket.emit('data', '\r\nvlan 10\r\n[SW2-ACCESS]'), 25)
  }

  const result = await session.exec('vlan 10', { timeoutMs: 3000 })
  assert.equal(result.prompt, '[SW2-ACCESS]', 'the prompt must come from this command, not the previous one')
  assert.equal(result.view, 'system', 'a dashed hostname in system view is not a sub-view')
  assert.match(result.output, /vlan 10/, 'the transcript keeps the echo')
})

test('exec accepts a reply whose echo and prompt arrive in one chunk', async () => {
  // The fast path: VRP often writes echo and prompt together. The echo guard must
  // not turn that into a timeout.
  class FakeSocket extends EventEmitter {
    setEncoding() {}
    destroy() {}
    write(text) {
      if (/^quit\r$/.test(text)) setImmediate(() => this.emit('data', 'quit\r\n[SW2-ACCESS]'))
    }
  }
  const session = new ConsoleSession(new FakeSocket(), 'SW2-ACCESS')
  session.prime = async () => '[SW2-ACCESS-Vlanif10]'
  const result = await session.exec('quit', { timeoutMs: 3000 })
  assert.equal(result.prompt, '[SW2-ACCESS]')
  assert.equal(result.view, 'system')
})

test('install paths are found by probing, not by assuming E:', async () => {
  // Reported symptom: the tool hard-coded `E:\Huawei\eNSP\eNSP_Client.exe`, so on
  // a machine with `C:\Program Files\Huawei\eNSP` every launch failed with
  // `Start-Process : 系统找不到指定的文件`.
  const { enspCandidates, vboxCandidates, probePaths, resolveEnspExe } = await import('../src/core/paths.mjs')

  const ensp = enspCandidates('D:/somewhere/eNSP_Client.exe')
  assert.equal(ensp[0].path, 'D:/somewhere/eNSP_Client.exe', 'an explicit path is tried first')
  assert.equal(ensp[0].source, 'override')
  assert.ok(
    ensp.some((c) => /^C:[\\/]Program Files[\\/]Huawei[\\/]eNSP/i.test(c.path)),
    'the default Program Files location is tried',
  )
  assert.ok(ensp.length >= 4, 'several candidates, so one wrong guess does not end the search')

  // The environment variable is the documented escape hatch for a non-standard
  // install, so it has to appear in the list when set.
  const saved = process.env.DSH_ENSP_EXE
  try {
    process.env.DSH_ENSP_EXE = 'D:/custom/eNSP_Client.exe'
    const withEnv = enspCandidates()
    assert.equal(withEnv[0].source, 'DSH_ENSP_EXE')
    assert.equal(withEnv[0].path, 'D:/custom/eNSP_Client.exe')
  } finally {
    if (saved === undefined) delete process.env.DSH_ENSP_EXE
    else process.env.DSH_ENSP_EXE = saved
  }

  const vbox = vboxCandidates()
  assert.ok(vbox.some((c) => /VBoxManage\.exe$/i.test(c.path)))

  // The probe reports what it found and what it tried. It must never throw on a
  // machine where nothing is installed, because `doctor` has to report that.
  // `probePaths` is the non-throwing form used by doctor, so it has to answer the
  // same way on every platform: a hit carries the path and where it came from, a
  // miss carries ok:false and no path. CI runs on Linux, where nothing is found,
  // and that branch is as important as the hit.
  const found = probePaths({})
  assert.ok('ensp' in found && 'vbox' in found)
  for (const entry of [found.ensp, found.vbox]) {
    if (entry.ok) {
      assert.ok(entry.path, 'a hit carries a path')
      assert.ok(entry.source, 'a hit says where the path came from')
    } else {
      assert.equal(entry.path, null, 'a miss reports no path')
    }
  }

  // An explicit path that does not exist must fail loudly. Silently using a
  // different installation is worse than failing: the user pointed at a machine
  // and would be told the opposite of the truth.
  assert.throws(
    () => resolveEnspExe('D:/definitely/not/here/eNSP_Client.exe'),
    /does not exist/,
    'a wrong explicit path is reported, not replaced by a guess',
  )
})

test('the installer registry is consulted before the usual roots', async () => {
  // An eNSP installed on F: with no entry in the four usual roots is still
  // findable, because Inno Setup records it under the uninstall key. This test
  // does not assert that such an entry exists here: it asserts the source code
  // reads that key at all, which is what a machine with a non-standard install
  // depends on.
  const source = sourceOf('../src/core/paths.mjs')
  assert.ok(
    /CurrentVersion\\+Uninstall\\+eNSP/.test(source),
    'the uninstall key Inno Setup writes must be read',
  )
  assert.ok(
    /SOFTWARE\\+Oracle\\+VirtualBox/.test(source),
    'VirtualBox records InstallDir in the registry, so it must be read too',
  )

  const { enspCandidates, vboxCandidates } = await import('../src/core/paths.mjs')
  for (const list of [enspCandidates(), vboxCandidates()]) {
    const rootIndex = list.findIndex((c) => c.source === 'install root')
    const registryIndex = list.findIndex((c) => c.source.includes('Uninstall') || c.source.includes('Oracle'))
    if (registryIndex >= 0 && rootIndex >= 0) {
      assert.ok(
        registryIndex < rootIndex,
        'a registry hit is tried before a guessed install root, because the guess may name a different copy',
      )
    }
  }
})

test('the curriculum index points every chapter at a real scenario', async () => {
  const { curriculumLevels, curriculumChapters, curriculumFor, searchCurriculum } = await import(
    '../src/core/curriculum.mjs'
  )
  const { SCENARIOS } = await import('../src/core/presets.mjs')

  // Study order is the order a reader meets the manuals, so the levels have to be
  // exactly these three rather than whatever a stray chapter title produced.
  assert.deepEqual(curriculumLevels(), ['HCIA', 'HCIP', 'HCIE'])

  const chapters = curriculumChapters()
  assert.ok(chapters.length >= 20, 'expected a substantial chapter index, got ' + chapters.length)

  const seen = new Set()
  for (const chapter of chapters) {
    const key = chapter.level + '|' + chapter.title
    assert.ok(!seen.has(key), 'duplicate chapter: ' + key)
    seen.add(key)

    assert.ok(['HCIA', 'HCIP', 'HCIE'].includes(chapter.level), 'unknown level ' + chapter.level)
    assert.ok(chapter.title && chapter.title.length > 2, 'chapter needs a title')
    assert.ok(Number.isInteger(chapter.page) && chapter.page > 0, chapter.title + ' needs a page number')

    // A scenario id that does not exist would render a dead pointer in the brief.
    for (const id of chapter.scenarios) {
      assert.ok(SCENARIOS[id], chapter.title + ' points at unknown scenario ' + id)
    }
    assert.ok(chapter.scenarios.length > 0, chapter.title + ' teaches no scenario')

    // Verification commands come from the manual, so they must be the two kinds of
    // command a lab actually proves things with.
    for (const command of chapter.verify) {
      assert.match(command, /^(display|ping|tracert)\s/, chapter.title + ': unexpected command ' + command)
      // The extractor fuses a command with the next token when a page break lands
      // between them; that produced 'display ip routing-tableprotocol ospf'.
      assert.ok(!/routing-tableprotocol|briefprotocol|interfaceverbose/.test(command), 'fused command ' + command)
    }
  }

  // Both directions of the lookup must agree.
  const taught = curriculumFor('ospf-lsa-types')
  assert.ok(taught.length > 0, 'ospf-lsa-types should have a chapter')
  for (const chapter of taught) assert.ok(chapter.scenarios.includes('ospf-lsa-types'))

  assert.deepEqual(curriculumFor('__probe-not-a-scenario'), [], 'unknown scenario has no chapter')
  assert.ok(searchCurriculum('bgp').length > 0, 'chapter search should find BGP')
  assert.ok(searchCurriculum('BGP').length === searchCurriculum('bgp').length, 'search is case-insensitive')
  assert.deepEqual(searchCurriculum(''), [], 'an empty query matches nothing')
})

test('the curriculum generator is deterministic and keeps chapters in study order', async () => {
  const { buildCurriculum } = await import('../scripts/gen-curriculum.mjs')

  // A miniature extract covering the shapes that matter: a chapter whose commands
  // came back fused, one whose goals are exam questions, and one on a platform
  // manual that must be skipped because its sibling already covers it.
  const source = [
    {
      manual: 'HCIP-Core.pdf.json',
      level: 'HCIP',
      chapter: '1',
      title: 'OSPF 基础实验',
      page: 7,
      goals: ['实现单区域OSPF 的配置', '思考：为什么需要区域划分？'],
      verify: ['display ip routing-tableprotocol ospf', 'display ospf peer'],
    },
    {
      manual: 'HCIE-VRP.pdf.json',
      level: 'HCIE',
      chapter: '1',
      title: 'IPv4 路由技术',
      page: 10,
      goals: ['实现部署BFD 加快OSPF 收敛速度'],
      verify: ['display ospf bfd session all'],
    },
    {
      manual: 'HCIE-YunShan_OS.pdf.json',
      level: 'HCIE',
      chapter: '1',
      title: 'IPv4 路由技术',
      page: 10,
      goals: ['实现部署BFD'],
      verify: ['display ospf bfd session all'],
    },
  ]

  const index = buildCurriculum(source)
  assert.deepEqual(Object.keys(index.levels), ['HCIA', 'HCIP', 'HCIE'])

  const chapters = index.levels.HCIP.concat(index.levels.HCIE)
  assert.equal(chapters.length, 2, 'the platform-specific duplicate is skipped')

  // HCIA sorts before HCIP before HCIE, so the flat order matches the study order.
  assert.equal(chapters[0].level, 'HCIP')
  assert.equal(chapters[1].level, 'HCIE')

  const ospf = chapters[0]
  assert.deepEqual(ospf.verify, ['display ip routing-table protocol ospf', 'display ospf peer'].sort((a, b) =>
    ospf.verify.indexOf(a) - ospf.verify.indexOf(b),
  ))
  // Thinking questions are not learning goals.
  assert.ok(!ospf.goals.some((g) => g.includes('思考')), 'exam questions are dropped from goals')

  // Same input, same output: the file is generated, so a churning diff would make
  // every regeneration look like a change.
  assert.deepEqual(buildCurriculum(source), buildCurriculum(source))
})

test('the bundle manifest declares what DSH 0.2 checks before loading it', async () => {
  // DSH 0.2.1-alpha.3 made `engines.dsh` the single compatibility answer: when it
  // is present, the @deepseek-ai/dsh peer ranges are ignored, so the range here has
  // to cover every release the plugin actually runs on. Without it, profile
  // startup falls back to peers, and this package declares none.
  const { existsSync } = await import('node:fs')
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

  assert.ok(manifest.engines && typeof manifest.engines === 'object', 'engines must stay an object')
  const range = manifest.engines.dsh
  assert.equal(typeof range, 'string', 'engines.dsh must be a string')

  // A `workspace:` value is only legal in peers; in engines.dsh it is treated as
  // incompatible, which would refuse the package at install time.
  assert.ok(!range.includes('workspace:'), 'workspace: is not a version range')
  assert.ok(range.trim() !== '', 'an empty range matches nothing')

  // Both bounds are needed. An unbounded range would promise compatibility with a
  // DSH major that has not been tested, which is the failure this declaration
  // exists to prevent.
  const bounds = /^>=(\d+)\.(\d+)\.(\d+)(?:-[\w.]+)? <(\d+)\.(\d+)\.(\d+)/.exec(range)
  assert.ok(bounds, 'engines.dsh needs a lower and an upper bound, got ' + range)
  assert.equal(Number(bounds[1]), 0, 'the lower bound is a 0.x DSH')
  assert.equal(Number(bounds[4]), 0, 'the upper bound is the next 0.x, not 1.0')
  assert.ok(
    Number(bounds[5]) > Number(bounds[2]),
    'the upper bound must be above the lower bound',
  )

  // `dsh.bundle.platforms` is validated before the layer composes. eNSP has no
  // build outside Windows, so a bundle that claims otherwise would be activated on
  // a host where every device operation must fail.
  const bundle = manifest.dsh?.bundle
  assert.ok(bundle, 'dsh.bundle is what makes this an installable bundle')
  assert.equal(bundle.patch, './cordis.patch.yml')
  assert.ok(Array.isArray(bundle.platforms) && bundle.platforms.length > 0, 'platforms must be a non-empty list')
  for (const platform of bundle.platforms) {
    assert.equal(typeof platform, 'string')
    assert.ok(
      platform === 'wsl' || platform === 'win32',
      'unexpected platform ' + platform + ': eNSP only runs on Windows',
    )
  }
  assert.ok(bundle.platforms.includes('win32'), 'win32 has to be admitted, or the bundle never loads here')
})

test('locale metadata is readable and its detail documents ship with the package', async () => {
  // Since DSH 0.2.0-rc.2 a package-root plugin no longer has its subpath
  // package.json read for display metadata: the title, description and long
  // document come from locale/<language>.json. Without these files the plugin
  // manager falls back to the bare package name.
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const root = new URL('../', import.meta.url)

  assert.equal(manifest.exports['./package.json'], './package.json', 'package fields are read through this export')
  assert.equal(manifest.exports['./locale/*.json'], './locale/*.json', 'locale files are read through this export')
  assert.ok(
    manifest.files.includes('locale/*.json'),
    'the locale files must be published, or the installed package has no metadata',
  )

  for (const language of ['en', 'zh']) {
    const file = new URL('locale/' + language + '.json', root)
    const meta = JSON.parse(readFileSync(file, 'utf8')).meta
    assert.ok(meta, language + ' needs a meta object')
    for (const field of ['title', 'description']) {
      assert.equal(typeof meta[field], 'string', language + '.' + field + ' must be a string')
      assert.ok(meta[field].trim() !== '', language + '.' + field + ' must not be empty')
    }

    // `meta.detail` is a bare relative path with no fallback. A root-level
    // document is rejected by DSH because its neighbouring images would not be
    // published, so the path has to name a file inside a shipped directory.
    const detail = meta.detail
    assert.equal(typeof detail, 'string', language + ' should name a detail document')
    assert.ok(detail.endsWith('.md') || detail.endsWith('.markdown'), 'detail must be Markdown')
    assert.ok(!detail.startsWith('/') && !detail.includes('\\'), 'detail uses / and stays relative')
    assert.ok(detail.includes('/'), 'a root-level document is rejected')
    assert.ok(
      existsSync(new URL(detail, root)),
      language + ' detail document is missing: ' + detail,
    )

    // The top-level directory has to be listed in `files`. Without it the
    // document is present in the repository and absent from the package.
    const top = detail.split('/')[0]
    assert.ok(
      manifest.files.includes(top),
      'the directory holding ' + detail + ' must be in files',
    )
  }
})

test('a blueprint addressing plan turns into commands VRP would accept', () => {
  // The point of `labconfig.mjs` is that the table can be executed instead of
  // retyped. A row whose prefix cannot be parsed, or a port the blueprint never
  // declared, would produce a script that fails halfway through a device.
  assert.equal(maskFromPrefix(24), '255.255.255.0')
  assert.equal(maskFromPrefix(30), '255.255.255.252')
  assert.equal(maskFromPrefix(32), '255.255.255.255')
  assert.equal(maskFromPrefix(8), '255.0.0.0')
  // A shift count of 32 is taken modulo 32 in JavaScript, so a naive
  // `0xffffffff << (32 - bits)` answers /0 with 255.255.255.255.
  assert.equal(maskFromPrefix(0), '0.0.0.0')
  assert.equal(maskFromPrefix(1), '128.0.0.0')
  assert.equal(addressCommand('10.0.12.1/30'), 'ip address 10.0.12.1 255.255.255.252')
  assert.equal(addressCommand('2001:db8:1::1/128'), 'ipv6 address 2001:db8:1::1/128')
  assert.throws(() => addressCommand('10.0.0.1'), /no prefix length/)
  assert.throws(() => addressCommand('10.0.0.1/x'), /not a number/)

  for (const id of LAB_IDS) {
    const rows = labAddressing(id)
    if (!rows.length) {
      assert.equal(hasLabConfig(id), false, id + ' has no addressing, so it has no script')
      assert.deepEqual(labConfigs(id), [], id + ' must not invent a script')
      continue
    }
    assert.equal(hasLabConfig(id), true, id + ' has addressing, so it has a script')

    const declared = new Set(rows.map((row) => row.device))
    const configs = labConfigs(id)
    assert.equal(configs.length, declared.size, id + ' emits one block per device')

    for (const entry of configs) {
      assert.ok(declared.has(entry.device), id + ' script names an undeclared device ' + entry.device)
      const commands = parseScript(entry.script).map((c) => c.command)
      assert.equal(commands[0], 'system-view', id + ' script starts in system view')
      assert.equal(commands[commands.length - 1], 'return', id + ' script leaves system view')

      // Scope guard: the plan is addresses only. A routing protocol here would
      // hand the reader the answer the scenario is asking them to produce.
      for (const command of commands) {
        assert.match(
          command,
          /^(system-view|quit|return|interface \S+|ip address \S+ \S+|ipv6 address \S+)$/,
          id + ' script leaked a non addressing command: ' + command,
        )
      }

      // Ports must be the ones the blueprint declared, spelled the way VRP
      // spells them.
      const ports = commands.filter((c) => c.startsWith('interface ')).map((c) => c.slice(10))
      const expected = rows.filter((r) => r.device === entry.device).map((r) => r.port)
      assert.deepEqual(ports, expected, id + ' ports for ' + entry.device)
    }
  }

  assert.equal(countLabConfigs(), LAB_IDS.filter((id) => labAddressing(id).length > 0).length)
  assert.equal(countLabConfigs(), 45, 'five blueprints are layer 2 only and carry no addresses')
})

test('the generated script names each device once and is stable across calls', () => {
  const first = labConfigScript('ospf-single')
  assert.equal(first, labConfigScript('ospf-single'), 'generation must be deterministic')
  assert.match(first, /^# R1\nsystem-view\n/)
  assert.equal(first.split('\n# ').length, 3, 'one comment header per device')
  assert.equal(labConfigScript('vlan-access'), '', 'a blueprint without addresses yields nothing')
})

test('a serial port is drawn as a serial line, not a copper one', () => {
  // Wiring a Serial port with the default Copper media renders the topology and
  // keeps the console answering, but the line never comes up and `link-protocol
  // ppp` looks broken. eNSP stores the distinction as lineName="Serial".
  const copper = buildTopology({}).add('R1', 'Router', { x: 0, y: 0 }).add('R2', 'Router', { x: 200, y: 0 })
  copper.link('R1', 'GigabitEthernet0/0/0', 'R2', 'GigabitEthernet0/0/0', {}).finish()
  const serial = buildTopology({}).add('R1', 'Router', { x: 0, y: 0 }).add('R2', 'Router', { x: 200, y: 0 })
  serial.link('R1', 'Serial0/0/0', 'R2', 'Serial0/0/0', {}).finish()

  const copperXml = copper.toXml()
  const serialXml = serial.toXml()
  assert.match(copperXml, /lineName="Copper"/)
  assert.match(serialXml, /lineName="Serial"/)
  assert.doesNotMatch(serialXml, /lineName="Copper"/)
})

test('the render gate counts devices instead of counting pixels', () => {
  // The old gate compared saturated-blue and near-black pixel counts to fixed
  // thresholds. A single-device lab has no link strokes, so it was reported as
  // never rendered, while the welcome page scored high enough to count as one.
  // The gate must therefore be structural: eNSP gives each canvas device a hidden
  // Edit child, and the count has to reach the window API rather than the canvas.
  const source = sourceOf('../src/core/launcher.mjs')
  assert.match(source, /export function canvasDeviceCount\(hwnd\)/)
  assert.match(source, /export function topologyRendered\(hwnd\) \{\n  return canvasDeviceCount\(hwnd\) >= 1\n\}/)
  assert.doesNotMatch(source, /icon >= 15 && dark >= 40/, 'the pixel threshold must be gone')
  assert.doesNotMatch(source, /icon=\(\\\\d\+\) dark=/, 'the pixel counter must be gone')
})

test('the docx writer produces a package Word can open', () => {
  // The writer has no dependency, so the only way to know the zip and the OOXML
  // parts are well formed is to read them back with an independent reader.
  const buffer = buildDocx([
    { type: 'title', text: '标题' },
    { type: 'heading', level: 1, text: '一、实验目的' },
    { type: 'para', text: '正文含 **加粗** 与 `命令`。' },
    { type: 'code', text: 'system-view\n sysname R1' },
    { type: 'table', header: ['设备', '地址'], rows: [['R1', '10.0.12.1/24']] },
  ])
  assert.ok(buffer.length > 1000, 'a document with five blocks is not tiny')

  const text = docxText(buffer)
  assert.match(text, /标题/)
  assert.match(text, /一、实验目的/)
  assert.match(text, /正文含 加粗 与 命令。/, 'inline markers must become plain runs')
  assert.match(text, /system-view/)
  assert.match(text, /10\.0\.12\.1\/24/)

  // The package must carry the four parts a reader looks for, not just document.xml.
  const entries = zip([
    { name: '[Content_Types].xml', data: 'x' },
    { name: 'word/document.xml', data: 'y' },
  ])
  assert.match(entries.toString('latin1'), /\[Content_Types\]\.xml/)
})

test('a report says unverified when the lab proved nothing', async () => {
  // The whole point of the three-state verdict: a lab whose checks had no
  // assertion must not produce a document that reads like a pass.
  const query = async () => ({ ok: true, output: '' })
  const evidence = await collectEvidence({ id: 'firewall-zones', query })
  assert.equal(evidence.verdict.ok, null)
  assert.ok(evidence.checks.every((c) => c.pass === null))

  const blocks = buildReportBlocks(evidence)
  const flat = JSON.stringify(blocks)
  assert.match(flat, /未验证/)
  assert.doesNotMatch(flat, /验证通过/)
})

test('a report quotes each device configuration and each verification output', async () => {
  const config = 'sysname R1\n#\ninterface GigabitEthernet0/0/0\n ip address 10.0.12.1 255.255.255.0'
  const answers = {
    'display current-configuration': config,
    'display ospf peer brief': 'Area Id   Interface   Neighbor id   State\n0.0.0.0   GE0/0/0     2.2.2.2       Full',
    'display ip routing-table protocol ospf':
      'Destination/Mask  Proto  Pre  Cost  Flags NextHop  Interface\n10.0.23.0/24  OSPF  10  2  D  10.0.12.2  GE0/0/0',
  }
  const query = async ({ command }) => ({ ok: true, output: answers[command] ?? '' })
  const evidence = await collectEvidence({ id: 'ospf-single', query })

  assert.equal(evidence.verdict.ok, true)
  assert.equal(evidence.devices.length, 3)
  assert.equal(evidence.links.length, 3)
  assert.equal(evidence.addressing.length, 9)
  assert.ok(evidence.configs.every((c) => c.text.includes('sysname R1')))

  // Every check keeps the device's own words, not a summary of them.
  const peer = evidence.checks.find((c) => c.id === 'neighbour-full')
  assert.match(peer.output, /Full/)
  const route = evidence.checks.find((c) => c.id === 'ospf-route')
  assert.match(route.output, /10\.0\.23\.0\/24/)

  const blocks = buildReportBlocks(evidence)
  const flat = JSON.stringify(blocks)
  assert.match(flat, /验证通过/)
  for (const chapter of ['一、实验目的', '二、拓扑与地址规划', '三、配置思路与命令', '四、验证结果', '五、问题与结论', '六、附录']) {
    assert.match(flat, new RegExp(chapter), `missing chapter ${chapter}`)
  }
})

test('writeReport writes a .docx that a reader can open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ensp-report-'))
  const out = join(dir, 'ospf-single.docx')
  try {
    const query = async ({ command }) => ({
      ok: true,
      output:
        command === 'display current-configuration'
          ? 'sysname R1'
          : command === 'display ospf peer brief'
            ? 'State\nFull'
            : 'Destination/Mask Proto\n10.0.23.0/24 OSPF',
    })
    const result = await writeReport({ id: 'ospf-single', out, query })
    assert.equal(result.path, out)
    assert.ok(existsSync(out))
    const text = docxText(readFileSync(out))
    assert.match(text, /实验报告/)
    assert.match(text, /10\.0\.23\.0\/24/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
