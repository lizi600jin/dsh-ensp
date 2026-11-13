/**
 * Build the curriculum index from extracted vendor lab manuals.
 *
 * The manuals are hundreds of pages each and cannot ship: they are vendor
 * documentation, they are far larger than this package, and most of a page is
 * prose that a tool has no use for. What *is* useful is the skeleton of each
 * chapter: what it claims to teach, which `display` commands it uses to prove the
 * claim, and which built-in scenario covers the same ground. That skeleton is
 * small, factual, and stable across manual revisions.
 *
 * Input is the page-by-page JSON produced from the PDFs by the extractor in
 * `_huawei/pages.py`; output is `src/core/curriculum.json`. The extractor is not
 * part of the package because it needs the PDFs, which are not redistributable.
 *
 *   node scripts/gen-curriculum.mjs <guides.json> [more.json ...]
 *
 * @module scripts/gen-curriculum
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/** Manuals whose chapters duplicate another manual; keep the first of each pair. */
const SKIP_MANUAL = /YunShan_OS|eNSP_Pro/

/**
 * Which built-in scenarios a manual chapter teaches.
 *
 * This mapping is the actual editorial work. It is keyed by
 * `<level>:<chapter title>` so it survives a chapter being renumbered in a later
 * manual revision, and so a missing chapter is a visible gap rather than a silent
 * mis-filing.
 */
const CHAPTER_SCENARIOS = {
  'HCIA:华为网络设备基本操作': ['vlan-access', 'trunk-interconnect'],
  'HCIA:VLAN 配置实验': ['vlan-access', 'trunk-interconnect', 'vlanif-routing', 'super-vlan'],
  'HCIA:生成树配置实验': ['stp-rstp', 'mstp-load-balance'],
  'HCIA:以太网链路聚合实验': ['link-aggregation'],
  'HCIA:直连路由实验': ['vlanif-routing'],
  'HCIA:静态路由实验': ['static-route'],
  'HCIA:IP 地址自动配置实验': ['dhcp', 'dhcp-snooping'],
  'HCIA:OSPF 配置实验': ['ospf-single'],
  'HCIA:IPv6 地址配置实验': ['ipv6', 'ospfv3-ipv6'],
  'HCIA:ACL 配置实验': ['acl-filter', 'nat'],
  'HCIA:文件管理实验': ['aaa-local', 'network-management'],
  'HCIA:远程登录实验': ['aaa-local', 'network-management'],
  'HCIA:NAT 配置实验': ['nat', 'acl-filter'],
  'HCIA:WAC+FIT AP 组网实验': ['wlan-basic', 'wlan-roaming'],
  'HCIA:网络编程自动化实验': ['network-management'],
  'HCIA:网络故障排除实验': ['ospf-troubleshooting', 'bgp-troubleshooting'],
  'HCIA:园区网络综合实验': ['campus-network', 'vlanif-routing', 'static-route'],

  'HCIP:OSPF 基础实验': [
    'ospf-single',
    'ospf-multi-area',
    'ospf-lsa-types',
    'ospf-stub-nssa',
    'ospf-virtual-link',
  ],
  'HCIP:IS-IS 基础实验': ['isis-multi-level'],
  'HCIP:BGP 实验': ['bgp-ebgp-ibgp', 'bgp-route-reflector', 'bgp-aggregation'],
  'HCIP:路由策略与路由控制实验': ['route-policy-pbr', 'bgp-attributes'],
  'HCIP:RSTP 与MSTP 实验': ['stp-rstp', 'mstp-load-balance', 'vrrp-basics'],
  'HCIP:组播实验': ['multicast-pim-sm'],
  'HCIP:防火墙技术实验': ['firewall-zones', 'nat'],
  'HCIP:VRRP 实验': ['vrrp-basics'],
  'HCIP:DHCP 实验': ['dhcp', 'dhcp-snooping'],
  'HCIP:WLAN 实验': ['wlan-basic', 'wlan-roaming'],

  'HCIP:IGP 高级特性实验': ['ospf-troubleshooting', 'bfd-fast-convergence', 'isis-multi-level'],
  'HCIP:BGP 高级特性实验': ['bgp-troubleshooting', 'bgp-attributes', 'bgp-aggregation'],
  'HCIP:IPv6 实验': ['ipv6', 'ospfv3-ipv6'],
  'HCIP:VLAN 高级技术实验': ['super-vlan', 'port-isolation'],
  'HCIP:以太网交换安全实验': ['port-security', 'arp-security', 'dhcp-snooping'],
  'HCIP:BGP/MPLS IP VPN 实验': ['mpls-basic', 'mpls-l3vpn'],
  'HCIP:网络准入控制实验': ['port-security', 'aaa-local', 'dhcp-snooping'],
  'HCIP:VXLAN 与EVPN 实验': ['spine-leaf-vxlan', 'mpls-basic'],

  'HCIE:IPv4 路由技术': ['ospf-troubleshooting', 'isis-multi-level', 'bgp-troubleshooting', 'bfd-fast-convergence'],
  'HCIE:MPLS VPN': ['mpls-basic', 'mpls-l3vpn', 'ipsec-gre-tunnel'],
  'HCIE:EVPN': ['mpls-basic', 'spine-leaf-vxlan'],
  'HCIE:IPv6 路由技术': ['ospfv3-ipv6', 'ipv6'],
  'HCIE:VXLAN 实验': ['spine-leaf-vxlan'],
  'HCIE:VXLAN 虚拟化园区部署': ['spine-leaf-vxlan', 'wlan-roaming'],
  'HCIE:广域互联网络部署': ['dual-homed-isp', 'ipsec-gre-tunnel'],
  'HCIE:SR-MPLS 实验': ['mpls-basic', 'mpls-l3vpn'],
  'HCIE:SRv6 实验': ['ipv6', 'ospfv3-ipv6', 'mpls-l3vpn'],
  'HCIE:网络开放可编程': ['network-management'],
}

/** Drop sentences that are exam questions or half-cut lines from the extraction. */
const NOISE = /^(分析|思考|讨论|如果|若|假设|为什么|如何)|？$|，$|、$/

const MAX_GOALS = 6
const MAX_VERIFY = 10

/** Chapter titles carry suffixes such as （可选）that vary between manual editions. */
function titleKey(title) {
  return tidy(title).replace(/[（(][^）)]{1,8}[）)]$/,'').trim()
}

function tidy(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .trim()
}

/** `display ip routing-tableprotocol ospf` comes back fused; split it. */
function fixCommand(cmd) {
  return tidy(cmd).replace(/(routing-table|interface|brief|peer)(protocol|interface|verbose)/gi, '$1 $2')
}

function pick(list, max, filter = () => true) {
  const out = []
  for (const raw of list) {
    const value = tidy(raw)
    if (!value || value.length < 4 || NOISE.test(value)) continue
    if (!filter(value)) continue
    if (out.includes(value)) continue
    out.push(value)
    if (out.length >= max) break
  }
  return out
}

export function buildCurriculum(manuals) {
  const entries = []
  const seen = new Set()
  for (const chapter of manuals) {
    if (SKIP_MANUAL.test(chapter.manual)) continue
    const title = tidy(chapter.title)
    const key = `${chapter.level}:${titleKey(title)}`
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({
      level: chapter.level,
      title,
      page: chapter.page,
      scenarios: CHAPTER_SCENARIOS[key] || [],
      goals: pick(chapter.goals || [], MAX_GOALS, (g) => /^(实现|描述|阐明|掌握|理解|了解|配置)/.test(g)),
      verify: pick((chapter.verify || []).map(fixCommand), MAX_VERIFY, (c) => /^(display|ping|tracert)\s/.test(c)),
    })
  }
  entries.sort((a, b) => {
    const order = { HCIA: 0, HCIP: 1, HCIE: 2 }
    return (order[a.level] ?? 9) - (order[b.level] ?? 9) || a.page - b.page
  })
  const byLevel = { HCIA: [], HCIP: [], HCIE: [] }
  for (const entry of entries) (byLevel[entry.level] ||= []).push(entry)
  return { version: 1, levels: byLevel }
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (invokedDirectly) {
  const sources = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  if (!sources.length) {
    console.error('usage: node scripts/gen-curriculum.mjs <guides.json> [more.json ...]')
    process.exit(2)
  }
  const chapters = []
  for (const file of sources) {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    chapters.push(...(Array.isArray(parsed) ? parsed : parsed.chapters || []))
  }
  const index = buildCurriculum(chapters)
  const target = new URL('../src/core/curriculum.json', import.meta.url)
  writeFileSync(target, JSON.stringify(index, null, 1) + '\n')
  const counts = Object.entries(index.levels).map(([k, v]) => `${k} ${v.length}`)
  const mapped = Object.values(index.levels)
    .flat()
    .filter((e) => e.scenarios.length).length
  const bytes = JSON.stringify(index).length
  console.log(
    `wrote src/core/curriculum.json (${counts.join(', ')}; ${mapped} chapters mapped to scenarios; ${bytes} bytes)`,
  )
}
