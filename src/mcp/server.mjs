#!/usr/bin/env node
/**
 * MCP server for dsh-ensp.
 *
 * Exposes the same core as the CLI so any MCP client (Claude Desktop, Cursor, the
 * DeepSeek Harness, …) can drive an eNSP lab conversationally.
 *
 * Transport: stdio with newline-delimited JSON-RPC 2.0. That is the subset every
 * MCP client speaks; no SDK dependency is required, which keeps the published
 * package small and makes the wire format visible for debugging.
 *
 * Tools are intentionally coarse: each one maps to an operation a network engineer
 * would describe out loud ("build a two-PC lab", "start the devices"), and every
 * one returns structured JSON instead of prose so the model can reason over it.
 *
 * @module dsh-ensp/mcp
 */

import { readFile, writeFile, readdir } from 'node:fs/promises'
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
import { calibrateAnchors, inspectAnchors, DEFAULT_ANCHORS } from '../core/calibrate.mjs'
import { pushConfig, pushConfigMany, queryDevice } from '../core/provision.mjs'
import { SCENARIOS, SCENARIO_IDS, byLevel, renderScenario, searchScenarios } from '../core/presets.mjs'

const SERVER_INFO = { name: 'dsh-ensp', version: '0.1.0' }

/** JSON-schema helpers to keep the tool table readable. */
const obj = (properties, required = []) => ({ type: 'object', properties, required })

/** Every tool this server advertises. */
const TOOLS = [
  {
    name: 'ensp_status',
    description:
      'Report whether eNSP is running, where its window is, the calibrated toolbar anchors, ' +
      'and — when a topology path is given — which device consoles answer.',
    inputSchema: obj({ topology: { type: 'string', description: 'optional .topo path' } }),
    async run({ topology }) {
      const pid = enspPid()
      if (!pid) return { running: false }
      const hwnd = locateWindow(pid)
      const anchors = hwnd ? calibrateAnchors(hwnd) : null
      const out = {
        running: true,
        pid,
        hwnd,
        anchors: anchors ? { start: anchors.start, stop: anchors.stop, method: anchors.method } : null,
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
  },
  {
    name: 'ensp_build_topology',
    description:
      'Generate a .topo file. Use `preset: "two-pc"` for the built-in two-PC/one-switch lab, ' +
      'or pass `devices` and `links` explicitly. Returns the written path and a summary.',
    inputSchema: obj({
      path: { type: 'string', description: 'output .topo path' },
      preset: { type: 'string', enum: ['two-pc'], description: 'built-in lab' },
      vlan: { type: 'number', description: 'for preset two-pc (default 10)' },
      subnet: { type: 'string', description: 'for preset two-pc (default 192.168.10)' },
      devices: {
        type: 'array',
        description: 'explicit device list',
        items: obj({
          name: { type: 'string' },
          model: { type: 'string', enum: Object.keys(MODEL_SPECS) },
          x: { type: 'number' },
          y: { type: 'number' },
          pc: obj({ ip: { type: 'string' }, gateway: { type: 'string' } }),
        }),
      },
      links: {
        type: 'array',
        description: 'explicit links using VRP interface names',
        items: obj({
          a: { type: 'string' },
          aPort: { type: 'string' },
          b: { type: 'string' },
          bPort: { type: 'string' },
        }),
      },
    }),
    async run(args) {
      let topo
      if (args.preset === 'two-pc' || (!args.devices && !args.links)) {
        topo = twoPcLab({ vlan: args.vlan ?? 10, subnet: args.subnet ?? '192.168.10' })
      } else {
        const b = buildTopology()
        for (const d of args.devices ?? []) b.add(d.name, d.model, { x: d.x, y: d.y, pc: d.pc })
        for (const l of args.links ?? []) b.link(l.a, l.aPort, l.b, l.bPort)
        topo = autoLayout(b.finish())
      }
      const target = path.resolve(args.path)
      await writeTopology(target, topo)
      return { path: target, ...summarise(topo) }
    },
  },
  {
    name: 'ensp_open',
    description:
      'Launch eNSP (or reuse the running instance) and open a topology file. ' +
      'Returns the process id and window handle needed by the other tools.',
    inputSchema: obj({ topology: { type: 'string' } }, ['topology']),
    async run({ topology }) {
      const launched = await launchEnsp({ topology: path.resolve(topology) })
      return { pid: launched.pid, hwnd: launched.hwnd, reused: Boolean(launched.reused) }
    },
  },
  {
    name: 'ensp_start',
    description:
      'Boot every device in a topology. Locates the toolbar button by colour (no hard-coded ' +
      'coordinates), clicks it, then polls each console until VRP answers — boot time is ' +
      'measured, never assumed. Minimises the window afterwards unless keepWindow is set.',
    inputSchema: obj(
      {
        topology: { type: 'string' },
        hwnd: { type: 'string', description: 'optional; located automatically' },
        perDeviceTimeoutMs: { type: 'number', description: 'default 240000' },
        keepWindow: { type: 'boolean', description: 'leave the window visible' },
      },
      ['topology'],
    ),
    async run(args) {
      const topo = await readTopology(path.resolve(args.topology))
      const hwnd = args.hwnd ?? locateWindow(enspPid())
      if (!hwnd) throw new Error('eNSP window not found; call ensp_open first')
      const result = await startAllDevices({
        devices: topo.devices,
        hwnd,
        perDeviceTimeoutMs: args.perDeviceTimeoutMs ?? 240000,
        minimise: !args.keepWindow,
      })
      return {
        allReady: result.allReady,
        ready: result.ready,
        total: result.total,
        anchors: result.anchors,
        devices: result.devices.map((d) => ({ name: d.name, port: d.port, ready: d.ready, prompt: d.prompt, waitedMs: d.waitedMs })),
      }
    },
  },
  {
    name: 'ensp_stop',
    description: 'Shut down every device in the running topology.',
    inputSchema: obj({ hwnd: { type: 'string' } }),
    async run({ hwnd }) {
      const target = hwnd ?? locateWindow(enspPid())
      if (!target) throw new Error('eNSP window not found')
      const r = stopAllDevices(target)
      return { clicked: r.ok, anchors: r.anchors, detail: r.detail }
    },
  },
  {
    name: 'ensp_apply',
    description:
      'Push a configuration script to ONE device. Commands are sent one at a time, each one ' +
      'confirmed by its prompt; the first error aborts the batch and reports the line number, ' +
      'the offending command and its raw output.',
    inputSchema: obj(
      {
        device: { type: 'string', description: 'device name, for reporting' },
        port: { type: 'number', description: 'console TCP port from the .topo' },
        script: { type: 'string', description: 'the configuration text' },
        save: { type: 'boolean', description: 'run save at the end' },
      },
      ['device', 'port', 'script'],
    ),
    async run({ device, port, script, save }) {
      const r = await pushConfig({ device, port, script, save: Boolean(save) })
      return {
        ok: r.ok,
        applied: r.applied,
        total: r.total,
        saved: r.saved,
        durationMs: r.durationMs,
        failedAt: r.failedAt,
      }
    },
  },
  {
    name: 'ensp_apply_dir',
    description:
      'Push one .cfg per device from a directory, matching file names to device names. ' +
      'Devices are configured concurrently; a failure on one does not stop the others.',
    inputSchema: obj(
      {
        directory: { type: 'string' },
        topology: { type: 'string' },
        save: { type: 'boolean' },
        concurrency: { type: 'number', description: 'default 3' },
      },
      ['directory', 'topology'],
    ),
    async run(args) {
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
        results: results.map((r) => ({ device: r.device, ok: r.ok, applied: r.applied, total: r.total, failedAt: r.failedAt })),
      }
    },
  },
  {
    name: 'ensp_query',
    description: 'Run one read-only command on a device console and return its output.',
    inputSchema: obj({ port: { type: 'number' }, command: { type: 'string' } }, ['port', 'command']),
    async run({ port, command }) {
      const r = await queryDevice({ port, command })
      return { ok: r.ok, output: r.output, error: r.error }
    },
  },
  {
    name: 'ensp_probe',
    description:
      'Re-measure the toolbar button positions. Run this after upgrading eNSP or changing ' +
      'display scaling; the coordinates are cached per window size otherwise.',
    inputSchema: obj({ hwnd: { type: 'string' } }),
    async run({ hwnd }) {
      const target = hwnd ?? locateWindow(enspPid())
      if (!target) throw new Error('eNSP window not found')
      const r = inspectAnchors(target)
      return { window: r.window, green: r.green, red: r.red, resolved: r.resolved, defaults: DEFAULT_ANCHORS }
    },
  },
  {
    name: 'ensp_scenarios',
    description:
      'List or search the built-in configuration scenarios (23 of them, mirroring the labs ' +
      'shipped with eNSP plus verified project scenarios). Each entry is a skeleton: what to ' +
      'create, in what order, and the command that proves it worked — not a command dump.',
    inputSchema: obj({
      search: { type: 'string', description: 'keyword filter, e.g. "ospf" or "vlan"' },
      level: { type: 'string', enum: ['basic', 'intermediate', 'advanced'] },
    }),
    async run({ search, level }) {
      const groups = byLevel()
      let ids = level ? groups[level] ?? [] : SCENARIO_IDS
      if (search) {
        const matched = new Set(searchScenarios(search).map((h) => h.id))
        ids = ids.filter((id) => matched.has(id))
      }
      return ids.map((id) => ({
        id,
        title: SCENARIOS[id].title,
        level: SCENARIOS[id].level,
        goal: SCENARIOS[id].goal,
        devices: SCENARIOS[id].devices,
        source: SCENARIOS[id].source,
      }))
    },
  },
  {
    name: 'ensp_scenario',
    description:
      'Return one scenario as a step-by-step brief: ordered direction, the verification command ' +
      'for each step, and the known pitfalls. Use this to plan a configuration before touching ' +
      'any device.',
    inputSchema: obj({ id: { type: 'string' } }, ['id']),
    async run({ id }) {
      if (!SCENARIOS[id]) throw new Error(`unknown scenario "${id}"`)
      return { id, brief: renderScenario(id), data: SCENARIOS[id] }
    },
  },
  {
    name: 'ensp_preset_config',
    description: 'Return the configuration that makes the built-in two-PC lab pass traffic.',
    inputSchema: obj({ vlan: { type: 'number' } }),
    async run({ vlan }) {
      return { script: twoPcLabConfig({ vlan: vlan ?? 10 }) }
    },
  },
]

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n')
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } })
}

async function handle(request) {
  const { id, method, params } = request

  switch (method) {
    case 'initialize':
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      })

    case 'notifications/initialized':
      return // notification: no response

    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      })

    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name)
      if (!tool) return replyError(id, -32602, `unknown tool: ${params?.name}`)
      try {
        const value = await tool.run(params.arguments ?? {})
        return reply(id, {
          content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
          isError: false,
        })
      } catch (error) {
        // Tool failures are reported inside the result so the model can react,
        // rather than as a protocol error it cannot act on.
        return reply(id, {
          content: [{ type: 'text', text: `error: ${error.message}` }],
          isError: true,
        })
      }
    }

    case 'ping':
      return reply(id, {})

    default:
      if (id !== undefined) return replyError(id, -32601, `method not found: ${method}`)
  }
}

/** Start reading requests from stdin. */
export function serve() {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (!line) continue
      let request
      try {
        request = JSON.parse(line)
      } catch {
        replyError(null, -32700, 'parse error')
        continue
      }
      handle(request).catch((error) => {
        replyError(request?.id ?? null, -32603, error.message)
      })
    }
  })
  process.stdin.on('end', () => process.exit(0))
}

// Run when executed directly (not when imported by the DSH plugin).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
if (isMain) serve()
