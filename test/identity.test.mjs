import assert from 'node:assert/strict'
import test from 'node:test'

import {
  IdentityError,
  applyTrailingSlash,
  buildIdentity,
  byCodeUnit,
  normalizePathname,
  resolveRedirect,
} from '../src/url-identity.mjs'
import { scanHtml } from '../src/html-scan.mjs'
import { scanSitemap } from '../src/sitemap-scan.mjs'

const BASE = 'https://example.com'
const id = (raw, policy = 'never') => buildIdentity(raw, { base: BASE, policy }).identity

test('percent-encoded and literal spellings of the same path share one identity', () => {
  const expected = 'https://example.com/caf%C3%A9'
  assert.equal(id('/café'), expected)
  assert.equal(id('/caf%C3%A9'), expected)
  assert.equal(id('/caf%c3%a9'), expected)
  assert.equal(id('https://example.com/café'), expected)
  // Decomposed "e" + combining acute normalises to the same page.
  assert.equal(id('/café'), expected)
})

test('an encoded separator stays distinct from a real one', () => {
  assert.notEqual(id('/a%2Fb'), id('/a/b'))
  assert.equal(id('/a%2fb'), 'https://example.com/a%2Fb')
})

test('a literal percent sign round-trips instead of being lost', () => {
  assert.equal(normalizePathname('/100%25-uptime'), '/100%25-uptime')
})

test('a malformed percent-escape is an explicit encoding error, not a guess', () => {
  assert.throws(() => id('/caf%zz'), (error) => error instanceof IdentityError && error.code === 'encoding')
})

test('a non-http scheme is refused rather than compared', () => {
  assert.throws(() => id('mailto:sales@example.com'), (error) => error.code === 'scheme')
  assert.throws(() => id('   '), (error) => error.code === 'empty')
})

test('trailing-slash policy is applied exactly as configured', () => {
  assert.equal(applyTrailingSlash('/docs', 'always'), '/docs/')
  assert.equal(applyTrailingSlash('/docs/', 'always'), '/docs/')
  assert.equal(applyTrailingSlash('/docs', 'never'), '/docs')
  assert.equal(applyTrailingSlash('/docs//', 'never'), '/docs')
  assert.equal(applyTrailingSlash('/docs/', 'as-declared'), '/docs/')
  assert.equal(applyTrailingSlash('/docs', 'as-declared'), '/docs')
  assert.equal(applyTrailingSlash('/', 'always'), '/')
  assert.equal(applyTrailingSlash('/', 'never'), '/')
  // A final segment naming a file is left alone under "always".
  assert.equal(applyTrailingSlash('/logo.png', 'always'), '/logo.png')
})

test('the chosen policy decides whether two spellings are one page', () => {
  assert.equal(id('/docs', 'never'), id('/docs/', 'never'))
  assert.equal(id('/docs', 'always'), id('/docs/', 'always'))
  assert.notEqual(id('/docs', 'as-declared'), id('/docs/', 'as-declared'))
})

test('an unsupported policy is a programming error, not a silent default', () => {
  assert.throws(() => buildIdentity('/x', { base: BASE, policy: 'sometimes' }), TypeError)
})

test('byCodeUnit orders by code unit, not by locale', () => {
  assert.equal(byCodeUnit('Z', 'a'), -1)
  assert.equal(byCodeUnit('a', 'a'), 0)
  assert.equal(byCodeUnit('b', 'a'), 1)
})

test('redirect resolution separates a proven loop from an unfinished chain', () => {
  const index = new Map([['a', 'b'], ['b', 'c'], ['loop1', 'loop2'], ['loop2', 'loop1']])
  assert.deepEqual(resolveRedirect('c', index, 5), { outcome: 'none', target: 'c', chain: ['c'] })
  assert.equal(resolveRedirect('a', index, 5).outcome, 'redirected')
  assert.equal(resolveRedirect('a', index, 5).target, 'c')
  assert.equal(resolveRedirect('loop1', index, 5).outcome, 'loop')
  assert.equal(resolveRedirect('a', index, 1).outcome, 'too-deep')
})

test('the HTML scanner ignores canonicals that are not markup', () => {
  const html = [
    '<!doctype html>',
    '<html><head>',
    '<!-- <link rel="canonical" href="https://wrong.example/one"> -->',
    '<script>var t = \'<link rel="canonical" href="https://wrong.example/two">\'</script>',
    '<style>/* <link rel="canonical" href="https://wrong.example/three"> */</style>',
    '<link rel="canonical" href="https://example.com/real">',
    '</head><body></body></html>',
  ].join('\n')
  const scan = scanHtml(html)
  assert.equal(scan.canonicals.length, 1)
  assert.equal(scan.canonicals[0].href, 'https://example.com/real')
  assert.equal(scan.canonicals[0].inHead, true)
})

test('the HTML scanner reads rel token lists, entities, quoting styles and <base>', () => {
  const html = [
    '<head>',
    '<base href="/docs/">',
    '<link rel=" CANONICAL alternate " href=\'../a&amp;b?x=1&#38;y=2\'/>',
    '<link rel=canonical href=https://example.com/unquoted>',
    '</head>',
    '<body><link rel="canonical" href="https://example.com/late"></body>',
  ].join('\n')
  const scan = scanHtml(html)
  assert.equal(scan.base, '/docs/')
  assert.equal(scan.canonicals.length, 3)
  assert.equal(scan.canonicals[0].href, '../a&b?x=1&y=2')
  assert.equal(scan.canonicals[1].href, 'https://example.com/unquoted')
  assert.equal(scan.canonicals[2].inHead, false)
  assert.equal(scan.canonicals[2].line, 6)
})

test('a canonical link with no href is reported as present but empty', () => {
  const scan = scanHtml('<head><link rel="canonical"></head>')
  assert.equal(scan.canonicals.length, 1)
  assert.equal(scan.canonicals[0].href, null)
})

test('the HTML scanner names the limit it reached instead of truncating silently', () => {
  const html = `<head>${'<link rel="canonical" href="https://example.com/a">'.repeat(4)}</head>`
  const scan = scanHtml(html, { limits: { maxCanonicalLinks: 2 } })
  assert.equal(scan.canonicals.length, 2)
  assert.deepEqual(scan.limitsExceeded, ['maxCanonicalLinks'])

  const many = scanHtml('<div></div>'.repeat(10), { limits: { maxTags: 3 } })
  assert.deepEqual(many.limitsExceeded, ['maxTags'])
})

test('the sitemap scanner reads namespaced, CDATA and entity-escaped locations', () => {
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9">',
    '  <!-- <url><loc>https://wrong.example/skip</loc></url> -->',
    '  <sm:url><sm:loc><![CDATA[https://example.com/a?x=1&y=2]]></sm:loc></sm:url>',
    '  <sm:url><sm:loc>https://example.com/b?x=1&amp;y=2</sm:loc></sm:url>',
    '</sm:urlset>',
  ].join('\n')
  const scan = scanSitemap(xml)
  assert.equal(scan.kind, 'urlset')
  assert.deepEqual(scan.locations.map((entry) => entry.value), [
    'https://example.com/a?x=1&y=2',
    'https://example.com/b?x=1&y=2',
  ])
})

test('the sitemap scanner reports an index as an index, and never expands it', () => {
  const xml = '<sitemapindex><sitemap><loc>https://example.com/s1.xml</loc></sitemap></sitemapindex>'
  const scan = scanSitemap(xml)
  assert.equal(scan.kind, 'sitemapindex')
  assert.equal(scan.locations.length, 0)
})

test('the sitemap scanner names the URL limit it reached', () => {
  const url = '<url><loc>https://example.com/a</loc></url>'
  const scan = scanSitemap(`<urlset>${url.repeat(5)}</urlset>`, { limits: { maxUrls: 2 } })
  assert.equal(scan.locations.length, 2)
  assert.deepEqual(scan.limitsExceeded, ['maxUrls'])
})
