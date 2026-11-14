#!/usr/bin/env node
/**
 * Re-derive the eNSP topology facts from the samples installed on this machine.
 *
 * `docs/ENSP-FORMAT.md` records what this script reported; re-run it after an eNSP
 * upgrade to see whether any model changed shape. Nothing here writes to the
 * samples — it only reads them.
 *
 * Usage: node scripts/survey-topologies.mjs [--json]
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

import { resolveEnspRoot } from '../src/core/paths.mjs'

/** Locations to scan when `ENSP_EXAMPLES` says nothing; the install on this machine comes first. */
function defaultRoots() {
  const installed = resolveEnspRoot()
  const roots = installed ? [path.join(installed, 'examples')] : []
  roots.push(
    'C:/Program Files/Huawei/eNSP/examples',
    'D:/Huawei/eNSP/examples',
    'E:/Huawei/eNSP/examples',
    '/opt/ensp/examples',
  )
  return roots
}

/** Recursively collect .topo paths. */
function findTopologies(root, out = []) {
  let entries
  try {
    entries = readdirSync(root)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(root, entry)
    let st
    try {
      st = statSync(full)
    } catch {
      continue
    }
    if (st.isDirectory()) findTopologies(full, out)
    else if (entry.toLowerCase().endsWith('.topo')) out.push(full)
  }
  return out
}

/** Extract everything the survey needs from one file. */
function inspect(file) {
  const text = readFileSync(file, 'utf8')
  const devices = []
  for (const m of text.matchAll(/<dev\b([^>]*)>([\s\S]*?)<\/dev>/g)) {
    const head = m[1]
    const body = m[2]
    const model = /model="([^"]+)"/.exec(head)?.[1]
    if (!model) continue
    const attrs = [...head.matchAll(/(\w+)=/g)].map((x) => x[1])
    const groups = []
    for (const s of body.matchAll(/<slot\b[^>]*>([\s\S]*?)<\/slot>/g)) {
      for (const i of s[1].matchAll(/<interface\b([^>]*)\/>/g)) {
        groups.push([
          /sztype="([^"]*)"/.exec(i[1])?.[1] ?? '',
          /interfacename="([^"]*)"/.exec(i[1])?.[1] ?? '',
          Number(/count="([^"]*)"/.exec(i[1])?.[1] ?? 0),
        ])
      }
    }
    const num = (k) => {
      const v = new RegExp(`${k}="([\\-\\d.]+)"`).exec(head)?.[1]
      return v === undefined ? null : Number(v)
    }
    devices.push({
      id: /id="([^"]+)"/.exec(head)?.[1],
      name: /name="([^"]+)"/.exec(head)?.[1],
      model,
      attrs,
      groups,
      cx: num('cx'),
      cy: num('cy'),
      editLeft: num('edit_left'),
      editTop: num('edit_top'),
    })
  }

  const byId = new Map(devices.map((d) => [d.id, d]))
  const links = []
  for (const m of text.matchAll(/<line srcDeviceID="([^"]+)" destDeviceID="([^"]+)">([\s\S]*?)<\/line>/g)) {
    const [, sid, did, body] = m
    const pair = /<interfacePair\b([^>]*)\/>/.exec(body)?.[1]
    if (!pair) continue
    // eNSP writes unquoted or quoted numbers depending on version.
    const num = (key) => {
      const v = new RegExp(`${key}="?(\\d+)`).exec(pair)?.[1]
      return v === undefined ? null : Number(v)
    }
    links.push({
      src: byId.get(sid)?.name ?? sid,
      dst: byId.get(did)?.name ?? did,
      srcModel: byId.get(sid)?.model ?? '?',
      dstModel: byId.get(did)?.model ?? '?',
      srcIndex: num('srcIndex'),
      dstIndex: num('tarIndex'),
    })
  }
  return { file, devices, links }
}

function main() {
  const json = process.argv.includes('--json')
  const roots = (process.env.ENSP_EXAMPLES ?? '').split(path.delimiter).filter(Boolean)
  const searchRoots = roots.length ? roots : defaultRoots()

  const files = searchRoots.flatMap((r) => findTopologies(r))
  if (!files.length) {
    console.error('no .topo samples found; set ENSP_EXAMPLES to the examples directory')
    process.exit(1)
  }

  const modelGroups = new Map() // model -> Map(signature -> count)
  const modelAttrs = new Map() // model -> Map(attrs -> count)
  const indexUse = new Map() // model -> Set(index)
  const anchorOffsets = []

  for (const file of files) {
    const { devices, links } = inspect(file)

    for (const d of devices) {
      const sig = d.groups.map((g) => `${g[0]}/${g[1]}x${g[2]}`).join(' + ')
      if (!modelGroups.has(d.model)) modelGroups.set(d.model, new Map())
      const g = modelGroups.get(d.model)
      g.set(sig, (g.get(sig) ?? 0) + 1)

      const attrKey = d.attrs.join(' ')
      if (!modelAttrs.has(d.model)) modelAttrs.set(d.model, new Map())
      const a = modelAttrs.get(d.model)
      a.set(attrKey, (a.get(attrKey) ?? 0) + 1)

      // Derive the edit offsets per device (the fields are derived from cx/cy).
      if (d.cx !== null && d.editLeft !== null) {
        anchorOffsets.push([d.editLeft - d.cx, d.editTop - d.cy])
      }
    }

    for (const l of links) {
      for (const [model, idx] of [
        [l.srcModel, l.srcIndex],
        [l.dstModel, l.dstIndex],
      ]) {
        if (idx === null) continue
        if (!indexUse.has(model)) indexUse.set(model, new Set())
        indexUse.get(model).add(idx)
      }
    }
  }

  if (json) {
    const out = {
      samples: files.length,
      models: {},
      editOffsets: anchorOffsets.length
        ? [...new Set(anchorOffsets.map(([a, b]) => `${a}/${b}`))]
        : [],
    }
    for (const [model, sigs] of [...modelGroups].sort()) {
      out.models[model] = {
        signatures: [...sigs].sort((a, b) => b[1] - a[1]).map(([sig, n]) => ({ sig, n })),
        attrOrders: [...(modelAttrs.get(model) ?? new Map())].sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ order: k, n })),
        indexRange: indexUse.has(model)
          ? { min: Math.min(...indexUse.get(model)), max: Math.max(...indexUse.get(model)) }
          : null,
      }
    }
    console.log(JSON.stringify(out, null, 2))
    return
  }

  console.log(`samples scanned: ${files.length}\n`)
  console.log('=== interface declarations (most common first) ===')
  for (const [model, sigs] of [...modelGroups].sort()) {
    console.log(`\n${model}`)
    for (const [sig, n] of [...sigs].sort((a, b) => b[1] - a[1]).slice(0, 3)) {
      console.log(`  x${n}  ${sig}`)
    }
  }

  console.log('\n=== attribute order ===')
  for (const [model, attrs] of [...modelAttrs].sort()) {
    const [order, n] = [...attrs].sort((a, b) => b[1] - a[1])[0]
    console.log(`  ${model.padEnd(10)} x${String(n).padEnd(3)} ${order}`)
  }

  console.log('\n=== cable index ranges ===')
  for (const [model, set] of [...indexUse].sort()) {
    console.log(`  ${model.padEnd(10)} ${Math.min(...set)}..${Math.max(...set)}`)
  }

  const offsets = [...new Set(anchorOffsets.map(([a, b]) => `${a}/${b}`))]
  console.log(`\nedit offsets (edit_left-cx / edit_top-cy): ${offsets.join(', ') || 'n/a'}`)
}

main()
