/**
 * Tests for the OOXML text extractor.
 *
 * The fixtures are built here rather than checked in as binaries: a small zip
 * writer produces a real archive, so the tests exercise the same inflate and
 * central directory paths that a Word file uses, and they run offline.
 *
 * Run with `node --test tests/ooxml.test.mjs`.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { deflateRawSync } from 'node:zlib'

import {
  decodeEntities,
  docxText,
  isZip,
  ooxmlText,
  pptxText,
  readZip,
  xmlText,
  xlsxText,
} from '../src/core/ooxml.mjs'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buffer) {
  let c = -1
  for (let i = 0; i < buffer.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buffer[i]) & 0xff]
  return (c ^ -1) >>> 0
}

/**
 * Build a zip from `{name, data}` entries. Bodies are always deflated, which is
 * what Word, PowerPoint and Excel do, so the deflate branch is the one covered.
 */
function buildZip(entries, { method = 8 } = {}) {
  const chunks = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const body = method === 8 ? deflateRawSync(data, { level: 9 }) : data
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x0021, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    chunks.push(local, name, body)
    central.push({ name, crc, body: body.length, size: data.length, offset })
    offset += local.length + name.length + body.length
  }

  const centralStart = offset
  for (const entry of central) {
    const head = Buffer.alloc(46)
    head.writeUInt32LE(0x02014b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(20, 6)
    head.writeUInt16LE(0x0800, 8)
    head.writeUInt16LE(method, 10)
    head.writeUInt16LE(0, 12)
    head.writeUInt16LE(0x0021, 14)
    head.writeUInt32LE(entry.crc, 16)
    head.writeUInt32LE(entry.body, 20)
    head.writeUInt32LE(entry.size, 24)
    head.writeUInt16LE(entry.name.length, 28)
    head.writeUInt16LE(0, 30)
    head.writeUInt16LE(0, 32)
    head.writeUInt16LE(0, 34)
    head.writeUInt16LE(0, 36)
    head.writeUInt32LE(0, 38)
    head.writeUInt32LE(entry.offset, 42)
    chunks.push(head, entry.name)
    offset += head.length + entry.name.length
  }

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(central.length, 8)
  end.writeUInt16LE(central.length, 10)
  end.writeUInt32LE(offset - centralStart, 12)
  end.writeUInt32LE(centralStart, 16)
  end.writeUInt16LE(0, 20)
  chunks.push(end)

  return Buffer.concat(chunks)
}

const W_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
const A_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'

function paragraph(text) {
  return `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t>${text}</w:t></w:r></w:p>`
}

function docx(paras, extraParts = []) {
  return buildZip([
    {
      name: '[Content_Types].xml',
      data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    },
    { name: '_rels/.rels', data: '<?xml version="1.0"?><Relationships/>' },
    {
      name: 'word/document.xml',
      data: `<?xml version="1.0" encoding="UTF-8"?><w:document ${W_NS}><w:body>${paras.join('')}</w:body></w:document>`,
    },
    ...extraParts,
  ])
}

function pptx(slides) {
  return buildZip([
    { name: '[Content_Types].xml', data: '<Types/>' },
    ...slides.map(([number, text]) => ({
      name: `ppt/slides/slide${number}.xml`,
      data:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ${A_NS}>` +
        `<p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p>` +
        '</p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    })),
  ])
}

function xlsx(rows, shared = []) {
  const entries = [
    { name: '[Content_Types].xml', data: '<Types/>' },
    {
      name: 'xl/worksheets/sheet1.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        rows.join('') +
        '</sheetData></worksheet>',
    },
  ]
  if (shared.length) {
    entries.push({
      name: 'xl/sharedStrings.xml',
      data:
        '<?xml version="1.0" encoding="UTF-8"?>' +
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        shared.map((text) => `<si><t>${text}</t></si>`).join('') +
        '</sst>',
    })
  }
  return buildZip(entries)
}

test('isZip: detects the local file header only', () => {
  assert.equal(isZip(buildZip([{ name: 'a.txt', data: 'hello' }])), true)
  assert.equal(isZip(Buffer.from('%PDF-1.7\n')), false)
  assert.equal(isZip(Buffer.alloc(0)), false)
  assert.equal(isZip(null), false)
  assert.equal(isZip(Buffer.from([0x50, 0x4b])), false)
})

test('readZip: round trips two entries byte for byte', () => {
  const zip = buildZip([
    { name: 'word/document.xml', data: '<w:document>实验手册</w:document>' },
    { name: 'word/styles.xml', data: 'x'.repeat(4096) },
  ])
  const files = readZip(zip)

  assert.equal(files.size, 2)
  assert.equal(files.get('word/document.xml').toString('utf8'), '<w:document>实验手册</w:document>')
  assert.equal(files.get('word/styles.xml').toString('utf8'), 'x'.repeat(4096))
})

test('readZip: stored entries are copied, directories are skipped', () => {
  const zip = buildZip(
    [
      { name: 'word/', data: '' },
      { name: 'word/document.xml', data: '<w:document/>' },
    ],
    { method: 0 },
  )
  const files = readZip(zip)

  assert.equal(files.has('word/'), false)
  assert.equal(files.get('word/document.xml').toString('utf8'), '<w:document/>')
})

test('readZip: refuses input that is not a zip', () => {
  assert.throws(() => readZip(Buffer.from('%PDF-1.7\n')), /not a zip archive/)
  assert.throws(() => readZip(Buffer.alloc(0)), /not a zip archive/)
  assert.throws(() => readZip(Buffer.alloc(2048, 0x41)), /not a zip archive/)
})

test('docxText: two Chinese paragraphs land on separate lines', () => {
  const text = docxText(docx([paragraph('实验介绍'), paragraph('任务步骤')]))
  const lines = text.split('\n')

  assert.ok(text.includes('实验介绍'), `missing first paragraph: ${JSON.stringify(text)}`)
  assert.ok(text.includes('任务步骤'), `missing second paragraph: ${JSON.stringify(text)}`)
  assert.ok(lines.includes('实验介绍'))
  assert.ok(lines.includes('任务步骤'))
  assert.ok(text.indexOf('实验介绍') < text.indexOf('任务步骤'))
})

test('docxText: headers and footers stay out of the body', () => {
  const zip = docx([paragraph('正文内容')], [
    { name: 'word/header1.xml', data: `<w:hdr ${W_NS}><w:p><w:r><w:t>页眉噪声</w:t></w:r></w:p></w:hdr>` },
    { name: 'word/footer1.xml', data: `<w:ftr ${W_NS}><w:p><w:r><w:t>页脚噪声</w:t></w:r></w:p></w:ftr>` },
  ])
  const text = docxText(zip)

  assert.equal(text, '正文内容')
})

test('xmlText: decodes entities and turns paragraph ends into newlines', () => {
  assert.equal(xmlText('<w:p><w:r><w:t>a &lt; b &amp;&amp; c &gt; d</w:t></w:r></w:p>'), 'a < b && c > d')

  const two = xmlText('<w:p><w:r><w:t>第一段</w:t></w:r></w:p><w:p><w:r><w:t>第二段</w:t></w:r></w:p>')
  assert.deepEqual(two.split('\n').filter(Boolean), ['第一段', '第二段'])

  assert.equal(xmlText('<w:p><w:r><w:t>甲</w:t></w:r><w:r><w:t>乙</w:t></w:r></w:p>'), '甲乙')
  assert.equal(xmlText('<w:p><w:r><w:t>前</w:t></w:r><w:r><w:br/></w:r><w:r><w:t>后</w:t></w:r></w:p>'), '前\n后')
  assert.equal(
    xmlText('<w:p><w:r><w:t>A</w:t><w:tab/><w:t>B</w:t></w:r></w:p>'),
    'A\tB',
  )
})

test('xmlText: markup keywords and geometry are not text', () => {
  // Real files carry drawing anchors whose children hold a word ("left") and an
  // offset ("-1196975"); a tag stripper that keeps all character data emits them
  // as if they were prose.
  const xml =
    '<w:p><w:r><w:t>标题</w:t></w:r></w:p>' +
    '<w:p><w:r><w:drawing><wp:anchor><wp:positionH relativeFrom="page"><wp:align>left</wp:align>' +
    '</wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>-1196975</wp:posOffset>' +
    '</wp:positionV></wp:anchor></w:drawing></w:r></w:p>' +
    '<w:p><w:r><w:t>正文</w:t></w:r></w:p>'
  const text = xmlText(xml)

  assert.ok(!text.includes('left'), `alignment keyword leaked: ${JSON.stringify(text)}`)
  assert.ok(!text.includes('1196975'), `offset leaked: ${JSON.stringify(text)}`)
  assert.deepEqual(text.split('\n').filter(Boolean), ['标题', '正文'])
})

test('xmlText: numeric entities, collapsed blank lines and trimmed tails', () => {
  assert.equal(decodeEntities('&#20320;&#x597d;'), '你好')
  assert.equal(decodeEntities('&#x4E2D;&#25991; &quot;q&quot; &apos;s&apos;'), '中文 "q" \'s\'')
  assert.equal(xmlText('<w:p><w:r><w:t> x </w:t></w:r></w:p><w:p/><w:p/><w:p><w:r><w:t>y</w:t></w:r></w:p>'), 'x\n\ny')
  assert.equal(xmlText(''), '')
  assert.equal(xmlText(undefined), '')
})

test('xmlText: field instructions and tracked deletions are dropped', () => {
  // Real files carry a TOC built from field codes; the instruction text is not
  // visible prose and must not leak between paragraphs.
  const xml =
    '<w:p><w:r><w:t>目录</w:t></w:r></w:p>' +
    '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
    '<w:r><w:instrText xml:space="preserve"> PAGEREF _Toc123 \\h </w:instrText></w:r>' +
    '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>' +
    '<w:p><w:r><w:delText>已删除</w:delText></w:r><w:r><w:t>正文</w:t></w:r></w:p>'
  const text = xmlText(xml)

  assert.ok(!text.includes('PAGEREF'), `field code leaked: ${JSON.stringify(text)}`)
  assert.ok(!text.includes('已删除'), `deleted text leaked: ${JSON.stringify(text)}`)
  assert.deepEqual(text.split('\n').filter(Boolean), ['目录', '正文'])
})

test('pptxText: slides are ordered by number, not by name', () => {
  const text = pptxText(pptx([[10, '第十张幻灯片'], [1, '第一张幻灯片'], [2, '第二张幻灯片']]))
  const lines = text.split('\n').filter(Boolean)

  assert.deepEqual(lines, ['第一张幻灯片', '第二张幻灯片', '第十张幻灯片'])
  assert.ok(text.indexOf('第一张幻灯片') < text.indexOf('第十张幻灯片'))
})

test('xlsxText: shared strings resolve to a cell row', () => {
  const text = xlsxText(
    xlsx(
      [
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>',
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42</v></c></row>',
      ],
      ['设备名称', '接口', 'R1'],
    ),
  )

  assert.equal(text, '设备名称 | 接口\nR1 | 42')
})

test('xlsxText: skips empty rows and survives a missing shared string table', () => {
  const text = xlsxText(
    xlsx([
      '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><v>2</v></c></row>',
      '<row r="2"><c r="A2"/><c r="B2"/></row>',
      '<row r="3"><c r="A3" t="inlineStr"><is><t>行内</t></is></c></row>',
    ]),
  )

  assert.equal(text, '1 | 2\n行内')
})

test('xlsxText: worksheets are ordered by number', () => {
  const zip = buildZip([
    {
      name: 'xl/worksheets/sheet10.xml',
      data: '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>后表</t></is></c></row></sheetData></worksheet>',
    },
    {
      name: 'xl/worksheets/sheet2.xml',
      data: '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>前表</t></is></c></row></sheetData></worksheet>',
    },
  ])

  assert.equal(xlsxText(zip), '前表\n后表')
})

test('ooxmlText: dispatches by extension and rejects the rest', () => {
  const word = docx([paragraph('分派测试')])

  assert.equal(ooxmlText('report.docx', word), '分派测试')
  assert.equal(ooxmlText('REPORT.DOCX', word), '分派测试')
  assert.equal(ooxmlText('deck.pptx', pptx([[1, '幻灯片']])), '幻灯片')
  assert.equal(ooxmlText('book.xlsx', xlsx(['<row r="1"><c r="A1"><v>7</v></c></row>'])), '7')

  const pdf = Buffer.from('%PDF-1.7\n')
  assert.equal(ooxmlText('x.txt', pdf), null)
  assert.equal(ooxmlText('manual.pdf', pdf), null)
  assert.equal(ooxmlText('noext', pdf), null)
  assert.equal(ooxmlText('', pdf), null)
})

test('garbage input never escapes as an exception', () => {
  const truncated = docx([paragraph('完整内容')]).subarray(0, 40)
  const random = Buffer.from(Array.from({ length: 512 }, (_, i) => (i * 37) % 256))
  const inputs = [Buffer.alloc(0), Buffer.from('PK'), pdfBytes(), truncated, random, null, undefined]

  for (const input of inputs) {
    assert.equal(typeof docxText(input), 'string')
    assert.equal(typeof pptxText(input), 'string')
    assert.equal(typeof xlsxText(input), 'string')
    assert.doesNotThrow(() => docxText(input))
    assert.doesNotThrow(() => pptxText(input))
    assert.doesNotThrow(() => xlsxText(input))
  }

  // A body that is not XML at all must not throw either.
  const brokenXml = buildZip([{ name: 'word/document.xml', data: '\u0000\u0001 not xml <<<' }])
  assert.doesNotThrow(() => docxText(brokenXml))
})

function pdfBytes() {
  return Buffer.from('%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n')
}
