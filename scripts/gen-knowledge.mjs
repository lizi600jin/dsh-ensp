/**
 * Regenerate `src/core/knowledge.json`.
 *
 * Usage:
 *   node scripts/gen-knowledge.mjs <source.json> [more.json ...]
 *
 * The source is any array of `{ n, type, stem, options: [{key, text}], answer,
 * analysis, topics }`. It is not part of this package; what ships is the index
 * this script produces, so the transformation has to be reproducible and
 * reviewable by anyone who has the source.
 *
 * Two rules shape the output, and both exist because the obvious version of this
 * script produced a worse index:
 *
 * 1. **One topic per question.** Upstream tags are unreliable: a question
 *    about OSPF LSA types carries `ospf` and `security` both, and honouring every
 *    tag files the same fact under two headings. Score the text against topic
 *    keywords and keep the best match.
 * 2. **Drop "which is wrong" questions.** Once the distractors are removed, the
 *    surviving string is a false statement, which is worse than no material.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/** Topic tag -> the scenarios that teach it. */
const TOPIC_SCENARIOS = {
  ospf: ['ospf-single', 'ospf-multi-area', 'ospf-stub-nssa', 'ospf-lsa-types', 'ospf-virtual-link', 'ospf-troubleshooting'],
  bgp: ['bgp-ebgp-ibgp', 'bgp-route-reflector', 'bgp-attributes', 'bgp-aggregation', 'bgp-troubleshooting'],
  isis: ['isis-multi-level'],
  switching: [
    'vlan-access',
    'trunk-interconnect',
    'stp-rstp',
    'mstp-load-balance',
    'link-aggregation',
    'super-vlan',
    'port-security',
    'port-isolation',
    'stack-istack',
  ],
  multicast: ['multicast-pim-sm'],
  mpls: ['mpls-basic', 'mpls-l3vpn'],
  ipv6: ['ipv6', 'ospfv3-ipv6'],
  qos: ['qos-basics'],
  management: ['network-management'],
  reliability: ['vrrp-basics', 'bfd-fast-convergence', 'firewall-hrp', 'dual-homed-isp'],
  security: ['acl-filter', 'aaa-local', 'ipsec-vpn', 'firewall-zones', 'firewall-hrp', 'arp-security', 'dhcp-snooping', 'port-security'],
}

/** Keywords that decide which topic a question belongs to. */
const TOPIC_TERMS = {
  ospf: ['ospf', 'lsa', 'abr', 'asbr', 'nssa', 'stub', 'router-id'],
  bgp: ['bgp', 'as-path', 'ibgp', 'ebgp', 'community', 'aggregator', 'med', 'local-preference'],
  isis: ['is-is', 'isis', 'level-1', 'level-2', 'dis', 'lsp', 'att'],
  switching: ['vlan', 'mstp', 'rstp', 'stp', 'eth-trunk', '端口隔离', '端口安全', '堆叠', '根桥', 'bpdu'],
  multicast: ['pim', 'igmp', '组播', 'rpf', 'spt'],
  mpls: ['mpls', 'ldp', 'lsr', '标签', 'vpn-instance'],
  ipv6: ['ipv6', 'ospfv3', 'slaac'],
  qos: ['qos', '队列', '拥塞', '流量监管', '优先级映射'],
  management: ['网络管理', '网管', 'snmp', 'ntp', '日志', 'info-center', 'netconf', 'telemetry'],
  reliability: ['vrrp', 'bfd', 'hrp', '双机热备', '主备'],
  security: ['acl', '安全区域', 'security-policy', 'ipsec', 'ike', 'aaa', 'radius', '防火墙', 'nat'],
}

/** A question phrased this way keeps only a false statement once stripped. */
const NEGATIVE = /错误的是|不正确的是|不属于|不支持|不能|无需/

/**
 * Points kept per topic.
 *
 * The brief renders at most ten of them, so this cap is about how much depth a
 * topic carries into the index, not about screen space. It has to be generous:
 * every source that feeds the index contributes its own best rows, and a tight
 * cap lets a later source push out an earlier one entirely.
 */
const MAX_POINTS = 24

/** A question must score at least this many keyword hits to be filed at all. */
const MIN_SCORE = 2

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1).replace(/[，,、；;：: .]*$/, '') + '…')

/**
 * The answer as readable text.
 *
 * A bare key list (`A,C`) teaches nothing, so every chosen option is spelled out.
 * When the option text is unusable the explanation carries the fact instead: it
 * is the part a reader can actually learn from, and dropping the question because
 * its options came back blank throws away the answer along with them. Returns ''
 * only when neither source says anything.
 */
function answerText(q) {
  const keys = clean(q.answer).toUpperCase().match(/[A-Z]/g)
  const picked = (q.options || []).filter(
    (o) => keys?.includes(String(o.key).toUpperCase()) && clean(o.text).replace(/^[.、\s]*$/, ''),
  )
  if (picked.length) {
    return picked.map((o) => `${o.key}. ${clip(clean(o.text), 70)}`).join(' / ')
  }
  const explained = clean(q.analysis)
  if (explained.length >= 12) return clip(explained, 130)
  if (q.type === '判断题') return clean(q.answer) || ''
  return ''
}

/**
 * Build the index.
 *
 * Two sources feed one topic's points: the keyword pass over the raw questions,
 * and `carry` rows that are already in the shipped shape (`{topic, n, q, a}`).
 * The carry path exists because the index is built from more than one source
 * over time, and rebuilding from a single source would silently drop whatever
 * the other one contributed.
 *
 * @param {Array<object>} source raw questions
 * @param {Array<{topic: string, n: number, q: string, a: string}>} [carry] points to keep as-is
 * @returns {object}
 */
export function buildIndex(source, carry = []) {
  const perTopic = {}
  for (const q of source) {
    const answer = answerText(q)
    if (!answer) continue
    const stem = clean(q.stem)
    if (NEGATIVE.test(stem)) continue
    const hay = (stem + ' ' + clean(q.analysis)).toLowerCase()
    let best = null
    let bestScore = 0
    for (const [topic, terms] of Object.entries(TOPIC_TERMS)) {
      const score = terms.reduce((sum, t) => sum + (hay.split(t).length - 1), 0)
      if (score > bestScore) {
        bestScore = score
        best = topic
      }
    }
    if (!best || bestScore < MIN_SCORE) continue
    ;(perTopic[best] ||= []).push({ n: q.n, q: clip(stem, 90), a: answer, score: bestScore })
  }

  const topics = {}
  for (const topic of new Set([...Object.keys(perTopic), ...carry.map((c) => c.topic)])) {
    const rows = perTopic[topic] || []
    // Highest keyword score first, then the shortest stem: a one-line question
    // states a fact, while a long one describes a scene.
    const ranked = rows.slice().sort((a, b) => b.score - a.score || a.q.length - b.q.length)
    const seen = new Set()
    const points = []
    // Carried points go first. They were already reviewed when they shipped, so a
    // later source adds to them rather than displacing them; the alternative
    // silently traded an established fact for a new one that scored higher.
    for (const c of carry) {
      if (c.topic !== topic) continue
      if (points.length >= MAX_POINTS) break
      const key = c.q.slice(0, 40) + '|' + c.a.slice(0, 30)
      if (seen.has(key)) continue
      seen.add(key)
      points.push({ n: c.n, q: c.q, a: c.a })
    }
    for (const r of ranked) {
      if (points.length >= MAX_POINTS) break
      const key = r.q.slice(0, 40) + '|' + r.a.slice(0, 30)
      if (seen.has(key)) continue
      seen.add(key)
      points.push({ n: r.n, q: r.q, a: r.a })
    }
    topics[topic] = { scenarios: TOPIC_SCENARIOS[topic], points }
  }

  return {
    version: 1,
    topics,
  }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const args = process.argv.slice(2)
  const carryPath = args.find((a) => a.startsWith('--carry='))?.slice('--carry='.length)
  const sourcePaths = args.filter((a) => !a.startsWith('--'))
  if (!sourcePaths.length) {
    console.error('usage: node scripts/gen-knowledge.mjs [--carry=index.json] <source.json> [more.json ...]')
    process.exit(2)
  }
  const source = sourcePaths.flatMap((p) => JSON.parse(readFileSync(p, 'utf8')))
  const carry = carryPath ? JSON.parse(readFileSync(carryPath, 'utf8')) : []
  const index = buildIndex(source, carry)
  const target = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'core', 'knowledge.json')
  writeFileSync(target, JSON.stringify(index, null, 1) + '\n', 'utf8')
  const total = Object.values(index.topics).reduce((sum, t) => sum + t.points.length, 0)
  console.log(`wrote src/core/knowledge.json (${total} points from ${source.length} questions)`)
}
