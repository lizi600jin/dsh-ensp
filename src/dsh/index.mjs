/**
 * DeepSeek Harness plugin row.
 *
 * The plugin is a thin adapter: it registers the same operations the CLI and the
 * MCP server expose as **model tools**, so an agent can drive an eNSP lab directly
 * inside a Harness session. No behaviour lives here — everything delegates to
 * `src/core`, which keeps the three front-ends from drifting apart.
 *
 * It publishes no service of its own; it only consumes `tools`, so no `isolate`
 * realm is required.
 *
 * @module dsh-ensp/dsh
 */

import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'

import { buildTopology, twoPcLab, twoPcLabConfig, autoLayout, MODEL_SPECS } from '../core/build.mjs'
import { readTopology, writeTopology, summarise } from '../core/topology.mjs'
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
import { SCENARIOS, renderScenario, searchScenarios, byLevel } from '../core/presets.mjs'

/** Declared hard dependency: the tool registry. */
export const inject = ['tools']

export const name = 'ensp'

/**
 * Register the tools.
 *
 * Each tool returns compact JSON rather than prose so the model can branch on the
 * result. Failures are returned as `{ isError: true }` content instead of thrown,
 * because a thrown tool error gives the model nothing to act on.
 *
 * @param {object} ctx - Cordis context carrying `tools`
 */
export function apply(ctx) {
  const tools = ctx.tools
  if (!tools?.register) {
    console.warn('[dsh-ensp] tools service unavailable; plugin inactive')
    return
  }

  const register = (definition, handler) => {
    tools.register({
      ...definition,
      async execute(args) {
        try {
          const value = await handler(args ?? {})
          return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
        } catch (error) {
          return {
            content: [{ type: 'text', text: `error: ${error.message}` }],
            isError: true,
          }
        }
      },
    })
  }

  register(
    {
      name: 'ensp_status',
      description:
        'Report eNSP state: running or not, window handle, calibrated toolbar anchors, and ' +
        'per-device console readiness when a topology path is supplied.',
      parameters: {
        type: 'object',
        properties: { topology: { type: 'string' } },
        additionalProperties: false,
      },
    },
    async ({ topology }) => {
      const pid = enspPid()
      if (!pid) return { running: false }
      const hwnd = locateWindow(pid)
      const out = { running: true, pid, hwnd }
      if (hwnd) {
        const a = calibrateAnchors(hwnd)
        out.anchors = { start: a.start, stop: a.stop, method: a.method }
      }
      if (topology) {
        const topo = await readTopology(topology)
        out.devices = await Promise.all(
          topo.devices
            .filter((d) => d.comPort)
            .map(async (d) => {
              const r = await waitForConsole({ port: d.comPort, timeoutMs: 4000 })
              return { name: d.name, port: d.comPort, ready: r.ready, prompt: r.prompt }
            }),
        )
      }
      return out
    },
  )

  register(
    {
      name: 'ensp_build_topology',
      description:
        'Generate a .topo file. preset "two-pc" builds the two-PC/one-switch lab; otherwise ' +
        'pass devices and links (links use VRP interface names).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          preset: { type: 'string', enum: ['two-pc'] },
          vlan: { type: 'number' },
          devices: { type: 'array', items: { type: 'object' } },
          links: { type: 'array', items: { type: 'object' } },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    async (args) => {
      let topo
      if (args.preset === 'two-pc' || (!args.devices && !args.links)) {
        topo = twoPcLab({ vlan: args.vlan ?? 10 })
      } else {
        const b = buildTopology()
        for (const d of args.devices ?? []) b.add(d.name, d.model, { x: d.x, y: d.y, pc: d.pc })
        for (const l of args.links ?? []) b.link(l.a, l.aPort, l.b, l.bPort)
        topo = autoLayout(b.finish())
      }
      await writeTopology(path.resolve(args.path), topo)
      return { path: path.resolve(args.path), ...summarise(topo) }
    },
  )

  register(
    {
      name: 'ensp_open',
      description: 'Launch eNSP (or reuse it) and open a topology file.',
      parameters: {
        type: 'object',
        properties: { topology: { type: 'string' } },
        required: ['topology'],
        additionalProperties: false,
      },
    },
    async ({ topology }) => {
      const r = await launchEnsp({ topology: path.resolve(topology) })
      return { pid: r.pid, hwnd: r.hwnd, reused: Boolean(r.reused) }
    },
  )

  register(
    {
      name: 'ensp_start',
      description:
        'Boot every device. Calibrates the toolbar by colour, clicks start, then polls each ' +
        'console until VRP answers (readiness measured per device, never a fixed sleep). ' +
        'Minimises the window afterwards unless keepWindow is true.',
      parameters: {
        type: 'object',
        properties: {
          topology: { type: 'string' },
          perDeviceTimeoutMs: { type: 'number' },
          keepWindow: { type: 'boolean' },
        },
        required: ['topology'],
        additionalProperties: false,
      },
    },
    async (args) => {
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
        anchors: r.anchors,
        devices: r.devices.map((d) => ({ name: d.name, port: d.port, ready: d.ready, prompt: d.prompt })),
      }
    },
  )

  register(
    {
      name: 'ensp_stop',
      description: 'Shut down all devices in the running topology.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    async () => {
      const hwnd = locateWindow(enspPid())
      if (!hwnd) throw new Error('eNSP window not found')
      const r = stopAllDevices(hwnd)
      return { clicked: r.ok, anchors: r.anchors }
    },
  )

  register(
    {
      name: 'ensp_apply',
      description:
        'Push a configuration script to one device, one command at a time. The first error ' +
        'aborts the batch and reports the line, the command and the raw device output.',
      parameters: {
        type: 'object',
        properties: {
          device: { type: 'string' },
          port: { type: 'number' },
          script: { type: 'string' },
          save: { type: 'boolean' },
        },
        required: ['device', 'port', 'script'],
        additionalProperties: false,
      },
    },
    async (args) => {
      const r = await pushConfig({
        device: args.device,
        port: args.port,
        script: args.script,
        save: Boolean(args.save),
      })
      return {
        ok: r.ok,
        applied: r.applied,
        total: r.total,
        saved: r.saved,
        failedAt: r.failedAt,
        durationMs: r.durationMs,
      }
    },
  )

  register(
    {
      name: 'ensp_apply_dir',
      description: 'Push one .cfg per device from a directory, matched by file name to device name.',
      parameters: {
        type: 'object',
        properties: {
          directory: { type: 'string' },
          topology: { type: 'string' },
          save: { type: 'boolean' },
          concurrency: { type: 'number' },
        },
        required: ['directory', 'topology'],
        additionalProperties: false,
      },
    },
    async (args) => {
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
        results: results.map((r) => ({ device: r.device, ok: r.ok, applied: r.applied, failedAt: r.failedAt })),
      }
    },
  )

  register(
    {
      name: 'ensp_query',
      description: 'Run one read-only command on a device console and return its output.',
      parameters: {
        type: 'object',
        properties: { port: { type: 'number' }, command: { type: 'string' } },
        required: ['port', 'command'],
        additionalProperties: false,
      },
    },
    async ({ port, command }) => {
      const r = await queryDevice({ port, command })
      return { ok: r.ok, output: r.output, error: r.error }
    },
  )

  register(
    {
      name: 'ensp_scenarios',
      description:
        'List or search the 23 built-in scenarios. Each is a skeleton (what to create, in what ' +
        'order, how to verify) rather than a command dump.',
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string' },
          level: { type: 'string', enum: ['basic', 'intermediate', 'advanced'] },
        },
        additionalProperties: false,
      },
    },
    async ({ search, level }) => {
      const groups = byLevel()
      let ids = level ? groups[level] ?? [] : Object.keys(SCENARIOS)
      if (search) {
        const matched = new Set(searchScenarios(search).map((h) => h.id))
        ids = ids.filter((id) => matched.has(id))
      }
      return ids.map((id) => ({
        id,
        title: SCENARIOS[id].title,
        level: SCENARIOS[id].level,
        goal: SCENARIOS[id].goal,
      }))
    },
  )

  register(
    {
      name: 'ensp_scenario',
      description: 'Return one scenario as a step-by-step brief with pitfalls.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
        additionalProperties: false,
      },
    },
    async ({ id }) => {
      if (!SCENARIOS[id]) throw new Error(`unknown scenario "${id}"`)
      return { id, brief: renderScenario(id) }
    },
  )

  register(
    {
      name: 'ensp_preset_config',
      description: 'Return the configuration text for the built-in two-PC lab.',
      parameters: {
        type: 'object',
        properties: { vlan: { type: 'number' } },
        additionalProperties: false,
      },
    },
    async ({ vlan }) => ({ script: twoPcLabConfig({ vlan: vlan ?? 10 }) }),
  )

  register(
    {
      name: 'ensp_probe',
      description:
        'Re-measure the toolbar anchors and report every colour cluster. Run after an eNSP ' +
        'upgrade or a display-scaling change.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    async () => {
      const hwnd = locateWindow(enspPid())
      if (!hwnd) throw new Error('eNSP window not found')
      return inspectAnchors(hwnd)
    },
  )
}

/** Model metadata for the plugin row. */
export const dsh = {
  name: 'dsh-ensp',
  version: '0.1.0',
  description: 'Automate Huawei eNSP labs: build topology, boot devices, push config with verification.',
  tools: ['ensp_status', 'ensp_build_topology', 'ensp_open', 'ensp_start', 'ensp_stop', 'ensp_apply', 'ensp_apply_dir', 'ensp_query', 'ensp_scenarios', 'ensp_scenario', 'ensp_preset_config', 'ensp_probe'],
}

export { MODEL_SPECS }
