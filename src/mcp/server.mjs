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

import { buildTopology, twoPcLab, twoPcLabConfig, autoLayout } from '../core/build.mjs'
import { readTopology, writeTopology, summarise } from '../core/topology.mjs'
import {
  LAB_IDS,
  buildScenarioTopology,
  hasLab,
  labAddressing,
  labDevices,
} from '../core/labs.mjs'
import { countLabConfigs, hasLabConfig, labConfigScript } from '../core/labconfig.mjs'
import { checkTopologySupport, pluginMediaPlan, pluginModels, installPluginMedia } from '../core/compat.mjs'
import {
  enspPid,
  locateWindow,
  launchEnsp,
  showEnsp,
  startAllDevices,
  stopAllDevices,
  waitForConsole,
} from '../core/launcher.mjs'
import { calibrateAnchors, inspectAnchors, DEFAULT_ANCHORS } from '../core/calibrate.mjs'
import { doctor, modelsOf } from '../core/doctor.mjs'
import { runAcceptance, hasChecks, EXPECTATIONS, formatAcceptance } from '../core/acceptance.mjs'
import { curriculumFor, renderCurriculum, searchCurriculum } from '../core/curriculum.mjs'
import { pushConfig, pushConfigMany, queryDevice } from '../core/provision.mjs'
import { writeReport } from '../core/report.mjs'
import { SCENARIOS, SCENARIO_IDS, byLevel, renderScenario, searchScenarios } from '../core/presets.mjs'
import { PACKAGE_NAME, VERSION } from '../core/version.mjs'
import { TOOL_SPECS, toInputSchema } from '../tools.mjs'

const SERVER_INFO = { name: PACKAGE_NAME, version: VERSION }

/**
 * Tool handlers, keyed by name.
 *
 * The names, descriptions and parameter schemas live in `../tools.mjs` so the MCP
 * table and the DSH plugin table cannot drift apart. Only the implementations stay
 * here, because the two front ends return different shapes.
 */
const HANDLERS = {
  async ensp_status({ topology }) {
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
  async ensp_build_topology(args) {
    let topo
    if (args.scenario) {
      if (!hasLab(args.scenario)) {
        throw new Error(
          `scenario "${args.scenario}" has no topology blueprint; ${LAB_IDS.length} of ${SCENARIO_IDS.length} have one: ${LAB_IDS.join(', ')}`,
        )
      }
      topo = buildScenarioTopology(args.scenario)
    } else if (args.preset === 'two-pc' || (!args.devices && !args.links)) {
      topo = twoPcLab({ vlan: args.vlan ?? 10, subnet: args.subnet ?? '192.168.10' })
    } else {
      const b = buildTopology()
      for (const d of args.devices ?? []) b.add(d.name, d.model, { x: d.x, y: d.y, pc: d.pc })
      for (const l of args.links ?? []) b.link(l.a, l.aPort, l.b, l.bPort)
      topo = autoLayout(b.finish())
    }
    const target = path.resolve(args.path)
    await writeTopology(target, topo)
    const support = checkTopologySupport(topo)
    return {
      path: target,
      ...summarise(topo),
      ...(args.scenario
        ? { scenario: args.scenario, devices: labDevices(args.scenario), addressing: labAddressing(args.scenario) }
        : {}),
      ...(support.ok ? {} : { unsupportedDevices: support.blocked }),
    }
  },
  async ensp_open({ topology }) {
    const launched = await launchEnsp({ topology: path.resolve(topology) })
    return { pid: launched.pid, hwnd: launched.hwnd, reused: Boolean(launched.reused) }
  },
  async ensp_start(args) {
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
  async ensp_stop({ hwnd }) {
    const target = hwnd ?? locateWindow(enspPid())
    if (!target) throw new Error('eNSP window not found')
    const r = stopAllDevices(target)
    return { clicked: r.ok, anchors: r.anchors, detail: r.detail }
  },
  async ensp_apply({ device, port, script, save }) {
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
  async ensp_apply_dir(args) {
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
  async ensp_query({ port, command }) {
    const r = await queryDevice({ port, command })
    return { ok: r.ok, output: r.output, error: r.error }
  },
  async ensp_probe({ hwnd }) {
    const target = hwnd ?? locateWindow(enspPid())
    if (!target) throw new Error('eNSP window not found')
    const r = inspectAnchors(target)
    return { window: r.window, green: r.green, red: r.red, resolved: r.resolved, defaults: DEFAULT_ANCHORS }
  },
  async ensp_show({ hwnd }) {
    const target = hwnd ?? locateWindow(enspPid())
    if (!target) throw new Error('eNSP window not found')
    return showEnsp(target)
  },
  async ensp_scenarios({ search, level, syllabus }) {
    if (syllabus) return searchCurriculum(syllabus)
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
  async ensp_scenario({ id }) {
    if (!SCENARIOS[id]) throw new Error(`unknown scenario "${id}"`)
    return {
      id,
      brief: renderScenario(id) + renderCurriculum(id),
      data: SCENARIOS[id],
      hasTopology: hasLab(id),
      hasCuratedChecks: hasChecks(id),
      ...(hasLab(id) ? { devices: labDevices(id), addressing: labAddressing(id) } : {}),
      curriculum: curriculumFor(id),
    }
  },
  async ensp_images({ model, source, overwrite }) {
    if (source) {
      if (!model) throw new Error('model is required when installing an image')
      return installPluginMedia(model, source, { overwrite: overwrite === true })
    }
    const models = model ? [model] : pluginModels()
    const plans = models.map((name) => pluginMediaPlan(name))
    return { models: plans, ready: plans.every((plan) => plan.ready) }
  },
  async ensp_doctor({ topology, deep }) {
    let models
    if (topology) models = modelsOf(await readTopology(topology))
    return doctor({ models, deep: deep !== false })
  },
  async ensp_verify({ scenario, topology, timeout, wait }) {
    if (!scenario) throw new Error('scenario is required')
    if (!topology) throw new Error('topology is required: pass the .topo file that is running')
    const report = await runAcceptance({ id: scenario, topology, timeoutMs: timeout, waitMs: wait })
    return {
      ...report,
      verified: report.ok !== null,
      summary: formatAcceptance(report),
    }
  },
  async ensp_preset_config({ vlan, scenario }) {
    if (!scenario) return { script: twoPcLabConfig({ vlan: vlan ?? 10 }) }
    if (!hasLabConfig(scenario)) {
      throw new Error(`scenario "${scenario}" has no addressing plan; ${countLabConfigs()} of them have one`)
    }
    return { script: labConfigScript(scenario) }
  },
  async ensp_report({ scenario, topology, out, timeout, wait }) {
    if (!scenario) throw new Error('scenario is required')
    const result = await writeReport({ id: scenario, topology, out, timeoutMs: timeout, waitMs: wait })
    return {
      path: result.path,
      bytes: result.bytes,
      scenario: result.evidence.id,
      title: result.evidence.title,
      verdict: result.evidence.verdict,
      devices: result.evidence.devices.length,
      checks: result.evidence.checks.length,
    }
  },
}

/**
 * The published tool table: shared specs plus the local handlers.
 *
 * Exported so the tests can compare it with what the DSH plugin registers.
 */
export const TOOLS = TOOL_SPECS.map((spec) => ({
  name: spec.name,
  description: spec.description,
  inputSchema: toInputSchema(spec.params),
  run: HANDLERS[spec.name],
}))

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
