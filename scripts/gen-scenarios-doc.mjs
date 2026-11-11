#!/usr/bin/env node
/**
 * Regenerate `docs/SCENARIOS.md` from `src/core/presets.mjs`.
 *
 * The doc used to be maintained by hand, which meant the count in the heading
 * drifted away from the catalogue every time a scenario was added. It is now a
 * build product: run this after editing presets, and the same script validates
 * the catalogue before writing anything.
 *
 *   node scripts/gen-scenarios-doc.mjs          # rewrite docs/SCENARIOS.md
 *   node scripts/gen-scenarios-doc.mjs --check  # fail if the file is stale
 */

import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SCENARIOS, SCENARIO_IDS, byLevel } from '../src/core/presets.mjs'
import { LABS, LAB_IDS, hasLab, labAddressing, labDevices, labModels } from '../src/core/labs.mjs'
import { imageNotesFor } from '../src/core/compat.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const target = path.join(root, 'docs', 'SCENARIOS.md')

const LEVEL_TITLES = { basic: '基础', intermediate: '进阶', advanced: '高级' }
const REQUIRED = ['title', 'titleEn', 'level', 'source', 'devices', 'goal']

/**
 * Validate every entry. A broken catalogue should stop the build rather than
 * silently produce a doc missing a scenario.
 *
 * @returns {string[]} problems, empty when the catalogue is sound
 */
export function validateScenarios(catalogue = SCENARIOS) {
  const problems = []
  const ids = Object.keys(catalogue)
  const seenTitles = new Map()

  for (const id of ids) {
    const s = catalogue[id]
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) {
      problems.push(`${id}: id must be kebab-case`)
    }
    for (const field of REQUIRED) {
      if (!s?.[field] || typeof s[field] !== 'string') {
        problems.push(`${id}: missing ${field}`)
      }
    }
    if (!LEVEL_TITLES[s?.level]) {
      problems.push(`${id}: level must be basic, intermediate or advanced (got ${s?.level})`)
    }
    if (!Array.isArray(s?.steps) || s.steps.length === 0) {
      problems.push(`${id}: needs at least one step`)
    } else {
      s.steps.forEach((step, i) => {
        if (!step?.do || typeof step.do !== 'string') problems.push(`${id}: step ${i + 1} has no "do"`)
        if (step?.detail !== undefined && typeof step.detail !== 'string') {
          problems.push(`${id}: step ${i + 1} detail must be a string`)
        }
        if (step?.verify !== undefined && typeof step.verify !== 'string') {
          problems.push(`${id}: step ${i + 1} verify must be a string`)
        }
      })
    }
    if (!Array.isArray(s?.pitfalls) || s.pitfalls.length === 0) {
      problems.push(`${id}: needs at least one pitfall`)
    }

    const titleKey = `${s?.title}\u0000${s?.titleEn}`
    if (seenTitles.has(titleKey)) {
      problems.push(`${id}: duplicate title of ${seenTitles.get(titleKey)}`)
    } else {
      seenTitles.set(titleKey, id)
    }
  }
  for (const id of LAB_IDS) {
    if (!catalogue[id]) problems.push(`${id}: topology blueprint with no matching scenario`)
  }
  return problems
}

function render(catalogue = SCENARIOS) {
  const groups = byLevel()
  const out = [
    `# 场景预设（${SCENARIO_IDS.length} 个）`,
    '',
    '由 `scripts/gen-scenarios-doc.mjs` 从 `src/core/presets.mjs` 与 `src/core/labs.mjs` 生成，勿手改。',
    '',
    '每个场景只给**方向、顺序、验证命令**，不给成品命令块。',
    '',
    `其中 ${LAB_IDS.length} 个带拓扑蓝图，可直接生成 \`.topo\`：`,
    '',
    '```',
    'ensp preset ospf-single --topo ospf-single.topo',
    'ensp up ospf-single.topo',
    '```',
  ]

  for (const level of ['basic', 'intermediate', 'advanced']) {
    out.push('', `## ${LEVEL_TITLES[level]}`, '')
    for (const id of groups[level]) {
      const s = catalogue[id]
      out.push(`### ${id} — ${s.title}`, '')
      out.push(`- **英文名**：${s.titleEn}`)
      out.push(`- **来源**：${s.source}`)
      out.push(`- **设备**：${s.devices}`)
      out.push(`- **目标**：${s.goal}`)
      out.push('', '**配置顺序**', '')
      s.steps.forEach((step, i) => {
        const detail = step.detail ? ` — ${step.detail}` : ''
        out.push(`${i + 1}. **${step.do}**${detail}`)
        if (step.verify) out.push(`   - 验证：\`${step.verify}\``)
      })
      if (s.pitfalls?.length) {
        out.push('', '**易错点**', '')
        for (const p of s.pitfalls) out.push(`- ${p}`)
      }
      if (hasLab(id)) {
        out.push('', '**拓扑蓝图**', '')
        out.push(`- 设备：${labDevices(id).join('、')}`)
        const links = LABS[id].links.length
        out.push(`- 链路：${links} 条`)
        const addressing = labAddressing(id)
        if (addressing.length) {
          out.push('', '| 设备 | 接口 | 地址 | 说明 |', '| --- | --- | --- | --- |')
          for (const row of addressing) {
            out.push(`| ${row.device} | ${row.port} | ${row.ip} | ${row.note || ''} |`)
          }
        }
        out.push('', `生成：\`ensp preset ${id} --topo ${id}.topo\``)
        const notes = imageNotesFor(labModels(id))
        for (const [model, note] of notes) out.push(`- 设备镜像：${model} ${note}`)
      }
      out.push('')
    }
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`
}

const problems = validateScenarios()
if (problems.length) {
  console.error(`catalogue invalid (${problems.length}):`)
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}

// Only act when run directly. Tests import `validateScenarios` from this file, and
// an unguarded body would rewrite docs/SCENARIOS.md as a side effect of importing.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const next = render()
  const check = process.argv.includes('--check')

  if (check) {
    let current = ''
    try {
      current = await readFile(target, 'utf8')
    } catch {
      current = ''
    }
    if (current !== next) {
      console.error('docs/SCENARIOS.md is stale; run `node scripts/gen-scenarios-doc.mjs`')
      process.exit(1)
    }
    console.log(`docs/SCENARIOS.md is current (${SCENARIO_IDS.length} scenarios)`)
  } else {
    await writeFile(target, next, 'utf8')
    console.log(`wrote docs/SCENARIOS.md (${SCENARIO_IDS.length} scenarios)`)
  }
}
