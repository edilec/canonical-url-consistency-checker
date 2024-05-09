# Changelog

All notable changes to this project are documented in this file.

## Unreleased

### Added

- a page-identity model that resolves a written URL into one comparable form:
  base resolution, per-segment percent-decode, Unicode NFC normalisation and a
  fixed re-encode, so `/café`, `/caf%C3%A9`, `/caf%c3%a9` and the decomposed
  spelling all name the same page while `%2F` stays distinct from a separator;
- an explicit, required `trailingSlash` policy (`always`, `never`,
  `as-declared`) applied identically to routes, canonicals, redirects and
  sitemap URLs, with policy-collapsing redirects reported as no-ops;
- `auditProject`, resolving canonical declarations across a route manifest,
  built HTML and sitemap exports, and reporting missing canonicals, multiple
  conflicting canonicals on one page, cross-host canonicals, route identity
  collisions, canonicals that the supplied redirect map sends elsewhere, and
  sitemap URLs that disagree with the page they name;
- a bounded HTML scanner for `<link rel="canonical">` and `<base href>` that
  skips comments and raw-text elements instead of pattern-matching the document;
- a bounded sitemap scanner handling namespace prefixes, CDATA and entities,
  which reports a `<sitemapindex>` as unread evidence rather than expanding it;
- explicit byte, entry, depth and tag limits whose breach is a named finding and
  an `incomplete` status, never a silent truncation;
- input-root confinement, so a configuration cannot read a file outside the tree
  it declares — enforced both on the path as written and on its real path once
  every symbolic link has been followed, so a link planted inside the root
  cannot make the tool open an out-of-root file or echo its content into the
  report (`input-not-relative`, `input-outside-root`, `input-escapes-root`);
- a CLI writing the JSON report to stdout only, diagnostics to stderr, and
  exiting 0 / 1 / 2;
- runnable clean and deliberately broken examples;
- the rule catalog, limits and determinism guarantee in
  `docs/canonical-rules.md`.

No release has been published.
