/**
 * INDstocks REST API endpoint map.
 *
 * PROVENANCE MATTERS HERE. Paths are tagged:
 *
 *   VERIFIED   - appears verbatim in the official quick-start / API docs with a
 *                documented request and response shape.
 *   UNVERIFIED - the docs have a page for this capability, but the exact path was
 *                not confirmed at the time of writing. Confirm against
 *                https://api-docs.indstocks.com/ before relying on it, or run the
 *                `diagnose_endpoints` tool which probes each one and reports what
 *                actually resolves on your account.
 *
 * Do not silently "fix" an UNVERIFIED path by guessing again. Check the docs,
 * flip the tag, and open a PR so the next person does not have to.
 *
 * A path may contain a `{name}` segment, which the client fills from its
 * pathParams argument. Historical data puts the candle interval in the path
 * rather than the query string.
 */

export type Provenance = "VERIFIED" | "UNVERIFIED";

export interface EndpointSpec {
  path: string;
  provenance: Provenance;
  /** Human description used in diagnostics output. */
  note: string;
}

export const BASE_URL = "https://api.indstocks.com";

export const ENDPOINTS = {
  /** GET - user profile. Confirms the token works. */
  profile: {
    path: "/user/profile",
    provenance: "VERIFIED",
    note: "User profile; cheapest way to validate a token.",
  },

  /** GET - full quote payload for one or more scrip codes. */
  quotesFull: {
    path: "/market/quotes/full",
    provenance: "VERIFIED",
    note: "Full quotes. Query param: scrip-codes=NSE_2885,NSE_11536",
  },

  /** GET - last traded price only. Lighter than quotesFull. */
  quotesLtp: {
    path: "/market/quotes/ltp",
    provenance: "VERIFIED",
    note: "LTP only. Query param: scrip-codes=NSE_2885",
  },

  /** GET - instruments master. Maps tradingsymbol -> security_id / scrip code. */
  instruments: {
    path: "/market/instruments",
    provenance: "VERIFIED",
    note: "Instrument master dump. Cached locally; refresh daily.",
  },

  /** GET - today's order book. READ ONLY here: we never POST to /order. */
  orderBook: {
    path: "/order-book",
    provenance: "VERIFIED",
    note: "Today's orders. Read-only view.",
  },

  /** GET - available funds and margin. */
  funds: {
    path: "/funds",
    provenance: "VERIFIED",
    note: "Available cash and margin.",
  },

  /** GET - long-term holdings (delivery / CNC). */
  holdings: {
    path: "/portfolio/holdings",
    provenance: "VERIFIED",
    note:
      "Equity holdings in the demat account. Returns quantity and average price only - " +
      "no LTP, market value or P&L. Join with quotesLtp to value the book.",
  },

  /** GET - open intraday / derivative positions. */
  positions: {
    path: "/portfolio/positions",
    provenance: "VERIFIED",
    note: "Open positions. Query params: segment=equity|derivative, product=margin|intraday|cnc.",
  },

  /** GET - historical OHLC candles. */
  historical: {
    path: "/market/historical/{interval}",
    provenance: "VERIFIED",
    note:
      "OHLCV candles. The interval is a PATH segment, not a query param. Query params: " +
      "scrip-codes (max 5), start_time and end_time as epoch MILLISECONDS.",
  },
} as const satisfies Record<string, EndpointSpec>;

export type EndpointName = keyof typeof ENDPOINTS;

/**
 * Token generation, kept deliberately outside `ENDPOINTS`.
 *
 * Everything in that map is a GET carrying an `Authorization` header, and this is
 * a POST authenticated with `x-api-key`. Keeping it separate means `client.get()`
 * cannot reach it by name and `diagnose_endpoints` cannot probe it with the wrong
 * verb — the type system does the enforcing rather than a comment.
 */
export const TOKEN_ENDPOINT = {
  path: "/generate/token",
  provenance: "VERIFIED",
  note:
    "POST. Header: x-api-key (client id). Body: { mpin, totp }. Returns { token }, " +
    "valid 24h. Issuing a token invalidates the account's previous one.",
} as const satisfies EndpointSpec;

/**
 * Endpoints this server refuses to expose as tools, and why.
 *
 * This is not a stylistic choice, it is the entire safety posture of the package.
 * An LLM is non-deterministic. `POST /order` moves real money. Those two facts do
 * not belong in the same process.
 *
 * If you fork this and add order placement, please rename the package. Users who
 * installed a read-only tool should not get order placement in a patch bump.
 */
export const DELIBERATELY_OMITTED = {
  "POST /order": "Places a real order with real money.",
  "POST /order/modify": "Modifies a live order.",
  "POST /order/cancel": "Cancels a live order.",
  "POST /smart/order": "Creates a multi-leg standing (GTT) trigger order.",
  "POST /smart/order/modify": "Modifies a standing trigger order.",
  "POST /smart/order/cancel": "Cancels a standing trigger order.",
} as const;
