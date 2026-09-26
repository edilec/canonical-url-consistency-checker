/**
 * A small, bounded scanner for sitemap `<loc>` values.
 *
 * Sitemaps are XML, but only one thing is needed from them here: which URLs the
 * export claims are indexable. A full XML parser is more machinery than that
 * warrants, and a regular expression over the document would happily pick up a
 * `<loc>` inside a comment or a CDATA block meant as an example. This walks the
 * document once, tracks just enough element context to know a `<url><loc>` from
 * a `<sitemap><loc>`, and stops at explicit limits.
 */

import { byCodeUnit } from './url-identity.mjs'

export const DEFAULT_SITEMAP_LIMITS = Object.freeze({
  maxUrls: 50000,
  maxTags: 1000000,
  maxDepth: 16,
  maxLocLength: 4096,
})

const XML_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', '\''],
])

const ENTITY_PATTERN = /&(#[0-9]{1,7}|#[xX][0-9A-Fa-f]{1,6}|[A-Za-z][A-Za-z0-9]{1,9});/g

function decodeXml(text) {
  if (!text.includes('&')) return text
  return text.replace(ENTITY_PATTERN, (match, body) => {
    if (body[0] !== '#') {
      const named = XML_ENTITIES.get(body.toLowerCase())
      return named === undefined ? match : named
    }
    const hex = body[1] === 'x' || body[1] === 'X'
    const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
    if (!Number.isInteger(code) || code < 1 || code > 0x10FFFF) return match
    if (code >= 0xD800 && code <= 0xDFFF) return match
    return String.fromCodePoint(code)
  })
}

function readName(source, start) {
  let cursor = start
  while (cursor < source.length) {
    const character = source[cursor]
    const code = source.charCodeAt(cursor)
    const alpha = (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
    const digit = code >= 48 && code <= 57
    if (!alpha && !digit && character !== '-' && character !== '_' && character !== '.' && character !== ':') break
    cursor += 1
  }
  const raw = source.slice(start, cursor)
  const colon = raw.lastIndexOf(':')
  return { name: (colon === -1 ? raw : raw.slice(colon + 1)).toLowerCase(), end: cursor }
}

/** Find the `>` that closes a tag, ignoring one inside a quoted attribute value. */
function findTagEnd(source, from) {
  let cursor = from
  let quote = null
  while (cursor < source.length) {
    const character = source[cursor]
    if (quote !== null) {
      if (character === quote) quote = null
    } else if (character === '"' || character === '\'') {
      quote = character
    } else if (character === '>') {
      return { end: cursor + 1, selfClosing: source[cursor - 1] === '/' }
    }
    cursor += 1
  }
  return { end: source.length, selfClosing: false }
}

function readText(source, from) {
  if (source.startsWith('<![CDATA[', from)) {
    const close = source.indexOf(']]>', from + 9)
    if (close === -1) return { text: source.slice(from + 9), end: source.length }
    return { text: source.slice(from + 9, close), end: close + 3 }
  }
  const close = source.indexOf('<', from)
  const end = close === -1 ? source.length : close
  return { text: decodeXml(source.slice(from, end)), end }
}

function lineAt(source, index) {
  let line = 1
  for (let cursor = 0; cursor < index; cursor += 1) {
    if (source.charCodeAt(cursor) === 10) line += 1
  }
  return line
}

/**
 * Scan one sitemap export.
 *
 * `kind` is the local name of the root element, so a caller can refuse a
 * `sitemapindex` rather than silently reporting zero URLs — this tool never
 * fetches, so an index it cannot expand is missing evidence, not an empty set.
 */
export function scanSitemap(source, options = {}) {
  const limits = { ...DEFAULT_SITEMAP_LIMITS, ...options.limits }
  const locations = []
  const exceeded = new Set()
  const stack = []
  let kind = null
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
    if (source.startsWith('<![CDATA[', open)) {
      const close = source.indexOf(']]>', open + 9)
      cursor = close === -1 ? source.length : close + 3
      continue
    }
    if (source.startsWith('<!', open) || source.startsWith('<?', open)) {
      const close = source.indexOf('>', open + 2)
      cursor = close === -1 ? source.length : close + 1
      continue
    }

    const closing = source[open + 1] === '/'
    const { name, end } = readName(source, open + (closing ? 2 : 1))
    if (name === '') {
      cursor = open + 1
      continue
    }

    tags += 1
    if (tags > limits.maxTags) {
      exceeded.add('maxTags')
      break
    }

    const tag = findTagEnd(source, end)
    cursor = tag.end

    if (closing) {
      const at = stack.lastIndexOf(name)
      if (at !== -1) stack.length = at
      continue
    }
    if (kind === null) kind = name
    if (tag.selfClosing) continue

    if (name === 'loc') {
      const parent = stack[stack.length - 1] ?? null
      const text = readText(source, cursor)
      cursor = text.end
      if (parent !== 'url') continue
      if (text.text.length > limits.maxLocLength) {
        exceeded.add('maxLocLength')
        continue
      }
      if (locations.length >= limits.maxUrls) {
        exceeded.add('maxUrls')
        continue
      }
      locations.push({ value: text.text.trim(), index: locations.length, line: lineAt(source, open) })
      continue
    }

    stack.push(name)
    if (stack.length > limits.maxDepth) {
      exceeded.add('maxDepth')
      break
    }
  }

  return { kind: kind ?? 'empty', locations, limitsExceeded: [...exceeded].sort(byCodeUnit) }
}
