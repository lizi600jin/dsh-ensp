/**
 * DeepSeek Harness plugin row.
 *
 * A thin adapter: it publishes the same operations the CLI and the MCP server
 * expose as **model tools**, so an agent can drive an eNSP lab inside a Harness
 * session. No behaviour lives here; everything delegates to `src/core`.
 *
 * ## Tool contract
 *
 * `ctx.tools.register` wants a shape that differs from the MCP schema in two ways,
 * and getting either wrong fails activation with a schema complaint rather than a
 * stack trace:
 *
 *   - `parameters` is a **flat map of field name to field schema**, not a JSON
 *     Schema object with `properties`.
 *   - `output` is **required** and pairs a closed `schema` with a `render`
 *     function that turns the handler's value into content blocks.
 *
 * The helpers below mirror what the first-party plugins do, so the two front-ends
 * stay readable side by side.
 *
 * @module dsh-ensp/dsh
 */

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { buildTopology, twoPcLab, twoPcLabConfig, autoLayout } from '../core/build.mjs'
import { readTopology, writeTopology, summarise } from '../core/topology.mjs'
import {
  LAB_IDS,
  buildScenarioTopology,
  hasLab,
  labAddressing,
  labDevices,
} from '../core/labs.mjs'
import { checkTopologySupport } from '../core/compat.mjs'
import {
  enspPid,
  locateWindow,
  launchEnsp,
  startAllDevices,
  stopAllDevices,
  waitForConsole,
} from '../core/launcher.mjs'
import { calibrateAnchors, inspectAnchors } from '../core/calibrate.mjs'
import { pushConfig, pushConfigMany, queryDevice } from '../core/provision.mjs'
import { SCENARIOS, SCENARIO_IDS, renderScenario, searchScenarios, byLevel } from '../core/presets.mjs'
import { VERSION } from '../core/version.mjs'

/** Declared hard dependency: the tool registry. */
export const inject = ['tools']

export const name = 'ensp'

// ---------------------------------------------------------------- schema helpers
//
// `req()` marks a field as required for the *author*, and `obj()` compiles the
// marker away into the JSON-Schema form the validator accepts: a top-level
// `required` array of names, never a `required: true` on the leaf.
//
// Leaving the marker on the leaf fails activation with
//   unsupported JSON schema: schema.properties.x.required is not supported on type "boolean"

const str = (description) => ({ type: 'string', ...(description ? { description } : {}) })
const num = (description) => ({ type: 'number', ...(description ? { description } : {}) })
const bool = (description) => ({ type: 'boolean', ...(description ? { description } : {}) })
const arr = (description) => ({ type: 'array', items: { type: 'object' }, ...(description ? { description } : {}) })

/** Mark an output field required. The marker is consumed by `obj()`. */
const req = (node) => Object.assign(node, { required: true })

/**
 * Turn an author-facing property map into a closed JSON Schema object,
 * hoisting every leaf `required: true` into the object-level array.
 */
function compileObject(properties) {
  const compiled = {}
  const required = []
  for (const key of Object.keys(properties ?? {})) {
    const child = properties[key]
    if (child && typeof child === 'object' && child.required === true) required.push(key)
    compiled[key] = stripRequired(child)
  }
  const schema = { type: 'object', additionalProperties: false, properties: compiled }
  if (required.length) schema.required = required
  return schema
}

/** Deep-copy a node without the internal `required` marker. */
function stripRequired(node) {
  if (node === null || typeof node !== 'object') return node
  if (Array.isArray(node)) return node.map(stripRequired)
  const out = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === 'required') continue
    out[key] = stripRequired(value)
  }
  return out
}

/** Declare a closed output object. */
const obj = (properties) => compileObject(properties)

/** One plain text content block. */
const text = (value) => [{ type: 'text', text: String(value) }]

/** Render a JSON payload for display without depending on any UI helper. */
const showJson = (value) => text(JSON.stringify(value, null, 2))

/**
 * Register one tool with the harness.
 *
 * @param {object} tools - `ctx.tools`
 * @param {object} definition - `{ name, description, parameters, output, execute }`
 */
function add(tools, definition) {
  const { execute, ...rest } = definition
  return tools.register({
    ...rest,
    async execute(args) {
      return execute(args ?? {})
    },
  })
}

/**
 * Build the plugin.
 *
 * @param {object} ctx - Cordis context carrying the declared services.
 */
export function apply(ctx) {
  const tools = ctx.tools
  if (!tools?.register) {
    console.warn('[dsh-ensp] tools service unavailable; plugin inactive')
    return
  }

  /* ------------------------------------------------------------------ status */

  add(tools, {
    name: 'ensp_status',
    description:
      'Report eNSP state: whether the client is running, its window handle, and the calibrated toolbar anchors. '
      + 'With a topology path, also polls every device console and reports which ones answer VRP.',
    parameters: {
      topology: str('Optional .topo path; when set, each console is probed (max 4s each).'),
    },
    output: {
      schema: obj({
        running: req(bool()),
        pid: req(num()),
        hwnd: req(str()),
        anchors: req(str()),
        devices: req(str()),
        error: req(str()),
      }),
      render(args, value) {
        if (!value.running) return text('eNSP is not running.')
        const lines = [`eNSP running, pid ${value.pid}, hwnd ${value.hwnd || '(no frame)'}`]
        if (value.anchors) lines.push(value.anchors)
        if (value.devices) lines.push('', value.devices)
        if (value.error) lines.push('', value.error)
        return text(lines.join('\n'))
      },
    },
    async execute({ topology }) {
      const pid = enspPid()
      if (!pid) return { running: false }
      const hwnd = locateWindow(pid)
      let anchors = ''
      if (hwnd) {
        const a = calibrateAnchors(hwnd)
        anchors = `toolbar anchors (${a.method}): start ${JSON.stringify(a.start)}, stop ${JSON.stringify(a.stop)}`
      }
      let devices = ''
      if (topology) {
        const topo = await readTopology(topology)
        const rows = await Promise.all(
          topo.devices
            .filter((d) => d.comPort)
            .map(async (d) => {
              const r = await waitForConsole({ port: d.comPort, timeoutMs: 4000 })
              return `${r.ready ? 'ready' : 'no answer'}  ${d.name}  :${d.comPort}  ${r.prompt ?? ''}`.trimEnd()
            }),
        )
        devices = rows.join('\n')
      }
      return { running: true, pid, hwnd: hwnd ?? '', anchors, devices }
    },
  })

  /* -------------------------------------------------------------- build topo */

  add(tools, {
    name: 'ensp_build_topology',
    description:
      'Generate a .topo file eNSP can open. Use preset "two-pc" for the built-in two-PC lab, '
      + 'scenario for the topology behind a scenario id, or pass devices and links (links use VRP '
      + 'interface names such as GigabitEthernet0/0/0).',
    parameters: {
      path: str('Output .topo path.'),
      preset: str('"two-pc" for the built-in lab.'),
      scenario: str('Scenario id with a topology blueprint, e.g. "ospf-single".'),
      vlan: num('VLAN id for the two-pc preset (default 10).'),
      devices: arr('Device list: [{ name, model, x, y }].'),
      links: arr('Link list: [{ a, aPort, b, bPort }].'),
    },
    output: {
      schema: obj({
        path: req(str()),
        devices: req(num()),
        links: req(num()),
        consoles: req(str()),
        error: req(str()),
      }),
      render(args, value) {
        if (value.error) return text(value.error)
        return text(
          `wrote ${value.path}\n${value.devices} devices, ${value.links} links\nconsoles: ${value.consoles}`,
        )
      },
    },
    async execute(args) {
      if (!args.path) throw new Error('path is required')
      let topo
      if (args.scenario) {
        if (!hasLab(args.scenario)) {
          throw new Error(
            `scenario "${args.scenario}" has no topology blueprint; ${LAB_IDS.length} of ${SCENARIO_IDS.length} have one`,
          )
        }
        topo = buildScenarioTopology(args.scenario)
      } else if (args.preset === 'two-pc' || (!args.devices && !args.links)) {
        topo = twoPcLab({ vlan: args.vlan ?? 10 })
      } else {
        const b = buildTopology()
        for (const d of args.devices ?? []) b.add(d.name, d.model, { x: d.x, y: d.y, pc: d.pc })
        for (const l of args.links ?? []) b.link(l.a, l.aPort, l.b, l.bPort)
        topo = autoLayout(b.finish())
      }
      const target = path.resolve(args.path)
      await writeTopology(target, topo)
      const info = summarise(topo)
      const detail = args.scenario
        ? '\n' + labDevices(args.scenario).join('\n')
        : ''
      const support = checkTopologySupport(topo)
      const warning = support.ok
        ? ''
        : '\nWARNING: this machine cannot start ' +
          support.blocked.map((b) => `${b.name} (${b.model}: ${b.reason})`).join(', ') +
          ' -- eNSP will open the file and then quit'
      return {
        path: target,
        devices: info.devices,
        links: info.links,
        consoles: JSON.stringify(info.consoles) + detail + warning,
      }
    },
  })

  /* ------------------------------------------------------------------- open */

  add(tools, {
    name: 'ensp_open',
    description: 'Launch the eNSP client (or reuse the running one) and open a topology file.',
    parameters: { topology: str('Absolute path to a .topo file.') },
    output: {
      schema: obj({
        pid: req(num()),
        hwnd: req(str()),
        reused: req(bool()),
        error: req(str()),
      }),
      render(args, value) {
        return text(`eNSP pid ${value.pid}, hwnd ${value.hwnd}${value.reused ? ' (reused)' : ' (launched)'}`)
      },
    },
    async execute({ topology }) {
      if (!topology) throw new Error('topology is required')
      const r = await launchEnsp({ topology: path.resolve(topology) })
      return { pid: r.pid, hwnd: r.hwnd, reused: Boolean(r.reused) }
    },
  })

  /* ------------------------------------------------------------------ start */

  add(tools, {
    name: 'ensp_start',
    description:
      'Boot every device in a topology. Calibrates the toolbar by colour, clicks start, then polls each '
      + 'console until VRP answers, so readiness is measured per device rather than assumed. The window is '
      + 'minimised afterwards unless keepWindow is true.',
    parameters: {
      topology: str('Absolute path to the .topo file that is currently open.'),
      perDeviceTimeoutMs: num('Per-device readiness ceiling in ms (default 240000).'),
      keepWindow: bool('Leave the eNSP window visible after starting.'),
    },
    output: {
      schema: obj({
        allReady: req(bool()),
        ready: req(num()),
        total: req(num()),
        anchors: req(str()),
        devices: req(str()),
        error: req(str()),
      }),
      render(args, value) {
        if (value.error) return text(value.error)
        const head = `${value.ready}/${value.total} devices ready${value.allReady ? '' : ' (some did not answer)'}`
        return text([head, value.anchors, '', value.devices].filter(Boolean).join('\n'))
      },
    },
    async execute(args) {
      if (!args.topology) throw new Error('topology is required')
      const topo = await readTopology(path.resolve(args.topology))
      const hwnd = locateWindow(enspPid())
      if (!hwnd) throw new Error('eNSP window not found; call ensp_open first')
      const r = await startAllDevices({
        devices: topo.devices,
        hwnd,
        perDeviceTimeoutMs: args.perDeviceTimeoutMs ?? 240000,
        minimise: !args.keepWindow,
      })
      return {
        allReady: r.allReady,
        ready: r.ready,
        total: r.total,
        anchors: `toolbar anchors (${r.anchors?.method ?? 'default'}): ${JSON.stringify(r.anchors?.start ?? {})}`,
        devices: r.devices
          .map((d) => `${d.ready ? 'ready' : 'no answer'}  ${d.name}  :${d.port}  ${d.prompt ?? ''}`.trimEnd())
          .join('\n'),
      }
    },
  })

  /* ------------------------------------------------------------------- stop */

  add(tools, {
    name: 'ensp_stop',
    description: 'Shut down every device in the running topology.',
    parameters: {},
    output: {
      schema: obj({
        ok: req(bool()),
        anchors: req(str()),
        error: req(str()),
      }),
      render(args, value) {
        if (value.error) return text(value.error)
        return text(`shutdown requested for all devices\n${value.anchors}`)
      },
    },
    async execute() {
      const hwnd = locateWindow(enspPid())
      if (!hwnd) throw new Error('eNSP window not found')
      const r = stopAllDevices(hwnd)
      return { ok: r.ok, anchors: `anchors (${r.anchors?.method ?? 'default'}): ${JSON.stringify(r.anchors?.stop ?? {})}` }
    },
  })

  /* ------------------------------------------------------------------ apply */

  add(tools, {
    name: 'ensp_apply',
    description:
      'Push a configuration script to one device, one command at a time. Each command is confirmed by its '
      + 'prompt before the next is sent; the first error aborts the batch and reports the line, the command '
      + 'and the raw device output.',
    parameters: {
      device: str('Device name, used in the report.'),
      port: num('Console TCP port from the .topo file.'),
      script: str('Configuration text; blank lines and ! / # comments are skipped.'),
      save: bool('Run save at the end.'),
    },
    output: {
      schema: obj({
        ok: req(bool()),
        applied: req(num()),
        total: req(num()),
        saved: req(bool()),
        failedAt: req(str()),
        error: req(str()),
      }),
      render(args, value) {
        if (value.error) return text(value.error)
        if (value.ok) {
          return text(`${args.device}: ${value.applied}/${value.total} commands applied${value.saved ? ', saved' : ''}`)
        }
        return text(`${args.device}: stopped after ${value.applied}/${value.total} commands\n${value.failedAt}`)
      },
    },
    async execute(args) {
      if (!args.port) throw new Error('port is required')
      const r = await pushConfig({
        device: args.device ?? 'device',
        port: args.port,
        script: args.script ?? '',
        save: Boolean(args.save),
      })
      return {
        ok: r.ok,
        applied: r.applied,
        total: r.total,
        saved: r.saved,
        failedAt: r.failedAt
          ? `line ${r.failedAt.line}: ${r.failedAt.command}\n  ${r.failedAt.error}\n  ${(r.failedAt.output ?? '').trim().split('\n').slice(-6).join('\n  ')}`
          : '',
      }
    },
  })

  /* -------------------------------------------------------------- apply dir */

  add(tools, {
    name: 'ensp_apply_dir',
    description:
      'Push one .cfg per device from a directory, matching file names to device names. Devices are '
      + 'configured concurrently and one failure does not stop the others.',
    parameters: {
      directory: str('Directory containing <device>.cfg files.'),
      topology: str('Topology that maps device names to console ports.'),
      save: bool('Run save on each device afterwards.'),
      concurrency: num('How many devices to configure at once (default 3).'),
    },
    output: {
      schema: obj({
        configured: req(num()),
        total: req(num()),
        results: req(str()),
        error: req(str()),
      }),
      render(args, value) {
        if (value.error) return text(value.error)
        return text(`${value.configured}/${value.total} devices configured\n\n${value.results}`)
      },
    },
    async execute(args) {
      if (!args.directory || !args.topology) throw new Error('directory and topology are required')
      const topo = await readTopology(path.resolve(args.topology))
      const consoles = new Map(topo.devices.filter((d) => d.comPort).map((d) => [d.name, d.comPort]))
      const files = (await readdir(args.directory)).filter((f) => /\.(cfg|txt)$/i.test(f))
      const targets = []
      for (const file of files) {
        const device = file.replace(/\.(cfg|txt)$/i, '')
        const port = consoles.get(device)
        if (!port) continue
        targets.push({ device, port, script: await readFile(path.join(args.directory, file), 'utf8') })
      }
      const results = await pushConfigMany({
        targets,
        concurrency: args.concurrency ?? 3,
        save: Boolean(args.save),
      })
      return {
        configured: results.filter((r) => r.ok).length,
        total: results.length,
        results: results
          .map((r) =>
            r.ok
              ? `ok    ${r.device}  ${r.applied}/${r.total}`
              : `FAIL  ${r.device}  line ${r.failedAt?.line}: ${r.failedAt?.command} -> ${r.failedAt?.error}`,
          )
          .join('\n'),
      }
    },
  })

  /* ------------------------------------------------------------------ query */

  add(tools, {
    name: 'ensp_query',
    description: 'Run one read-only command on a device console and return its output.',
    parameters: {
      port: num('Console TCP port.'),
      command: str('One VRP command, e.g. "display ip routing-table".'),
    },
    output: {
      schema: obj({
        ok: req(bool()),
        output: req(str()),
        error: req(str()),
      }),
      render(args, value) {
        if (!value.ok) return text(`${args.command} failed: ${value.error ?? 'unknown error'}`)
        return text(value.output)
      },
    },
    async execute(args) {
      if (!args.port || !args.command) throw new Error('port and command are required')
      const r = await queryDevice({ port: args.port, command: args.command })
      return { ok: r.ok, output: r.output, error: r.error ?? '' }
    },
  })

  /* -------------------------------------------------------------- scenarios */

  add(tools, {
    name: 'ensp_scenarios',
    description:
      'List or search the ' + SCENARIO_IDS.length + ' built-in configuration scenarios. Each is a skeleton: what to create, in what '
      + 'order, and the command that proves it worked, rather than a command dump.',
    parameters: {
      search: str('Keyword filter, e.g. "ospf" or "vlan".'),
      level: str('One of basic, intermediate, advanced.'),
    },
    output: {
      schema: obj({
        count: req(num()),
        list: req(str()),
        error: req(str()),
      }),
      render(args, value) {
        return text(value.list || '(no scenario matched)')
      },
    },
    async execute({ search, level }) {
      const groups = byLevel()
      let ids = level && groups[level] ? groups[level] : Object.keys(SCENARIOS)
      if (search) {
        const matched = new Set(searchScenarios(search).map((h) => h.id))
        ids = ids.filter((id) => matched.has(id))
      }
      return {
        count: ids.length,
        list: ids
          .map((id) => `${id.padEnd(24)} ${SCENARIOS[id].title}  [${SCENARIOS[id].level}]`)
          .join('\n'),
      }
    },
  })

  add(tools, {
    name: 'ensp_scenario',
    description: 'Return one scenario as a step-by-step brief with verification commands and pitfalls.',
    parameters: { id: str('Scenario id, e.g. "ospf-single".') },
    output: {
      schema: obj({
        id: req(str()),
        brief: req(str()),
        error: req(str()),
      }),
      render(args, value) {
        return text(value.brief)
      },
    },
    async execute({ id }) {
      if (!SCENARIOS[id]) throw new Error(`unknown scenario "${id}"`)
      const brief = hasLab(id)
        ? renderScenario(id) + `\n\n可生成拓扑: ensp_build_topology { path: "${id}.topo", scenario: "${id}" }`
        : renderScenario(id)
      return { id, brief }
    },
  })

  /* ---------------------------------------------------------- preset config */

  add(tools, {
    name: 'ensp_preset_config',
    description: 'Return the configuration text for the built-in two-PC lab.',
    parameters: { vlan: num('VLAN id (default 10).') },
    output: {
      schema: obj({
        script: req(str()),
        error: req(str()),
      }),
      render(args, value) {
        return text(value.script)
      },
    },
    async execute({ vlan }) {
      return { script: twoPcLabConfig({ vlan: vlan ?? 10 }) }
    },
  })

  /* ------------------------------------------------------------------ probe */

  add(tools, {
    name: 'ensp_probe',
    description:
      'Re-measure the toolbar anchors and report every colour cluster. Run this after an eNSP upgrade or a '
      + 'change of display scaling; results are cached per window size otherwise.',
    parameters: {},
    output: {
      schema: obj({
        window: req(str()),
        start: req(str()),
        stop: req(str()),
        method: req(str()),
        clusters: req(str()),
        error: req(str()),
      }),
      render(args, value) {
        if (value.error) return text(value.error)
        return text(
          `window ${value.window}\nanchors (${value.method}): start ${value.start}, stop ${value.stop}\n\n${value.clusters}`,
        )
      },
    },
    async execute() {
      const hwnd = locateWindow(enspPid())
      if (!hwnd) throw new Error('eNSP window not found')
      const r = inspectAnchors(hwnd)
      const resolved = r.resolved ?? { start: {}, stop: {}, method: 'none' }
      return {
        window: r.window ?? '(unknown)',
        start: JSON.stringify(resolved.start),
        stop: JSON.stringify(resolved.stop),
        method: resolved.method,
        clusters: [
          `green (${r.green.length}): ` + r.green.map((c) => `${c.x},${c.y} ${c.w}x${c.h}`).join(' | '),
          `red   (${r.red.length}): ` + r.red.map((c) => `${c.x},${c.y} ${c.w}x${c.h}`).join(' | '),
        ].join('\n'),
      }
    },
  })
}

/** Model metadata for the plugin row. */
export const dsh = {
  name: 'dsh-ensp',
  version: VERSION,
  description: 'Automate Huawei eNSP labs: build topology, boot devices, push config with verification.',
}
