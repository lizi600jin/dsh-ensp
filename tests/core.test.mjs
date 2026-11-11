/**
 * Regression tests for the pieces that were actually broken during development.
 *
 * These are deliberately narrow: each case corresponds to a real failure that cost
 * debugging time, so a future refactor cannot silently reintroduce it.
 *
 * Run with `npm test` (node:test, no dependencies).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { viewOf, hostnameOf } from '../src/core/console.mjs'
import { parseScript } from '../src/core/provision.mjs'
import {
  interfaceName,
  interfaceIndex,
  parseTopology,
  serialiseTopology,
} from '../src/core/topology.mjs'
import { buildTopology, twoPcLab, MODEL_SPECS, vrpToFlatIndex } from '../src/core/build.mjs'

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

  assert.equal(registered.length, 12, 'expected 12 tools')

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
