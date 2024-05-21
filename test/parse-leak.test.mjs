import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

/**
 * The three JSON inputs -- the config, the route manifest and the redirect map
 * -- all reach `JSON.parse`, and a file that does not parse is exactly the file
 * whose content is least trustworthy. V8 hands that content back inside the
 * error message: `Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid
 * JSON` reproduces a short file in full, and a longer one through a window
 * around the offence. Interpolating that message into the `ConfigError`
 * published it on stderr, where a CI log keeps it.
 *
 * `excerpt` does not fix it: it collapses whitespace and trims from the END,
 * while the quoted span sits at the FRONT and is far inside the 200-character
 * limit.
 *
 * The canary is AWS's own published documentation placeholder, not a
 * credential. It is checked down to eight characters, because half a leak is
 * still a leak.
 */

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const cli = join(root, 'bin', 'canonical-url-consistency-checker.mjs')
const CANARY = 'AKIAIOSFODNN7EXAMPLE'
const SHORTEST_PREFIX = 8

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', cwd: root })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'canonical-leak-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

function assertNoCanary(stream, where) {
  for (let length = CANARY.length; length >= SHORTEST_PREFIX; length -= 1) {
    const prefix = CANARY.slice(0, length)
    assert.ok(
      !stream.includes(prefix),
      `${where} carries ${length} characters of the canary: ${JSON.stringify(stream)}`,
    )
  }
}

test('a config that is nothing but a credential is not echoed back', (t) => {
  const directory = workspace(t)
  const config = join(directory, 'canonical.config.json')
  writeFileSync(config, CANARY)

  const result = run(['--config', config])
  assert.equal(result.code, 2, 'an unparseable config is a refusal')
  assertNoCanary(result.stdout, 'stdout')
  assertNoCanary(result.stderr, 'stderr')
})

test('a credential inside an unparseable route manifest is not echoed either', (t) => {
  const directory = workspace(t)
  const config = join(directory, 'canonical.config.json')
  const routes = join(directory, 'routes.json')
  writeFileSync(
    config,
    JSON.stringify({
      schemaVersion: '1',
      site: { origin: 'https://example.com' },
      trailingSlash: 'never',
      routes: 'routes.json',
    }),
  )
  // V8 quotes a WINDOW around the offence, not only the head of the file, so a
  // secret in the middle of a broken manifest leaks just as readily.
  writeFileSync(routes, `{"schemaVersion": "1", "token": ${CANARY}}`)

  const result = run(['--config', config])
  assert.equal(result.code, 2)
  assertNoCanary(result.stdout, 'stdout')
  assertNoCanary(result.stderr, 'stderr')
})

test('the refusal still says which file broke and where', (t) => {
  const directory = workspace(t)
  const config = join(directory, 'canonical.config.json')
  writeFileSync(config, '{"schemaVersion": "1" "site": {}}')

  const result = run(['--config', config])
  assert.equal(result.code, 2)
  assert.match(result.stderr, /The config is not valid JSON/)
  // A diagnostic that says nothing is a different defect: position, line and
  // column are V8's useful half and none of them is file content.
  assert.match(result.stderr, /at position 22 \(line 1 column 23\)/)
})

test('a config that merely CONTAINS "at position" does not smuggle itself through', (t) => {
  // Looking for `at position` before recognising the quoting shape would keep
  // the quoted span whenever the file supplied that phrase itself.
  const directory = workspace(t)
  const config = join(directory, 'canonical.config.json')
  writeFileSync(config, `${CANARY} at position 9 (line 1 column 10)`)

  const result = run(['--config', config])
  assertNoCanary(result.stdout, 'stdout')
  assertNoCanary(result.stderr, 'stderr')
  assert.match(result.stderr, /unexpected token 'A'/)
})
