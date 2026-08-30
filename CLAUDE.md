# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`indstocks-mcp` — a read-only MCP server (stdio transport) exposing the official INDstocks (INDmoney) REST API, AMFI mutual fund NAV data, and CAMS/KFintech consolidated account statements to an LLM. Published to npm as a global CLI (`bin: dist/index.js`). No linter; TypeScript strict mode plus `npm test` are the checks.

## Commands

```bash
npm install
npm run build       # tsc -> dist/
npm run typecheck   # tsc --noEmit; the closest thing to a test
npm run dev         # tsc --watch
npm start           # node dist/index.js (needs INDSTOCKS_TOKEN in env)
npm test            # builds, then runs node:test over tests/ against dist/
```

Tests are plain `.mjs` under `tests/`, run by Node's built-in runner against the
compiled `dist/` — no test framework, no TS test tooling. To run one file:

```bash
node --test tests/cas.test.mjs          # after npm run build
node --test --test-name-pattern "XIRR"  # one test by name
```

Smoke-test a token before debugging anything downstream — a bad/expired token makes every API tool fail identically:

```bash
curl -s https://api.indstocks.com/user/profile -H "Authorization: $INDSTOCKS_TOKEN"
```

Sources live in `src/` and compile to `dist/`, which is what `tsconfig.json`, the `bin` entry, and the README all assume.

## Architecture

Single-process stdio MCP server. `index.ts` is the only file that knows about MCP; everything else is plain TypeScript with no SDK dependency.

```
index.ts        MCP tool registrations + stdio transport + process entry
  client.ts     HTTP layer for api.indstocks.com (auth, retry, error taxonomy)
    auth.ts       TokenStore: holds the token, mints new ones via POST /generate/token
      totp.ts     RFC 6238 code generation for unattended refresh
    ratelimit.ts  per-endpoint-path token buckets
    endpoints.ts  the endpoint map + provenance tags + the omit list
    schemas.ts    zod response shapes, envelope unwrapping, drift warnings
  stream.ts       live price feed over WebSocket (built-in, no dependency)
  instruments.ts  cached symbol -> scrip-code master (from the API)
  amfi.ts         cached all-India mutual fund NAV universe (from AMFI, no auth)
  statement.ts    routes a statement to the right parser (breaks the import cycle)
    cas.ts          CAMS/KFintech registrar statements — funds, with transactions
    casdepository.ts NSDL/CDSL depository statements — all demat accounts, no ledger
    caspdf.ts     PDF text extraction for both (the only heavy dependency)
  sectors.ts      NSE macro-economic sector classification (free, unauthenticated)
  analytics.ts    pure deterministic maths (allocation, HHI, XIRR, drift)
```

Two constraints shape everything and must be preserved:

**1. Read-only is the product, not an omission.** `endpoints.ts` carries a `DELIBERATELY_OMITTED` map documenting the order endpoints (`POST /order`, `/order/modify`, `/order/cancel`, and the `/smart/order` GTT family) and why they are absent. Never add order placement, modification, or cancellation tools. Never add a tool that ranks, scores, or recommends securities — the server stays a data-and-arithmetic layer for SEBI Investment Adviser reasons spelled out in the README.

**2. Analytics run in code, never in the model.** XIRR, HHI, and expense drag live in `analytics.ts` / `amfi.ts` and are exposed as tools so the LLM explains numbers rather than producing them. XIRR uses bisection deliberately (Newton-Raphson diverges on real SIP flow patterns) — don't "optimize" it to Newton.

### Endpoint provenance

Every entry in `ENDPOINTS` is tagged `VERIFIED` (documented path + response shape) or `UNVERIFIED` (capability documented, exact path unconfirmed). **Nothing is UNVERIFIED right now** — all paths were confirmed against https://api-docs.indstocks.com/ on 2026-08-30. Keep it that way: when adding an endpoint, confirm the path and set the tag in the same change rather than guessing and leaving a note.

The client's 404 handler branches on provenance (`pathNotFoundHint` in `client.ts`), and it takes `Provenance` as a *parameter* on purpose — with every endpoint currently VERIFIED, an inline comparison narrows to one literal and stops compiling. Don't "simplify" it back inline.

A path may carry a `{name}` segment, filled from the `pathParams` argument to `client.get()`. Only `historical` needs it today: the API takes the candle interval as a path segment (`/market/historical/1day`), and the intervals are spelled out (`1day`, `15minute`) rather than abbreviated. Its date range goes as `start_time`/`end_time` in epoch **milliseconds**, anchored to IST — a UTC midnight boundary lands at 05:30 IST and clips intraday candles.

### Response validation

`schemas.ts` holds a zod schema per endpoint, transcribed from the documented
example responses. Three rules keep it useful rather than annoying:

- **Never throw, never withhold.** A mismatch returns the payload anyway with
  warnings naming the fields that moved. A schema that failed the call would trade
  a silent wrong answer for a broken tool, which is not an improvement. This is the
  same posture as CAS reconciliation: keep answering, but say plainly when the data
  is not what was expected.
- **`passthrough()` everywhere, and require only what consumers use.** The API
  adding a field must not break anything. Requiring every documented field would
  generate false alarms; requiring none would validate nothing.
- **Only schema what the docs show.** `orderBook` has no schema because its shape
  is not published, and its tool description says so. Inventing field names there
  would recreate precisely the guessing this module removes.

Two envelopes exist — `{status, data}` for most endpoints, `{success, data}` for
historical — and `unwrapEnvelope` handles both so tools return the payload rather
than a wrapper. It only unwraps when a `status` or `success` marker is present,
since an object that merely has a `data` key may have siblings worth keeping.

Field names that bite:

- REST quotes call the last price **`live_price`**; the WebSocket feed calls the
  same number `ltp`. Reading the wrong one yields `undefined`, not an error, so the
  schema requires `live_price` and a payload using `ltp` is flagged.
- Candle `ts` is epoch **seconds**, while the request takes epoch **milliseconds**.

`normaliseHoldings` renames `total_qty`/`avg_price` into the `quantity`/
`averagePrice` vocabulary the analytics layer speaks, in one documented place
instead of at every call site. It runs **only on a payload that validated** —
renaming fields on a response we did not recognise would launder a shape change
into confident-looking numbers. It deliberately does not invent `lastPrice`:
holdings genuinely carry none, and `scripCodeAssumingNse` names its own assumption
because holdings carry no exchange field either.

### Holdings carry no prices

`GET /portfolio/holdings` returns `security_id`, `symbol`, `isin`, `total_qty`, `used_qty`, `avg_price`, `t1_qty`, `t1_avg_price`, `dp_qty`, `dp_avg_price` — and no LTP, market value, or P&L. Anything that values the book has to join holdings against `quotesLtp` by `security_id`. This is why `analyze_allocation` cannot be wired straight to `get_holdings` without a quotes call in between.

### Sector classification

`analyze_allocation` could always group by sector, but the sector arrived as an
optional string on each position — meaning the model supplied the grouping
dimension from memory. Deterministic arithmetic over a guessed input is the one
combination this codebase exists to avoid, so `sectors.ts` resolves it from NSE's
published classification for Nifty Total Market constituents (~750 names, keyed by
symbol and ISIN, free and unauthenticated).

**Precedence is the whole feature: the index wins over a caller-supplied sector.**
A passed-in `sector` is a fallback for the tail NSE does not cover, never an
override — inverting that puts the model back in charge of the grouping. Every
response reports the mix (`resolvedFromIndex` / `callerSupplied` / `unclassified`)
so it stays auditable, and unclassified positions are named and keep their full
weight in the totals rather than being dropped or folded into a neighbour.

Two more things worth preserving:

- **A failed fetch is not a coverage gap.** `SectorStore` never throws — a missing
  feed degrades an allocation rather than failing the call — but `available` and
  `lastError` keep "NSE was unreachable" distinct from "this stock is not in the
  index". Only the first means the weights are wrong. A failure also sets a short
  retry floor so a broken feed is not re-fetched on every lookup.
- **NSE seeds the CSV with `DUMMY*` placeholder rows** for pending corporate
  actions, carrying invented `DUM…` ISINs. Requiring a real `IN` prefix drops them;
  without that they enter the symbol index as if they were listed companies.

Lookup prefers ISIN over symbol, because symbols get reused and reassigned after
corporate actions while the ISIN does not.

Funds are deliberately excluded: a flexi-cap fund spans every sector, so
`analyze_cas_portfolio` groups by AMFI's own `category` instead. Don't add sector
grouping there — the concept does not transfer.

The CSV splitter is shared with `instruments.ts` (exported from there) rather than
duplicated; the coupling is type-only, so there is no runtime dependency.

### Live prices

MCP is request/response, so nothing here can push a tick at the model. `stream.ts`
exists to decouple collection from asking: a background subscription keeps a cache
of the latest tick per instrument (read instantly, costs no REST rate limit), and
`watch()` collects a bounded window, which is the only shape that fits one tool
call. Don't try to make a tool that "streams to the model" — it cannot exist, and
the attempt just produces a blocking call returning stale numbers.

Details that are load-bearing rather than incidental:

- **Auth is a handshake header**, which the WHATWG WebSocket API cannot set. Node's
  built-in accepts a non-standard options argument, which is why the constructor is
  re-typed as `HeaderCapableWebSocket` instead of `ws` being added as a dependency.
  The token is read at connect time, so a reconnect after `refresh_token` picks up
  the new credential for free.
- **Two spellings for one instrument.** REST uses `NSE_2885`; the socket wants
  `NSE:2885`; and a tick identifies itself by the bare token `2885`. Ticks are
  therefore cached by token, and `scripCode` is only resolved when exactly one
  subscription owns that token — subscribing `NSE_2885` and `BSE_2885` together
  makes it `null` rather than a coin flip.
- **A first subscribe must not double-send.** Subscriptions are recorded before the
  socket opens so the open handler can replay them, which also covers reconnects;
  sending the delta as well would put every initial subscription on the wire twice.
  `subscribe()` only sends when the socket was already open.
- **A failed connect must reset state to `closed`.** Leaving it at `connecting`
  makes `status()` lie about why prices stopped.
- **`watch()` unsubscribes only what it added**, so a short observation cannot
  dismantle a standing subscription someone else set up.
- Reconnect backoff timers are `unref`'d, and `index.ts` closes the stream on
  SIGINT/SIGTERM and on stdin end. An open socket is a ref'd handle: without that
  the server would outlive the client that started it.

`tests/helpers/fakefeed.mjs` is a minimal WebSocket server (Node ships a client but
no server) used to exercise all of this without the live feed or a test dependency.

### Depository statements (NSDL/CDSL)

A second, unrelated document also gets called a "CAS". Where the registrar
statement covers funds with a full ledger, a depository statement covers **every
demat account across every broker** — equities, bonds and funds together — as a
**snapshot with no transactions**. That last point is load-bearing: `compute_cas_xirr`
must refuse on one rather than derive a rate from nothing.

`statement.ts` routes between the two and exists as its own module purely to break
an import cycle, since the depository parser reuses the number and date helpers
from the registrar one.

**Rows are anchored on the ISIN, not on x-coordinates.** casparser parses these
with fixed column bands plus a long tail of heuristics for rendering quirks, all
tuned to one PDF engine's coordinate space. Transplanting that blind to pdfjs would
produce a parser that looks complete and is quietly wrong about somebody's entire
portfolio. An ISIN is unambiguous and position independent, and anchoring on it
also drops headers, totals and footer prose for free — none of them are enumerated
anywhere.

**The value column is resolved by arithmetic, not convention.** These tables carry
different columns per section, and an MF row can append cost and returns *after*
the market value, so the rightmost number is not reliably the value. Instead the
column that sums to the statement's own "Sub Total" / "Total" is the value column.
When no column matches, holdings come back with quantities and `value: null` and
the account is flagged — never attributed to the wrong figure. Don't replace this
with "take the last number".

**The bug this closed matters more than the feature.** An NSDL file used to be
detected correctly and then handed to the registrar parser, which found no folios
and returned an empty statement *with no warning* — so the tool reported zero
holdings and zero rupees for someone whose whole portfolio was in the file. Both
parsers now warn when they read nothing. Keep that: "parsed nothing" must never be
presentable as "owns nothing".

`analyze_cas_portfolio` accepts either vocabulary for `groupBy` — scheme/holding,
amc/account, category/assetType — and maps to whichever the statement kind
supports. Depository values are used as printed rather than revalued: an equity has
no NAV feed here, and the statement's own figure is the authority.

### Tokens

Tokens die 24 hours after issue, which used to be the end of the session. `TokenStore`
owns the current token and can mint a replacement through `POST /generate/token`;
the client refreshes **once** on a 401 and retries, so expiry mid-conversation is
invisible. Two things about that endpoint make it awkward and both are deliberate
in the code:

- It authenticates with `x-api-key`, not `Authorization`, and it is a POST. That is
  why it lives in `TOKEN_ENDPOINT` rather than in `ENDPOINTS` — keeping it out of
  that map means `client.get()` cannot name it and `diagnose_endpoints` cannot
  probe it with the wrong verb. Type system over comment.
- The API keeps **one live TOTP-issued token per account**, so a refresh revokes
  whatever another script holds. That is also why `TokenStore.refresh()` collapses
  concurrent callers onto one in-flight request: two races would leave one caller
  holding a token the other had already killed.

The documented flow wants a six-digit code typed out of an authenticator app, so
interactive refresh via the `refresh_token` tool is the baseline. Supplying
`INDSTOCKS_TOTP_SECRET` lets `totp.ts` derive that code locally and makes refresh
unattended — at the cost of parking both factors in one place, which `auth.ts`
spells out. It is opt-in and must stay opt-in; never infer it.

Guardrails worth preserving: a refresh is attempted **once** per request (a rejected
MPIN retried three times is three chances at a lockout), a failed refresh throws
rather than falling into the network-retry path, and neither the token nor the
upstream response body is ever echoed back — that body was produced from a request
carrying the MPIN. `refresh_token` returns a four-character fingerprint, nothing more.

`tests/totp.test.mjs` checks generation against the published RFC 6238 vectors.
That matters more than it looks: a wrong code comes back as "invalid TOTP", which
is indistinguishable from a typo, a clock skew, or a bad seed.

### The CAS layer

A consolidated account statement is the only source of *actual* mutual fund
holdings: the INDstocks API does not cover mutual funds, and AMFI publishes the
price of every fund but nobody's units. It is also the only realistic source of
dated cash flows, which is what made `compute_xirr` useless in practice — the
arithmetic was always there, but no one can hand-type six years of SIP instalments.

The split matters. `cas.ts` is pure `string -> CasStatement` with no dependency,
so the format-sensitive half is unit tested against fixtures; `caspdf.ts` holds the
one dependency (`unpdf`, a ~2 MB bundled pdfjs rather than the 34 MB `pdfjs-dist`)
and is imported dynamically so starting the server does not load a PDF engine.

**Reconciliation is the safety mechanism, not a nicety.** A mis-parsed statement
produces confident, wrong rupee figures, which is worse than no parser. Every
scheme is checked against two figures the statement asserts about itself —
`opening + sum(units) == closing` and `closing * NAV == valuation` — and any
failure sets `reconciled: false` with the discrepancy spelled out. Tools surface
that rather than averaging the scheme in. Keep that contract when editing.

Statements are read from local disk and parsed in process; nothing is uploaded.
PANs are masked (`ABCDE****F`) and investor name, address and email are never
parsed at all. Don't add them "for completeness".

Transaction classification is ported from casparser, the de-facto reference: the
sign of the units column separates an inflow from an outflow and the description
only refines the kind. Cash-flow signs are derived from the classified *type*, not
from the printed sign, because the two RTAs disagree on whether a redemption
prints positive. Switches and dividend reinvestments move units without moving
cash, so they are excluded at portfolio scope and included only at scheme scope.

### Client behaviour worth knowing before editing

- Auth header is the bare token (`Authorization: <token>`), no `Bearer` prefix. The one exception is token generation, which uses `x-api-key`.
- 401/403 → one refresh attempt if the process holds credentials, otherwise `TokenExpiredError`. Its message names every way out (the `refresh_token` tool, the env vars for unattended refresh, the manual URL); keep it that way — this is still the dominant failure mode.
- Retries with exponential backoff on 429, 5xx, and network/timeout errors only. Other 4xx throw immediately by design — retrying a malformed request three times is just three malformed requests.
- Rate limiter buckets are keyed by endpoint *path* (API documents 10 rps per endpoint), so quote polling cannot starve a portfolio call.
- `getText()` exists for the instruments master, which may arrive as CSV or JSON — `instruments.ts` sniffs the first non-space character and dispatches to the right parser.

### Caching

`InstrumentStore` (12h TTL) and `AmfiStore` (6h TTL) are in-memory, process-lifetime caches with an `inflight` promise to collapse concurrent first-use loads. Both are lazy: nothing is fetched until a tool needs it. Parsed CAS statements are cached separately in `index.ts`, keyed by path + mtime so a freshly downloaded statement at the same path invalidates itself.

The AMFI feed (`portal.amfiindia.com/spages/NAVAll.txt`) is semicolon-delimited with AMC names and category headers interleaved between data rows, so `parseNavAll` is a stateful line parser — rows with fewer than 6 fields are headers, not data.

**Read the NAV and date from the end of the row, never by fixed index.** AMFI widened this feed from six columns to eight by inserting `Plan` and `Option` between the scheme name and the NAV. The old code read index 4 as the NAV, got `"Direct Plan"`, failed `Number.isFinite`, and dropped *every row* — leaving an empty universe that looked identical to a search matching nothing, with no error anywhere. `tests/amfi.test.mjs` pins both layouts. Plan and option are recombined into `schemeName` because search queries ("… direct growth") depend on them being there.

## Conventions

- ESM with Node16 resolution: **relative imports must carry the `.js` extension** (`./client.js`), even though the sources are `.ts`.
- **stdout is reserved for MCP JSON-RPC framing.** All logging goes through the `log` helper in `index.ts`, which writes to stderr. A stray `console.log` corrupts the protocol.
- Every tool handler wraps its body in try/catch and returns `ok(...)` / `fail(...)` so errors reach the model as text rather than crashing the transport.
- Tool descriptions are user-facing documentation: they state when a path is UNVERIFIED and repeat that the server cannot trade. Keep that when editing them.
- Comments in this codebase explain *why* a choice was made (bisection over Newton, per-path buckets, no fuzzy instrument matching). Match that register rather than narrating what the code does.
