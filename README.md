# @pipeworx/oklahoma-code

Oklahoma Statutes — state statutes by citation, full-text topic search,
amendment history, and historical (superseded) versions. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1704+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `ok_statute(citation, version_citeid?)` — full text of an Oklahoma
  Statutes section by citation ("21-701.7" is Murder in the First Degree;
  "41-111" is termination of tenancy). Returns the statute text, its
  chapter breadcrumb, the "Cite as" line, its full amendment `history`, and
  a `historical_versions` array — each entry's `citeid` can be passed back
  as `version_citeid` to retrieve that EXACT prior version's text instead
  of the current one.
- `ok_search(query, limit?)` — full-text search over statutory BODY TEXT
  (not just headings), returning matching citations, headings, effective
  dates, and relevancy.
- `ok_titles()` — all 94 titles of the Code with their official names, for
  routing a subject to the right title number.

## Auth

Keyless.

## The survey trap did not apply here

The August state-law survey (`docs/state-law-probe.md`) flagged Oklahoma as
"published only as PDF" — oklegislature.gov serves each of the 94 titles as
one ~1.2 MB per-title PDF with no per-section split. Looking past that the
way CO/IN/NJ/GA/KY did: **OSCN**, the Oklahoma State Courts Network
(oscn.net — the state court system's own site, not the legislature's),
serves the full "Oklahoma Statutes Citationized" as live HTML, keyless,
bare-UA, current through the 2025 legislative session plus at least one
2026-effective 2025 amendment (verified live 2026-10-06: 21 O.S. § 701.7's
own "Cite as" line reads "(OSCN 2026)", and its most recent amendment, Laws
2025 HB 2104, took effect January 1, 2026).

This turned out to be a BETTER source than the PDF-extraction packs in this
family, not just an escape from the PDF trap: OSCN runs a real full-text
search over statutory body text (confirmed — searching "landlord" surfaces
41 O.S. § 111, "Termination of Tenancy", a heading that never says
"landlord") and keeps every superseded prior version of an amended section
on its own directly-linked page. So this pack gets all four capabilities
the survey cares about — citation lookup, topic search, amendment history,
and historical versions — with none of them approximated or unavailable,
unlike Kentucky (no historical versions) or Iowa (caption search, not full
text).

## Citations

Oklahoma cites by title-section, e.g. "21-701.7" (Title 21, Crimes and
Punishments, Section 701.7) or "41-111" (Title 41, Landlord and Tenant,
Section 111). `ok_statute` also accepts "21 O.S. 701.7", "21 O.S. § 701.7",
and "Title 21, Section 701.7". 9 of the 94 titles carry a letter suffix
(3A, 10A, 12A, 14A, 27A, 37A, 43A, 75A, 85A) — pass it as part of the title,
e.g. "10A-1".

## Navigation shape — two hops, and why no local cache was built

1. `Index.asp?ftdb=STOKSTnn&level=1` — the whole title's directory,
   FLATTENED: every section anchor appears on one page, because this
   database's directory tree is only Title -> Document (confirmed live:
   chapter headers are inline markers within the same flattened page, not
   separate fetchable URLs). Title dbcodes are NOT derivable from the title
   number for the 9 lettered titles (10A is `STOKSTA1`, not `STOKST10A`) —
   the pack carries the full static map read off the master index page.
2. `deliverdocument.asp?citeid=NNNNN&PrintOnly=true` — the section itself.
   `PrintOnly` is load-bearing: dropping it returns the SAME text wrapped in
   the entire title's navigation tree re-embedded on every single section
   page (272 KB for one section of Title 21, confirmed live), where
   `PrintOnly` strips that tree (14 KB for the same section).

Title index pages range from ~65 KB (Title 85) to ~610 KB (Title 74, State
Government) — plain HTML parsed with a handful of regexes, not a binary PDF
needing font/stream decoding. Unlike the per-title PDF fallback this task
was built to avoid, there is no smaller unit OSCN offers to cache instead —
one title is the structural minimum, verified live, and is cheap to parse
even at its largest. `ok_statute` still does only one such fetch per call,
never a second title fetch for the same call.

## Amendment history and historical versions

Every amended section's `PrintOnly` page ends with a `Historical Data`
marker followed by one paragraph chaining every amending Act, e.g. "Amended
by Laws 2025, HB 2104, c. 486, § 1, eff. January 1, 2026 (superseded
document available)." Each "(superseded document available)" is a direct
link to that PRIOR version's own CiteID — fetching it through the same
route returns the statute exactly as it read before that amendment, headed
"Superceded On: MM/DD/YYYY" (OSCN's own spelling, not a typo introduced here).

## Data sources

- `https://www.oscn.net/applications/oscn/index.asp?ftdb=STOKST` — the
  master title index (94 titles, their dbcodes, and the Code's overall
  currency line, e.g. "Current through the 2025 Legislative Session").
- `https://www.oscn.net/applications/oscn/Index.asp?ftdb=STOKSTnn&level=1`
  — one title's full section directory (name -> CiteID). `ok_statute`'s
  citation-resolution hop.
- `https://www.oscn.net/applications/oscn/deliverdocument.asp?citeid=NNNNN&PrintOnly=true`
  — one section's full text, breadcrumb, and amendment history. Also used,
  unchanged, to fetch a historical (superseded) version by its own CiteID.
- `https://www.oscn.net/applications/oscn/Search.asp?ftdb=STOKST&quick=true&query=landlord&hidesuperseded=Yes&dbCodeText=STOKST&SUBMITTED=true`
  — full-text search over statutory body text across all 94 titles.
  `ok_search`.

All four are plain, keyless, server-rendered HTML — no login, no JS, no
rate limit observed during development. The site's markup is ISO-8859-1
(not UTF-8); the pack decodes accordingly rather than assuming UTF-8, which
would otherwise corrupt the § character these pages use throughout.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "oklahoma-code": {
      "url": "https://gateway.pipeworx.io/oklahoma-code/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/oklahoma-code/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1704+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ok_statute \
  -H 'Content-Type: application/json' \
  -d '{"citation":"21-701.7"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ok_statute`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "oklahoma-code": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-oklahoma-code"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-oklahoma-code
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Oklahoma Code data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
