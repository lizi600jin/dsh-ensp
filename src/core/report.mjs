/**
 * Turns a finished lab into a Word delivery report.
 *
 * The report is evidence, not narration. Every command in it was applied to a
 * live device in this run, every verification output is the text the device
 * printed, and the verdict at the top is the same three-state verdict
 * `ensp verify` gives. A lab whose checks had no assertion is reported as
 * unverified here too, so the document cannot claim more than the run proved.
 *
 * Chapter order follows what a course deliverable is expected to contain:
 * purpose, topology and addressing, configuration, verification, problems and
 * conclusion, appendix.
 *
 * @module core/report
 */

import { writeFileSync } from 'node:fs'
import { basename } from 'node:path'

import { buildDocx } from './docx.mjs'
import { consolePorts, runAcceptance } from './acceptance.mjs'
import { buildScenarioTopology, hasLab, labAddressing } from './labs.mjs'
import { SCENARIOS } from './presets.mjs'
import { queryDevice } from './provision.mjs'
import { readTopology } from './topology.mjs'

/** Kept short so one device's config cannot push a chapter onto its own page. */
const MAX_CONFIG_LINES = 400

/** How many verification commands to list in the appendix table. */
const APPENDIX_ROWS = 60

function today(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * Ask every device for its running configuration.
 *
 * `display current-configuration` is used rather than the .cfg files that were
 * applied: the files say what was meant, the device says what took effect, and
 * a report is worth more when those differ.
 */
async function collectConfigs(devices, query, timeoutMs) {
  const configs = []
  for (const device of devices) {
    const port = device.comPort
    if (!port) {
      configs.push({ device: device.name, text: '', note: '没有控制台端口，未读取配置' })
      continue
    }
    const res = await query({ port, command: 'display current-configuration', timeoutMs })
    const output = (res?.output || '').trim()
    if (!res?.ok || !output) {
      configs.push({
        device: device.name,
        text: '',
        note: res?.ok === false ? `读取失败：${res.error || '控制台无响应'}` : '设备无配置',
      })
      continue
    }
    const lines = output.split('\n')
    configs.push({
      device: device.name,
      text: lines.slice(0, MAX_CONFIG_LINES).join('\n'),
      note: lines.length > MAX_CONFIG_LINES ? `配置超过 ${MAX_CONFIG_LINES} 行，已截断` : '',
    })
  }
  return configs
}

/**
 * Run the lab's acceptance checks and keep the full output of each command.
 *
 * `runAcceptance` keeps a 400 character snippet because it is formatted for a
 * terminal. A document wants the whole table, so this wraps its `query` and
 * records the last answer per command, which after the convergence retry is the
 * converged one.
 */
async function collectChecks(id, { topology, ports, query, timeoutMs, waitMs, intervalMs, onProgress }) {
  // Key captured output by device name, not by port: the report prints device
  // names, and two devices can be asked the same question.
  const byPort = new Map()
  if (ports) {
    for (const [name, port] of ports) byPort.set(port, name)
  } else if (topology) {
    const parsed = await readTopology(topology)
    for (const [name, port] of consolePorts(parsed)) byPort.set(port, name)
  }
  const captured = new Map()
  const recording = async (args) => {
    const res = await query(args)
    const name = byPort.get(args.port) ?? String(args.port)
    captured.set(`${name}|${args.command}`, res?.output || '')
    return res
  }
  const report = await runAcceptance({
    id,
    ...(topology ? { topology } : { ports }),
    query: recording,
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(waitMs ? { waitMs } : {}),
    ...(intervalMs ? { intervalMs } : {}),
    ...(onProgress ? { onProgress } : {}),
  })
  const checks = report.results.map((r) => ({
    id: r.id,
    on: r.device,
    command: r.command,
    pass: r.pass,
    asserted: r.asserted,
    why: r.why,
    waitedMs: r.waitedMs || 0,
    output: captured.get(`${r.device}|${r.command}`) ?? '',
  }))
  return { ...report, checks }
}

/**
 * Gather everything the document needs from the running lab.
 *
 * @param {{
 *   id: string,
 *   topology?: string,
 *   query?: Function,
 *   timeoutMs?: number,
 *   waitMs?: number,
 *   intervalMs?: number,
 *   onProgress?: Function,
 * }} options
 */
export async function collectEvidence(options = {}) {
  const { id, topology, query = queryDevice, timeoutMs, waitMs, intervalMs, onProgress } = options
  const scenario = SCENARIOS[id]
  if (!scenario) {
    throw new Error(`unknown scenario "${id}"; available: ${Object.keys(SCENARIOS).join(', ')}`)
  }

  let devices = []
  let links = []
  let parsedPath = null
  if (topology) {
    const parsed = await readTopology(topology)
    parsedPath = topology
    devices = parsed.devices.map((d) => ({ name: d.name, model: d.model, comPort: d.comPort }))
    links = parsed.links.map((l) => ({
      a: l.srcName,
      aPort: l.srcPort,
      b: l.dstName,
      bPort: l.dstPort,
      media: l.media,
    }))
  } else if (hasLab(id)) {
    // No .topo on disk: describe the blueprint so the topology chapter is still
    // accurate, and use the ports the blueprint would hand out.
    const blueprint = buildScenarioTopology(id)
    devices = blueprint.devices.map((d) => ({ name: d.name, model: d.model, comPort: d.comPort }))
    links = blueprint.links.map((l) => ({
      a: l.srcName,
      aPort: l.srcPort,
      b: l.dstName,
      bPort: l.dstPort,
      media: l.media,
    }))
  }

  const portMap = new Map()
  for (const device of devices) {
    if (device.comPort) portMap.set(device.name, device.comPort)
  }

  const addressing = hasLab(id) ? labAddressing(id) : []
  const configs = await collectConfigs(devices, query, timeoutMs)
  const checks = await collectChecks(id, {
    topology: parsedPath,
    ports: parsedPath ? undefined : portMap,
    query,
    timeoutMs,
    waitMs,
    intervalMs,
    onProgress,
  })

  return {
    id,
    title: scenario.title,
    titleEn: scenario.titleEn,
    level: scenario.level,
    source: scenario.source,
    goal: scenario.goal,
    steps: scenario.steps || [],
    pitfalls: scenario.pitfalls || [],
    devices,
    links,
    addressing,
    configs,
    verdict: { ok: checks.ok, passed: checks.passed, failed: checks.failed, unverified: checks.unverified, total: checks.total },
    checks: checks.checks,
    sourceKind: checks.source,
    topologyPath: parsedPath,
    generatedAt: today(),
  }
}

function verdictSentence(evidence) {
  const { ok, passed, failed, unverified, total } = evidence.verdict
  if (!total) return '本次运行没有可执行的验证项。'
  if (ok === true) return `验证通过：${passed}/${total} 项检查全部满足，配置状态与预期一致。`
  if (ok === false) return `验证未通过：${failed}/${total} 项检查失败，详见第四章的失败原因。`
  return (
    `本次运行未验证：${unverified}/${total} 项检查没有断言，${passed} 项命令被设备接受。` +
    '命令被接受不等于状态正确，这一章不能作为达标证明。'
  )
}

function verdictNote(evidence) {
  const { ok } = evidence.verdict
  if (ok === true) return '验证结论：通过。'
  if (ok === false) return '验证结论：未通过。'
  return '验证结论：未验证。这些检查没有断言，只能证明命令被设备接受。'
}

/** Build the document blocks for a collected evidence set. */
export function buildReportBlocks(evidence) {
  const blocks = []
  const push = (...items) => blocks.push(...items)

  push(
    { type: 'title', text: `${evidence.title} 实验报告` },
    { type: 'subtitle', text: `${evidence.id} · dsh-ensp · ${evidence.generatedAt}` },
  )

  const deviceCount = evidence.devices.length
  push(
    { type: 'caption', text: '文档信息' },
    {
      type: 'table',
      header: ['项目', '内容'],
      rows: [
        ['实验场景', `${evidence.title}（${evidence.id}）`],
        ['实验级别', evidence.level],
        ['设备数量', String(deviceCount)],
        ['拓扑文件', evidence.topologyPath ? basename(evidence.topologyPath) : '未指定，按蓝图记录'],
        ['验证来源', evidence.sourceKind === 'curated' ? '针对性断言' : '仅命令执行'],
        ['验证结论', verdictSentence(evidence)],
        ['生成时间', evidence.generatedAt],
      ],
      widths: [2000, 7000],
    },
    { type: 'note', text: verdictSentence(evidence) },
  )

  // ---- 一、实验目的
  push({ type: 'heading', level: 1, text: '一、实验目的' })
  push({ type: 'para', text: `本次实验的目标是${evidence.goal}。` })
  if (evidence.steps.length) {
    push({ type: 'para', text: '需要完成的工作：' })
    push({ type: 'bullets', items: evidence.steps.map((s) => s.do) })
  }

  // ---- 二、拓扑与地址规划
  push({ type: 'heading', level: 1, text: '二、拓扑与地址规划' })
  if (deviceCount) {
    push({ type: 'para', text: `实验拓扑包含 ${deviceCount} 台设备、${evidence.links.length} 条链路。` })
    push(
      { type: 'caption', text: '表 2-1 设备清单' },
      {
        type: 'table',
        header: ['设备', '型号', '控制台端口'],
        rows: evidence.devices.map((d) => [d.name, d.model, d.comPort ? String(d.comPort) : '无']),
        widths: [3000, 3000, 3000],
      },
    )
  } else {
    push({ type: 'para', text: '本次运行未指定拓扑文件，拓扑部分按蓝图记录，实际连接以运行的实验为准。' })
  }

  if (evidence.links.length) {
    push(
      { type: 'caption', text: '表 2-2 链路连接' },
      {
        type: 'table',
        header: ['本端设备', '本端接口', '对端设备', '对端接口', '介质'],
        rows: evidence.links.map((l) => [l.a, l.aPort, l.b, l.bPort, l.media]),
        widths: [1800, 2400, 1800, 2400, 1400],
      },
    )
  }

  if (evidence.addressing.length) {
    push({ type: 'para', text: '地址规划如下表。接口名称与设备上的实际名称一致。' })
    push(
      { type: 'caption', text: '表 2-3 地址规划' },
      {
        type: 'table',
        header: ['设备', '接口', '地址', '说明'],
        rows: evidence.addressing.map((row) => [row.device, row.port, row.ip, row.note || '']),
        widths: [1600, 3000, 2600, 1800],
      },
    )
  } else {
    push({ type: 'note', text: '本场景的蓝图没有地址规划表，地址配置见第三章各设备的配置原文。' })
  }

  // ---- 三、配置思路与命令
  push({ type: 'heading', level: 1, text: '三、配置思路与命令' })
  if (evidence.steps.length) {
    push({ type: 'para', text: '配置顺序按下面的步骤推进，每一步的验证命令列在括号里。' })
    push({
      type: 'steps',
      items: evidence.steps.map((s) => (s.verify ? `${s.do}（验证：${s.verify}）` : s.do)),
    })
  }
  push({
    type: 'para',
    text: '下面的配置原文取自各设备执行 `display current-configuration` 的结果，是本次运行实际生效的内容。',
  })

  for (const config of evidence.configs) {
    push({ type: 'heading', level: 2, text: config.device })
    if (config.note && !config.text) {
      push({ type: 'note', text: config.note })
      continue
    }
    push({ type: 'code', text: config.text })
    if (config.note) push({ type: 'note', text: config.note })
  }

  // ---- 四、验证结果
  push({ type: 'heading', level: 1, text: '四、验证结果' })
  push({ type: 'para', text: verdictSentence(evidence) })

  let index = 0
  for (const check of evidence.checks) {
    index += 1
    const mark = check.pass === true ? '通过' : check.pass === null ? '未验证' : '未通过'
    push({ type: 'heading', level: 2, text: `4.${index} ${check.id}（${check.on}）` })
    push({ type: 'para', text: `检查命令：\`${check.command}\`。判定结果：${mark}。` })
    if (check.output) {
      push({ type: 'code', text: check.output })
    } else {
      push({ type: 'note', text: '该命令没有返回内容。' })
    }
    if (check.pass !== true) {
      const waited = check.waitedMs ? `（已等待 ${Math.round(check.waitedMs / 1000)} 秒）` : ''
      push({ type: 'note', text: `判定说明：${check.why}${waited}` })
    }
  }

  push({ type: 'note', text: verdictNote(evidence) })

  // ---- 五、问题与结论
  push({ type: 'heading', level: 1, text: '五、问题与结论' })
  if (evidence.pitfalls.length) {
    push({ type: 'para', text: '这个实验容易出错的地方：' })
    push({ type: 'bullets', items: evidence.pitfalls })
  }
  push({ type: 'heading', level: 2, text: '结论' })
  push({ type: 'para', text: verdictSentence(evidence) })

  const failed = evidence.checks.filter((c) => c.pass === false)
  if (failed.length) {
    push({ type: 'para', text: '需要处理的问题：' })
    push({ type: 'bullets', items: failed.map((c) => `${c.id}（${c.on}）：${c.why}`) })
  }

  // ---- 六、附录
  push({ type: 'heading', level: 1, text: '六、附录' })
  push({ type: 'heading', level: 2, text: '复现步骤' })
  push({
    type: 'steps',
    items: [
      `生成拓扑：\`ensp preset ${evidence.id} --topo ${evidence.id}.topo\``,
      `启动设备：\`ensp up --topology ${evidence.id}.topo\``,
      '按第三章的配置原文在各设备上执行配置',
      `运行验证：\`ensp verify ${evidence.id} --topology ${evidence.id}.topo\``,
      `生成文档：\`ensp report ${evidence.id} --topology ${evidence.id}.topo\``,
    ],
  })
  push({ type: 'heading', level: 2, text: '验证命令清单' })
  push({ type: 'caption', text: '表 6-1 验证命令与结果' })
  push({
    type: 'table',
    header: ['序号', '设备', '命令', '结果'],
    rows: evidence.checks.slice(0, APPENDIX_ROWS).map((c, i) => [
      String(i + 1),
      String(c.on),
      c.command,
      c.pass === true ? '通过' : c.pass === null ? '未验证' : '未通过',
    ]),
    widths: [900, 1600, 5100, 1400],
  })

  return blocks
}

/**
 * Collect evidence, render the document and write it to disk.
 *
 * @returns {Promise<{path: string, bytes: number, evidence: object}>}
 */
export async function writeReport(options = {}) {
  const { out, ...rest } = options
  const evidence = await collectEvidence(rest)
  const blocks = buildReportBlocks(evidence)
  const buffer = buildDocx(blocks)
  const path = out || `${evidence.id}-report.docx`
  writeFileSync(path, buffer)
  return { path, bytes: buffer.length, evidence }
}
