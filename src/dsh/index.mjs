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
 * The tool names, descriptions and parameter maps themselves live in
 * `../tools.mjs`, shared with the MCP server, so the two tables cannot drift
 * apart. What stays here is the DSH-specific half: the output schema plus render
 * function, and the handler that produces the display-ready value.
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
import { calibrateAnchors, inspectAnchors } from '../core/calibrate.mjs'
import { pushConfig, pushConfigMany, queryDevice } from '../core/provision.mjs'
import { writeReport } from '../core/report.mjs'
import { SCENARIOS, SCENARIO_IDS, renderScenario, searchScenarios, byLevel } from '../core/presets.mjs'
import { doctor, modelsOf } from '../core/doctor.mjs'
import { runAcceptance, hasChecks } from '../core/acceptance.mjs'
import { curriculumFor, renderCurriculum, searchCurriculum } from '../core/curriculum.mjs'
import { VERSION } from '../core/version.mjs'
import { TOOL_SPECS } from '../tools.mjs'

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

/**
 * Fill in required properties that a return branch omitted.
 *
 * A tool has several branches, and some of them legitimately have nothing to
 * report: when eNSP is not running there is no pid, no hwnd and no anchor. The
 * consumer still benefits from a stable shape, so the branch does not have to
 * repeat empty fields and the schema does not have to relax.
 *
 * Missing required keys get the empty value for their type. Keys the branch did
 * return are never touched, so a wrong value still reaches the validator.
 */
/**
 * Fill in the branches a tool did not return.
 *
 * Exported so the contract can be tested without calling a device: every tool
 * declares its full output shape, and a run that legitimately has nothing to say
 * about one field must still satisfy that shape.
 */
export function conform(schema, value) {
  if (!schema || schema.type !== 'object') return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const out = { ...value }
  for (const key of schema.required ?? []) {
    if (out[key] !== undefined) continue
    out[key] = emptyFor(schema.properties?.[key])
  }
  return out
}

/** The empty value for a schema node's type. */
function emptyFor(node) {
  const type = node?.type
  if (type === 'number' || type === 'integer') return 0
  if (type === 'boolean') return false
  if (type === 'array') return []
  if (type === 'object') return {}
  return ''
}

/** One plain text content block. */
const text = (value) => [{ type: 'text', text: String(value) }]

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
      const value = await execute(args ?? {})
      return conform(definition.output?.schema, value)
    },
  })
}

// ---------------------------------------------------------------------------
// Output half: the DSH-only shape, keyed by tool name
// ---------------------------------------------------------------------------

const OUTPUTS = {
  ensp_status: {
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

  ensp_build_topology: {
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

  ensp_open: {
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

  ensp_start: {
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

  ensp_stop: {
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

  ensp_apply: {
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

  ensp_apply_dir: {
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

  ensp_query: {
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

  ensp_probe: {
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

  ensp_show: {
    schema: obj({
      found: req(bool()),
      restored: req(bool()),
      raised: req(bool()),
      foreground: req(str()),
      error: req(str()),
    }),
    render(args, value) {
      if (value.error) return text(value.error)
      if (!value.found) return text('eNSP window not found.')
      const lines = [
        value.restored ? 'window restored from the taskbar' : 'window was not minimised',
        value.raised ? 'window is in front' : 'window could not be raised; another window still holds the foreground',
      ]
      return text(lines.join('\n'))
    },
  },

  ensp_scenarios: {
    schema: obj({
      count: req(num()),
      list: req(str()),
      error: req(str()),
    }),
    render(args, value) {
      return text(value.list || '(no scenario matched)')
    },
  },

  ensp_scenario: {
    schema: obj({
      id: req(str()),
      brief: req(str()),
      curriculum: req(arr()),
      error: req(str()),
    }),
    render(args, value) {
      return text(value.brief)
    },
  },

  ensp_images: {
    schema: obj({
      ready: req(bool()),
      models: req(str()),
      installed: req(str()),
      error: req(str()),
    }),
    render(args, value) {
      if (value.error) return text(value.error)
      const head = value.installed ? `installed ${value.installed}\n\n` : ''
      return text(head + value.models)
    },
  },

  ensp_doctor: {
    schema: obj({
      ok: req(bool()),
      failed: req(str()),
      warned: req(str()),
      skipped: req(str()),
      checks: req(str()),
      error: req(str()),
    }),
    render(args, value) {
      if (value.error) return text(value.error)
      return text(value.checks + '\n\n' + (value.ok ? 'environment ok' : 'environment NOT ready'))
    },
  },

  ensp_verify: {
    schema: obj({
      scenario: req(str()),
      ok: req(bool()),
      verified: req(bool()),
      summary: req(str()),
      detail: req(str()),
      error: req(str()),
    }),
    render(args, value) {
      if (value.error) return text(value.error)
      return text(`${value.scenario} · ${value.summary}\n\n${value.detail}`)
    },
  },

  ensp_preset_config: {
    schema: obj({
      script: req(str()),
      error: req(str()),
    }),
    render(args, value) {
      return text(value.script)
    },
  },

  ensp_report: {
    schema: obj({
      path: req(str()),
      bytes: req(num()),
      scenario: req(str()),
      title: req(str()),
      verdict: req(str()),
      devices: req(num()),
      checks: req(num()),
      error: req(str()),
    }),
    render(args, value) {
      if (value.error) return text(value.error)
      const kb = Math.max(1, Math.round(value.bytes / 1024))
      return text(
        `${value.scenario} · ${value.title}\n\n` +
          `wrote ${value.path} (${kb} kB)\n` +
          `${value.devices} devices, ${value.checks} checks\n` +
          `${value.verdict}`,
      )
    },
  },
}

// ---------------------------------------------------------------------------
// Execute half: returns the display-ready value the output schema describes
// ---------------------------------------------------------------------------

const EXEC = {
  async ensp_status({ topology }) {
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

  async ensp_build_topology(args) {
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
      topo = twoPcLab({ vlan: args.vlan ?? 10, subnet: args.subnet ?? '192.168.10' })
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

  async ensp_open({ topology }) {
    if (!topology) throw new Error('topology is required')
    const r = await launchEnsp({ topology: path.resolve(topology) })
    return { pid: r.pid, hwnd: r.hwnd, reused: Boolean(r.reused) }
  },

  async ensp_start(args) {
    if (!args.topology) throw new Error('topology is required')
    const topo = await readTopology(path.resolve(args.topology))
    const hwnd = args.hwnd ?? locateWindow(enspPid())
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

  async ensp_stop(args = {}) {
    const hwnd = args.hwnd ?? locateWindow(enspPid())
    if (!hwnd) throw new Error('eNSP window not found')
    const r = stopAllDevices(hwnd)
    return { ok: r.ok, anchors: `anchors (${r.anchors?.method ?? 'default'}): ${JSON.stringify(r.anchors?.stop ?? {})}` }
  },

  async ensp_apply(args) {
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

  async ensp_apply_dir(args) {
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

  async ensp_query(args) {
    if (!args.port || !args.command) throw new Error('port and command are required')
    const r = await queryDevice({ port: args.port, command: args.command })
    return { ok: r.ok, output: r.output, error: r.error ?? '' }
  },

  async ensp_probe(args = {}) {
    const hwnd = args.hwnd ?? locateWindow(enspPid())
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

  async ensp_show(args = {}) {
    const hwnd = args.hwnd ?? locateWindow(enspPid())
    if (!hwnd) throw new Error('eNSP window not found')
    const r = showEnsp(hwnd)
    return { ...r, foreground: r.foreground ?? '' }
  },

  async ensp_scenarios({ search, level, syllabus }) {
    if (syllabus) {
      const chapters = searchCurriculum(syllabus)
      return {
        count: chapters.length,
        list: chapters
          .map(
            (c) =>
              `${c.level} · ${c.title} (p${c.page})\n` +
              (c.scenarios.length ? `  场景: ${c.scenarios.join(', ')}\n` : '') +
              (c.verify.length ? `  验证: ${c.verify.slice(0, 4).join(' / ')}` : ''),
          )
          .join('\n'),
      }
    }
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

  async ensp_scenario({ id }) {
    if (!SCENARIOS[id]) throw new Error(`unknown scenario "${id}"`)
    const brief = hasLab(id)
      ? renderScenario(id) + `\n\n可生成拓扑: ensp_build_topology { path: "${id}.topo", scenario: "${id}" }`
      : renderScenario(id)
    return {
      id,
      brief:
        brief +
        (hasChecks(id)
          ? `\n\n验收: ensp_verify { scenario: "${id}", topology: "${id}.topo" }`
          : '\n\n验收: 无专门断言，ensp_verify 会逐条跑场景里的验证命令') +
        renderCurriculum(id),
      curriculum: curriculumFor(id).map((c) => ({
        level: c.level,
        title: c.title,
        page: c.page,
        verify: c.verify,
      })),
    }
  },

  async ensp_images({ model, source, overwrite }) {
    if (source) {
      if (!model) throw new Error('model is required when installing an image')
      const result = installPluginMedia(model, path.resolve(source), { overwrite: overwrite === true })
      const line = result.bytes
        ? `${result.model} → ${result.target} (${result.bytes} bytes)`
        : `${result.model} already has its image at ${result.target}`
      return { ready: true, models: line, installed: result.bytes ? result.model : '', error: '' }
    }
    const models = model ? [model] : pluginModels()
    const plans = models.map((name) => pluginMediaPlan(name))
    const lines = plans.map((plan) => {
      if (!plan.plugin) return `${plan.model}: not a plugin device in this installation`
      if (plan.ready) {
        const present = plan.media.find((item) => item.present)
        return `${plan.model}: ready (${present.relative})`
      }
      return `${plan.model}: missing ${plan.target ?? 'no template'}`
    })
    return {
      ready: plans.every((plan) => plan.ready),
      models: lines.join('\n'),
      installed: '',
      error: '',
    }
  },

  async ensp_doctor({ topology, deep }) {
    let models
    if (topology) models = modelsOf(await readTopology(path.resolve(topology)))
    const report = doctor({ models, deep: deep !== false })
    const lines = report.checks.map((c) => {
      const tag = c.status === 'pass' ? '[ok  ]'
        : c.status === 'warn' ? '[warn]'
          : c.status === 'skip' ? '[skip]'
            : '[FAIL]'
      return `${tag} ${c.id}: ${c.detail}` + (c.fix ? `\n       fix: ${c.fix}` : '')
    })
    return {
      ok: report.ok,
      failed: report.failed.join(', ') || '(none)',
      warned: report.warned.join(', ') || '(none)',
      skipped: report.skipped.join(', ') || '(none)',
      checks: lines.join('\n'),
    }
  },

  async ensp_verify({ scenario, topology, timeout, wait }) {
    if (!scenario) throw new Error('scenario is required')
    if (!topology) throw new Error('topology is required: pass the .topo file that is running')
    const report = await runAcceptance({
      id: scenario,
      topology: path.resolve(topology),
      timeoutMs: timeout,
      waitMs: wait,
    })
    const detail = report.results
      .map((r) => {
        const mark = r.pass === true ? 'PASS' : r.pass === null ? 'SKIP' : 'FAIL'
        const waited = r.pass === true && r.waitedMs ? ` (converged after ${Math.round(r.waitedMs / 1000)}s)` : ''
        return `${mark} ${r.device ?? '(no device)'} · ${r.id}${waited}: ${r.why}`
      })
      .join('\n')
    return {
      scenario: report.scenario,
      ok: report.ok === true,
      verified: report.ok !== null,
      summary:
        report.ok === null
          ? `unverified: ${report.unverified}/${report.total} commands ran with no assertion (${report.source})`
          : `${report.passed}/${report.total} checks passed (${report.source})`,
      detail,
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
    const { verdict } = result.evidence
    const verdictText =
      verdict.ok === true
        ? `passed: ${verdict.passed}/${verdict.total} checks`
        : verdict.ok === false
          ? `failed: ${verdict.failed}/${verdict.total} checks`
          : `unverified: ${verdict.unverified}/${verdict.total} checks had no assertion`
    return {
      path: result.path,
      bytes: result.bytes,
      scenario: result.evidence.id,
      title: result.evidence.title,
      verdict: verdictText,
      devices: result.evidence.devices.length,
      checks: result.evidence.checks.length,
    }
  },
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

  for (const spec of TOOL_SPECS) {
    add(tools, {
      name: spec.name,
      description: spec.description,
      // A private copy per front end: `add()` and the schema helpers walk these
      // nodes, so the two tables must never share one object graph.
      parameters: structuredClone(spec.params),
      output: OUTPUTS[spec.name],
      execute: EXEC[spec.name],
    })
  }
}

/** Model metadata for the plugin row. */
export const dsh = {
  name: 'dsh-ensp',
  version: VERSION,
  description: 'Automate Huawei eNSP labs: build topology, boot devices, push config with verification.',
}

// The package root is the plugin entry, because that is what the Harness loads.
// Library users reached for the same specifier and found none of the functions the
// README shows, so the core surface is re-exported here as well. Nothing in
// `core` collides with the plugin exports above, and `dsh-ensp/core` still works
// for anyone who already imports it.
export * from '../core/index.mjs'
