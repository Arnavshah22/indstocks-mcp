/**
 * Response shapes for the INDstocks REST API.
 *
 * Until now every tool handed the raw JSON straight to the model. That works
 * right up until the API changes a field name, at which point the tool keeps
 * returning 200 and the model confidently describes a payload that no longer says
 * what it used to. Schemas turn that silent drift into a stated warning.
 *
 * ## The posture: validate, then degrade — never throw
 *
 * A read-only data tool must not break because the API added a field. So every
 * object is `passthrough()` (unknown keys survive untouched), only the fields a
 * consumer actually depends on are required, and a mismatch returns the payload
 * anyway alongside an explicit warning. Same shape as the CAS reconciliation
 * check: keep answering, but say plainly when the data is not what was expected.
 *
 * ## Only what the docs actually show
 *
 * Every schema here is transcribed from a documented example response at
 * https://api-docs.indstocks.com/. The order book is deliberately absent — its
 * shape is not published, and inventing field names would recreate exactly the
 * guessing this file exists to remove. It passes through unchecked and says so.
 */

import { z } from "zod";
import type { EndpointName } from "./endpoints.js";

/* ------------------------------------------------------------- envelopes -- */

/**
 * Two envelopes are in play: most endpoints return `{status, data}`, historical
 * data returns `{success, data}`. Unwrapping here means tools return the payload
 * a caller wants rather than making the model dig through a wrapper.
 */
export type EnvelopeKind = "status" | "success" | "none";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function unwrapEnvelope(raw: unknown): { data: unknown; envelope: EnvelopeKind } {
  if (isRecord(raw) && "data" in raw) {
    if (typeof raw.status === "string") return { data: raw.data, envelope: "status" };
    if (typeof raw.success === "boolean") return { data: raw.data, envelope: "success" };
  }
  return { data: raw, envelope: "none" };
}

/* --------------------------------------------------------------- account -- */

export const ProfileSchema = z
  .object({
    user_id: z.string(),
    email: z.string().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    demat_id: z.string().optional(),
    ucc: z.string().optional(),
    is_nse_onboarded: z.boolean().optional(),
    is_bse_onboarded: z.boolean().optional(),
    is_nse_fno_onboarded: z.boolean().optional(),
    is_bse_fno_onboarded: z.boolean().optional(),
    is_ddpi_active: z.boolean().optional(),
  })
  .passthrough();
export type Profile = z.infer<typeof ProfileSchema>;

export const FundsSchema = z
  .object({
    sod_balance: z.number().optional(),
    withdrawal_balance: z.number().optional(),
    // Per-product buying power: eq_cnc, eq_mis, future, option_buy, and so on.
    detailed_avl_balance: z.record(z.string(), z.number()).optional(),
    pledge_received: z.number().optional(),
    pledge_remained: z.number().optional(),
    funds_added: z.number().optional(),
    funds_withdrawn: z.number().optional(),
    realized_pnl: z.number().optional(),
    unrealized_pnl: z.number().optional(),
    brokerage: z.number().optional(),
    eq_charges: z.number().optional(),
    fno_charges: z.number().optional(),
  })
  .passthrough();
export type Funds = z.infer<typeof FundsSchema>;

/* ------------------------------------------------------------- portfolio -- */

/**
 * Note what is *not* here: no price, no market value, no P&L. Valuing a holding
 * means joining it against quotes by security_id — see normaliseHoldings.
 */
export const HoldingSchema = z
  .object({
    security_id: z.string(),
    symbol: z.string(),
    isin: z.string().optional(),
    total_qty: z.number(),
    used_qty: z.number().optional(),
    avg_price: z.number(),
    t1_qty: z.number().optional(),
    t1_avg_price: z.number().optional(),
    dp_qty: z.number().optional(),
    dp_avg_price: z.number().optional(),
  })
  .passthrough();
export type Holding = z.infer<typeof HoldingSchema>;
export const HoldingsSchema = z.array(HoldingSchema);

export const PositionRowSchema = z
  .object({
    position_id: z.string().optional(),
    security_id: z.string(),
    symbol: z.string(),
    segment: z.string().optional(),
    product: z.string().optional(),
    exchange: z.string().optional(),
    isin: z.string().optional(),
    net_qty: z.number(),
    avg_price: z.number().optional(),
    realized_profit: z.number().optional(),
    // Derivative legs; absent on an equity position.
    drv_instrument: z.string().optional(),
    drv_expiry_date: z.string().optional(),
    drv_option_type: z.string().optional(),
    drv_strike_price: z.number().optional(),
    buy_qty: z.number().optional(),
    buy_avg: z.number().optional(),
    sell_qty: z.number().optional(),
    sell_avg: z.number().optional(),
    day_buy_qty: z.number().optional(),
    day_buy_val: z.number().optional(),
    day_sell_qty: z.number().optional(),
    day_sell_val: z.number().optional(),
    cf_buy_qty: z.number().optional(),
    cf_buy_val: z.number().optional(),
    cf_sell_qty: z.number().optional(),
    cf_sell_val: z.number().optional(),
  })
  .passthrough();
export type PositionRow = z.infer<typeof PositionRowSchema>;
export const PositionsSchema = z.array(PositionRowSchema);

/* ----------------------------------------------------------- market data -- */

/**
 * The last traded price is `live_price`, not `ltp` — the WebSocket feed calls the
 * same number `ltp`, and mixing the two up yields undefined rather than an error.
 */
export const QuoteSchema = z
  .object({
    live_price: z.number(),
    day_change: z.number().optional(),
    day_change_percentage: z.number().optional(),
    day_open: z.number().optional(),
    day_high: z.number().optional(),
    day_low: z.number().optional(),
    prev_close: z.number().optional(),
    "52week_high": z.number().optional(),
    "52week_low": z.number().optional(),
    upper_circuit: z.number().optional(),
    lower_circuit: z.number().optional(),
    volume: z.number().optional(),
    market_depth: z.unknown().optional(),
  })
  .passthrough();
export type Quote = z.infer<typeof QuoteSchema>;

/** Keyed by scrip code: `{ "NSE_3045": { live_price: 788.8, … } }`. */
export const QuotesSchema = z.record(z.string(), QuoteSchema);

/** `ts` is epoch *seconds* here, while the request took epoch milliseconds. */
export const CandleSchema = z
  .object({
    ts: z.number(),
    o: z.number(),
    h: z.number(),
    l: z.number(),
    c: z.number(),
    v: z.number(),
  })
  .passthrough();
export type Candle = z.infer<typeof CandleSchema>;

export const HistoricalSchema = z.record(
  z.string(),
  z.object({ candles: z.array(CandleSchema) }).passthrough(),
);

/* ---------------------------------------------------------------- registry */

/**
 * `orderBook` is intentionally missing: its response is not in the published docs.
 * Guessing field names here would put back exactly the invented-shape problem this
 * module removes, so it passes through unchecked and the tool says so.
 *
 * `instruments` is absent too — it arrives as CSV or JSON through getText and has
 * its own parser in instruments.ts.
 */
const RESPONSE_SCHEMAS: Partial<Record<EndpointName, z.ZodTypeAny>> = {
  profile: ProfileSchema,
  funds: FundsSchema,
  holdings: HoldingsSchema,
  positions: PositionsSchema,
  quotesFull: QuotesSchema,
  quotesLtp: QuotesSchema,
  historical: HistoricalSchema,
};

export interface ParsedResponse {
  /** The unwrapped payload — parsed when a schema matched, raw otherwise. */
  data: unknown;
  envelope: EnvelopeKind;
  validated: boolean;
  warnings: string[];
}

/**
 * Unwrap and validate a response.
 *
 * Never throws and never withholds data: a mismatch still returns the payload,
 * with warnings saying what did not line up. The caller decides how loudly to
 * report it; the model should treat unvalidated numbers with suspicion rather than
 * presenting them as fact.
 */
export function parseResponse(endpoint: EndpointName, raw: unknown): ParsedResponse {
  const { data, envelope } = unwrapEnvelope(raw);
  const schema = RESPONSE_SCHEMAS[endpoint];

  if (!schema) {
    return {
      data,
      envelope,
      validated: false,
      warnings: [
        `No response schema exists for '${endpoint}' because its shape is not published. ` +
          "The payload is passed through unchecked — read the field names before relying on them.",
      ],
    };
  }

  const result = schema.safeParse(data);
  if (result.success) {
    return { data: result.data, envelope, validated: true, warnings: [] };
  }

  return {
    data,
    envelope,
    validated: false,
    warnings: [
      `The '${endpoint}' response did not match the shape documented at ` +
        "https://api-docs.indstocks.com/. The payload is returned unchanged, but the API " +
        "may have changed: check the fields before trusting these values.",
      // A handful of issues is diagnostic; the whole list is noise.
      ...result.error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    ],
  };
}

/* -------------------------------------------------------- normalisation --- */

export interface NormalisedHolding {
  securityId: string;
  symbol: string;
  isin: string | null;
  quantity: number;
  averagePrice: number;
  /**
   * Scrip code for the quote lookup, *assuming NSE*. Holdings carry no exchange
   * field, so this is a construction rather than something the API stated — check
   * it before using it for a BSE-only listing.
   */
  scripCodeAssumingNse: string;
}

/**
 * Reshape holdings into the vocabulary the analytics layer speaks.
 *
 * The API says `total_qty` and `avg_price`; `analyze_allocation` wants `quantity`
 * and a price. This does the renaming in one documented place instead of leaving
 * every caller to rediscover it — and it cannot fill in `lastPrice`, because
 * holdings genuinely do not carry one. Join with get_quotes for that.
 */
export function normaliseHoldings(holdings: Holding[]): NormalisedHolding[] {
  return holdings.map((holding) => ({
    securityId: holding.security_id,
    symbol: holding.symbol,
    isin: holding.isin ?? null,
    quantity: holding.total_qty,
    averagePrice: holding.avg_price,
    scripCodeAssumingNse: `NSE_${holding.security_id}`,
  }));
}
