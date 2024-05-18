/**
 * The headline invariant: an unknown is never a pass.
 *
 * Every path in the audit that gives up on a piece of evidence must set the
 * report to `incomplete` and exit 2. For a finding whose severity is `error`
 * the status would at least still be `fail` if that flag were lost; for a
 * finding whose severity is only `warning` the flag is the one thing standing
 * between unread evidence and a green build, so those paths are pinned here
 * with the rest rather than trusted.
 *
 * Each case below is isolated: its fixture reaches exactly one of those paths
 * and produces exactly one finding, so deleting any single `incomplete = true`
 * in the audit fails the case that covers it and no other.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { checkProject, exitCodeFor } from '../src/index.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'bin', 'canonical-url-consistency-checker.mjs')
const fixture = (name) => join(here, 'fixtures', 'incomplete', name)

/** One row per place the audit declares evidence unread. */
const CASES = [
  { config: 'route-limit.config.json', ruleId: 'route-limit-exceeded', severity: 'error' },
  { config: 'redirect-limit.config.json', ruleId: 'redirect-limit-exceeded', severity: 'error' },
  { config: 'html-unreadable.config.json', ruleId: 'html-unreadable', severity: 'error' },
  { config: 'html-too-large.config.json', ruleId: 'html-too-large', severity: 'error' },
  { config: 'html-scan-limit.config.json', ruleId: 'html-scan-limit-exceeded', severity: 'error' },
  { config: 'canonical-chain.config.json', ruleId: 'canonical-redirect-chain-too-long', severity: 'error' },
  { config: 'sitemap-unreadable.config.json', ruleId: 'sitemap-unreadable', severity: 'error' },
  { config: 'sitemap-too-large.config.json', ruleId: 'sitemap-too-large', severity: 'error' },
  { config: 'sitemap-scan-limit.config.json', ruleId: 'sitemap-scan-limit-exceeded', severity: 'error' },
  { config: 'sitemap-index.config.json', ruleId: 'sitemap-index-unsupported', severity: 'warning' },
  { config: 'sitemap-root.config.json', ruleId: 'sitemap-root-unexpected', severity: 'warning' },
  { config: 'sitemap-chain.config.json', ruleId: 'sitemap-loc-redirect-chain-too-long', severity: 'error' },
]

for (const { config, ruleId, severity } of CASES) {
  test(`${ruleId} makes the report incomplete and exit 2`, async () => {
    const report = await checkProject({ config: fixture(config) })

    assert.deepEqual(
      report.findings.map((item) => item.ruleId),
      [ruleId],
      'the fixture must reach exactly one unread-evidence path, so this case pins that one alone',
    )
    assert.equal(report.findings[0].severity, severity)
    assert.equal(report.status, 'incomplete', `${ruleId} left unread evidence and must never be a pass`)
    assert.equal(exitCodeFor(report), 2, `${ruleId} must exit 2, not 0 or 1`)
    assert.notEqual(report.status, 'pass')
  })
}

test('unread evidence with no error at all still exits 2, never 0', async () => {
  // The two warning-only paths are the whole invariant on their own: nothing but
  // the incomplete flag stops a wholly unread sitemap from reporting a pass.
  for (const config of ['sitemap-root.config.json', 'sitemap-index.config.json']) {
    const report = await checkProject({ config: fixture(config) })
    assert.equal(report.summary.errors, 0, `${config} must contain no error to make the point`)
    assert.equal(report.status, 'incomplete')

    const result = spawnSync(process.execPath, [cli, '--config', fixture(config)], { encoding: 'utf8' })
    assert.equal(result.status, 2, `${config}: a warning-only report on unread evidence must still exit 2`)
    assert.equal(JSON.parse(result.stdout).status, 'incomplete')
  }
})

test('every unread-evidence path in the audit is covered by a case above', async () => {
  // A new `incomplete = true` with no case here would be an unguarded invariant
  // again, which is precisely how the warning-only sitemap paths went untested.
  const source = await readFile(join(here, '..', 'src', 'index.mjs'), 'utf8')
  const declared = source.split('incomplete = true').length - 1
  assert.equal(
    declared,
    CASES.length,
    `src/index.mjs sets incomplete in ${declared} place(s) but CASES covers ${CASES.length}. `
    + 'Add a fixture and a row for the new path, or update this count deliberately.',
  )
})
