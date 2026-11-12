/**
 * Curriculum knowledge attached to scenarios.
 *
 * The scenario presets say what to build and in what order. They deliberately do
 * not carry commands, because the whole point of the tool is to catch a copied
 * command that does not fit. What they were missing is the vocabulary the lab is
 * teaching: which LSA belongs to which area, which attribute wins a BGP decision,
 * which port role only MSTP has. That is exactly the material a certification
 * question bank covers.
 *
 * This module reads a small generated index instead of the question bank itself:
 * one topic, the scenarios that teach it, and a list of short question/answer
 * pairs. Keeping the bank out of the package matters for two reasons. Most of its
 * questions are three-sentence reading exercises that say nothing, and shipping
 * a copyrighted question bank inside a GPL package is not a reasonable default.
 *
 * @module dsh-ensp/knowledge
 */

import { readFileSync } from 'node:fs'

let cache = null

/**
 * Load the generated index, once.
 *
 * Read through `new URL` so the path resolves from this module rather than from
 * whatever directory the caller happens to run in.
 *
 * @returns {object}
 */
function catalogue() {
  if (cache) return cache
  const text = readFileSync(new URL('./knowledge.json', import.meta.url), 'utf8')
  cache = JSON.parse(text)
  return cache
}

/** @returns {string[]} the topics the index covers. */
export function knowledgeTopics() {
  return Object.keys(catalogue().topics).sort()
}

/**
 * Knowledge points for one scenario.
 *
 * A topic can feed several scenarios: `ospf` covers six of them, and each gets the
 * same points. That repetition is intentional. A learner running the multi-area
 * lab should not have to know that the material also sits under another scene.
 *
 * @param {string} scenarioId
 * @returns {Array<{topic: string, n: number, q: string, a: string}>}
 */
export function knowledgeFor(scenarioId) {
  const out = []
  for (const [topic, entry] of Object.entries(catalogue().topics)) {
    if (!entry.scenarios?.includes(scenarioId)) continue
    for (const point of entry.points || []) out.push({ topic, ...point })
  }
  return out
}

/**
 * Search the index by question or answer text.
 *
 * Case-insensitive substring match, same contract as {@link searchScenarios} so the
 * two can be chained in a CLI command without surprising the user.
 *
 * @param {string} query
 * @returns {Array<{topic: string, n: number, q: string, a: string}>}
 */
export function searchKnowledge(query) {
  const needle = String(query ?? '').trim().toLowerCase()
  if (!needle) return []
  const out = []
  for (const [topic, entry] of Object.entries(catalogue().topics)) {
    for (const point of entry.points || []) {
      if (`${point.q} ${point.a}`.toLowerCase().includes(needle)) out.push({ topic, ...point })
    }
  }
  return out
}

/**
 * Render the knowledge section for a scenario brief.
 *
 * Returns an empty string when the scenario has none, so callers can append it
 * unconditionally.
 *
 * @param {string} scenarioId
 * @param {object} [options]
 * @param {number} [options.limit=10]
 * @returns {string}
 */
export function renderKnowledge(scenarioId, { limit = 10 } = {}) {
  const points = knowledgeFor(scenarioId).slice(0, limit)
  if (!points.length) return ''
  const lines = ['', '## 知识点（来自认证题库，按主题归类）']
  for (const p of points) {
    lines.push(`- ${p.q}`)
    lines.push(`  答: ${p.a}`)
  }
  return lines.join('\n')
}
