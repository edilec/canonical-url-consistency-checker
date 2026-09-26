/**
 * Page identity: turning a written URL into something two files can be compared on.
 *
 * Every rule in this tool reduces to one question — do these two declarations
 * name the same page? That question is only answerable once a URL has been put
 * into a single, documented form, so all of that work lives here.
 */

export const TRAILING_SLASH_POLICIES = Object.freeze(['always', 'never', 'as-declared'])

/**
 * Order by UTF-16 code unit.
 *
 * `localeCompare` is deliberately never used in this tool. Its ordering depends
 * on the ICU data a particular Node build was compiled against, so the same
 * inputs could produce differently ordered reports on two machines.
 */
export function byCodeUnit(left, right) {
  if (left === right) return 0
  return left < right ? -1 : 1
}

export class IdentityError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'IdentityError'
    this.code = code
  }
}

/**
 * Characters that may appear unescaped in a path segment (RFC 3986 `pchar`).
 * `%` is deliberately absent: by the time a segment is re-encoded it has already
 * been decoded, so a surviving `%` is a literal one and must become `%25`.
 */
const PATH_SAFE = new Set([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  ...'abcdefghijklmnopqrstuvwxyz',
  ...'0123456789',
  ...'-._~',
  ...'!$&\'()*+,;=',
  ...':@',
])

const encoder = new TextEncoder()

function encodeSegment(text) {
  let out = ''
  for (const character of text) {
    if (character.length === 1 && PATH_SAFE.has(character)) {
      out += character
      continue
    }
    for (const byte of encoder.encode(character)) {
      out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    }
  }
  return out
}

function decodeSegment(segment) {
  try {
    return decodeURIComponent(segment)
  } catch {
    throw new IdentityError('encoding', `contains a malformed percent-escape: "${segment.slice(0, 48)}"`)
  }
}

/**
 * Normalise a pathname so that percent-encoded and literal spellings of the same
 * path agree.
 *
 * Each segment is decoded, normalised to Unicode NFC, then re-encoded with one
 * fixed rule. That makes `/caf%C3%A9`, `/caf%c3%a9` and `/café` (decomposed)
 * all resolve to the same identity, while `%2F` stays encoded and therefore stays
 * distinct from a real separator.
 */
export function normalizePathname(pathname) {
  const segments = pathname.split('/')
  for (let index = 0; index < segments.length; index += 1) {
    segments[index] = encodeSegment(decodeSegment(segments[index]).normalize('NFC'))
  }
  return segments.join('/')
}

/**
 * Apply the configured trailing-slash policy.
 *
 * The policy is an explicit choice, never inferred, because inferring it from
 * the majority spelling in a build would make the report depend on which pages
 * happened to be built. Under `always` a final segment containing a dot is left
 * alone: such a path names a file, and `/logo.png/` is not the same resource.
 */
export function applyTrailingSlash(pathname, policy) {
  if (policy === 'as-declared') return pathname
  if (pathname === '/') return '/'
  if (policy === 'always') {
    if (pathname.endsWith('/')) return pathname
    const last = pathname.slice(pathname.lastIndexOf('/') + 1)
    return last.includes('.') ? pathname : `${pathname}/`
  }
  if (!pathname.endsWith('/')) return pathname
  let end = pathname.length
  while (end > 1 && pathname[end - 1] === '/') end -= 1
  return pathname.slice(0, end)
}

function classifyForm(text) {
  if (text.startsWith('//')) return 'protocol-relative'
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(text)) return 'absolute'
  return 'relative'
}

/**
 * Build the comparable identity of one written URL.
 *
 * Throws `IdentityError` rather than returning a sentinel: a URL that cannot be
 * resolved is missing evidence, and the caller must record that as a finding
 * instead of quietly comparing against a guess.
 */
export function buildIdentity(raw, options) {
  const { base, policy } = options
  if (!TRAILING_SLASH_POLICIES.includes(policy)) {
    throw new TypeError(`Unsupported trailing-slash policy "${policy}"`)
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new IdentityError('empty', 'is empty')
  }
  const text = raw.trim()
  let url
  try {
    url = new URL(text, base)
  } catch {
    throw new IdentityError('unparsable', `is not a URL that resolves against ${base}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new IdentityError('scheme', `uses the unsupported scheme "${url.protocol.slice(0, -1)}"`)
  }
  const declaredPath = normalizePathname(url.pathname)
  const path = applyTrailingSlash(declaredPath, policy)
  return {
    raw: text,
    form: classifyForm(text),
    origin: url.origin,
    declaredPath,
    path,
    search: url.search,
    hash: url.hash,
    identity: `${url.origin}${path}${url.search}`,
  }
}

/**
 * Follow a redirect chain to its end within an explicit bound.
 *
 * `too-deep` is reported separately from `loop` because they mean different
 * things: a loop is a defect the tool has proved, while an over-long chain only
 * means the tool stopped looking, which is missing evidence and never a pass.
 */
export function resolveRedirect(identity, index, maxDepth) {
  const chain = [identity]
  let current = identity
  for (let step = 0; step <= maxDepth; step += 1) {
    const next = index.get(current)
    if (next === undefined) {
      return { outcome: chain.length > 1 ? 'redirected' : 'none', target: current, chain }
    }
    if (step === maxDepth) return { outcome: 'too-deep', target: null, chain }
    if (chain.includes(next)) {
      chain.push(next)
      return { outcome: 'loop', target: null, chain }
    }
    chain.push(next)
    current = next
  }
  /* c8 ignore next */
  return { outcome: 'too-deep', target: null, chain }
}
