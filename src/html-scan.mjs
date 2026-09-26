/**
 * A small, bounded HTML scanner for `<link rel="canonical">` and `<base href>`.
 *
 * A regular expression run over a whole document is the usual shortcut here and
 * it is wrong in ways that matter: it finds canonical-looking text inside
 * comments, inside `<script>` strings and inside escaped examples in prose, and
 * it cannot tell a declaration in `<head>` from one stranded in `<body>`. This
 * scanner walks the document once, skips comments and raw-text elements, and
 * stops at explicit limits instead of running away on a hostile input.
 */

import { byCodeUnit } from './url-identity.mjs'

export const DEFAULT_HTML_LIMITS = Object.freeze({
  maxTags: 200000,
  maxCanonicalLinks: 50,
  maxAttributes: 200,
})

/** Elements whose content is text, not markup. A `<link>` inside one is not a tag. */
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'textarea', 'title'])

const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', '\''],
  ['nbsp', ' '],
])

const ENTITY_PATTERN = /&(#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,9});/g

/** Decode entities in one attribute value. Bounded input, so a pattern is safe here. */
function decodeEntities(text) {
  if (!text.includes('&')) return text
  return text.replace(ENTITY_PATTERN, (match, body) => {
    if (body[0] !== '#') {
      const named = NAMED_ENTITIES.get(body.toLowerCase())
      return named === undefined ? match : named
    }
    const hex = body[1] === 'x' || body[1] === 'X'
    const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
    if (!Number.isInteger(code) || code < 1 || code > 0x10FFFF) return match
    if (code >= 0xD800 && code <= 0xDFFF) return match
    return String.fromCodePoint(code)
  })
}

function isSpace(character) {
  return character === ' ' || character === '\t' || character === '\n' || character === '\r' || character === '\f'
}

function readTagName(source, start) {
  let cursor = start
  while (cursor < source.length) {
    const code = source.charCodeAt(cursor)
    const alpha = (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
    const digit = code >= 48 && code <= 57
    if (!alpha && !digit) break
    cursor += 1
  }
  return { name: source.slice(start, cursor).toLowerCase(), end: cursor }
}

function readAttributes(source, start, maxAttributes) {
  const attributes = new Map()
  let cursor = start
  let selfClosing = false
  let overflow = false

  while (cursor < source.length) {
    while (cursor < source.length && isSpace(source[cursor])) cursor += 1
    if (cursor >= source.length) break
    const character = source[cursor]
    if (character === '>') {
      cursor += 1
      break
    }
    if (character === '/') {
      if (source[cursor + 1] === '>') {
        selfClosing = true
        cursor += 2
        break
      }
      cursor += 1
      continue
    }

    const nameStart = cursor
    while (
      cursor < source.length
      && !isSpace(source[cursor])
      && source[cursor] !== '='
      && source[cursor] !== '>'
      && source[cursor] !== '/'
    ) cursor += 1
    const name = source.slice(nameStart, cursor).toLowerCase()
    if (name === '') {
      cursor += 1
      continue
    }

    let value = ''
    let lookahead = cursor
    while (lookahead < source.length && isSpace(source[lookahead])) lookahead += 1
    if (source[lookahead] === '=') {
      cursor = lookahead + 1
      while (cursor < source.length && isSpace(source[cursor])) cursor += 1
      const quote = source[cursor]
      if (quote === '"' || quote === '\'') {
        cursor += 1
        const close = source.indexOf(quote, cursor)
        value = source.slice(cursor, close === -1 ? source.length : close)
        cursor = close === -1 ? source.length : close + 1
      } else {
        const valueStart = cursor
        while (cursor < source.length && !isSpace(source[cursor]) && source[cursor] !== '>') cursor += 1
        value = source.slice(valueStart, cursor)
      }
    }

    if (attributes.size >= maxAttributes) overflow = true
    else if (!attributes.has(name)) attributes.set(name, decodeEntities(value))
  }

  return { attributes, end: cursor, selfClosing, overflow }
}

function findRawTextEnd(source, from, name) {
  const needle = `</${name}`
  let cursor = from
  while (cursor < source.length) {
    const open = source.indexOf('<', cursor)
    if (open === -1) return source.length
    if (source.slice(open, open + needle.length).toLowerCase() === needle) return open
    cursor = open + 1
  }
  return source.length
}

function lineAt(source, index) {
  let line = 1
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) line += 1
  }
  return line
}

function excerptTag(source, open, end) {
  const limit = Math.min(end, open + 200)
  return source.slice(open, limit).replace(/\s+/g, ' ').trim()
}

/**
 * Scan one HTML document.
 *
 * Returns every canonical declaration in document order, whether each was still
 * inside `<head>`, and the first `<base href>` if one was set. Limits that were
 * reached are named in `limitsExceeded` so the caller can report them; nothing
 * is ever dropped silently.
 */
export function scanHtml(source, options = {}) {
  const limits = { ...DEFAULT_HTML_LIMITS, ...options.limits }
  const canonicals = []
  const exceeded = new Set()
  let base = null
  let headEnded = false
  let tags = 0
  let cursor = 0

  while (cursor < source.length) {
    const open = source.indexOf('<', cursor)
    if (open === -1) break

    if (source.startsWith('<!--', open)) {
      const close = source.indexOf('-->', open + 4)
      cursor = close === -1 ? source.length : close + 3
      continue
    }
    if (source.startsWith('<!', open) || source.startsWith('<?', open)) {
      const close = source.indexOf('>', open + 2)
      cursor = close === -1 ? source.length : close + 1
      continue
    }

    const closing = source[open + 1] === '/'
    const { name, end } = readTagName(source, open + (closing ? 2 : 1))
    if (name === '') {
      cursor = open + 1
      continue
    }

    tags += 1
    if (tags > limits.maxTags) {
      exceeded.add('maxTags')
      break
    }

    const tag = readAttributes(source, end, limits.maxAttributes)
    if (tag.overflow) exceeded.add('maxAttributes')
    cursor = tag.end

    if (closing) {
      if (name === 'head') headEnded = true
      continue
    }
    if (RAW_TEXT_ELEMENTS.has(name) && !tag.selfClosing) {
      cursor = findRawTextEnd(source, cursor, name)
      continue
    }
    if (name === 'body') {
      headEnded = true
      continue
    }
    if (name === 'base') {
      if (base === null && tag.attributes.has('href')) base = tag.attributes.get('href')
      continue
    }
    if (name !== 'link') continue

    const rel = tag.attributes.get('rel')
    if (rel === undefined) continue
    if (!rel.toLowerCase().split(/\s+/).filter(Boolean).includes('canonical')) continue

    if (canonicals.length >= limits.maxCanonicalLinks) {
      exceeded.add('maxCanonicalLinks')
      continue
    }
    canonicals.push({
      href: tag.attributes.has('href') ? tag.attributes.get('href') : null,
      inHead: !headEnded,
      offset: open,
      line: lineAt(source, open),
      excerpt: excerptTag(source, open, tag.end),
    })
  }

  return { base, canonicals, limitsExceeded: [...exceeded].sort(byCodeUnit) }
}
