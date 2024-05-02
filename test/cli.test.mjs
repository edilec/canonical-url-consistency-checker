import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import test from 'node:test'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const cli = join(root, 'bin', 'canonical-url-consistency-checker.mjs')
const example = (name) => join(root, 'examples', name, 'canonical.config.json')
const fixture = (...parts) => join(here, 'fixtures', ...parts)

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: root })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

test('--help explains the tool and keeps stdout clear for the report', () => {
  const result = run(['--help'])
  assert.equal(result.code, 0)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, /--trailing-slash POLICY/)
  assert.match(result.stderr, /never fetches anything/)
})

test('a passing project exits 0 and writes only JSON to stdout', () => {
  const result = run(['--config', example('clean')])
  assert.equal(result.code, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'pass')
  assert.equal(report.tool, 'canonical-url-consistency-checker')
  // The human summary is a diagnostic and belongs on stderr.
  assert.match(result.stderr, /Status pass/)
})

test('ACCEPTANCE: the CLI locates the redirect target mismatch and exits 1', () => {
  const result = run(['--config', example('broken')])
  assert.equal(result.code, 1)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'fail')
  const finding = report.findings.find((item) => item.ruleId === 'canonical-redirected')
  assert.equal(finding.location.file, 'build/plans.html')
  assert.match(finding.message, /sends to https:\/\/example\.com\/plans/)
  assert.match(result.stderr, /canonical-redirected/)
})

test('--json keeps stderr empty so stdout can be piped on its own', () => {
  const result = run(['--config', example('clean'), '--json'])
  assert.equal(result.code, 0)
  assert.equal(result.stderr, '')
  assert.equal(JSON.parse(result.stdout).status, 'pass')
})

test('ACCEPTANCE: two identical runs write byte-identical stdout', () => {
  for (const name of ['clean', 'broken']) {
    const first = run(['--config', example(name), '--json'])
    const second = run(['--config', example(name), '--json'])
    assert.equal(first.stdout, second.stdout, `${name} must be byte-identical across runs`)
    assert.equal(first.code, second.code)
  }
})

test('ACCEPTANCE: --trailing-slash overrides the policy and stays stable', () => {
  const first = run(['--config', example('clean'), '--trailing-slash', 'always', '--json'])
  const second = run(['--config', example('clean'), '--trailing-slash', 'always', '--json'])
  assert.equal(first.stdout, second.stdout)
  const report = JSON.parse(first.stdout)
  assert.equal(report.summary.trailingSlash, 'always')
  assert.notEqual(first.stdout, run(['--config', example('clean'), '--json']).stdout)
})

test('unreadable evidence exits 2 and is never reported as a pass', () => {
  const result = run(['--config', fixture('missing', 'canonical.config.json'), '--json'])
  assert.equal(result.code, 2)
  const report = JSON.parse(result.stdout)
  assert.equal(report.status, 'incomplete')
  assert.ok(report.findings.some((item) => item.ruleId === 'html-unreadable'))
})

test('invalid usage and invalid configuration exit 2 with stdout untouched', () => {
  for (const args of [
    [],
    ['--config'],
    ['--config', example('clean'), '--nope'],
    ['--config', example('clean'), '--trailing-slash', 'sometimes'],
    ['--config', fixture('no-policy.config.json')],
    ['--config', fixture('does-not-exist.json')],
  ]) {
    const result = run(args)
    assert.equal(result.code, 2, `expected exit 2 for ${JSON.stringify(args)}`)
    assert.equal(result.stdout, '', `stdout must stay clear for ${JSON.stringify(args)}`)
    assert.notEqual(result.stderr, '')
  }
})

test('--root chooses the tree every declared path resolves against', () => {
  // Naming the config's own directory is what the default already does.
  const explicit = run(['--config', example('clean'), '--root', join(root, 'examples', 'clean'), '--json'])
  assert.equal(explicit.stdout, run(['--config', example('clean'), '--json']).stdout)

  // Naming a different root really moves resolution: the manifest is no longer
  // where the config says it is, and that is a configuration error, not a pass.
  const moved = run(['--config', example('clean'), '--root', join(root, 'examples'), '--json'])
  assert.equal(moved.code, 2)
  assert.equal(moved.stdout, '')
  assert.match(moved.stderr, /route manifest/)
})
