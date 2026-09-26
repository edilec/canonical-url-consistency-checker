#!/usr/bin/env node

import { TRAILING_SLASH_POLICIES, checkProject, exitCodeFor, formatSummary } from '../src/index.mjs'

const HELP = `canonical-url-consistency-checker

Resolve canonical declarations across a route manifest, built HTML and sitemap
exports, and report disagreements about which URL names a page.

Usage:
  canonical-url-consistency-checker --config FILE [--root DIR] [--trailing-slash POLICY] [--json]

Options:
  --config FILE            Project configuration (required)
  --root DIR               Input root that every declared path resolves against
                           and may not escape. Defaults to the config directory.
  --trailing-slash POLICY  Override config.trailingSlash: ${TRAILING_SLASH_POLICIES.join(', ')}
  --json                   Suppress the human summary on stderr
  -h, --help               Show this help

Streams:
  stdout  the JSON report, and nothing else, so it can be piped into a parser
  stderr  the human summary and any diagnostics

Exit codes:
  0  every route, canonical and sitemap URL agreed
  1  the check completed and found a policy failure
  2  invalid configuration, unreadable input, or evidence the tool could not
     fully read. An input that could not be read is never reported as a pass.

This tool never fetches anything. Redirect knowledge comes only from the
supplied map, and a sitemap index is reported as unread rather than expanded.
`

function parseArguments(argv) {
  if (argv.includes('-h') || argv.includes('--help')) return { help: true }
  const options = { config: null, root: null, trailingSlash: undefined, json: false }

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const takeValue = (name) => {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`${name} requires a value`)
      index += 1
      return value
    }
    if (argument === '--json') options.json = true
    else if (argument === '--config') options.config = takeValue('--config')
    else if (argument === '--root') options.root = takeValue('--root')
    else if (argument === '--trailing-slash') options.trailingSlash = takeValue('--trailing-slash')
    else throw new Error(`Unknown option "${argument}"`)
  }

  if (options.config === null) throw new Error('--config is required')
  return options
}

async function main(argv) {
  let options
  try {
    options = parseArguments(argv)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`)
    return 2
  }
  if (options.help) {
    process.stderr.write(HELP)
    return 0
  }

  let report
  try {
    report = await checkProject({
      config: options.config,
      root: options.root ?? undefined,
      trailingSlash: options.trailingSlash,
    })
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    return 2
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (!options.json) process.stderr.write(formatSummary(report))
  return exitCodeFor(report)
}

process.exitCode = await main(process.argv.slice(2))
