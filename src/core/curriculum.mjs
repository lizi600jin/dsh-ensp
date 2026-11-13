/**
 * Access to the curriculum index: which vendor manual chapter teaches what, and
 * which commands that chapter uses to prove the result.
 *
 * The index holds only structure. The manuals themselves are vendor
 * documentation, are hundreds of pages each, and are not redistributed with this
 * package; what ships is the chapter title, the learning goals, and the
 * verification commands, which is what a scenario needs to point at.
 *
 * @module core/curriculum
 */

import { readFileSync } from 'node:fs'

let cached = null

function catalogue() {
  if (!cached) {
    cached = JSON.parse(readFileSync(new URL('./curriculum.json', import.meta.url), 'utf8'))
  }
  return cached
}

/** Levels that have chapters, in study order. */
export function curriculumLevels() {
  return Object.keys(catalogue().levels)
}

/** Every chapter, optionally limited to one level. */
export function curriculumChapters(level = null) {
  const { levels } = catalogue()
  if (level) return [...(levels[level] || [])]
  return Object.values(levels).flat()
}

/** Chapters that teach a given scenario, in study order. */
export function curriculumFor(scenarioId) {
  if (!scenarioId) return []
  return curriculumChapters().filter((chapter) => chapter.scenarios?.includes(scenarioId))
}

/** Chapter titles that mention a term, for a keyword search. */
export function searchCurriculum(query) {
  const needle = String(query ?? '').trim().toLowerCase()
  if (!needle) return []
  return curriculumChapters().filter((chapter) => {
    const haystack = [chapter.title, ...(chapter.goals || []), ...(chapter.verify || [])]
      .join(' ')
      .toLowerCase()
    return haystack.includes(needle)
  })
}

/**
 * Markdown block for a scenario brief, or an empty string when no chapter covers
 * it. Verification commands come from the manual rather than from this project,
 * so they carry the authority of whatever the vendor actually checks.
 */
export function renderCurriculum(scenarioId, { limit = 2 } = {}) {
  const chapters = curriculumFor(scenarioId).slice(0, limit)
  if (!chapters.length) return ''
  const lines = ['', '## 官方教材对应章节']
  for (const chapter of chapters) {
    lines.push(`- ${chapter.level} · ${chapter.title}（手册第 ${chapter.page} 页）`)
    if (chapter.verify?.length) {
      lines.push(`  验证：${chapter.verify.slice(0, 4).join(' / ')}`)
    }
  }
  return lines.join('\n')
}
