# indstocks-mcp

[![CI](https://github.com/Arnavshah22/indstocks-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Arnavshah22/indstocks-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/indstocks-mcp)](https://www.npmjs.com/package/indstocks-mcp)
[![node](https://img.shields.io/node/v/indstocks-mcp)](https://www.npmjs.com/package/indstocks-mcp)

**The INDmoney MCP server that doesn't scrape.**

An MCP server giving Claude read-only access to your INDmoney portfolio and Indian market data — built on the **official INDstocks REST API**, not Playwright browser automation.

No headless Chrome. No cookie copying. No re-doing OTP every time the session dies. No terms-of-service grey zone. And no order placement, ever.

---

## Why this exists

Every other INDmoney MCP server drives a browser. Their own READMEs say it: broker UIs change without notice, sessions expire mid-request, aggressive use trips anti-bot measures, and automated access to a broker web app may violate its terms.

INDmoney ships a real API. This uses it.

|                           | Scraper-based servers        | indstocks-mcp                              |
| ------------------------- | ---------------------------- | ------------------------------------------ |
| Data source               | Playwright + DOM/XHR         | Official REST API + WebSocket              |
| Breaks when               | UI changes                   | API version changes                        |
| Terms of service          | Grey zone                    | Sanctioned integration                     |
| Keeping a session alive   | Chrome window, OTP each time | Paste a token, or TOTP for unattended refresh |
| Market data               | Whatever the UI renders      | Quotes, historical, live streaming          |
| Mutual funds              | Yes (scraped)                | NAVs from AMFI **and** the units you hold, from your CAS |
| Holdings at other brokers | No                           | Yes, from an NSDL/CDSL statement           |
| Order placement           | No                           | **No, by design**                          |

### The one thing the official API doesn't do

It covers equity, F&O and currency. **It does not cover mutual funds.** For most Indian retail portfolios that's the majority of the money, so a portfolio tool without MF data answers the wrong question.

Two things fill that gap. AMFI's free daily NAV feed gives the price of every scheme in the country — no key, no auth, no scraping. And your **consolidated account statement** gives the part no public feed can: the units you actually hold, and every dated transaction behind them.

Trading data from the official API, fund prices from the official industry body, holdings from the statement the registrars already send you.

---

## Read-only, and that is not negotiable

This server exposes **no** order placement, modification, or cancellation tools. That is the point of the package, not a missing feature.

An LLM is non-deterministic. `POST /order` moves real money. Those two things do not belong in the same process. A prompt instruction saying "don't trade without asking" is a suggestion; not shipping the tool is a guarantee.

```
Deliberately not exposed:
  POST /order                places a real order with real money
  POST /order/modify         modifies a live order
  POST /order/cancel         cancels a live order
  POST /smart/order          creates a multi-leg standing (GTT) trigger order
  POST /smart/order/modify   modifies a standing trigger order
  POST /smart/order/cancel   cancels a standing trigger order
```

If you fork this and add order placement, **please rename the package.** People who installed a read-only tool should not get order placement in a patch bump.

### Not investment advice

Nothing here recommends anything. `analyze_allocation` describes a portfolio. `compare_expense_ratio` compounds arithmetic on numbers you supply. No tool ranks funds, scores stocks, or suggests what to buy. That line is drawn deliberately — see [Regulatory notes](#regulatory-notes).

---

## Install

```bash
npm install -g indstocks-mcp
```

Get a token: log in at [indstocks.com](https://www.indstocks.com) → `/app/api-trading/access-tokens` → **Claim Your API Access** → generate.

**Tokens expire after 24 hours.** This is the single most common failure mode, and it used to mean editing a JSON config file and restarting your MCP client every morning. It no longer does — see below.

Verify before wiring anything up:

```bash
curl -s https://api.indstocks.com/user/profile -H "Authorization: $INDSTOCKS_TOKEN"
```

If that doesn't return your profile, stop — nothing downstream will work.

### Never paste a token again

Set up TOTP on the same access-tokens page. The dashboard then shows a **client id**, which is the API key.

```json
"env": {
  "INDSTOCKS_API_KEY": "your-client-id",
  "INDSTOCKS_MPIN": "your-mpin"
}
```

Now when the token expires, ask Claude to refresh it and give it the six-digit code from your authenticator app. `refresh_token` swaps the token in place — no restart, no config editing.

To skip even that, add `INDSTOCKS_TOTP_SECRET` (the authenticator key). The server then derives the code itself and refreshes the moment it sees a 401, unattended.

> **Read this before setting the seed.** Storing the TOTP seed beside the MPIN puts both factors in one place; anyone who can read them can mint tokens for the account indefinitely. That this server is read-only is no protection — the credential is not scoped to it, and the same token places orders against the real API. It is the right trade for an unattended box you control, and the wrong one for a shared laptop.

Note that INDstocks keeps a single live TOTP-issued token per account, so refreshing revokes whatever token another script was using.

### Claude Desktop

```json
{
  "mcpServers": {
    "indstocks": {
      "command": "npx",
      "args": ["-y", "indstocks-mcp"],
      "env": { "INDSTOCKS_TOKEN": "your-token-here" }
    }
  }
}
```

### Claude Code

```bash
claude mcp add indstocks -e INDSTOCKS_TOKEN=your-token -- npx -y indstocks-mcp
```

---

## Tools

**Account** — `get_profile`, `get_funds`, `refresh_token`

**Market data** — `search_instruments` (resolve `RELIANCE` → `NSE_2885`), `get_quotes`, `get_historical`

**Live prices (WebSocket)** — `watch_prices` (collect ticks for a fixed window), `stream_subscribe` / `stream_unsubscribe`, `stream_quotes` (instant cache read, no rate limit)

**Portfolio** — `get_holdings`, `get_positions`, `get_order_book` (read)

**Mutual funds** — `search_mutual_funds` (whole AMFI universe), `get_scheme_nav`, `compare_expense_ratio`

**Consolidated account statement** — `parse_cas` (CAMS/KFintech or NSDL/CDSL), `analyze_cas_portfolio` (allocation and concentration; fund units revalued at today's NAV), `compute_cas_xirr` (XIRR from actual dated cash flows, registrar statements only)

**Analytics** — `analyze_allocation` (weights, HHI concentration, drift vs target), `compute_xirr`, `classify_sectors`

**Diagnostics** — `diagnose_endpoints`

### What streaming can and cannot be here

MCP is request/response. A tick cannot interrupt the model mid-turn, so no MCP server can hand a language model a live stream, and one claiming to would just be a tool that blocks and returns stale numbers.

What the socket genuinely buys you is decoupling *collection* from *asking*:

- `stream_subscribe` opens a standing subscription that keeps updating in the background. `stream_quotes` then reads the latest values as a **cache lookup** — instant, and it spends none of the 10 req/sec REST budget. Worth it when the same names keep coming up in one conversation.
- `watch_prices` subscribes, collects for a stated number of seconds, and returns the series plus first/last/high/low/% change. That is the one shape that fits a single tool call.

Every quote carries `ageMs`. Check it before calling a price current — a stale value means the feed went quiet, not that the price held steady. Outside market hours no ticks arrive at all, and the tools say so rather than looking broken.

Uses Node's built-in WebSocket, so no new dependency. One connection of the three the API allows, leaving two for whatever else you run.

### Your statement stays on your machine

`parse_cas` reads a statement PDF from local disk and parses it in process. There is no upload step and no network call in that path. PANs come back masked; investor name, address and email are never parsed at all.

Two different documents both get called a "CAS", and both are supported:

- **CAMS / KFintech** ([camsonline.com](https://www.camsonline.com), [kfintech.com](https://www.kfintech.com)) — mutual funds only, but with the **full dated transaction history**. Ask for the *detailed* statement, not the summary. This is the one that makes `compute_cas_xirr` possible.
- **NSDL / CDSL** ([nsdl.co.in](https://nsdl.co.in), [cdslindia.com](https://www.cdslindia.com)) — **every demat account across every broker**, with equities, bonds and funds side by side. This is the only view of shares you hold outside INDmoney. It is a holdings snapshot with no transactions in it, so no return can be computed from one; `compute_cas_xirr` refuses rather than inventing a number.

The kind is detected from the file. Pass the path and the password.

**Everything is reconciled against the statement's own totals.** For a registrar statement: opening units plus transactions must equal the stated closing balance, and units times NAV must equal the stated valuation. For a depository statement the same idea does double duty — these tables carry different columns per section, so rather than assume which one holds the market value, the parser picks the column that *sums to the total the statement prints*. Disambiguation by arithmetic rather than by convention.

Anything that fails comes back `reconciled: false` with the discrepancy, and the analysis tools exclude it and say so rather than folding a mis-parse into your allocation. A depository account whose value column cannot be identified returns quantities with **no values at all**, which is the honest answer. A parser that quietly gets someone's portfolio wrong is worse than no parser — and a statement that cannot be read says so, instead of reporting an empty portfolio.

### Analytics are computed, not estimated

XIRR and concentration ratios have exactly one right answer, and a language model doing them in its head is a liability. They run in TypeScript. The model's job is to explain the numbers, not produce them.

XIRR uses bisection rather than Newton-Raphson: Newton is faster but diverges on the irregular flow patterns real SIP portfolios have (many small instalments, one large redemption). Bisection always converges inside the bracket.

The same rule applies to the *inputs*, not just the arithmetic. Grouping an allocation by sector used to mean the model recalling which bucket each company belongs in — deterministic maths resting on a guess, which is the worst of both. `analyze_allocation` now resolves sectors from **NSE's published macro-economic classification** for Nifty Total Market constituents (about 750 names), looked up by ISIN or symbol. A sector you pass in is a fallback for instruments outside that index, never an override.

Coverage is finite and the output says so: anything NSE does not list comes back as `Unclassified`, named and counted, still carrying its full weight in the totals. "NSE was unreachable" is reported separately from "this stock is not in the index" — both leave a position unclassified, but only one means the weights are wrong. `classify_sectors` exposes the same lookup directly, and with no arguments lists the 22-sector vocabulary.

Mutual funds get no sector grouping, deliberately: a flexi-cap fund spans every sector, so attributing one to it would be inventing information. `analyze_cas_portfolio` groups by AMFI's own scheme category instead.

---

## Endpoint provenance

Paths in `src/endpoints.ts` are tagged `VERIFIED` or `UNVERIFIED`. Verified paths appear in the official docs with a documented request and response shape. Unverified ones have a docs page for the capability but the exact path wasn't confirmed at the time of writing.

Currently unverified: **none**. Every path was confirmed against the official docs on 2026-08-30.

`diagnose_endpoints` probes each one against your account and reports what resolves. Now that the paths are all confirmed, a failure there usually means an expired token or a segment your account is not entitled to — not a wrong path. If you do find one that has moved, check the docs and flip the tag in the same change rather than guessing a replacement.

One gotcha worth knowing: `/portfolio/holdings` returns quantities and average prices but **no current price, market value or P&L**. To value a portfolio you have to join it against `/market/quotes/ltp` by `security_id`.

Responses are checked too, not just paths. Every documented payload has a schema in `src/schemas.ts` transcribed from the official examples, and responses are validated on the way through. Validation never throws and never withholds data — an API that adds a field must not break a read-only tool — but a payload that stops matching comes back with an explicit `schema.warnings` block naming the field that moved. Silent drift is the failure mode worth catching: the endpoint keeps returning 200 while the model confidently describes something that changed underneath it.

The order book is the one endpoint passed through unvalidated, because its shape is not published. It says so in its own tool description rather than pretending otherwise.

---

## Regulatory notes

Read these before forking.

**SEBI Investment Adviser regulations.** Providing investment advice can require registration. Being free and open source is not automatic exemption. This is why no tool here ranks funds or suggests trades — it stays a data and arithmetic layer.

**SEBI's retail algo framework.** The order endpoint requires an `algo_id` and static IP whitelisting for live orders. This is a real compliance regime, not a formality. It doesn't apply to this server since it places no orders — but it will apply to you the moment you fork and add them.

**Terms of service.** Check the INDstocks API terms before redistributing a client. This project is unaffiliated with and not endorsed by INDmoney / TranQuility. "INDmoney" and "INDstocks" belong to their owners.

---

## Contributing

Most useful first, roughly:

1. Confirm the `/order-book` response shape and add its schema — the last endpoint passed through unvalidated
2. The order-updates socket (`wss://ws-order-updates…`) — watching fills is read-only and legitimate, but this server places no orders, so it is low value here

Both CAS parsers are validated against synthetic fixtures modelled on the published layouts, **not against a corpus of real statements** — so real-world layout variation is the most likely place either breaks. The reconciliation checks exist to catch exactly that: a registrar scheme that fails comes back `reconciled: false`, and a depository account whose value column cannot be matched to the stated total returns quantities with no values rather than wrong ones.

If one mis-parses yours, open an issue with the *shape* of the failing rows — never the statement itself, and never a PDF.

Please don't open PRs adding order placement.

---

## License

MIT. **No warranty.** This talks to a live brokerage account. Read the code before you point it at real money.
