/**
 * Extracts plain text from OOXML packages (.docx, .pptx, .xlsx).
 *
 * A modern Office file is a zip whose parts are XML. This module reads the zip
 * itself (stored and deflate entries are enough for the formats it targets) and
 * scans the XML with a small tokenizer that keeps only real text nodes, so
 * nothing has to be installed and no external converter is spawned. It is read
 * only: the counterpart writer lives in `core/docx.mjs`.
 *
 * Extraction is best effort. A part that does not parse is skipped and a
 * package that is not a zip at all yields an empty string, because these
 * functions are usually called on user supplied reference material.
 *
 * @module core/ooxml
 */

import { inflateRawSync } from 'node:zlib'

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

/** Size of the fixed parts of each record, without name, extra and comment. */
const EOCD_SIZE = 22
const CENTRAL_SIZE = 46
const LOCAL_SIZE = 30

/** The comment length field is 16 bit, so the record can sit at most this far back. */
const MAX_COMMENT = 0xffff

/**
 * True when the buffer starts with the local file header signature.
 *
 * @param {Buffer|Uint8Array|null|undefined} buffer
 * @returns {boolean}
 */
export function isZip(buffer) {
  if (!buffer || typeof buffer.length !== 'number' || buffer.length < 4) return false
  return buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04
}

/** Return a Buffer view over any binary input, or null when there is nothing. */
function asBuffer(buffer) {
  if (Buffer.isBuffer(buffer)) return buffer
  if (buffer instanceof Uint8Array) return Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  return null
}

/**
 * Locate the End of Central Directory record. The archive comment may follow it,
 * so the search walks backwards from the end instead of assuming a fixed tail.
 */
function findEocd(buffer) {
  const lowest = Math.max(0, buffer.length - EOCD_SIZE - MAX_COMMENT)
  for (let offset = buffer.length - EOCD_SIZE; offset >= lowest; offset -= 1) {
    if (buffer.readUInt32LE(offset) === SIG_EOCD) return offset
  }
  return -1
}

/**
 * Read a zip archive into a map of internal path to raw contents.
 *
 * Directory entries are dropped, and entries using a compression method this
 * module does not know are skipped rather than failing the whole archive. The
 * optional data descriptor is ignored: central directory sizes are authoritative.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {Map<string, Buffer>} keys look like `word/document.xml`
 * @throws {Error} when the buffer is not a readable zip archive
 */
export function readZip(buffer) {
  const data = asBuffer(buffer)
  if (!data || data.length < EOCD_SIZE) throw new Error('not a zip archive')

  const eocd = findEocd(data)
  if (eocd < 0) throw new Error('not a zip archive: end of central directory is missing')

  const count = data.readUInt16LE(eocd + 10)
  const directoryOffset = data.readUInt32LE(eocd + 16)
  if (directoryOffset >= data.length) throw new Error('not a zip archive: central directory is out of range')

  const files = new Map()
  let cursor = directoryOffset

  for (let index = 0; index < count; index += 1) {
    if (cursor + CENTRAL_SIZE > data.length) throw new Error('not a zip archive: truncated central directory')
    if (data.readUInt32LE(cursor) !== SIG_CENTRAL) throw new Error('not a zip archive: bad central directory entry')

    const method = data.readUInt16LE(cursor + 10)
    const compressedSize = data.readUInt32LE(cursor + 20)
    const nameLength = data.readUInt16LE(cursor + 28)
    const extraLength = data.readUInt16LE(cursor + 30)
    const commentLength = data.readUInt16LE(cursor + 32)
    const localOffset = data.readUInt32LE(cursor + 42)
    const nameEnd = cursor + CENTRAL_SIZE + nameLength
    if (nameEnd > data.length) throw new Error('not a zip archive: truncated file name')

    const name = data.toString('utf8', cursor + CENTRAL_SIZE, nameEnd)
    cursor = nameEnd + extraLength + commentLength

    if (name.endsWith('/')) continue
    if (localOffset + LOCAL_SIZE > data.length) continue
    if (data.readUInt32LE(localOffset) !== SIG_LOCAL) continue

    // The local header repeats its own name and extra lengths, and those are the
    // ones that place the payload. They can differ from the central copy.
    const localNameLength = data.readUInt16LE(localOffset + 26)
    const localExtraLength = data.readUInt16LE(localOffset + 28)
    const start = localOffset + LOCAL_SIZE + localNameLength + localExtraLength
    const end = start + compressedSize
    if (start > data.length || end > data.length) continue

    const payload = data.subarray(start, end)
    if (method === 0) {
      files.set(name, Buffer.from(payload))
    } else if (method === 8) {
      try {
        files.set(name, inflateRawSync(payload))
      } catch {
        // A part that cannot be inflated is dropped; the rest of the package is
        // still worth reading.
      }
    }
  }

  return files
}

/** Decode the five XML entities plus decimal and hexadecimal character references. */
export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (match, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return ''
      // Lone surrogates are not valid code points and would throw.
      if (code >= 0xd800 && code <= 0xdfff) return ''
      return String.fromCodePoint(code)
    }
    switch (body) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      default:
        return match
    }
  })
}

/** One comment, one CDATA section, one tag, or one run of character data. */
const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<[^>]*>|([^<]+)/g

/**
 * Elements whose character data is never shown. Field instructions carry the
 * table of contents plumbing (` PAGEREF ...`) and deleted text is tracked
 * revision history, so both would otherwise land in the middle of the prose.
 */
const HIDDEN_ELEMENTS = new Set(['instrtext', 'deltext'])

/** A paragraph is a `p` element, or the ODF style `text:para` name. */
function isParagraph(element) {
  return element.local === 'p' || element.local === 'para'
}

/** An element is a text container when it is a `...:t` run or an ODF `text:` node. */
function holdsText(element) {
  if (!element || element.hidden) return false
  return element.local === 't' || element.prefix === 'text'
}

/**
 * Turn an XML part into plain text.
 *
 * Only character data inside a text element survives: `w:t`, `a:t`, `m:t` and the
 * ODF `text:` nodes. Everything else, including the numbers in positioning
 * elements and the keywords in alignment elements, is markup and is dropped.
 * Paragraph ends and breaks become newlines, tabs become tab characters, entities
 * are decoded, trailing spaces are dropped and runs of empty lines collapse to a
 * single blank line.
 *
 * @param {string} xml
 * @returns {string}
 */
export function xmlText(xml) {
  const source = String(xml ?? '')
  if (!source) return ''

  const parts = []
  const stack = []
  let hidden = 0

  for (const token of source.matchAll(TOKEN)) {
    const cdata = token[1]
    const data = token[2]

    // Character data: keep it only where a reader would see it.
    if (data !== undefined || cdata !== undefined) {
      if (hidden || !holdsText(stack[stack.length - 1])) continue
      parts.push(data !== undefined ? data : cdata)
      continue
    }

    const raw = token[0]
    if (raw.startsWith('<!--') || raw.startsWith('<!') || raw.startsWith('<?')) continue
    if (!raw.startsWith('<')) continue

    const nameMatch = /^<\/?\s*([^\s/>]+)/.exec(raw)
    if (!nameMatch) continue

    const name = nameMatch[1].toLowerCase()
    const colon = name.indexOf(':')
    const local = colon === -1 ? name : name.slice(colon + 1)
    const prefix = colon === -1 ? '' : name.slice(0, colon)
    const closing = raw.startsWith('</')
    const selfClosing = raw.endsWith('/>')

    if (closing) {
      const element = stack.pop()
      if (!element) continue
      if (element.hidden) hidden -= 1
      if (!hidden && isParagraph(element)) parts.push('\n')
      continue
    }

    if (selfClosing) {
      if (hidden) continue
      if (local === 'br' || local === 'cr' || local === 'line-break') parts.push('\n')
      else if (local === 'tab') parts.push('\t')
      else if (local === 'p' || local === 'para') parts.push('\n')
      continue
    }

    const element = { local, prefix, hidden: HIDDEN_ELEMENTS.has(local) }
    stack.push(element)
    if (element.hidden) hidden += 1
  }

  return decodeEntities(parts.join(''))
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0]+(?=\n)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Read one part as text, returning an empty string when it is missing or unreadable. */
function partText(files, name) {
  const entry = files.get(name)
  if (!entry) return ''
  try {
    return xmlText(entry.toString('utf8'))
  } catch {
    return ''
  }
}

/**
 * Extract the body text of a .docx.
 *
 * Only `word/document.xml` is read. Headers, footers, footnotes and comments are
 * deliberately left out: they repeat on every page and add noise to a document
 * that is being mined for its content.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {string}
 */
export function docxText(buffer) {
  let files
  try {
    files = readZip(buffer)
  } catch {
    return ''
  }
  return partText(files, 'word/document.xml')
}

/** Match a slide part and capture its number, so ordering is numeric. */
const SLIDE_PART = /^ppt\/slides\/slide(\d+)\.xml$/i

/**
 * Extract the text of a .pptx, one slide after another in slide order.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {string}
 */
export function pptxText(buffer) {
  let files
  try {
    files = readZip(buffer)
  } catch {
    return ''
  }

  const slides = []
  for (const name of files.keys()) {
    const match = SLIDE_PART.exec(name)
    if (match) slides.push({ name, number: Number(match[1]) })
  }
  slides.sort((left, right) => left.number - right.number)

  return slides
    .map((slide) => partText(files, slide.name))
    .filter(Boolean)
    .join('\n')
}

/** Match a worksheet part and capture its number. */
const SHEET_PART = /^xl\/worksheets\/sheet(\d+)\.xml$/i
const STRING_ITEM = /<si\b[^>]*>([\s\S]*?)<\/si>/gi
const CELL = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gi
const CELL_VALUE = /<v\b[^>]*>([\s\S]*?)<\/v>/i
const CELL_INLINE = /<is\b[^>]*>([\s\S]*?)<\/is>/i
const CELL_TYPE = /\bt\s*=\s*"([^"]*)"/i
const ROW = /<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/gi

/** Build the shared string table, which every `t="s"` cell indexes into. */
function sharedStrings(files) {
  const entry = files.get('xl/sharedStrings.xml')
  if (!entry) return []
  const xml = entry.toString('utf8')
  const values = []
  for (const match of xml.matchAll(STRING_ITEM)) {
    let text = ''
    try {
      text = xmlText(match[1]).replace(/\s*\n\s*/g, ' ')
    } catch {
      text = ''
    }
    values.push(text)
  }
  return values
}

/** Turn one `<c>` element into its display text, resolving shared strings. */
function cellText(attributes, body, strings) {
  const type = CELL_TYPE.exec(attributes || '')
  const kind = type ? type[1].toLowerCase() : ''
  const inner = body || ''

  if (kind === 's') {
    const value = CELL_VALUE.exec(inner)
    const index = value ? Number.parseInt(decodeEntities(value[1]).trim(), 10) : NaN
    return Number.isInteger(index) && index >= 0 && index < strings.length ? strings[index] : ''
  }

  const inline = CELL_INLINE.exec(inner)
  if (inline) return xmlText(inline[1]).replace(/\s*\n\s*/g, ' ')

  const value = CELL_VALUE.exec(inner)
  if (!value) return ''
  return decodeEntities(value[1]).replace(/\s+/g, ' ').trim()
}

/**
 * Extract the text of a .xlsx, one worksheet after another.
 *
 * Each row becomes one line with cells joined by ` | `. Empty rows are skipped.
 * Shared strings are resolved through their index; every other cell contributes
 * the raw `<v>` value, which is what a spreadsheet shows for numbers and dates.
 *
 * @param {Buffer|Uint8Array} buffer
 * @returns {string}
 */
export function xlsxText(buffer) {
  let files
  try {
    files = readZip(buffer)
  } catch {
    return ''
  }

  const strings = sharedStrings(files)
  const sheets = []
  for (const name of files.keys()) {
    const match = SHEET_PART.exec(name)
    if (match) sheets.push({ name, number: Number(match[1]) })
  }
  sheets.sort((left, right) => left.number - right.number)

  const lines = []
  for (const sheet of sheets) {
    const entry = files.get(sheet.name)
    if (!entry) continue
    const xml = entry.toString('utf8')
    for (const row of xml.matchAll(ROW)) {
      const body = row[1] || ''
      const cells = []
      for (const cell of body.matchAll(CELL)) {
        cells.push(cellText(cell[1], cell[2], strings))
      }
      if (cells.some((value) => value !== '')) lines.push(cells.join(' | '))
    }
  }

  return lines.join('\n')
}

/**
 * Extract plain text from a Word, PowerPoint or Excel file, picked by extension.
 *
 * @param {string} fileName name or path, only the extension is inspected
 * @param {Buffer|Uint8Array} buffer
 * @returns {string|null} null for a format this module does not handle
 */
export function ooxmlText(fileName, buffer) {
  const name = String(fileName ?? '').toLowerCase()
  const dot = name.lastIndexOf('.')
  const extension = dot === -1 ? '' : name.slice(dot + 1)

  switch (extension) {
    case 'docx':
    case 'docm':
      return docxText(buffer)
    case 'pptx':
    case 'pptm':
      return pptxText(buffer)
    case 'xlsx':
    case 'xlsm':
      return xlsxText(buffer)
    default:
      return null
  }
}
