/**
 * canonical-url-consistency-checker
 *
 * Resolve the canonical declarations a site actually ships — in its route
 * manifest, in its built HTML and in its sitemap exports — against one explicit
 * policy, and report where they disagree about which URL names a page.
 *
 * The tool never fetches anything. Everything it knows about redirects comes
 * from a supplied map, so a canonical that points at a redirected URL is found
 * by resolution, not by asking the network.
 */

import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path'

import {
  IdentityError,
  TRAILING_SLASH_POLICIES,
  buildIdentity,
  byCodeUnit,
  resolveRedirect,
} from './url-identity.mjs'
import { scanHtml } from './html-scan.mjs'
import { scanSitemap } from './sitemap-scan.mjs'

export { TRAILING_SLASH_POLICIES, buildIdentity, byCodeUnit, resolveRedirect } from './url-identity.mjs'
export { scanHtml } from './html-scan.mjs'
export { scanSitemap } from './sitemap-scan.mjs'

export const TOOL_ID = 'canonical-url-consistency-checker'
export const REPORT_SCHEMA_VERSION = '1'
export const CONFIG_SCHEMA_VERSION = '1'

export const DEFAULT_LIMITS = Object.freeze({
  maxRoutes: 20000,
  maxRedirects: 20000,
  maxRedirectDepth: 5,
  maxHtmlBytes: 2000000,
  maxSitemapBytes: 33554432,
  maxSitemapUrls: 50000,
  maxCanonicalLinks: 50,
  maxTags: 200000,
})

const LIMIT_NAMES = Object.freeze(Object.keys(DEFAULT_LIMITS))
const EVIDENCE_LIMIT = 200

/**
 * A problem with the configuration itself, not with the site being checked.
 *
 * `rule` names the refusal when one is dedicated to a documented boundary, so a
 * caller can tell an input-root violation from a schema mistake without matching
 * on prose. It is `null` for the ordinary schema refusals.
 */
export class ConfigError extends Error {
  constructor(message, rule = null) {
    super(message)
    this.name = 'ConfigError'
    this.rule = rule
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function excerpt(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim()
  return flat.length > EVIDENCE_LIMIT ? `${flat.slice(0, EVIDENCE_LIMIT - 1)}…` : flat
}

function toPosix(value) {
  return value.split(sep).join('/')
}

function at(file, pointer) {
  const location = {}
  if (file !== null && file !== undefined) location.file = file
  if (pointer !== null && pointer !== undefined) location.pointer = pointer
  return location
}

function makeFinding(ruleId, severity, message, location, extra = {}) {
  const finding = { ruleId, severity, message, location }
  if (extra.evidence !== undefined) finding.evidence = excerpt(extra.evidence)
  if (extra.suggestion !== undefined) finding.suggestion = extra.suggestion
  return finding
}

function escapes(from, target) {
  const rel = relative(from, target)
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

/**
 * The real path a target would have once every symbolic link on the way to it is
 * followed.
 *
 * `realpath` needs the whole path to exist, but a build output that was never
 * produced must still reach the audit as an `html-unreadable` finding rather
 * than a configuration error. So the deepest ancestor that does exist is
 * resolved for real and the segments below it are appended literally: a link
 * anywhere along the existing part is still followed, and a missing leaf keeps
 * the location its parent gives it.
 */
async function realPathOf(target, describe) {
  const tail = []
  let current = target
  for (;;) {
    try {
      const real = await realpath(current)
      return tail.length === 0 ? real : resolve(real, ...tail)
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') {
        // A link cycle, or a directory on the way down that cannot be read. The
        // target is unknown, so it cannot be shown to be inside the root, so it
        // is refused. The host path stays out of the message; the declared one
        // is what the reader can act on.
        throw new ConfigError(`${describe} could not be resolved (${error.code ?? 'unknown error'})`, 'input-unresolvable')
      }
      const parent = dirname(current)
      if (parent === current) return target
      tail.unshift(basename(current))
      current = parent
    }
  }
}

/**
 * Resolve an input path declared in the configuration, refusing to leave the
 * declared root.
 *
 * The configuration is data, and data does not get to choose which files this
 * tool opens. A manifest that points at `../../.ssh/id_rsa` is a configuration
 * error, not a route.
 *
 * Spelling a path is not the only way to leave a tree, so the lexical check is
 * not the whole boundary: a symbolic link planted inside the root points
 * wherever it likes, and following one would read a file the configuration never
 * had the right to name and echo its content into the report. The resolved path
 * is therefore confined again after every link on it has been followed, against
 * the real path of the root itself — the root may sit behind a link too, as
 * `/var` does on macOS.
 */
async function resolveWithin(root, realRoot, candidate, label) {
  if (typeof candidate !== 'string' || candidate.trim() === '') {
    throw new ConfigError(`${label} must be a non-empty relative path`, 'input-not-relative')
  }
  if (isAbsolute(candidate)) {
    throw new ConfigError(
      `${label} must be relative to the input root, but "${candidate}" is absolute`,
      'input-not-relative',
    )
  }
  const resolved = resolve(root, candidate)
  if (escapes(root, resolved)) {
    throw new ConfigError(`${label} resolves outside the input root: "${candidate}"`, 'input-outside-root')
  }
  if (escapes(realRoot, await realPathOf(resolved, `${label} ("${candidate}")`))) {
    throw new ConfigError(
      `${label} leaves the input root through a symbolic link: "${candidate}". Nothing was read from it.`,
      'input-escapes-root',
    )
  }
  return resolved
}

function assertOrigin(value, label) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw new ConfigError(`${label} must be an absolute http(s) URL, got "${String(value).slice(0, 80)}"`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`${label} must use http or https, got "${url.protocol.slice(0, -1)}"`)
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new ConfigError(`${label} must be a bare origin such as https://example.com, got "${String(value).slice(0, 80)}"`)
  }
  return url.origin
}

/**
 * Validate the configuration document.
 *
 * `trailingSlash` is required and has no default. A site's slash policy is a
 * decision, and guessing it would let the same build pass on one machine and
 * fail on another depending on which spelling happened to be more common.
 */
export function validateConfig(document, overrides = {}) {
  if (!isRecord(document)) throw new ConfigError('Config must be a JSON object')
  if (document.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new ConfigError(`Unsupported config schemaVersion: ${document.schemaVersion ?? 'missing'}`)
  }
  if (!isRecord(document.site)) throw new ConfigError('Config is missing its site object')

  const origin = assertOrigin(document.site.origin, 'site.origin')
  const alternateSource = document.site.alternateOrigins ?? []
  if (!Array.isArray(alternateSource)) throw new ConfigError('site.alternateOrigins must be an array')
  const alternateOrigins = alternateSource.map((entry, index) => assertOrigin(entry, `site.alternateOrigins[${index}]`))

  const trailingSlash = overrides.trailingSlash ?? document.trailingSlash
  if (!TRAILING_SLASH_POLICIES.includes(trailingSlash)) {
    throw new ConfigError(
      `trailingSlash must be one of ${TRAILING_SLASH_POLICIES.join(', ')}, got "${String(trailingSlash ?? 'missing').slice(0, 40)}"`,
    )
  }

  if (typeof document.routes !== 'string' || document.routes.trim() === '') {
    throw new ConfigError('Config must name a route manifest in "routes"')
  }
  const sitemaps = document.sitemaps ?? []
  if (!Array.isArray(sitemaps) || sitemaps.some((entry) => typeof entry !== 'string')) {
    throw new ConfigError('sitemaps must be an array of relative paths')
  }
  const redirects = document.redirects ?? null
  if (redirects !== null && typeof redirects !== 'string') {
    throw new ConfigError('redirects must be a relative path or omitted')
  }

  const limits = {}
  if (document.limits !== undefined) {
    if (!isRecord(document.limits)) throw new ConfigError('limits must be an object')
    for (const [name, value] of Object.entries(document.limits)) {
      if (!LIMIT_NAMES.includes(name)) {
        throw new ConfigError(`Unknown limit "${name}". Known limits: ${LIMIT_NAMES.join(', ')}`)
      }
      if (!Number.isInteger(value) || value < 1) {
        throw new ConfigError(`limits.${name} must be a positive integer`)
      }
      limits[name] = value
    }
  }

  return { schemaVersion: CONFIG_SCHEMA_VERSION, site: { origin, alternateOrigins }, trailingSlash, routes: document.routes, sitemaps, redirects, limits }
}

export function validateRoutes(document) {
  if (!isRecord(document)) throw new ConfigError('Route manifest must be a JSON object')
  if (document.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new ConfigError(`Unsupported route manifest schemaVersion: ${document.schemaVersion ?? 'missing'}`)
  }
  if (!Array.isArray(document.routes) || document.routes.length === 0) {
    throw new ConfigError('Route manifest must declare a non-empty routes array')
  }
  const routes = document.routes.map((entry, index) => {
    if (!isRecord(entry)) throw new ConfigError(`routes[${index}] must be an object`)
    if (typeof entry.path !== 'string' || !entry.path.startsWith('/')) {
      throw new ConfigError(`routes[${index}].path must be a site-relative path beginning with "/"`)
    }
    if (typeof entry.html !== 'string' || entry.html.trim() === '') {
      throw new ConfigError(`routes[${index}].html must name the built document for this route`)
    }
    if (entry.canonical !== undefined && typeof entry.canonical !== 'string') {
      throw new ConfigError(`routes[${index}].canonical must be a string when present`)
    }
    if (entry.indexable !== undefined && typeof entry.indexable !== 'boolean') {
      throw new ConfigError(`routes[${index}].indexable must be a boolean when present`)
    }
    return {
      index,
      path: entry.path,
      html: toPosix(entry.html),
      canonical: entry.canonical ?? null,
      indexable: entry.indexable ?? true,
    }
  })
  return { schemaVersion: CONFIG_SCHEMA_VERSION, routes }
}

export function validateRedirects(document) {
  if (!isRecord(document)) throw new ConfigError('Redirect map must be a JSON object')
  if (document.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new ConfigError(`Unsupported redirect map schemaVersion: ${document.schemaVersion ?? 'missing'}`)
  }
  if (!Array.isArray(document.redirects)) throw new ConfigError('Redirect map must declare a redirects array')
  const redirects = document.redirects.map((entry, index) => {
    if (!isRecord(entry)) throw new ConfigError(`redirects[${index}] must be an object`)
    if (typeof entry.from !== 'string' || typeof entry.to !== 'string') {
      throw new ConfigError(`redirects[${index}] must declare string "from" and "to" values`)
    }
    if (entry.status !== undefined && (!Number.isInteger(entry.status) || entry.status < 300 || entry.status > 399)) {
      throw new ConfigError(`redirects[${index}].status must be a 3xx integer when present`)
    }
    return { index, from: entry.from, to: entry.to, status: entry.status ?? 301 }
  })
  return { schemaVersion: CONFIG_SCHEMA_VERSION, redirects }
}

async function readJsonFile(file, label) {
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    throw new ConfigError(`Could not read the ${label} (${error.code ?? 'unknown error'})`)
  }
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new ConfigError(`The ${label} is not valid JSON: ${error.message}`)
  }
}

async function readBounded(file, maxBytes) {
  let info
  try {
    info = await stat(file)
  } catch (error) {
    return { status: 'unreadable', reason: error.code ?? 'unknown error', source: null, bytes: 0 }
  }
  if (!info.isFile()) return { status: 'unreadable', reason: 'not a regular file', source: null, bytes: 0 }
  if (info.size > maxBytes) return { status: 'too-large', reason: `${info.size} bytes`, source: null, bytes: info.size }
  try {
    return { status: 'ok', reason: null, source: await readFile(file, 'utf8'), bytes: info.size }
  } catch (error) {
    return { status: 'unreadable', reason: error.code ?? 'unknown error', source: null, bytes: info.size }
  }
}

/**
 * Read every input the configuration names.
 *
 * Reading is separated from auditing so the audit stays a pure function of what
 * was on disk: the same bytes always produce the same report, and tests can
 * exercise the rules without a filesystem.
 */
export async function loadProject(options = {}) {
  if (typeof options.config !== 'string' || options.config.trim() === '') {
    throw new ConfigError('A config file path is required')
  }
  const configFile = resolve(options.config)
  const config = validateConfig(await readJsonFile(configFile, 'config'), options)
  const root = resolve(options.root ?? dirname(configFile))
  const realRoot = await realPathOf(root, 'The input root')
  const limits = { ...DEFAULT_LIMITS, ...config.limits }

  const loadFindings = []
  let incomplete = false

  const routesFile = await resolveWithin(root, realRoot, config.routes, 'routes')
  const routesPath = toPosix(relative(root, routesFile))
  let routes = validateRoutes(await readJsonFile(routesFile, 'route manifest')).routes
  if (routes.length > limits.maxRoutes) {
    loadFindings.push(makeFinding(
      'route-limit-exceeded',
      'error',
      `The route manifest declares ${routes.length} routes, above the configured maxRoutes limit of ${limits.maxRoutes}. No route was audited.`,
      at(routesPath, '/routes'),
      { suggestion: 'Raise limits.maxRoutes or split the manifest into smaller exports.' },
    ))
    incomplete = true
    routes = []
  }

  const documents = new Map()
  for (const route of routes) {
    if (documents.has(route.html)) continue
    const file = await resolveWithin(root, realRoot, route.html, `routes[${route.index}].html`)
    documents.set(route.html, await readBounded(file, limits.maxHtmlBytes))
  }

  const sitemaps = []
  for (const [index, entry] of config.sitemaps.entries()) {
    const file = await resolveWithin(root, realRoot, entry, `sitemaps[${index}]`)
    sitemaps.push({ file: toPosix(entry), ...(await readBounded(file, limits.maxSitemapBytes)) })
  }

  let redirects = []
  let redirectsPath = null
  if (config.redirects !== null) {
    const file = await resolveWithin(root, realRoot, config.redirects, 'redirects')
    redirectsPath = toPosix(config.redirects)
    redirects = validateRedirects(await readJsonFile(file, 'redirect map')).redirects
    if (redirects.length > limits.maxRedirects) {
      loadFindings.push(makeFinding(
        'redirect-limit-exceeded',
        'error',
        `The redirect map declares ${redirects.length} entries, above the configured maxRedirects limit of ${limits.maxRedirects}. No redirect was resolved.`,
        at(redirectsPath, '/redirects'),
        { suggestion: 'Raise limits.maxRedirects or supply a pruned map.' },
      ))
      incomplete = true
      redirects = []
    }
  }

  return { config, limits, routes, routesPath, documents, sitemaps, redirects, redirectsPath, loadFindings, incomplete }
}

function buildRedirectIndex(project, findings) {
  const { config, redirects, redirectsPath } = project
  const index = new Map()
  const policy = config.trailingSlash
  for (const entry of redirects) {
    const pointer = `/redirects/${entry.index}`
    let from
    let to
    try {
      from = buildIdentity(entry.from, { base: config.site.origin, policy })
    } catch (error) {
      findings.push(makeFinding('redirect-entry-invalid', 'error', `Redirect source ${error.message}.`, at(redirectsPath, `${pointer}/from`), { evidence: entry.from }))
      continue
    }
    try {
      to = buildIdentity(entry.to, { base: config.site.origin, policy })
    } catch (error) {
      findings.push(makeFinding('redirect-entry-invalid', 'error', `Redirect target ${error.message}.`, at(redirectsPath, `${pointer}/to`), { evidence: entry.to }))
      continue
    }
    if (from.identity === to.identity) {
      findings.push(makeFinding(
        'redirect-noop-under-policy',
        'info',
        `This redirect is a no-op once the "${policy}" trailing-slash policy is applied: both sides resolve to ${to.identity}.`,
        at(redirectsPath, pointer),
        { evidence: `${entry.from} -> ${entry.to}` },
      ))
      continue
    }
    if (index.has(from.identity)) {
      findings.push(makeFinding(
        'redirect-source-duplicated',
        'warning',
        `${from.identity} is the source of more than one redirect; only the first is resolved.`,
        at(redirectsPath, pointer),
        { evidence: `${entry.from} -> ${entry.to}` },
      ))
      continue
    }
    index.set(from.identity, to.identity)
  }
  return index
}

function describeChain(chain) {
  return chain.join(' -> ')
}

/**
 * Audit one loaded project.
 *
 * Pure: given the same inputs it produces the same report, including the order
 * of every finding.
 */
export function auditProject(project) {
  const { config, limits, routes, routesPath, documents, sitemaps, redirectsPath } = project
  const policy = config.trailingSlash
  const origin = config.site.origin
  const alternates = new Set(config.site.alternateOrigins)
  const findings = [...project.loadFindings]
  let incomplete = project.incomplete

  const redirectIndex = buildRedirectIndex(project, findings)

  // Route identities first: a collision means two manifest entries claim the same
  // page, and every later comparison would be against an ambiguous target.
  const routeByIdentity = new Map()
  const collisions = new Map()
  const identified = []
  for (const route of routes) {
    let identity
    try {
      identity = buildIdentity(route.path, { base: origin, policy })
    } catch (error) {
      findings.push(makeFinding('route-path-invalid', 'error', `Route path ${error.message}.`, at(routesPath, `/routes/${route.index}/path`), { evidence: route.path }))
      continue
    }
    identified.push({ route, identity })
    if (routeByIdentity.has(identity.identity)) {
      const group = collisions.get(identity.identity) ?? [routeByIdentity.get(identity.identity).route.path]
      group.push(route.path)
      collisions.set(identity.identity, group)
      continue
    }
    routeByIdentity.set(identity.identity, { route, identity })
  }
  for (const [identity, paths] of collisions) {
    const sorted = [...paths].sort(byCodeUnit)
    const owner = routeByIdentity.get(identity).route
    findings.push(makeFinding(
      'route-identity-collision',
      'error',
      `${sorted.length} routes resolve to the same page identity ${identity} under the "${policy}" trailing-slash policy.`,
      at(routesPath, `/routes/${owner.index}/path`),
      { evidence: sorted.join(', '), suggestion: 'Keep one route and redirect the others, or change the trailing-slash policy deliberately.' },
    ))
  }

  const canonicalByRoute = new Map()

  for (const { route, identity: routeIdentity } of identified) {
    const pointer = routeIdentity.identity
    const document = documents.get(route.html)
    if (document === undefined || document.status === 'unreadable') {
      findings.push(makeFinding(
        'html-unreadable',
        'error',
        `The built document for ${route.path} could not be read (${document?.reason ?? 'missing'}).`,
        at(route.html, pointer),
        { suggestion: 'Run the build before the check, or correct routes[].html.' },
      ))
      incomplete = true
      continue
    }
    if (document.status === 'too-large') {
      findings.push(makeFinding(
        'html-too-large',
        'error',
        `The built document for ${route.path} is ${document.reason}, above the configured maxHtmlBytes limit of ${limits.maxHtmlBytes}. It was not scanned.`,
        at(route.html, pointer),
        { suggestion: 'Raise limits.maxHtmlBytes deliberately, or exclude this document.' },
      ))
      incomplete = true
      continue
    }

    const scan = scanHtml(document.source, { limits })
    for (const limitName of scan.limitsExceeded) {
      findings.push(makeFinding(
        'html-scan-limit-exceeded',
        'error',
        `Scanning the built document for ${route.path} reached the ${limitName} limit, so its canonical declarations were not fully read.`,
        at(route.html, pointer),
        { suggestion: `Raise limits.${limitName} deliberately after checking why the document is this large.` },
      ))
      incomplete = true
    }

    let base = origin
    if (scan.base !== null) {
      try {
        base = new URL(scan.base, origin).href
      } catch {
        findings.push(makeFinding('base-href-invalid', 'warning', `The <base href> in this document is not a usable URL; canonical resolution fell back to ${origin}.`, at(route.html, pointer), { evidence: scan.base }))
      }
    }

    if (scan.canonicals.length === 0) {
      findings.push(makeFinding(
        'canonical-missing',
        'error',
        `${route.path} declares no <link rel="canonical">.`,
        at(route.html, pointer),
        { suggestion: `Add <link rel="canonical" href="${routeIdentity.identity}">.` },
      ))
      canonicalByRoute.set(routeIdentity.identity, null)
      continue
    }

    const resolved = []
    for (const link of scan.canonicals) {
      if (link.href === null || link.href.trim() === '') {
        findings.push(makeFinding('canonical-href-empty', 'error', `A canonical link on ${route.path} has no href.`, at(route.html, pointer), { evidence: link.excerpt }))
        continue
      }
      try {
        resolved.push({ link, identity: buildIdentity(link.href, { base, policy }) })
      } catch (error) {
        const ruleId = error instanceof IdentityError && error.code === 'encoding'
          ? 'canonical-encoding-invalid'
          : 'canonical-unparsable'
        findings.push(makeFinding(ruleId, 'error', `The canonical declared on ${route.path} ${error.message}.`, at(route.html, pointer), { evidence: link.excerpt }))
      }
    }
    if (resolved.length === 0) {
      canonicalByRoute.set(routeIdentity.identity, null)
      continue
    }

    const distinct = [...new Set(resolved.map((entry) => entry.identity.identity))].sort(byCodeUnit)
    if (distinct.length > 1) {
      findings.push(makeFinding(
        'canonical-multiple-conflicting',
        'error',
        `${route.path} declares ${resolved.length} canonical links naming ${distinct.length} different pages.`,
        at(route.html, pointer),
        { evidence: distinct.join(', '), suggestion: 'Keep exactly one canonical declaration per document.' },
      ))
    } else if (resolved.length > 1) {
      findings.push(makeFinding(
        'canonical-duplicate-declaration',
        'warning',
        `${route.path} declares the same canonical ${resolved.length} times.`,
        at(route.html, pointer),
        { evidence: distinct[0] },
      ))
    }

    // Document order decides which declaration is treated as the page's claim,
    // matching what a consumer reading the head top-down would take.
    const primary = resolved[0]
    const declared = primary.identity
    canonicalByRoute.set(routeIdentity.identity, declared.identity)

    if (!primary.link.inHead) {
      findings.push(makeFinding('canonical-outside-head', 'warning', `The canonical on ${route.path} is declared outside <head> (line ${primary.link.line}).`, at(route.html, pointer), { evidence: primary.link.excerpt }))
    }
    if (declared.form !== 'absolute') {
      findings.push(makeFinding('canonical-not-absolute', 'warning', `The canonical on ${route.path} is written as a ${declared.form} URL.`, at(route.html, pointer), { evidence: declared.raw, suggestion: `Declare it absolutely as ${declared.identity}.` }))
    }
    if (declared.hash !== '') {
      findings.push(makeFinding('canonical-has-fragment', 'warning', `The canonical on ${route.path} carries a fragment, which never identifies a separate page.`, at(route.html, pointer), { evidence: declared.raw }))
    }
    if (policy !== 'as-declared' && declared.declaredPath !== declared.path) {
      findings.push(makeFinding(
        'canonical-trailing-slash-policy',
        'warning',
        `The canonical on ${route.path} is written as ${declared.declaredPath} but the configured "${policy}" policy makes the page identity ${declared.path}.`,
        at(route.html, pointer),
        { suggestion: `Emit the canonical in the policy form: ${declared.identity}.` },
      ))
    }

    if (declared.origin !== origin) {
      if (alternates.has(declared.origin)) {
        findings.push(makeFinding('canonical-alternate-host', 'warning', `${route.path} points its canonical at the alternate origin ${declared.origin} instead of ${origin}.`, at(route.html, pointer), { evidence: declared.identity }))
      } else {
        findings.push(makeFinding(
          'canonical-cross-host',
          'error',
          `${route.path} points its canonical at ${declared.origin}, which is neither the configured origin nor a declared alternate.`,
          at(route.html, pointer),
          { evidence: declared.identity, suggestion: 'Correct the canonical, or declare that origin in site.alternateOrigins if it really is yours.' },
        ))
      }
    }

    const redirected = resolveRedirect(declared.identity, redirectIndex, limits.maxRedirectDepth)
    if (redirected.outcome === 'redirected') {
      findings.push(makeFinding(
        'canonical-redirected',
        'error',
        `The canonical on ${route.path} points at ${declared.identity}, which the supplied redirect map sends to ${redirected.target}.`,
        at(route.html, pointer),
        { evidence: describeChain(redirected.chain), suggestion: `Declare the redirect target directly: ${redirected.target}.` },
      ))
    } else if (redirected.outcome === 'loop') {
      findings.push(makeFinding('canonical-redirect-loop', 'error', `The canonical on ${route.path} enters a redirect loop.`, at(route.html, pointer), { evidence: describeChain(redirected.chain) }))
    } else if (redirected.outcome === 'too-deep') {
      findings.push(makeFinding(
        'canonical-redirect-chain-too-long',
        'error',
        `The canonical on ${route.path} starts a redirect chain longer than the configured maxRedirectDepth of ${limits.maxRedirectDepth}, so its final target is unknown.`,
        at(route.html, pointer),
        { evidence: describeChain(redirected.chain), suggestion: 'Shorten the chain, or raise limits.maxRedirectDepth deliberately.' },
      ))
      incomplete = true
    }

    let expected = routeIdentity
    if (route.canonical !== null) {
      try {
        expected = buildIdentity(route.canonical, { base: origin, policy })
      } catch (error) {
        findings.push(makeFinding('route-canonical-invalid', 'error', `The expected canonical declared for ${route.path} ${error.message}.`, at(routesPath, `/routes/${route.index}/canonical`), { evidence: route.canonical }))
        expected = null
      }
    }
    if (expected !== null && declared.identity !== expected.identity) {
      findings.push(makeFinding(
        'canonical-target-unexpected',
        'error',
        `${route.path} declares ${declared.identity} as canonical, but the route manifest expects ${expected.identity}.`,
        at(route.html, pointer),
        { evidence: `declared ${declared.identity}; expected ${expected.identity}` },
      ))
    }
    if (redirected.outcome === 'none' && declared.origin === origin && !routeByIdentity.has(declared.identity)) {
      findings.push(makeFinding(
        'canonical-target-unknown-route',
        'error',
        `The canonical on ${route.path} names ${declared.identity}, which the route manifest does not declare and the redirect map does not explain.`,
        at(route.html, pointer),
        { suggestion: 'Add the target to the route manifest, or point the canonical at a route that exists.' },
      ))
    }
  }

  // Sitemaps: what the export tells a consumer to index.
  const sitemapIdentities = new Set()
  let sitemapUrls = 0
  let sitemapsUsable = 0
  for (const sitemap of sitemaps) {
    if (sitemap.status === 'unreadable') {
      findings.push(makeFinding('sitemap-unreadable', 'error', `The sitemap export could not be read (${sitemap.reason}).`, at(sitemap.file, '/urlset'), { suggestion: 'Export the sitemap before the check, or correct the configured path.' }))
      incomplete = true
      continue
    }
    if (sitemap.status === 'too-large') {
      findings.push(makeFinding('sitemap-too-large', 'error', `The sitemap export is ${sitemap.reason}, above the configured maxSitemapBytes limit of ${limits.maxSitemapBytes}. It was not scanned.`, at(sitemap.file, '/urlset'), { suggestion: 'Raise limits.maxSitemapBytes deliberately, or split the export.' }))
      incomplete = true
      continue
    }

    const scan = scanSitemap(sitemap.source, { limits: { maxUrls: limits.maxSitemapUrls } })
    for (const limitName of scan.limitsExceeded) {
      findings.push(makeFinding(
        'sitemap-scan-limit-exceeded',
        'error',
        `Scanning this sitemap reached the ${limitName} limit, so its URLs were not fully read.`,
        at(sitemap.file, '/urlset'),
        { suggestion: 'Raise the matching limit deliberately, or split the export.' },
      ))
      incomplete = true
    }
    if (scan.kind === 'sitemapindex') {
      findings.push(makeFinding(
        'sitemap-index-unsupported',
        'warning',
        'This export is a sitemap index. This tool never fetches, so the sitemaps it references were not read.',
        at(sitemap.file, '/sitemapindex'),
        { suggestion: 'List the individual sitemap exports in config.sitemaps instead.' },
      ))
      incomplete = true
      continue
    }
    if (scan.kind !== 'urlset') {
      findings.push(makeFinding('sitemap-root-unexpected', 'warning', `The root element of this export is <${scan.kind}>, not <urlset>; no URLs were read from it.`, at(sitemap.file, `/${scan.kind}`)))
      incomplete = true
      continue
    }
    sitemapsUsable += 1

    for (const location of scan.locations) {
      sitemapUrls += 1
      const pointer = `/urlset/url/${location.index}/loc`
      let identity
      try {
        identity = buildIdentity(location.value, { base: origin, policy })
      } catch (error) {
        findings.push(makeFinding('sitemap-loc-invalid', 'error', `A sitemap <loc> ${error.message}.`, at(sitemap.file, pointer), { evidence: location.value }))
        continue
      }
      if (sitemapIdentities.has(identity.identity)) {
        findings.push(makeFinding('sitemap-duplicate-loc', 'warning', `${identity.identity} is listed more than once across the supplied sitemaps.`, at(sitemap.file, pointer), { evidence: location.value }))
      }
      sitemapIdentities.add(identity.identity)

      if (identity.origin !== origin) {
        findings.push(makeFinding(
          'sitemap-loc-cross-host',
          'error',
          `A sitemap <loc> names ${identity.origin}, which is not the configured origin ${origin}.`,
          at(sitemap.file, pointer),
          { evidence: identity.identity },
        ))
        continue
      }

      const redirected = resolveRedirect(identity.identity, redirectIndex, limits.maxRedirectDepth)
      if (redirected.outcome === 'redirected') {
        findings.push(makeFinding(
          'sitemap-loc-redirected',
          'error',
          `The sitemap lists ${identity.identity}, which the supplied redirect map sends to ${redirected.target}.`,
          at(sitemap.file, pointer),
          { evidence: describeChain(redirected.chain), suggestion: `List ${redirected.target} instead.` },
        ))
        continue
      }
      if (redirected.outcome === 'loop') {
        findings.push(makeFinding('sitemap-loc-redirect-loop', 'error', `The sitemap lists ${identity.identity}, which enters a redirect loop.`, at(sitemap.file, pointer), { evidence: describeChain(redirected.chain) }))
        continue
      }
      if (redirected.outcome === 'too-deep') {
        findings.push(makeFinding(
          'sitemap-loc-redirect-chain-too-long',
          'error',
          `The sitemap lists ${identity.identity}, which starts a redirect chain longer than the configured maxRedirectDepth of ${limits.maxRedirectDepth}.`,
          at(sitemap.file, pointer),
          { evidence: describeChain(redirected.chain) },
        ))
        incomplete = true
        continue
      }

      if (!routeByIdentity.has(identity.identity)) {
        findings.push(makeFinding('sitemap-loc-unknown-route', 'warning', `The sitemap lists ${identity.identity}, which the route manifest does not declare.`, at(sitemap.file, pointer), { evidence: location.value }))
        continue
      }
      const canonical = canonicalByRoute.get(identity.identity)
      if (canonical !== undefined && canonical !== null && canonical !== identity.identity) {
        findings.push(makeFinding(
          'sitemap-loc-not-canonical',
          'error',
          `The sitemap lists ${identity.identity}, but that page declares ${canonical} as its canonical.`,
          at(sitemap.file, pointer),
          { suggestion: `List ${canonical} instead, or correct the page's canonical.` },
        ))
      }
    }
  }

  if (sitemapsUsable > 0) {
    for (const { route, identity } of identified) {
      if (!route.indexable) continue
      if (canonicalByRoute.get(identity.identity) !== identity.identity) continue
      if (sitemapIdentities.has(identity.identity)) continue
      findings.push(makeFinding(
        'sitemap-missing-route',
        'warning',
        `${identity.identity} is self-canonical and indexable but no supplied sitemap lists it.`,
        at(routesPath, `/routes/${route.index}/path`),
        { suggestion: 'Add it to the sitemap export, or mark the route indexable: false.' },
      ))
    }
  }

  findings.sort((left, right) => (
    byCodeUnit(left.location.file ?? '', right.location.file ?? '')
    || byCodeUnit(left.location.pointer ?? '', right.location.pointer ?? '')
    || byCodeUnit(left.ruleId, right.ruleId)
    || byCodeUnit(left.message, right.message)
  ))

  const errors = findings.filter((item) => item.severity === 'error').length
  const warnings = findings.filter((item) => item.severity === 'warning').length

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: TOOL_ID,
    status: incomplete ? 'incomplete' : errors > 0 ? 'fail' : 'pass',
    summary: {
      checked: identified.length,
      errors,
      warnings,
      info: findings.length - errors - warnings,
      routes: routes.length,
      sitemapUrls,
      redirects: redirectIndex.size,
      trailingSlash: policy,
      origin,
      redirectMap: redirectsPath,
    },
    findings,
  }
}

export async function checkProject(options = {}) {
  return auditProject(await loadProject(options))
}

export function exitCodeFor(report) {
  if (report.status === 'pass') return 0
  if (report.status === 'fail') return 1
  return 2
}

/** A human summary. It goes to stderr, because stdout carries only the report. */
export function formatSummary(report) {
  const lines = report.findings.map((item) => {
    const where = [item.location.file, item.location.pointer].filter(Boolean).join(' ')
    return `${item.severity.toUpperCase().padEnd(7)} ${item.ruleId.padEnd(36)} ${where}`
  })
  lines.push('')
  lines.push(
    `${report.summary.checked} route(s) checked against ${report.summary.origin} `
    + `with trailing-slash policy "${report.summary.trailingSlash}": `
    + `${report.summary.errors} error, ${report.summary.warnings} warning, ${report.summary.info} info.`,
  )
  lines.push(`${report.summary.sitemapUrls} sitemap URL(s) and ${report.summary.redirects} redirect(s) resolved. Status ${report.status}.`)
  return `${lines.join('\n')}\n`
}
