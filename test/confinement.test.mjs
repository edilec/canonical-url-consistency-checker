/**
 * The input root is a boundary, and a boundary that only inspects spelling is
 * not one. These tests plant symbolic links inside a declared root and require
 * that nothing outside it is opened, that the refusal names the rule, and that
 * no byte of an out-of-root file reaches either stream.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

import { ConfigError, checkProject } from '../src/index.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const cli = join(here, '..', 'bin', 'canonical-url-consistency-checker.mjs')

const SECRET = 'SECRET-TOKEN-abc123'

const CLEAN_PAGE = '<!doctype html><html><head><link rel="canonical" href="https://example.com/"></head><body></body></html>\n'
const CLEAN_ROUTES = JSON.stringify({ schemaVersion: '1', routes: [{ path: '/', html: 'index.html' }] })

/**
 * Build a throwaway tree shaped like a checkout: `root/` is what the config
 * declares, `outside/` is the part of the disk it has no right to read.
 *
 * The temporary directory itself usually sits behind a symbolic link (`/var` on
 * macOS), which is exactly why the root is confined against its own real path.
 */
async function tree() {
  const base = await mkdtemp(join(tmpdir(), 'canonical-confinement-'))
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  await mkdir(root, { recursive: true })
  await mkdir(join(outside, 'private'), { recursive: true })
  await writeFile(join(outside, 'secret.txt'), `${SECRET}\n`)
  await writeFile(
    join(outside, 'private', 'secret.html'),
    `<!doctype html><html><head><link rel="canonical" href="https://example.com/${SECRET}"></head><body></body></html>\n`,
  )
  await writeFile(
    join(outside, 'private', 'secret.xml'),
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset><url><loc>https://example.com/${SECRET}</loc></url></urlset>\n`,
  )
  await writeFile(
    join(outside, 'private', 'secret.json'),
    JSON.stringify({ schemaVersion: '1', routes: [{ path: `/${SECRET}`, html: 'index.html' }] }),
  )
  return { base, root, outside, cleanup: () => rm(base, { recursive: true, force: true }) }
}

async function config(root, document) {
  const file = join(root, 'canonical.config.json')
  await writeFile(file, JSON.stringify({
    schemaVersion: '1',
    site: { origin: 'https://example.com' },
    trailingSlash: 'never',
    ...document,
  }))
  return file
}

function runCli(configFile) {
  const result = spawnSync(process.execPath, [cli, '--config', configFile], { encoding: 'utf8' })
  return { code: result.status, stdout: result.stdout, stderr: result.stderr }
}

/** Refused, named, and silent about what it refused to read. */
async function assertRefused(configFile, label) {
  await assert.rejects(
    checkProject({ config: configFile }),
    (error) => {
      assert.ok(error instanceof ConfigError, `${label}: expected a ConfigError`)
      assert.equal(error.rule, 'input-escapes-root', `${label}: the refusal must name its rule`)
      assert.match(error.message, /leaves the input root through a symbolic link/)
      assert.equal(error.message.includes(SECRET), false, `${label}: the refusal must not echo the target`)
      return true
    },
  )

  const result = runCli(configFile)
  assert.equal(result.code, 2, `${label}: a boundary violation exits 2`)
  assert.equal(result.stdout, '', `${label}: no report is written at all`)
  assert.equal(result.stdout.includes(SECRET), false, `${label}: no out-of-root content in the report`)
  assert.equal(result.stderr.includes(SECRET), false, `${label}: no out-of-root content on stderr`)
}

test('a symlink to a file outside the root is refused, not followed', async () => {
  const { root, outside, cleanup } = await tree()
  try {
    await writeFile(join(root, 'routes.json'), CLEAN_ROUTES)
    await symlink(join(outside, 'private', 'secret.html'), join(root, 'index.html'))
    await assertRefused(await config(root, { routes: 'routes.json' }), 'routes[].html via a file link')
  } finally {
    await cleanup()
  }
})

test('a symlink to a directory outside the root is refused, not followed', async () => {
  const { root, outside, cleanup } = await tree()
  try {
    await writeFile(join(root, 'index.html'), CLEAN_PAGE)
    await writeFile(join(root, 'routes.json'), CLEAN_ROUTES)
    await symlink(join(outside, 'private'), join(root, 'linked'))
    await assertRefused(
      await config(root, { routes: 'routes.json', sitemaps: ['linked/secret.xml'] }),
      'sitemaps[] through a directory link',
    )
  } finally {
    await cleanup()
  }
})

test('every path the configuration declares is confined the same way', async () => {
  const { root, outside, cleanup } = await tree()
  try {
    await writeFile(join(root, 'index.html'), CLEAN_PAGE)
    await writeFile(join(root, 'routes.json'), CLEAN_ROUTES)
    await writeFile(
      join(outside, 'private', 'redirects.json'),
      JSON.stringify({ schemaVersion: '1', redirects: [{ from: `/${SECRET}`, to: '/' }] }),
    )
    await symlink(join(outside, 'private', 'secret.json'), join(root, 'linked-routes.json'))
    await symlink(join(outside, 'private', 'secret.xml'), join(root, 'linked-sitemap.xml'))
    await symlink(join(outside, 'private', 'redirects.json'), join(root, 'linked-redirects.json'))
    await symlink(join(outside, 'secret.txt'), join(root, 'linked-page.html'))

    await assertRefused(await config(root, { routes: 'linked-routes.json' }), 'routes')
    await assertRefused(
      await config(root, { routes: 'routes.json', sitemaps: ['linked-sitemap.xml'] }),
      'sitemaps[]',
    )
    await assertRefused(
      await config(root, { routes: 'routes.json', redirects: 'linked-redirects.json' }),
      'redirects',
    )

    await writeFile(
      join(root, 'routes.json'),
      JSON.stringify({ schemaVersion: '1', routes: [{ path: '/', html: 'linked-page.html' }] }),
    )
    await assertRefused(await config(root, { routes: 'routes.json' }), 'routes[].html')
  } finally {
    await cleanup()
  }
})

test('a symlink that stays inside the root is still followed', async () => {
  // The boundary is where the target lands, not whether a link was involved: a
  // build that publishes through links inside its own tree must still be read.
  const { root, cleanup } = await tree()
  try {
    await mkdir(join(root, 'build'), { recursive: true })
    await writeFile(join(root, 'build', 'real.html'), CLEAN_PAGE)
    await symlink(join(root, 'build', 'real.html'), join(root, 'index.html'))
    await writeFile(join(root, 'routes.json'), CLEAN_ROUTES)
    const report = await checkProject({ config: await config(root, { routes: 'routes.json' }) })
    assert.equal(report.status, 'pass')
    assert.equal(report.summary.errors, 0)
  } finally {
    await cleanup()
  }
})

test('a build output that does not exist yet is still an audit finding, not a boundary error', async () => {
  // Confining a path must not require it to exist: an unbuilt document is
  // missing evidence the report has to state, not a configuration mistake.
  const { root, cleanup } = await tree()
  try {
    await writeFile(
      join(root, 'routes.json'),
      JSON.stringify({ schemaVersion: '1', routes: [{ path: '/', html: 'build/never-built.html' }] }),
    )
    const report = await checkProject({ config: await config(root, { routes: 'routes.json' }) })
    assert.equal(report.status, 'incomplete')
    assert.equal(report.findings[0].ruleId, 'html-unreadable')
  } finally {
    await cleanup()
  }
})

test('a link cycle is refused, not walked', async () => {
  // A target that cannot be resolved cannot be shown to be inside the root, so
  // it is refused rather than opened — and refused as a named configuration
  // error, not as an unhandled system error carrying a host path.
  const { root, cleanup } = await tree()
  try {
    await symlink(join(root, 'loop-b.html'), join(root, 'loop-a.html'))
    await symlink(join(root, 'loop-a.html'), join(root, 'loop-b.html'))
    await writeFile(
      join(root, 'routes.json'),
      JSON.stringify({ schemaVersion: '1', routes: [{ path: '/', html: 'loop-a.html' }] }),
    )
    const configFile = await config(root, { routes: 'routes.json' })
    await assert.rejects(
      checkProject({ config: configFile }),
      (error) => {
        assert.ok(error instanceof ConfigError)
        assert.equal(error.rule, 'input-unresolvable')
        assert.match(error.message, /routes\[0\]\.html \("loop-a\.html"\) could not be resolved \(ELOOP\)/)
        assert.equal(error.message.includes(root), false, 'the refusal must not echo a host path')
        return true
      },
    )
    const result = runCli(configFile)
    assert.equal(result.code, 2)
    assert.equal(result.stdout, '')
  } finally {
    await cleanup()
  }
})

test('the lexical escape is refused with its own rule', async () => {
  const { root, cleanup } = await tree()
  try {
    await assertRefusedLexically(await config(root, { routes: '../outside/secret.txt' }), 'input-outside-root')
    await assertRefusedLexically(await config(root, { routes: join(root, 'routes.json') }), 'input-not-relative')
  } finally {
    await cleanup()
  }
})

async function assertRefusedLexically(configFile, rule) {
  await assert.rejects(
    checkProject({ config: configFile }),
    (error) => error instanceof ConfigError && error.rule === rule,
  )
}
