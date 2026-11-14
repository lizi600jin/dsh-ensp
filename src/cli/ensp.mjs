#!/usr/bin/env node
/**
 * `ensp` command line.
 *
 * Three verbs cover the whole workflow:
 *
 *   ensp up      open a topology and boot every device, verifying each one
 *   ensp apply   push configuration files, one device at a time, with errors caught
 *   ensp status  show what is running and which consoles answer
 *
 * Plus `ensp probe`, which re-measures the toolbar anchors — necessary after an
 * eNSP upgrade or a change of display scaling.
 *
 * Exit codes: 0 success, 1 failure, 2 usage error.
 *
 * @module dsh-ensp/cli
 */

import { readFile, access, mkdir, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import { readTopology, summarise } from '../core/topology.mjs'
import {
  enspPid,
  locateWindow,
  startAllDevices,
  stopAllDevices,
  launchEnsp,
  showEnsp,
  waitForConsole,
} from '../core/launcher.mjs'
import { calibrateAnchors, inspectAnchors, DEFAULT_ANCHORS } from '../core/calibrate.mjs'
import { doctor, formatDoctor, modelsOf } from '../core/doctor.mjs'
import { runAcceptance, formatAcceptance, hasChecks, planFor } from '../core/acceptance.mjs'
import { pushConfig } from '../core/provision.mjs'
import { writeReport } from '../core/report.mjs'
import { SCENARIOS, SCENARIO_IDS, byLevel, renderScenario, searchScenarios } from '../core/presets.mjs'
import { curriculumFor, renderCurriculum, searchCurriculum } from '../core/curriculum.mjs'
import {
  LAB_IDS,
  buildScenarioTopology,
  hasLab,
  labAddressing,
  labDevices,
} from '../core/labs.mjs'
import { countLabConfigs, hasLabConfig, labConfigScript, labConfigs } from '../core/labconfig.mjs'
import { checkTopologySupport, pluginMediaPlan, pluginModels, installPluginMedia } from '../core/compat.mjs'
import { writeTopology } from '../core/topology.mjs'

const C = {
  dim: (s) => `\u001b[2m${s}\u001b[0m`,
  green: (s) => `\u001b[32m${s}\u001b[0m`,
  red: (s) => `\u001b[31m${s}\u001b[0m`,
  yellow: (s) => `\u001b[33m${s}\u001b[0m`,
  bold: (s) => `\u001b[1m${s}\u001b[0m`,
}

const HELP = `
${C.bold('ensp')} — automate Huawei eNSP labs

${C.bold('USAGE')}
  ensp up      <topology.topo> [--stop] [--keep-window]
  ensp apply   <config-dir> --topology <topology.topo> [--save] [--device NAME]
  ensp status  [--topology <topology.topo>]
  ensp doctor  [--topology <topology.topo>] [--json] [--shallow]
  ensp verify  <scenario-id> --topology <topology.topo> [--json] [--wait MS]
  ensp report  <scenario-id> [--topology <topology.topo>] [--out <file.docx>] [--json]
  ensp probe   [--json]
  ensp show    [--json]         (bring the eNSP window back to the front)
  ensp images  [--json] [<model>] [--install <image>]
  ensp stop    [--topology <topology.topo>]
  ensp preset  [<id>] [--search <keyword>] [--syllabus <keyword>] [--topo <out.topo>] [--config] [--json]
  ensp mcp     (start the MCP server on stdio)

${C.bold('OPTIONS')}
  --stop            stop all devices instead of starting them
  --keep-window     leave the eNSP window visible (default: minimise after clicking)
  --save            run "save" on each device after its configuration
  --device NAME     apply only to one device
  --timeout MS      per-device readiness timeout (default 240000)
  --wait MS         verify: how long a failing assertion may keep being retried (default 60000)
  --out PATH        report: where to write the .docx (default <scenario>-report.docx)
  --install PATH    images: put this device image where this machine's eNSP looks for it
  --syllabus KW     search the vendor manual chapter index (goals and verification commands)
  --config [DIR]    print the scenario's addressing plan as commands, or write one .cfg per device into DIR
  --topo PATH       write the scenario's topology blueprint to a .topo file
  --topology PATH   the .topo file that is running (doctor, verify)
  --exe PATH        full path to eNSP_Client.exe (default: auto-detect via registry and install roots)
  --vbox PATH       full path to VBoxManage.exe (default: auto-detect via PATH and install roots)
  --shallow         doctor: skip the input-injection probe
  --json            machine-readable output
  -h, --help        show this help

${C.bold('EXAMPLES')}
  ensp up lab.topo
  ensp doctor --topology lab.topo
  ensp verify ospf-single --topology lab.topo
  ensp report ospf-single --topology lab.topo --out ospf-single.docx
  ensp apply ./configs --topology lab.topo --save
  ensp status --topology lab.topo
  ensp up lab.topo --exe "C:/Program Files/Huawei/eNSP/eNSP_Client.exe"
  ensp probe
  ensp show
  ensp images
  ensp images USG6000V --install D:/downloads/vfw_usg.vdi
  ensp preset --search ospf
  ensp preset --syllabus "MPLS"
  ensp preset ospf-single
  ensp preset campus-network --topo campus.topo
  ensp mcp

${C.bold('NOTES')}
  · eNSP must be installed and runnable. It requires administrator rights.
  · Run this tool elevated too: a normal-integrity process cannot inject the mouse
    input that starts devices, and SendInput will silently report success.
  · Starting devices briefly focuses the eNSP window (it has to be clicked),
    then the window is minimised again. Run doctor first if a start does nothing.
  · Readiness is verified per device by polling its console, never by sleeping.
  · Verification is separate from configuration: ensp verify asserts on what
    each device actually reports.
`

/** Parse argv into { verb, positional, flags }. */
function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-h' || a === '--help') {
      flags.help = true
    } else if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next && !next.startsWith('--')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(a)
    }
  }
  return { verb: positional.shift() ?? null, positional, flags }
}

async function exists(file) {
  try {
    await access(file, constants.R_OK)
    return true
  } catch {
    return false
  }
}

/** Resolve the eNSP window, launching the client if needed. */
async function ensureWindow(topologyPath) {
  const pid = enspPid()
  if (pid) {
    const hwnd = locateWindow(pid)
    if (hwnd) return { hwnd, launched: false }
  }
  const launched = await launchEnsp({ topology: topologyPath })
  return { hwnd: launched.hwnd, launched: true }
}

/** Pretty console line for a device readiness event. */
function deviceLine(event) {
  const name = event.name.padEnd(12)
  if (event.ready) {
    return `  ${C.green('✓')} ${name} ${C.dim(`console ${event.port} → ${event.prompt}`)} ${C.dim(`${(event.waitedMs / 1000).toFixed(1)}s`)}`
  }
  return `  ${C.red('✗')} ${name} ${C.dim(`console ${event.port} never answered (${(event.waitedMs / 1000).toFixed(1)}s)`)}`
}

// --------------------------------------------------------------------------- up
async function cmdUp({ positional, flags }) {
  // `ensp stop --topology x.topo` is documented in the help text, so accept the flag
  // as well as the positional form; both mean the same file.
  const topoPath = positional[0] ?? flags.topology
  if (!topoPath) {
    console.error(C.red('error:') + ' missing topology path')
    return 2
  }
  if (!(await exists(topoPath))) {
    console.error(C.red('error:') + ` no such file: ${topoPath}`)
    return 2
  }

  const topo = await readTopology(path.resolve(topoPath))
  const info = summarise(topo)
  console.log(`${C.bold('topology')} ${topoPath}`)
  console.log(
    `  ${info.devices} devices, ${info.links} links ` +
      C.dim(`(${Object.entries(info.byModel).map(([m, n]) => `${m}×${n}`).join(', ')})`),
  )

  const { hwnd, launched } = await ensureWindow(path.resolve(topoPath))
  console.log(`${C.bold('window')} hwnd=${hwnd}${launched ? C.dim(' (launched)') : C.dim(' (reused)')}`)

  if (flags.stop) {
    const r = stopAllDevices(hwnd)
    console.log(`${C.bold('stop')} ${r.anchors?.method ?? 'default'} anchor ${JSON.stringify(r.anchors?.stop ?? DEFAULT_ANCHORS.stop)}`)
    console.log(`  ${C.yellow('all devices asked to shut down')}`)
    return 0
  }

  const timeout = Number(flags.timeout ?? 240000)
  console.log(`${C.bold('starting devices')} ${C.dim(`(per-device timeout ${timeout / 1000}s)`)}`)

  const result = await startAllDevices({
    devices: topo.devices,
    hwnd,
    perDeviceTimeoutMs: timeout,
    minimise: !flags.keepWindow,
    onProgress: (e) => {
      if (e.phase === 'calibrated') {
        console.log(
          `  ${C.dim('toolbar anchors')} ${e.method === 'measured' ? C.green('measured') : C.yellow('default')} ` +
            C.dim(JSON.stringify(e.detail.pickedStart ?? e.detail)),
        )
      } else if (e.phase === 'device') {
        console.log(deviceLine(e))
      } else if (e.phase === 'minimised') {
        console.log(`  ${C.dim('window minimised — desktop handed back')}`)
      }
    },
  })

  console.log(
    `\n${result.allReady ? C.green('all devices ready') : C.yellow(`${result.ready}/${result.total} devices ready`)}` +
      C.dim(` (${result.newPorts.length} new console ports)`),
  )
  return result.allReady ? 0 : 1
}

// ------------------------------------------------------------------------ apply
async function cmdApply({ positional, flags }) {
  const dir = positional[0]
  const topoPath = flags.topology
  if (!dir || !topoPath) {
    console.error(C.red('error:') + ' usage: ensp apply <config-dir> --topology <topology.topo>')
    return 2
  }

  const topo = await readTopology(path.resolve(topoPath))
  const consoles = new Map(topo.devices.filter((d) => d.comPort).map((d) => [d.name, d.comPort]))

  const entries = (await import('node:fs/promises')).readdir
  const files = await (await import('node:fs/promises')).readdir(dir)
  const cfgs = files.filter((f) => f.endsWith('.cfg') || f.endsWith('.txt'))
  if (!cfgs.length) {
    console.error(C.red('error:') + ` no .cfg/.txt files in ${dir}`)
    return 2
  }

  let failures = 0
  for (const file of cfgs) {
    const device = path.basename(file).replace(/\.(cfg|txt)$/, '')
    if (flags.device && flags.device !== device) continue
    const port = consoles.get(device)
    if (!port) {
      console.log(`  ${C.yellow('skip')} ${device} ${C.dim('(no console port in topology)')}`)
      continue
    }

    // Confirm the console is actually alive before pushing.
    const probe = await waitForConsole({ port, timeoutMs: 8000 })
    if (!probe.ready) {
      console.log(`  ${C.red('✗')} ${device} ${C.dim('console not answering, skipped')}`)
      failures++
      continue
    }

    const script = await readFile(path.join(dir, file), 'utf8')
    process.stdout.write(`  ${C.dim('…')} ${device.padEnd(12)}`)
    const r = await pushConfig({ device, port, script, save: Boolean(flags.save) })
    if (r.ok) {
      console.log(`\r  ${C.green('✓')} ${device.padEnd(12)} ${r.applied}/${r.total} commands${r.saved ? ', saved' : ''} ${C.dim(`${(r.durationMs / 1000).toFixed(1)}s`)}`)
    } else {
      failures++
      console.log(`\r  ${C.red('✗')} ${device.padEnd(12)} stopped at line ${r.failedAt?.line}: ${r.failedAt?.error}`)
      console.log(C.dim(`      ${r.failedAt?.command ?? ''}`))
      if (r.failedAt?.output) {
        console.log(C.dim(r.failedAt.output.trim().split('\n').slice(-6).map((l) => '      ' + l).join('\n')))
      }
    }
  }

  return failures ? 1 : 0
}

// ----------------------------------------------------------------------- status
async function cmdStatus({ flags }) {
  const pid = enspPid()
  if (!pid) {
    console.log(`${C.bold('eNSP')}  ${C.red('not running')}`)
    return 1
  }
  const hwnd = locateWindow(pid)
  console.log(`${C.bold('eNSP')}  pid=${pid} hwnd=${hwnd ?? C.red('no window')}`)

  const anchors = hwnd ? calibrateAnchors(hwnd) : { ...DEFAULT_ANCHORS, method: 'default', detail: {} }
  console.log(
    `${C.bold('anchors')} ${anchors.method === 'measured' ? C.green('measured') : C.yellow('default')} ` +
      `start=${JSON.stringify(anchors.start)} stop=${JSON.stringify(anchors.stop)}`,
  )

  if (!flags.topology) {
    console.log(C.dim('  (pass --topology to verify each console)'))
    return 0
  }
  const topo = await readTopology(path.resolve(flags.topology))
  const targets = topo.devices.filter((d) => d.comPort)
  console.log(`${C.bold('devices')} ${targets.length}`)

  let ready = 0
  await Promise.all(
    targets.map(async (d) => {
      const r = await waitForConsole({ port: d.comPort, timeoutMs: 4000 })
      if (r.ready) {
        ready++
        console.log(`  ${C.green('✓')} ${d.name.padEnd(12)} :${d.comPort} ${C.dim(r.prompt ?? '')}`)
      } else {
        console.log(`  ${C.red('✗')} ${d.name.padEnd(12)} :${d.comPort} ${C.dim('not answering')}`)
      }
    }),
  )
  console.log(`\n${ready}/${targets.length} consoles ready`)
  return ready === targets.length ? 0 : 1
}

// ----------------------------------------------------------------------- preset
async function cmdPreset({ positional, flags }) {
  const id = positional[0]

  if (flags.syllabus) {
    const hits = searchCurriculum(String(flags.syllabus))
    if (flags.json) {
      console.log(JSON.stringify(hits, null, 2))
      return hits.length ? 0 : 1
    }
    if (!hits.length) {
      console.log(C.yellow('no manual chapter matched') + ` "${flags.syllabus}"`)
      return 1
    }
    for (const h of hits) {
      console.log(`${C.bold(h.level)} ${h.title} ${C.dim('p' + h.page)}`)
      if (h.scenarios?.length) console.log(C.dim(`  场景: ${h.scenarios.join(', ')}`))
      if (h.verify?.length) console.log(C.dim(`  验证: ${h.verify.slice(0, 3).join(' / ')}`))
    }
    return 0
  }

  if (flags.search) {
    const hits = searchScenarios(String(flags.search))
    if (flags.json) {
      console.log(JSON.stringify(hits, null, 2))
      return hits.length ? 0 : 1
    }
    if (!hits.length) {
      console.log(C.yellow('no scenario matched') + ` "${flags.search}"`)
      return 1
    }
    for (const h of hits) {
      console.log(`${C.bold(h.id.padEnd(24))} ${h.title} ${C.dim(`[${h.level}]`)}`)
      console.log(C.dim(`  ${h.goal}`))
    }
    return 0
  }

  if (!id) {
    const groups = byLevel()
    const labels = { basic: '基础', intermediate: '进阶', advanced: '高级' }
    for (const [level, ids] of Object.entries(groups)) {
      if (!ids.length) continue
      console.log(`${C.bold(labels[level])} ${C.dim(`(${ids.length})`)}`)
      for (const sid of ids) {
        console.log(`  ${sid.padEnd(24)} ${SCENARIOS[sid].title}`)
      }
      console.log()
    }
    console.log(C.dim(`${SCENARIO_IDS.length} 个预设 · ensp preset <id> 查看详情 · --search <kw> 搜索`))
    return 0
  }

  if (!SCENARIOS[id]) {
    console.error(C.red('error:') + ` unknown scenario "${id}" · ensp preset --search <kw>`)
    return 2
  }

  try {
    if (flags.config) {
      if (!hasLabConfig(id)) {
        console.error(
          C.red('error:') +
            ` scenario "${id}" has no addressing plan to turn into a script; ${countLabConfigs()} of ${SCENARIO_IDS.length} have one`,
        )
        return 2
      }
      const script = labConfigScript(id)
      if (flags.config !== true) {
        // A path was given, so write the one-file-per-device directory that
        // `ensp apply` reads instead of printing a script the reader has to
        // split by hand.
        const dir = path.resolve(String(flags.config))
        await mkdir(dir, { recursive: true })
        const written = []
        for (const entry of labConfigs(id)) {
          const file = path.join(dir, entry.device + '.cfg')
          await writeFile(file, entry.script + '\n', 'utf8')
          written.push(file)
        }
        if (flags.json) {
          console.log(JSON.stringify({ scenario: id, directory: dir, files: written }, null, 2))
          return 0
        }
        for (const file of written) console.log(`${C.green('wrote')} ${file}`)
        console.log(
          C.dim(`\n# 只有地址规划 · 路由与策略仍按步骤自己配\n# 下一步: ensp apply ${dir} --topology <lab.topo>`),
        )
        return 0
      }
      if (flags.json) {
        console.log(JSON.stringify({ scenario: id, script }, null, 2))
        return 0
      }
      console.log(script)
      console.log(
        C.dim(
          `\n# 只覆盖地址规划，路由与策略仍按步骤自己配 · 给 --config 一个目录即可写成每台设备一个 .cfg`,
        ),
      )
      return 0
    }

    if (flags.topo) {
      if (!hasLab(id)) {
        console.error(
          C.red('error:') +
            ` scenario "${id}" has no topology blueprint yet; ${LAB_IDS.length} of ${SCENARIO_IDS.length} have one`,
        )
        return 2
      }
      const topo = buildScenarioTopology(id)
      const target = path.resolve(String(flags.topo))
      await writeTopology(target, topo)
      console.log(`${C.green('wrote')} ${target}`)
      for (const line of labDevices(id)) console.log(`  ${line}`)
      for (const row of labAddressing(id)) {
        console.log(`  ${row.device.padEnd(10)} ${row.port.padEnd(22)} ${row.ip.padEnd(20)} ${C.dim(row.note)}`)
      }
      console.log(C.dim(`  ${topo.devices.length} 台设备 · ${topo.links.length} 条链路 · ensp up ${target}`))

      // Warn now rather than let `ensp up` fail later: a missing device image is
      // invisible in the .topo file and eNSP quits without a message.
      const support = checkTopologySupport(topo)
      if (!support.ok) {
        console.error('')
        for (const b of support.blocked) {
          console.error(`${C.yellow('warning:')} ${b.name} (${b.model}) ${b.reason}`)
        }
        console.error(
          C.dim('  这台机器装不上该机型时，eNSP 会打开拓扑后自行退出，ensp up 会直接报错。'),
        )
      }
      return 0
    }

    const text = renderScenario(id)
    const chapters = curriculumFor(id).map((c) => ({
      level: c.level,
      title: c.title,
      page: c.page,
      verify: c.verify,
    }))
    console.log(
      flags.json
        ? JSON.stringify({ ...SCENARIOS[id], curriculum: chapters }, null, 2)
        : text,
    )
    const taught = renderCurriculum(id)
    if (taught) console.log(taught)
    if (hasLab(id)) {
      console.log(C.dim(`\n可生成拓扑: ensp preset ${id} --topo ${id}.topo`))
    }
    if (hasLabConfig(id)) {
      console.log(C.dim(`地址规划: ensp preset ${id} --config`))
    }
    return 0
  } catch (error) {
    console.error(C.red('error:') + ' ' + error.message)
    return 2
  }
}

// -------------------------------------------------------------------------- mcp
async function cmdMcp() {
  const { serve } = await import('../mcp/server.mjs')
  serve()
  return null // keep the process alive
}

// ------------------------------------------------------------------------ probe
async function cmdProbe({ flags }) {
  const pid = enspPid()
  if (!pid) {
    console.error(C.red('error:') + ' eNSP is not running')
    return 1
  }
  const hwnd = locateWindow(pid)
  if (!hwnd) {
    console.error(C.red('error:') + ' eNSP window not found')
    return 1
  }
  const r = inspectAnchors(hwnd)
  if (flags.json) {
    console.log(JSON.stringify(r, null, 2))
    return r.resolved?.method === 'measured' ? 0 : 1
  }
  console.log(`${C.bold('window')} ${r.window ?? '?'} (physical pixels)`)
  console.log(`${C.bold('green clusters')} ${r.green.length}`)
  for (const g of r.green) console.log(C.dim(`  x=${g.x} y=${g.y} ${g.w}x${g.h}`))
  console.log(`${C.bold('red clusters')} ${r.red.length}`)
  for (const g of r.red) console.log(C.dim(`  x=${g.x} y=${g.y} ${g.w}x${g.h}`))
  if (r.resolved) {
    console.log(
      `\n${C.bold('resolved')} ${r.resolved.method === 'measured' ? C.green('measured') : C.yellow('default')}`,
    )
    console.log(`  start ${JSON.stringify(r.resolved.start)}`)
    console.log(`  stop  ${JSON.stringify(r.resolved.stop)}`)
  }
  return r.resolved?.method === 'measured' ? 0 : 1
}

/**
 * `ensp show` (alias `ensp front`)
 *
 * Bring eNSP back out of the taskbar and in front, so the lab can be watched while
 * it is being configured. Booting minimises the window on purpose, which is fine
 * until someone wants to look at it.
 */
async function cmdShow({ flags }) {
  const pid = enspPid()
  if (!pid) {
    console.error(C.red('error:') + ' eNSP is not running')
    return 1
  }
  const hwnd = locateWindow(pid)
  if (!hwnd) {
    console.error(C.red('error:') + ' eNSP window not found')
    return 1
  }
  const r = showEnsp(hwnd)
  if (flags.json) {
    console.log(JSON.stringify({ pid, hwnd, ...r }, null, 2))
    return r.raised ? 0 : 1
  }
  console.log(`${C.bold('window')} ${hwnd} (pid ${pid})`)
  console.log(r.restored ? `${C.green('restored')} from the taskbar` : C.dim('was not minimised'))
  if (r.raised) {
    console.log(`${C.green('in front')}`)
    return 0
  }
  console.error(
    C.yellow('warning:') +
      ' the window was restored but another window still holds the foreground. Windows does not let another ' +
      'process raise a foreign window, so click the taskbar button once.',
  )
  return 1
}

/**
 * `ensp doctor [--topology t.topo] [--json] [--shallow]`
 *
 * Answers "why did nothing happen?" before a lab starts. Every failing check
 * carries its own fix, because the failure modes here (missing image, covered
 * window, dead input queue) all look the same from the outside.
 */
/**
 * Report which plugin device images this installation has, and install one.
 *
 * The destination is never guessed here: `pluginMediaPlan` reads it out of the
 * model's own VirtualBox template, so the same command works on a machine that
 * installed eNSP somewhere else.
 */
async function cmdImages({ positional, flags }) {
  const model = positional[0]

  if (flags.install) {
    if (!model) {
      console.error(C.red('error:') + ' usage: ensp images <model> --install <image-file>')
      return 2
    }
    const source = path.resolve(String(flags.install))
    if (!(await exists(source))) {
      console.error(C.red('error:') + ` no such file: ${source}`)
      return 2
    }
    let result
    try {
      result = installPluginMedia(model, source, { overwrite: Boolean(flags.overwrite) })
    } catch (error) {
      console.error(C.red('error:') + ' ' + error.message)
      return 1
    }
    if (flags.json) {
      console.log(JSON.stringify(result, null, 2))
      return 0
    }
    if (!result.bytes) {
      console.log(`${C.bold(model)} already has its image at ${result.target}`)
      console.log(C.dim('pass --overwrite to replace it'))
      return 0
    }
    console.log(`${C.green('installed')} ${model} → ${result.target} (${result.bytes} bytes)`)
    if (result.iniUpdated) console.log(C.dim('ImgFile updated in the plugin system.ini'))
    console.log(C.dim('restart eNSP if it is open, then run ensp doctor --topology <file>'))
    return 0
  }

  const models = model ? [model] : pluginModels()
  if (!models.length) {
    console.error(C.red('error:') + ' this eNSP installation declares no plugin devices')
    return 1
  }
  const plans = models.map((name) => pluginMediaPlan(name))

  if (flags.json) {
    console.log(JSON.stringify(plans, null, 2))
    return plans.every((p) => p.ready) ? 0 : 1
  }

  for (const plan of plans) {
    if (!plan.plugin) {
      console.log(`${C.bold(plan.model)} ${C.dim('not a plugin device in this installation')}`)
      continue
    }
    if (plan.ready) {
      console.log(`${C.green('ready')} ${plan.model} ${C.dim(plan.media.find((m) => m.present).relative)}`)
      continue
    }
    console.log(`${C.yellow('missing')} ${plan.model} ${C.dim(plan.target ?? 'no template')}`)
  }

  const missing = plans.filter((p) => p.plugin && !p.ready)
  if (missing.length) {
    console.log(
      '\n' +
        C.dim(
          'Install one with: ensp images <model> --install <image-file>\n' +
            'Or reinstall eNSP and tick the device component. eNSP opens a topology that ' +
            'uses these models, renders it, then quits by itself.',
        ),
    )
  }
  return missing.length ? 1 : 0
}

/** `ensp doctor [--topology t.topo] [--json] [--shallow]` */
async function cmdDoctor({ positional, flags }) {
  let models
  if (flags.topology || positional[0]) {
    const file = flags.topology || positional[0]
    try {
      models = modelsOf(await readTopology(file))
    } catch (error) {
      console.error(C.red('error:') + ' ' + error.message)
      return 1
    }
  }
  const report = doctor({
    exe: flags.exe,
    vbox: flags.vbox,
    models,
    deep: !flags.shallow,
  })
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2))
    return report.ok ? 0 : 1
  }
  console.log(formatDoctor(report))
  return report.ok ? 0 : 1
}

/**
 * Exit code for an acceptance report.
 *
 * 0 means the checks that carry an assertion all passed and at least one of them
 * existed. 1 means something contradicted the expected state. 3 means the lab was
 * reachable but nothing was asserted against it, so the run proved only that the
 * commands were accepted.
 */
function exitCodeFor(report) {
  if (report.ok === true) return 0
  if (report.ok === false) return 1
  return 3
}

/**
 * `ensp verify <scenario-id> --topology t.topo [--json]`
 *
 * Runs the scenario's acceptance checks against a lab that is already up. This
 * is the difference between "the commands were sent" and "the lab works": a
 * curated check asserts on what the device reports, and a smoke check at least
 * proves every verification command still parses.
 */
async function cmdVerify({ positional, flags }) {
  const id = positional[0]
  if (!id) {
    console.error(C.red('error:') + ' usage: ensp verify <scenario-id> --topology <topology.topo>')
    return 2
  }
  if (!SCENARIOS[id]) {
    console.error(C.red('error:') + ` unknown scenario "${id}"`)
    return 2
  }
  const topology = flags.topology
  if (!topology) {
    console.error(C.red('error:') + ' verify needs --topology <the .topo file that is running>')
    return 2
  }
  const report = await runAcceptance({
    id,
    topology,
    timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
    waitMs: flags.wait ? Number(flags.wait) : undefined,
    onProgress: flags.json
      ? undefined
      : (e) => {
          if (e.phase === 'check') process.stderr.write(C.dim(`  checking ${e.id} on ${e.device}\n`))
          else if (e.phase === 'retry')
            process.stderr.write(C.dim(`  waiting ${Math.round(e.waited / 1000)}s for ${e.id} on ${e.device} (${e.why})\n`))
        },
  })
  if (flags.json) {
    console.log(JSON.stringify(report, null, 2))
    return exitCodeFor(report)
  }
  console.log(formatAcceptance(report))
  return exitCodeFor(report)
}

async function cmdReport({ positional, flags }) {
  const id = positional[0]
  if (!id) {
    console.error(C.red('error:') + ' usage: ensp report <scenario-id> [--topology <topology.topo>] [--out <file.docx>]')
    return 2
  }
  if (!SCENARIOS[id]) {
    console.error(C.red('error:') + ` unknown scenario "${id}"`)
    return 2
  }
  const out = flags.out ? String(flags.out) : undefined
  if (!flags.json) {
    console.log(C.dim(`collecting evidence for ${id}${flags.topology ? ` from ${flags.topology}` : ' (blueprint ports)'}`))
  }
  const result = await writeReport({
    id,
    topology: flags.topology ? String(flags.topology) : undefined,
    out,
    timeoutMs: flags.timeout ? Number(flags.timeout) : undefined,
    waitMs: flags.wait ? Number(flags.wait) : undefined,
    onProgress: flags.json
      ? undefined
      : (e) => {
          if (e.phase === 'check') process.stderr.write(C.dim(`  checking ${e.id} on ${e.device}\n`))
          else if (e.phase === 'retry')
            process.stderr.write(C.dim(`  waiting ${Math.round(e.waited / 1000)}s for ${e.id} on ${e.device}\n`))
        },
  })
  const { verdict } = result.evidence
  if (flags.json) {
    console.log(
      JSON.stringify(
        { path: result.path, bytes: result.bytes, scenario: result.evidence.id, verdict },
        null,
        2,
      ),
    )
  } else {
    console.log(`wrote ${result.path} (${result.bytes} bytes)`)
    console.log(
      `verdict: ${verdict.ok === true ? 'passed' : verdict.ok === false ? 'failed' : 'unverified'} ` +
        `(${verdict.passed} passed, ${verdict.failed} failed, ${verdict.unverified} unverified of ${verdict.total})`,
    )
  }
  return verdict.ok === false ? 1 : 0
}

// ------------------------------------------------------------------------- main
async function main() {
  const { verb, positional, flags } = parseArgs(process.argv.slice(2))
  // --exe and --vbox are global: every verb that launches or inspects eNSP has
  // to see the same install, and the launcher reads these variables anyway.
  if (flags.exe) process.env.DSH_ENSP_EXE = String(flags.exe)
  if (flags.vbox) process.env.DSH_VBOX = String(flags.vbox)
  if (!verb || flags.help) {
    console.log(HELP)
    return flags.help && !verb ? 0 : 2
  }

  switch (verb) {
    case 'up':
      return cmdUp({ positional, flags })
    case 'apply':
      return cmdApply({ positional, flags })
    case 'status':
      return cmdStatus({ positional, flags })
    case 'probe':
      return cmdProbe({ positional, flags })
    case 'doctor':
      return cmdDoctor({ positional, flags })
    case 'verify':
      return cmdVerify({ positional, flags })
    case 'report':
      return cmdReport({ positional, flags })
    case 'stop':
      return cmdUp({ positional, flags: { ...flags, stop: true } })
    case 'show':
    case 'front':
      return cmdShow({ flags })
    case 'images':
      return cmdImages({ positional, flags })
    case 'preset':
      return cmdPreset({ positional, flags })
    case 'mcp':
      return cmdMcp()
    default:
      console.error(C.red('error:') + ` unknown command "${verb}"\n`)
      console.log(HELP)
      return 2
  }
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((error) => {
    console.error(C.red('error:') + ' ' + (error?.stack ?? error))
    process.exit(1)
  })
