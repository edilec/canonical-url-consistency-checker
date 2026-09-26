# Rule catalog, limits and determinism

Rule ids are stable across releases. Renaming one is a breaking change and is
recorded in the changelog.

## Page identity

Every rule below reduces to one question: do two declarations name the same
page? That is only answerable once a written URL has been reduced to a single
documented form, called its **identity** here.

An identity is built in this order:

1. The URL is resolved against a base — the `<base href>` of the document when
   one is present, otherwise `site.origin`. A URL that does not resolve, or that
   uses a scheme other than `http`/`https`, produces a finding instead of a guess.
2. Each path segment is percent-decoded, normalised to Unicode **NFC**, then
   re-encoded with one fixed rule (RFC 3986 `pchar` kept literal, everything else
   as uppercase `%XX` of its UTF-8 bytes). So `/café`, `/caf%C3%A9`, `/caf%c3%a9`
   and the decomposed `/cafe` + U+0301 all resolve to `/caf%C3%A9`, while `%2F`
   stays encoded and therefore stays distinct from a real separator.
3. The configured trailing-slash policy is applied to the path.
4. The identity is `origin + path + query`. The fragment is dropped from the
   identity, because a fragment never names a separate page — a canonical that
   carries one is reported separately.

Query strings are compared as the URL parser wrote them. They are not reordered,
because parameter order can be significant and reordering would change meaning
rather than normalise it. Repeated separators (`/a//b`) are likewise preserved.

## Trailing-slash policy

`trailingSlash` is **required** and has no default. Guessing it from the majority
spelling in a build would let the same bytes pass on one export and fail on
another.

| Policy | Effect |
| --- | --- |
| `always` | Every path gains a trailing slash, except `/` and a final segment containing a `.` (such a path names a file, and `/logo.png/` is not that file). |
| `never` | Every trailing slash is removed, except on `/`. |
| `as-declared` | Paths are never rewritten, so `/docs` and `/docs/` are two different pages. |

Under `always` and `never` a policy-collapsing redirect (`/pricing/` to
`/pricing`) becomes a no-op and is reported as `redirect-noop-under-policy`
rather than silently ignored. Under `as-declared` the same entry is a real
redirect again. This is the intended, documented difference between the policies.

## Findings

`location.file` is always relative to the input root, never an absolute host
path. `location.pointer` follows one of two documented conventions:

- for a finding about a **built document**, it is the resolved page identity of
  the route that document serves;
- for a finding about a **manifest, redirect map or sitemap**, it is a field path
  into that document, such as `/routes/5/path`, `/redirects/0/to` or
  `/urlset/url/2/loc`.

### Route manifest

| Rule id | Severity | Meaning |
| --- | --- | --- |
| `route-path-invalid` | error | A declared route path could not be resolved into an identity. |
| `route-canonical-invalid` | error | A route's expected `canonical` could not be resolved. |
| `route-identity-collision` | error | Two or more routes resolve to the same identity under the configured policy. |
| `route-limit-exceeded` | error | The manifest declares more routes than `limits.maxRoutes`. Nothing was audited. |

### Canonical declarations in built HTML

| Rule id | Severity | Meaning |
| --- | --- | --- |
| `canonical-missing` | error | The document declares no `<link rel="canonical">`. |
| `canonical-href-empty` | error | A canonical link carries no `href`. |
| `canonical-unparsable` | error | The `href` is not a URL that resolves, or uses an unsupported scheme. |
| `canonical-encoding-invalid` | error | The `href` contains a malformed percent-escape, so it cannot be compared. |
| `canonical-multiple-conflicting` | error | One document declares canonicals naming more than one page. |
| `canonical-duplicate-declaration` | warning | One document repeats the same canonical. |
| `canonical-cross-host` | error | The canonical names a host that is neither `site.origin` nor a declared alternate. |
| `canonical-alternate-host` | warning | The canonical names a declared alternate origin rather than the primary one. |
| `canonical-not-absolute` | warning | The canonical is written relative or protocol-relative. |
| `canonical-outside-head` | warning | The canonical is declared outside `<head>`. |
| `canonical-has-fragment` | warning | The canonical carries a fragment. |
| `canonical-trailing-slash-policy` | warning | The canonical as written disagrees with the configured policy, though the identity still resolves. |
| `canonical-redirected` | error | The canonical names a URL the supplied redirect map sends elsewhere. |
| `canonical-redirect-loop` | error | Following the canonical through the redirect map returns to a URL already visited. |
| `canonical-redirect-chain-too-long` | error | The chain is longer than `limits.maxRedirectDepth`, so the final target is unknown. |
| `canonical-target-unexpected` | error | The canonical names a page other than the one the route manifest expects. |
| `canonical-target-unknown-route` | error | The canonical names a same-origin URL that is neither a declared route nor a redirect source. |
| `base-href-invalid` | warning | The document's `<base href>` is not usable; resolution fell back to `site.origin`. |
| `html-unreadable` | error | The built document could not be read. |
| `html-too-large` | error | The document is above `limits.maxHtmlBytes` and was not scanned. |
| `html-scan-limit-exceeded` | error | The scanner reached a declared limit, so the document was not fully read. |

### Redirect map

| Rule id | Severity | Meaning |
| --- | --- | --- |
| `redirect-entry-invalid` | error | A redirect's `from` or `to` could not be resolved into an identity. |
| `redirect-source-duplicated` | warning | One source appears more than once; only the first is resolved. |
| `redirect-noop-under-policy` | info | Both sides resolve to the same identity once the trailing-slash policy is applied. |
| `redirect-limit-exceeded` | error | The map declares more entries than `limits.maxRedirects`. No redirect was resolved. |

### Sitemap exports

| Rule id | Severity | Meaning |
| --- | --- | --- |
| `sitemap-loc-invalid` | error | A `<loc>` could not be resolved into an identity. |
| `sitemap-loc-cross-host` | error | A `<loc>` names a host other than `site.origin`. |
| `sitemap-loc-redirected` | error | A listed URL is a redirect source. |
| `sitemap-loc-redirect-loop` | error | A listed URL enters a redirect loop. |
| `sitemap-loc-redirect-chain-too-long` | error | A listed URL starts a chain longer than `limits.maxRedirectDepth`. |
| `sitemap-loc-not-canonical` | error | A listed URL belongs to a page that declares a different canonical. |
| `sitemap-loc-unknown-route` | warning | A listed URL is not a declared route. |
| `sitemap-duplicate-loc` | warning | The same identity is listed more than once across the supplied sitemaps. |
| `sitemap-missing-route` | warning | A self-canonical, indexable route appears in no supplied sitemap. |
| `sitemap-index-unsupported` | warning | The export is a `<sitemapindex>`. This tool never fetches, so it was not expanded. |
| `sitemap-root-unexpected` | warning | The root element is neither `<urlset>` nor `<sitemapindex>`. |
| `sitemap-unreadable` | error | The export could not be read. |
| `sitemap-too-large` | error | The export is above `limits.maxSitemapBytes` and was not scanned. |
| `sitemap-scan-limit-exceeded` | error | The scanner reached a declared limit, so the export was not fully read. |

## Limits

Every limit is explicit and configurable under `limits` in the config. Reaching
one produces a finding that names the limit and sets `status` to `incomplete`.
No input is ever truncated silently, and an incomplete result is never a pass.

That holds regardless of severity. A finding can be a `warning` and still make
the report `incomplete` and the exit code `2`, because severity describes how
bad a *known* fact is while `incomplete` describes evidence that was never read.
A `<sitemapindex>` that the tool refuses to expand and an export whose root
element it does not recognise are both warnings, and both exit `2`: the alternative
would be reporting a pass over a file nothing ever looked inside. Every audit
path that declares evidence unread is pinned to that outcome by a test in
`test/incomplete.test.mjs`, one case per path.

| Limit | Default | Guards |
| --- | ---: | --- |
| `maxRoutes` | 20000 | Route manifest entries. |
| `maxRedirects` | 20000 | Redirect map entries. |
| `maxRedirectDepth` | 5 | Hops followed from one URL before the target is declared unknown. |
| `maxHtmlBytes` | 2000000 | Bytes read from one built document. |
| `maxSitemapBytes` | 33554432 | Bytes read from one sitemap export. |
| `maxSitemapUrls` | 50000 | `<loc>` values read from one export. |
| `maxCanonicalLinks` | 50 | Canonical links read from one document. |
| `maxTags` | 200000 | Tags walked in one document. |

The sitemap scanner additionally enforces a 16-element nesting depth and a
4096-character bound on one `<loc>` value.

## Input-root confinement

Input paths are a boundary, not a suggestion: every path in the configuration
must be relative and must resolve inside the input root. A manifest pointing at
`../../secrets.json` is a configuration error, not a route.

Spelling is only half of that boundary. A symbolic link planted inside the root
points wherever it likes, so each path is confined twice: once as written, and
again after every link on the way to it has been followed, against the **real**
path of the root itself. The root is resolved for real too, because a root can
sit behind a link as `/var` does on macOS.

Confinement runs before anything is opened, so a refused path is never read and
nothing from outside the root can reach the report. A refusal is a configuration
error — exit `2`, no report on stdout — and names its rule:

| Rule | Meaning |
| --- | --- |
| `input-not-relative` | The path is absent, empty or absolute. |
| `input-outside-root` | The path as written resolves outside the input root. |
| `input-escapes-root` | The path stays inside the root as written but leaves it through a symbolic link. |
| `input-unresolvable` | The path could not be resolved at all — a link cycle, or a directory on the way down that cannot be read. |

A path need not exist to be confined: the deepest ancestor that does exist is
resolved for real and the missing segments below it are appended, so a build
output that was never produced still reaches the audit as `html-unreadable`
rather than being refused here. A link whose target stays inside the root is
followed normally — the boundary is where a path lands, not whether a link was
involved.

## What a refusal may repeat back

A refusal names the file and what was wrong with it. It does not quote the file's content.

That is not free. V8 reports an invalid document two ways, and one of them embeds the input:
`Unexpected token 'A', "AKIAIOSFODNN7EXAMPLE" is not valid JSON` reproduces a short file in full,
and a longer one through a window around the offence. The config, the route manifest and the
redirect map all reach `JSON.parse`, and the file that fails to parse is the file whose content is
least trustworthy. Bounding the message with `excerpt` does not help, because it trims from the end
while the quoted span sits at the front.

Only the useful half is kept: the position, line and column where V8 reports them, and the
offending token where it does not. The quoted span is removed before the `ConfigError` is built, so
it reaches neither stderr nor a CI log.

## Determinism

Running the tool twice over identical bytes produces byte-identical stdout.

- Findings sort by `location.file`, then `location.pointer`, then `ruleId`, then
  `message`, all compared by **UTF-16 code unit**. `localeCompare` is never used:
  its ordering depends on the ICU data a given Node build carries, which would
  make a report machine-dependent.
- No wall clock, no random source, no hash-map iteration order and no filesystem
  enumeration order reaches the output. Documents are read in the order the route
  manifest declares them, and sitemaps in the order the config lists them.
- Nothing is fetched. The tool has no network access path at all, so no report
  can depend on what a remote host answered at the moment it ran.
