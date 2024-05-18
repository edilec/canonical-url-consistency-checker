# canonical-url-consistency-checker

Resolve the canonical declarations a site actually ships — in its route
manifest, in its built HTML and in its sitemap exports — against one explicit
policy, and report where they disagree about which URL names a page.

- **Repository:** [edilec/canonical-url-consistency-checker](https://github.com/edilec/canonical-url-consistency-checker)
- **Area:** SEO & Search
- **License:** MIT
- **Dependencies:** none, at runtime or in development. Node 22+ built-ins only.

## The problem

A page's identity is asserted in at least three places, and nothing keeps them
honest. The route manifest says a page exists at `/plans`. The built HTML says
its canonical is `/old-plans`. The redirect map says `/old-plans` goes to
`/plans`. Each file is individually defensible; together they tell a crawler to
index a URL that immediately redirects away, and the page competes with itself.

The same disagreement hides behind spelling. `/café` and `/caf%C3%A9` are the
same page, and a diff tool will say they are different. `/docs` and `/docs/` may
be the same page or two pages, and which one is true is a decision nobody wrote
down. This tool makes that decision explicit, applies it to every input, and
reports only real disagreements.

It is deliberately narrower than a crawler and deliberately different from
`content-identity-auditor`, which compares the canonicals an inventory already
declares. This one *resolves* declarations across separate build artefacts.

## Install

```sh
npm install canonical-url-consistency-checker
```

Or run it from a checkout with no install step at all:

```sh
node bin/canonical-url-consistency-checker.mjs --config examples/clean/canonical.config.json
```

## Commands

```sh
canonical-url-consistency-checker --config FILE [--root DIR] [--trailing-slash POLICY] [--json]
```

| Option | Meaning |
| --- | --- |
| `--config FILE` | Project configuration. Required. |
| `--root DIR` | Input root that every declared path resolves against and may not escape, by spelling or by symlink. Defaults to the config file's directory. |
| `--trailing-slash POLICY` | Override `config.trailingSlash`: `always`, `never` or `as-declared`. |
| `--json` | Suppress the human summary on stderr. |
| `-h`, `--help` | Show usage. |

Repository scripts:

```sh
npm run lint     # node --check over every shipped source and test file
npm test         # node --test
npm run example  # run the clean example end to end
npm run check    # lint, test, example, pack check
```

## Inputs

### Configuration

```json
{
  "schemaVersion": "1",
  "site": {
    "origin": "https://example.com",
    "alternateOrigins": ["https://www.example.com"]
  },
  "trailingSlash": "never",
  "routes": "routes.json",
  "sitemaps": ["sitemap.xml"],
  "redirects": "redirects.json",
  "limits": { "maxRedirectDepth": 5 }
}
```

`trailingSlash` is required and has no default — see
[docs/canonical-rules.md](./docs/canonical-rules.md). Every path is relative and
must resolve inside the input root, both as written and after every symbolic
link on the way to it has been followed. A path that leaves the root either way
is refused before anything is opened, so nothing outside the declared tree is
read or reported.

### Route manifest

```json
{
  "schemaVersion": "1",
  "routes": [
    { "path": "/pricing", "html": "build/pricing.html" },
    {
      "path": "/legacy-pricing",
      "html": "build/legacy-pricing.html",
      "canonical": "https://example.com/pricing",
      "indexable": false
    }
  ]
}
```

A route with no `canonical` is expected to be self-canonical. `indexable: false`
exempts a route from the "should be in a sitemap" rule.

### Redirect map

```json
{
  "schemaVersion": "1",
  "redirects": [{ "from": "/old-plans", "to": "/plans", "status": 301 }]
}
```

This is how the tool knows a canonical points at a URL that redirects. It is
supplied, never discovered: nothing is fetched.

### Built HTML and sitemap exports

`<link rel="canonical">` is extracted by a small bounded scanner that skips
comments and raw-text elements, honours `<base href>`, reads `rel` as a token
list, and records whether each declaration was still inside `<head>`. A
canonical mentioned in a comment or inside a `<script>` string is not a
declaration and is not read as one.

Sitemap `<loc>` values are read by an equally small scanner that handles
namespace prefixes, CDATA and entity escapes. A `<sitemapindex>` is reported as
unread evidence rather than expanded.

## Output

The JSON report goes to **stdout and nothing else**, so it can be piped straight
into a parser. The human summary and every diagnostic go to **stderr**.

```json
{
  "schemaVersion": "1",
  "tool": "canonical-url-consistency-checker",
  "status": "fail",
  "summary": {
    "checked": 7,
    "errors": 11,
    "warnings": 5,
    "info": 0,
    "routes": 7,
    "sitemapUrls": 4,
    "redirects": 2,
    "trailingSlash": "never",
    "origin": "https://example.com",
    "redirectMap": "redirects.json"
  },
  "findings": [
    {
      "ruleId": "canonical-redirected",
      "severity": "error",
      "message": "The canonical on /plans points at https://example.com/old-plans, which the supplied redirect map sends to https://example.com/plans.",
      "location": { "file": "build/plans.html", "pointer": "https://example.com/plans" },
      "evidence": "https://example.com/old-plans -> https://example.com/plans",
      "suggestion": "Declare the redirect target directly: https://example.com/plans."
    }
  ]
}
```

`status` is `pass`, `fail` or `incomplete`. `incomplete` means evidence was
missing, unreadable or above a declared limit; it is never interchangeable with
`pass`. Findings are sorted deterministically and the same bytes always produce
byte-identical stdout.

## Exit codes

| Code | Meaning |
| ---: | --- |
| `0` | Every route, canonical and sitemap URL agreed. |
| `1` | The check completed and found a policy failure. |
| `2` | Invalid configuration, unreadable input, or evidence the tool could not fully read. |

## Examples

```sh
npm run example                                                            # passes, exit 0
node bin/canonical-url-consistency-checker.mjs --config examples/broken/canonical.config.json   # exit 1
```

`examples/clean` passes: its `/café` route is written literally in the HTML and
percent-encoded in the sitemap, and both resolve to one page. Its `/pricing/`
redirect is reported as a no-op because the configured `never` policy has
already collapsed it.

`examples/broken` fails, and each failure is a different way page identity comes
apart: a canonical pointing at a redirect source, a missing canonical, two
conflicting canonicals on one page, a cross-host canonical, a route colliding
with its own trailing-slash variant, and a sitemap listing a redirected URL.

## Limits and non-goals

This tool reads files. It cannot conclude anything that requires asking a server
or a search engine, and it does not pretend otherwise.

- **It never fetches.** It cannot tell you whether a URL is reachable, what
  status code it really returns, whether a redirect map matches the deployed
  edge configuration, or whether a `<base href>` resolves the way a browser
  would against the served document. Everything it says about redirects comes
  from the map you supplied. If that map is stale, the report is stale.
- **It cannot tell you what a search engine will do.** Canonical declarations
  are a hint, not an instruction. A consistent report is not a ranking outcome,
  an indexing guarantee, or evidence that a page is indexed.
- **It does not discover pages.** The route manifest is the authority. A built
  HTML file no route declares is not scanned, and a page that exists only in a
  sitemap is reported as an unknown route rather than audited.
- **It does not expand sitemap indexes**, because doing so would mean fetching.
  List the individual exports instead.
- **It does not render.** A canonical injected by client-side JavaScript after
  hydration is invisible to it, and so is one inserted by an edge worker after
  the build.
- **It does not read `robots.txt`, `<meta name="robots">`, `hreflang`, or HTTP
  `Link:` headers.** Indexability here means the `indexable` flag you declared
  in the route manifest, nothing more.
- **It does not normalise query strings.** Parameter order and repetition are
  preserved, because reordering them changes meaning rather than normalising it.
- **It does not fix anything.** It is read-only and writes no files.
- **An unknown is never a pass.** Anything it could not read becomes `status:
  "incomplete"` and exit `2` — including when the finding that records it is
  only a `warning`, such as a sitemap index it will not expand.

## Documentation

- [docs/canonical-rules.md](./docs/canonical-rules.md) — rule catalog, limits,
  and the determinism guarantee.
- [CHANGELOG.md](./CHANGELOG.md)
