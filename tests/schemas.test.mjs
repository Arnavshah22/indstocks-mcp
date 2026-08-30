// Response schemas.
//
// The failure these guard against is quiet: the API renames a field, the endpoint
// keeps returning 200, and the model describes a payload that no longer says what
// it used to. So the assertions below care about two things — that a good payload
// validates cleanly, and that a drifted one is flagged *without* the data being
// withheld. A schema that throws would just trade a silent wrong answer for a
// broken tool.

import test from "node:test";
import assert from "node:assert/strict";

import {
  unwrapEnvelope,
  parseResponse,
  normaliseHoldings,
  HoldingSchema,
  QuoteSchema,
} from "../dist/schemas.js";

const HOLDING = {
  security_id: "18520",
  symbol: "CUPID",
  isin: "INE509F01029",
  total_qty: 1,
  used_qty: 0,
  avg_price: 217.3,
  t1_qty: 1,
  t1_avg_price: 217.3,
  dp_qty: 0,
  dp_avg_price: 0,
};

/* ------------------------------------------------------------- envelopes -- */

test("unwraps both documented envelopes and leaves bare payloads alone", () => {
  assert.deepEqual(unwrapEnvelope({ status: "success", data: [1, 2] }), {
    data: [1, 2],
    envelope: "status",
  });
  // Historical data uses {success, data}; everything else uses {status, data}.
  assert.deepEqual(unwrapEnvelope({ success: true, data: { a: 1 } }), {
    data: { a: 1 },
    envelope: "success",
  });
  assert.deepEqual(unwrapEnvelope({ a: 1 }), { data: { a: 1 }, envelope: "none" });
  assert.deepEqual(unwrapEnvelope([1, 2]), { data: [1, 2], envelope: "none" });
});

test("an object with data but no status marker is not treated as an envelope", () => {
  // Unwrapping this would silently discard sibling fields.
  const raw = { data: { x: 1 }, somethingElse: 2 };
  assert.equal(unwrapEnvelope(raw).envelope, "none");
});

/* -------------------------------------------------------------- holdings -- */

test("validates a documented holdings payload", () => {
  const parsed = parseResponse("holdings", { status: "success", data: [HOLDING] });
  assert.equal(parsed.validated, true);
  assert.deepEqual(parsed.warnings, []);
  assert.equal(parsed.envelope, "status");
  assert.equal(parsed.data[0].symbol, "CUPID");
});

test("keeps unknown fields instead of stripping them", () => {
  // The API adding a field must never break a read-only tool.
  const parsed = parseResponse("holdings", {
    status: "success",
    data: [{ ...HOLDING, brand_new_field: "hello" }],
  });
  assert.equal(parsed.validated, true);
  assert.equal(parsed.data[0].brand_new_field, "hello");
});

test("flags a missing required field but still returns the payload", () => {
  const { avg_price, ...withoutPrice } = HOLDING;
  const parsed = parseResponse("holdings", { status: "success", data: [withoutPrice] });

  assert.equal(parsed.validated, false);
  assert.match(parsed.warnings[0], /did not match the shape documented/);
  assert.ok(parsed.warnings.some((w) => w.includes("avg_price")), "names the offending field");
  // Withholding data would turn a shape change into a broken tool.
  assert.equal(parsed.data[0].symbol, "CUPID");
});

test("flags a field that changed type", () => {
  const parsed = parseResponse("holdings", {
    status: "success",
    data: [{ ...HOLDING, total_qty: "1" }],
  });
  assert.equal(parsed.validated, false);
  assert.ok(parsed.warnings.some((w) => w.includes("total_qty")));
});

/* ---------------------------------------------------------------- quotes -- */

test("validates a quotes payload keyed by scrip code", () => {
  const parsed = parseResponse("quotesFull", {
    status: "success",
    data: { NSE_3045: { live_price: 788.8, day_change: -3.5, volume: 3546732 } },
  });
  assert.equal(parsed.validated, true);
  assert.equal(parsed.data.NSE_3045.live_price, 788.8);
});

test("rejects a quote that uses the WebSocket's field name", () => {
  // REST says live_price; the socket says ltp. Reading the wrong one yields
  // undefined rather than an error, so this must not pass validation.
  const parsed = parseResponse("quotesLtp", {
    status: "success",
    data: { NSE_3045: { ltp: 792.5 } },
  });
  assert.equal(parsed.validated, false);
  assert.ok(parsed.warnings.some((w) => w.includes("live_price")));
});

test("accepts the 52-week fields whose names start with a digit", () => {
  const result = QuoteSchema.safeParse({
    live_price: 100,
    "52week_high": 899,
    "52week_low": 680,
  });
  assert.equal(result.success, true);
  assert.equal(result.data["52week_high"], 899);
});

/* ------------------------------------------------------------ historical -- */

test("validates candles under the success envelope", () => {
  const parsed = parseResponse("historical", {
    success: true,
    data: { NSE_1594: { candles: [{ ts: 1782877500, o: 1007, h: 1013.9, l: 999.3, c: 1000.4, v: 2847163 }] } },
  });
  assert.equal(parsed.validated, true);
  assert.equal(parsed.envelope, "success");
  assert.equal(parsed.data.NSE_1594.candles[0].c, 1000.4);
});

test("flags a malformed candle", () => {
  const parsed = parseResponse("historical", {
    success: true,
    data: { NSE_1594: { candles: [{ ts: 1782877500, o: 1007 }] } },
  });
  assert.equal(parsed.validated, false);
});

/* ------------------------------------------------------------ undocumented */

test("passes the order book through unchecked and says why", () => {
  // Its shape is not published. Inventing field names here would recreate the
  // guessing these schemas exist to remove.
  const parsed = parseResponse("orderBook", { status: "success", data: [{ anything: true }] });
  assert.equal(parsed.validated, false);
  assert.match(parsed.warnings[0], /not published/);
  assert.equal(parsed.data[0].anything, true, "the payload still comes through");
});

/* ------------------------------------------------------- account payloads -- */

test("validates profile and funds", () => {
  const profile = parseResponse("profile", {
    status: "success",
    data: { user_id: "1234567", email: "a@b.com", is_ddpi_active: true },
  });
  assert.equal(profile.validated, true);
  assert.equal(profile.data.user_id, "1234567");

  const funds = parseResponse("funds", {
    status: "success",
    data: {
      sod_balance: 4996.47,
      withdrawal_balance: 2983.47,
      detailed_avl_balance: { eq_cnc: 2980.4, future: 2980.4 },
      realized_pnl: -751.92,
    },
  });
  assert.equal(funds.validated, true);
  assert.equal(funds.data.detailed_avl_balance.eq_cnc, 2980.4);
});

/* ---------------------------------------------------------- normalisation -- */

test("renames holdings into the vocabulary analytics speaks", () => {
  const [row] = normaliseHoldings([HOLDING]);
  assert.deepEqual(row, {
    securityId: "18520",
    symbol: "CUPID",
    isin: "INE509F01029",
    quantity: 1,
    averagePrice: 217.3,
    scripCodeAssumingNse: "NSE_18520",
  });
});

test("normalisation does not invent a last price", () => {
  // Holdings genuinely carry no price; manufacturing one would be the exact
  // failure mode the reconciliation and provenance work exists to prevent.
  const [row] = normaliseHoldings([HOLDING]);
  assert.ok(!("lastPrice" in row));
  assert.ok(!("marketValue" in row));
});

test("a holding with no ISIN normalises to null rather than undefined", () => {
  const { isin, ...withoutIsin } = HOLDING;
  const parsed = HoldingSchema.parse(withoutIsin);
  assert.equal(normaliseHoldings([parsed])[0].isin, null);
});
