import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { ConfigError, byCodeUnit, checkProject, validateConfig } from '../src/index.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const example = (name) => join(here, '..', 'examples', name, 'canonical.config.json')
const fixture = (...parts) => join(here, 'fixtures', ...parts)

const rule = (report, ruleId) => report.findings.filter((item) => item.ruleId === ruleId)
const ruleIds = (report) => [...new Set(report.findings.map((item) => item.ruleId))].sort()

test('the clean example passes with no error and no warning', async () => {
  const report = await checkProject({ config: example('clean') })
  assert.equal(report.status, 'pass')
  assert.equal(report.schemaVersion, '1')
  assert.equal(report.tool, 'canonical-url-consistency-checker')
  assert.equal(report.summary.errors, 0)
  assert.equal(report.summary.warnings, 0)
  assert.equal(report.summary.checked, 4)
  assert.equal(report.summary.sitemapUrls, 3)
  // The one finding is informational: a trailing-slash redirect that the
  // configured "never" policy has already made a no-op.
  assert.deepEqual(ruleIds(report), ['redirect-noop-under-policy'])
})

test('ACCEPTANCE: a canonical pointing at a redirect source is located with its target', async () => {
  const report = await checkProject({ config: example('broken') })
  assert.equal(report.status, 'fail')

  const [redirected] = rule(report, 'canonical-redirected')
  assert.ok(redirected, 'the redirect target mismatch must be reported')
  assert.equal(redirected.severity, 'error')
  assert.equal(redirected.location.file, 'build/plans.html')
  assert.equal(redirected.location.pointer, 'https://example.com/plans')
  assert.match(redirected.message, /points at https:\/\/example\.com\/old-plans/)
  assert.match(redirected.message, /sends to https:\/\/example\.com\/plans/)
  assert.equal(redirected.evidence, 'https://example.com/old-plans -> https://example.com/plans')
  assert.equal(redirected.suggestion, 'Declare the redirect target directly: https://example.com/plans.')

  // The same mismatch is also located in the sitemap export.
  const [listed] = rule(report, 'sitemap-loc-redirected')
  assert.equal(listed.location.file, 'sitemap.xml')
  assert.equal(listed.location.pointer, '/urlset/url/2/loc')
})

test('the broken example reports every page-identity defect it contains', async () => {
  const report = await checkProject({ config: example('broken') })
  assert.deepEqual(ruleIds(report), [
    'canonical-cross-host',
    'canonical-missing',
    'canonical-multiple-conflicting',
    'canonical-not-absolute',
    'canonical-outside-head',
    'canonical-redirected',
    'canonical-target-unexpected',
    'canonical-target-unknown-route',
    'canonical-trailing-slash-policy',
    'route-identity-collision',
    'sitemap-loc-not-canonical',
    'sitemap-loc-redirected',
    'sitemap-missing-route',
  ])
  assert.equal(rule(report, 'canonical-cross-host')[0].evidence, 'https://mirror.example.org/mirror')
  assert.equal(rule(report, 'route-identity-collision')[0].evidence, '/docs, /docs/')
})

test('ACCEPTANCE: an encoded path compares stably against its literal spelling', async () => {
  // The route declares /café, the HTML writes it literally, the sitemap writes
  // it percent-encoded. All three must resolve to one page.
  const report = await checkProject({ config: example('clean') })
  assert.equal(rule(report, 'canonical-target-unexpected').length, 0)
  assert.equal(rule(report, 'sitemap-loc-unknown-route').length, 0)

  const broken = await checkProject({ config: example('broken') })
  const [mismatch] = rule(broken, 'canonical-target-unexpected').filter(
    (item) => item.location.file === 'build/cafe.html',
  )
  assert.equal(mismatch.location.pointer, 'https://example.com/caf%C3%A9')
  assert.match(mismatch.message, /declares https:\/\/example\.com\/cafe as canonical/)
})

test('ACCEPTANCE: each trailing-slash policy produces a stable, self-consistent result', async () => {
  const results = {}
  for (const trailingSlash of ['always', 'never', 'as-declared']) {
    const first = await checkProject({ config: example('clean'), trailingSlash })
    const second = await checkProject({ config: example('clean'), trailingSlash })
    assert.equal(JSON.stringify(first), JSON.stringify(second), `${trailingSlash} must be repeatable`)
    assert.equal(first.summary.trailingSlash, trailingSlash)
    results[trailingSlash] = first
  }

  // "never" is the policy the clean example is written for: nothing to report.
  assert.equal(results.never.status, 'pass')
  assert.equal(results.never.summary.errors, 0)

  // Under "always" the same bytes describe a different, still fully determined
  // site: every declared canonical is now a slash short of the policy form.
  assert.equal(results.always.summary.trailingSlash, 'always')
  assert.equal(
    rule(results.always, 'canonical-trailing-slash-policy').length,
    3,
    'the three non-root routes each declare the non-policy spelling',
  )

  // Under "as-declared" the tool never rewrites a path, so the /pricing/
  // redirect is a real redirect again rather than a no-op.
  assert.equal(rule(results['as-declared'], 'redirect-noop-under-policy').length, 0)
  assert.equal(rule(results['as-declared'], 'canonical-trailing-slash-policy').length, 0)
})

test('the same input twice produces byte-identical reports', async () => {
  for (const name of ['clean', 'broken']) {
    const first = JSON.stringify(await checkProject({ config: example(name) }), null, 2)
    const second = JSON.stringify(await checkProject({ config: example(name) }), null, 2)
    assert.equal(first, second)
  }
})

test('findings are ordered by file, then pointer, then rule id, then message', async () => {
  const report = await checkProject({ config: example('broken') })
  const key = (item) => [item.location.file ?? '', item.location.pointer ?? '', item.ruleId, item.message]
  for (let index = 1; index < report.findings.length; index += 1) {
    const previous = key(report.findings[index - 1])
    const current = key(report.findings[index])
    let decided = false
    for (let part = 0; part < previous.length && !decided; part += 1) {
      if (previous[part] === current[part]) continue
      assert.ok(byCodeUnit(previous[part], current[part]) < 0, `findings out of order at index ${index}`)
      decided = true
    }
  }
})

test('a config that never states a trailing-slash policy is refused', async () => {
  await assert.rejects(
    checkProject({ config: fixture('no-policy.config.json') }),
    (error) => error instanceof ConfigError && /trailingSlash must be one of/.test(error.message),
  )
})

test('invalid configuration is refused rather than defaulted', () => {
  const base = { schemaVersion: '1', site: { origin: 'https://example.com' }, trailingSlash: 'never', routes: 'routes.json' }
  assert.throws(() => validateConfig({ ...base, schemaVersion: '2' }), ConfigError)
  assert.throws(() => validateConfig({ ...base, site: { origin: 'ftp://example.com' } }), ConfigError)
  assert.throws(() => validateConfig({ ...base, site: { origin: 'https://example.com/app' } }), ConfigError)
  assert.throws(() => validateConfig({ ...base, site: { origin: 'https://example.com', alternateOrigins: 'no' } }), ConfigError)
  assert.throws(() => validateConfig({ ...base, routes: '' }), ConfigError)
  assert.throws(() => validateConfig({ ...base, sitemaps: [7] }), ConfigError)
  assert.throws(() => validateConfig({ ...base, redirects: 3 }), ConfigError)
  assert.throws(() => validateConfig({ ...base, limits: { maxUnknown: 1 } }), ConfigError)
  assert.throws(() => validateConfig({ ...base, limits: { maxHtmlBytes: 0 } }), ConfigError)
  assert.throws(() => validateConfig('nope'), ConfigError)
  // A CLI override is validated on the same terms as the file.
  assert.throws(() => validateConfig(base, { trailingSlash: 'sometimes' }), ConfigError)
})

test('a config cannot read a file outside the declared input root', async () => {
  await assert.rejects(
    checkProject({ config: fixture('escape', 'canonical.config.json') }),
    (error) => error instanceof ConfigError && /outside the input root/.test(error.message),
  )
})

test('a build output that was never produced is incomplete, never a pass', async () => {
  const report = await checkProject({ config: fixture('missing', 'canonical.config.json') })
  assert.equal(report.status, 'incomplete')
  const [finding] = rule(report, 'html-unreadable')
  assert.equal(finding.severity, 'error')
  assert.equal(finding.location.file, 'build/never-built.html')
  assert.match(finding.message, /ENOENT/)
})

test('a document above the byte limit is reported, never silently skipped', async () => {
  const report = await checkProject({ config: fixture('limits', 'canonical.config.json') })
  assert.equal(report.status, 'incomplete')
  const [finding] = rule(report, 'html-too-large')
  assert.match(finding.message, /above the configured maxHtmlBytes limit of 40/)
  assert.equal(report.findings.some((item) => item.ruleId === 'canonical-missing'), false)
})

test('a canonical with a malformed percent-escape is an error, not a comparison', async () => {
  const report = await checkProject({ config: fixture('encoding', 'canonical.config.json') })
  assert.equal(report.status, 'fail')
  const [finding] = rule(report, 'canonical-encoding-invalid')
  assert.match(finding.message, /malformed percent-escape/)
  assert.equal(finding.location.file, 'build/menu.html')
})

test('a sitemap index is reported as unread evidence rather than expanded', async () => {
  const report = await checkProject({ config: fixture('sitemap-index', 'canonical.config.json') })
  assert.equal(report.status, 'incomplete')
  const [finding] = rule(report, 'sitemap-index-unsupported')
  assert.equal(finding.severity, 'warning')
  assert.match(finding.message, /never fetches/)
})

test('a missing config path is refused before anything is read', async () => {
  await assert.rejects(checkProject({}), ConfigError)
  await assert.rejects(checkProject({ config: fixture('does-not-exist.json') }), ConfigError)
})
