/**
 * Writes .docx files without any runtime dependency.
 *
 * A .docx is a zip holding OOXML parts. This module builds the parts a plain
 * report needs (content types, package relationships, document, styles,
 * numbering) and zips them itself, so the package installs nothing and works
 * offline.
 *
 * Blocks are plain objects; see {@link renderBlocks} for the shapes. Text may
 * carry two inline markers, `**bold**` and `` `code` ``, which become runs.
 *
 * @module core/docx
 */

import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

/** CRC32, needed by both the local and the central zip records. */
function crc32(buffer) {
  let c = -1
  for (let i = 0; i < buffer.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buffer[i]) & 0xff]
  return (c ^ -1) >>> 0
}

/**
 * Build a zip from `{name, data}` entries. Every entry is deflated when that
 * actually saves space and stored otherwise, which keeps tiny parts readable in
 * a hex dump while still compressing the document body.
 */
export function zip(entries) {
  const chunks = []
  const central = []
  let offset = 0

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const deflated = deflateRawSync(data, { level: 9 })
    const compressed = deflated.length < data.length
    const body = compressed ? deflated : data
    const method = compressed ? 8 : 0
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x0021, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)

    chunks.push(local, name, body)
    central.push({ name, crc, body: body.length, size: data.length, method, offset })
    offset += local.length + name.length + body.length
  }

  const centralStart = offset
  for (const entry of central) {
    const head = Buffer.alloc(46)
    head.writeUInt32LE(0x02014b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(20, 6)
    head.writeUInt16LE(0, 8)
    head.writeUInt16LE(entry.method, 10)
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

/** XML-escape text and drop control characters, which OOXML rejects. */
export function escapeXml(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const RUN_FONTS = '<w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:eastAsia="\u5b8b\u4f53"/>'
const CODE_FONTS = '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:eastAsia="Consolas"/>'

/** Turn `**bold**` and backtick spans into runs. */
export function inlineRuns(text, { size = 24, bold = false, color = null } = {}) {
  const parts = String(text ?? '').split(/(\*\*[^*]+\*\*|`[^`]+`)/)
  const runs = []
  for (const part of parts) {
    if (!part) continue
    let body = part
    let isBold = bold
    let isCode = false
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      body = part.slice(2, -2)
      isBold = true
    } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      body = part.slice(1, -1)
      isCode = true
    }
    const props = [
      isCode ? CODE_FONTS : RUN_FONTS,
      `<w:sz w:val="${isCode ? Math.max(16, size - 2) : size}"/>`,
      `<w:szCs w:val="${isCode ? Math.max(16, size - 2) : size}"/>`,
      isBold ? '<w:b/>' : '',
      color ? `<w:color w:val="${color}"/>` : '',
    ].join('')
    runs.push(`<w:r><w:rPr>${props}</w:rPr><w:t xml:space="preserve">${escapeXml(body)}</w:t></w:r>`)
  }
  if (!runs.length) runs.push(`<w:r><w:rPr>${RUN_FONTS}</w:rPr><w:t></w:t></w:r>`)
  return runs.join('')
}

function paragraph(text, { style = null, align = null, size = 24, bold = false, spaceAfter = 80, indent = null } = {}) {
  const props = [
    style ? `<w:pStyle w:val="${style}"/>` : '',
    align ? `<w:jc w:val="${align}"/>` : '',
    indent ? `<w:ind w:firstLine="${indent}"/>` : '',
    `<w:spacing w:after="${spaceAfter}" w:line="320" w:lineRule="auto"/>`,
  ].join('')
  return `<w:p><w:pPr>${props}</w:pPr>${inlineRuns(text, { size, bold })}</w:p>`
}

function numberedParagraph(text, numId) {
  return (
    '<w:p><w:pPr>' +
    `<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${numId}"/></w:numPr>` +
    '<w:spacing w:after="60" w:line="320" w:lineRule="auto"/>' +
    `</w:pPr>${inlineRuns(text, { size: 24 })}</w:p>`
  )
}

function codeBlock(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, '').split('\n')
  const runs = []
  lines.forEach((line, index) => {
    if (index) runs.push('<w:r><w:br/></w:r>')
    runs.push(
      `<w:r><w:rPr>${CODE_FONTS}<w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>` +
        `<w:t xml:space="preserve">${escapeXml(line) || ' '}</w:t></w:r>`,
    )
  })
  return (
    '<w:p><w:pPr><w:pStyle w:val="Code"/>' +
    '<w:shd w:val="clear" w:color="auto" w:fill="F4F4F4"/>' +
    '<w:spacing w:after="120" w:line="240" w:lineRule="auto"/></w:pPr>' +
    `${runs.join('')}</w:p>`
  )
}

function tableBlock({ header = [], rows = [], widths = [] }) {
  const columns = Math.max(header.length, ...rows.map((r) => r.length), 1)
  const total = 9000
  const cells = widths.length === columns ? widths : new Array(columns).fill(Math.floor(total / columns))
  const grid = cells.map((w) => `<w:gridCol w:w="${w}"/>`).join('')
  const border =
    '<w:tblBorders>' +
    '<w:top w:val="single" w:sz="4" w:space="0" w:color="808080"/>' +
    '<w:left w:val="single" w:sz="4" w:space="0" w:color="808080"/>' +
    '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="808080"/>' +
    '<w:right w:val="single" w:sz="4" w:space="0" w:color="808080"/>' +
    '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="808080"/>' +
    '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="808080"/>' +
    '</w:tblBorders>'
  const tblPr =
    '<w:tblPr><w:tblW w:w="5000" w:type="pct"/>' + border +
    '<w:tblLayout w:type="fixed"/></w:tblPr>'

  const buildRow = (values, isHeader) => {
    const tcs = []
    for (let i = 0; i < columns; i += 1) {
      const value = values[i] ?? ''
      const shading = isHeader ? '<w:shd w:val="clear" w:color="auto" w:fill="EDEDED"/>' : ''
      tcs.push(
        '<w:tc><w:tcPr>' +
          `<w:tcW w:w="${cells[i]}" w:type="dxa"/>` +
          `${shading}<w:vAlign w:val="center"/></w:tcPr>` +
          `<w:p><w:pPr><w:spacing w:after="20" w:line="260" w:lineRule="auto"/>` +
          `${isHeader ? '<w:jc w:val="center"/>' : ''}</w:pPr>` +
          `${inlineRuns(value, { size: 21, bold: isHeader })}</w:p></w:tc>`,
      )
    }
    return `<w:tr>${isHeader ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${tcs.join('')}</w:tr>`
  }

  const headerRow = header.length ? buildRow(header, true) : ''
  const bodyRows = rows.map((row) => buildRow(row, false)).join('')
  return `<w:tbl>${tblPr}<w:tblGrid>${grid}</w:tblGrid>${headerRow}${bodyRows}</w:tbl>` +
    '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>'
}

/** Render one block. Unknown types are ignored rather than crashing the build. */
function renderBlock(block) {
  switch (block.type) {
    case 'title':
      return paragraph(block.text, { style: 'Title', align: 'center', size: 44, bold: true, spaceAfter: 160 })
    case 'subtitle':
      return paragraph(block.text, { style: 'Subtitle', align: 'center', size: 28, spaceAfter: 240 })
    case 'heading':
      return paragraph(block.text, { style: `Heading${Math.min(4, Math.max(1, block.level ?? 1))}`, spaceAfter: 120 })
    case 'para':
      return paragraph(block.text, { indent: block.indent === false ? null : 480 })
    case 'bullets':
      return (block.items || []).map((item) => numberedParagraph(item, 1)).join('')
    case 'steps':
      return (block.items || []).map((item) => numberedParagraph(item, 2)).join('')
    case 'code':
      return codeBlock(block.text)
    case 'table':
      return tableBlock(block)
    case 'caption':
      return paragraph(block.text, { style: 'Caption', align: 'center', size: 20, spaceAfter: 60 })
    case 'note':
      return paragraph(block.text, { style: 'Note', indent: false })
    case 'pageBreak':
      return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>'
    default:
      return ''
  }
}

/** Render a list of blocks into the body of `word/document.xml`. */
export function renderBlocks(blocks) {
  return (blocks || []).map(renderBlock).join('')
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0">
<w:multiLevelType w:val="singleLevel"/>
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="\u2022"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="840" w:hanging="360"/></w:pPr><w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New"/></w:rPr></w:lvl>
</w:abstractNum>
<w:abstractNum w:abstractNumId="1">
<w:multiLevelType w:val="singleLevel"/>
<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="840" w:hanging="420"/></w:pPr></w:lvl>
</w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`

function headingStyle(id, name, size, outline, before, after) {
  return (
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>` +
    '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
    `<w:pPr><w:keepNext/><w:outlineLvl w:val="${outline}"/>` +
    `<w:spacing w:before="${before}" w:after="${after}"/></w:pPr>` +
    `<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="\u9ed1\u4f53"/><w:b/>` +
    `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`
  )
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>${RUN_FONTS}<w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault>
<w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="320" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:jc w:val="center"/><w:spacing w:before="240" w:after="160"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="\u9ed1\u4f53"/><w:b/><w:sz w:val="44"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:qFormat/>
<w:pPr><w:jc w:val="center"/><w:spacing w:after="240"/></w:pPr>
<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:eastAsia="\u9ed1\u4f53"/><w:sz w:val="28"/><w:color w:val="595959"/></w:rPr></w:style>
${headingStyle('Heading1', 'heading 1', 32, 0, 320, 160)}
${headingStyle('Heading2', 'heading 2', 28, 1, 240, 120)}
${headingStyle('Heading3', 'heading 3', 24, 2, 200, 100)}
${headingStyle('Heading4', 'heading 4', 24, 3, 160, 80)}
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/>
<w:pPr><w:ind w:left="240" w:right="120"/><w:spacing w:after="120" w:line="240" w:lineRule="auto"/></w:pPr>
<w:rPr>${CODE_FONTS}<w:sz w:val="18"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/><w:basedOn w:val="Normal"/>
<w:pPr><w:jc w:val="center"/><w:keepNext/><w:spacing w:before="120" w:after="60"/></w:pPr>
<w:rPr><w:sz w:val="20"/><w:color w:val="404040"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Note"><w:name w:val="Note"/><w:basedOn w:val="Normal"/>
<w:pPr><w:shd w:val="clear" w:color="auto" w:fill="FBF6E9"/><w:ind w:left="240" w:right="240"/><w:spacing w:before="80" w:after="120"/></w:pPr>
<w:rPr><w:sz w:val="21"/><w:color w:val="7F5F00"/></w:rPr></w:style>
</w:styles>`

const SECTION =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
  '<w:pgMar w:top="1440" w:right="1418" w:bottom="1440" w:left="1418" w:header="851" w:footer="992" w:gutter="0"/>' +
  '<w:docGrid w:linePitch="312"/></w:sectPr>'

/** Wrap rendered blocks into a complete `word/document.xml`. */
export function documentXml(blocks) {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${renderBlocks(blocks)}${SECTION}</w:body></w:document>`
  )
}

/** Build the whole .docx as a Buffer. */
export function buildDocx(blocks) {
  return zip([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: ROOT_RELS },
    { name: 'word/document.xml', data: documentXml(blocks) },
    { name: 'word/_rels/document.xml.rels', data: DOCUMENT_RELS },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/numbering.xml', data: NUMBERING },
  ])
}
