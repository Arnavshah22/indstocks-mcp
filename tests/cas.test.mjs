// CAS parser tests. Run with `npm test` (builds first, then exercises dist/).
//
// These fixtures are synthetic, modelled on the CAMS/KFintech DETAILED layout.
// They are not real statements — no real CAS is committed to this repo, and none
// should be. What they pin down is the parsing contract: column assignment,
// transaction classification, sign conventions, and the reconciliation that is
// supposed to catch a mis-parse rather than let it through as a confident number.

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseCasText,
  parseTransactionRow,
  parseNumberCell,
  classifyTransaction,
  toIsoDate,
  maskPan,
  holdings,
  cashFlows,
} from "../dist/cas.js";

const RECONCILING = `
Consolidated Account Statement
01-Apr-2023 To 31-Mar-2024
KFINCASWS
PPFAS Mutual Fund
Folio No: 12345678 / 90 PAN: ABCDE1234F KYC: OK PAN: OK
PP01-Parag Parikh Flexi Cap Fund - Direct Plan - Growth (Advisor: DIRECT) Registrar : KFINTECH
ISIN: INF879O01019
Opening Unit Balance: 100.000
05-Apr-2023 Purchase 10,000.00 200.000 50.0000 300.000
05-May-2023 Systematic Investment Instalment 1 5,000.00 100.000 50.0000 400.000
05-May-2023 *** Stamp Duty *** 0.25
10-Jun-2023 Redemption (2,500.00) (50.000) 50.0000 350.000
20-Aug-2023 IDCW Payout @ Rs. 2.50 per unit 875.00
01-Jan-2024 ***Registration of Nominee***
Closing Unit Balance: 350.000
NAV on 31-Mar-2024: INR 60.0000
Valuation on 31-Mar-2024: INR 21,000.00
`;

test("parses the statement envelope", () => {
  const cas = parseCasText(RECONCILING);
  assert.equal(cas.fileType, "KFINTECH");
  assert.equal(cas.statementType, "DETAILED");
  assert.deepEqual(cas.period, { from: "2023-04-01", to: "2024-03-31" });
  assert.equal(cas.folios.length, 1);
});

test("captures folio identity and masks the PAN", () => {
  const [folio] = parseCasText(RECONCILING).folios;
  assert.equal(folio.folio, "12345678/90");
  assert.equal(folio.amc, "PPFAS Mutual Fund");
  assert.equal(folio.kycOk, true);
  assert.equal(folio.pan, "ABCDE****F");
  // Only the complete PAN is the identifier worth suppressing — the folio number
  // legitimately contains the same run of digits.
  assert.ok(!JSON.stringify(folio).includes("ABCDE1234F"), "the intact PAN must not survive");
});

test("captures the scheme header including a wrapped ISIN line", () => {
  const [scheme] = parseCasText(RECONCILING).folios[0].schemes;
  assert.equal(scheme.isin, "INF879O01019");
  assert.equal(scheme.rta, "KFINTECH");
  assert.equal(scheme.advisor, "DIRECT");
  assert.match(scheme.name, /Parag Parikh Flexi Cap Fund/);
  // The advisor, ISIN and registrar markers are metadata, not part of the name.
  assert.ok(!/Advisor|ISIN|Registrar/i.test(scheme.name), scheme.name);
});

test("a NAV row does not open a phantom scheme", () => {
  // SCHEME_CODE_RE matches the "NAV on 31-" prefix, so without the labelled-row
  // guard this statement parses as two schemes and loses the transactions.
  const [folio] = parseCasText(RECONCILING).folios;
  assert.equal(folio.schemes.length, 1);
  assert.equal(folio.schemes[0].nav, 60);
  assert.equal(folio.schemes[0].navDate, "2024-03-31");
  assert.equal(folio.schemes[0].valuation, 21000);
});

test("assigns transaction columns from the right", () => {
  const [scheme] = parseCasText(RECONCILING).folios[0].schemes;
  const byDesc = Object.fromEntries(scheme.transactions.map((t) => [t.description, t]));

  const purchase = byDesc["Purchase"];
  assert.deepEqual(
    { a: purchase.amount, u: purchase.units, n: purchase.nav, b: purchase.balance },
    { a: 10000, u: 200, n: 50, b: 300 },
  );

  // KFintech leaks the instalment number into the description column. The four
  // table columns are still the last four numerics; the stray "1" stays put.
  const sip = byDesc["Systematic Investment Instalment 1"];
  assert.ok(sip, "instalment-number row should keep its trailing digit in the description");
  assert.deepEqual({ a: sip.amount, u: sip.units, n: sip.nav, b: sip.balance }, {
    a: 5000, u: 100, n: 50, b: 400,
  });
});

test("classifies transactions and reads accounting negatives", () => {
  const [scheme] = parseCasText(RECONCILING).folios[0].schemes;
  const types = Object.fromEntries(scheme.transactions.map((t) => [t.type, t]));

  assert.ok(types.PURCHASE);
  assert.ok(types.PURCHASE_SIP);
  assert.equal(types.REDEMPTION.units, -50);
  assert.equal(types.REDEMPTION.amount, -2500);
  assert.equal(types.STAMP_DUTY_TAX.amount, 0.25);
  assert.equal(types.STAMP_DUTY_TAX.units, null);
  assert.equal(types.DIVIDEND_PAYOUT.dividendRate, 2.5);
  // A dated marker row carries no figures at all and must not be forced into a column.
  assert.equal(types.MISC.amount, null);
  assert.equal(types.MISC.units, null);
});

test("reconciles units and valuation against the statement's own totals", () => {
  const [scheme] = parseCasText(RECONCILING).folios[0].schemes;
  const r = scheme.reconciliation;
  assert.equal(r.ok, true, r.issues.join(" | "));
  assert.equal(r.computedClosing, 350);
  assert.equal(r.statedClosing, 350);
  assert.equal(r.computedValuation, 21000);
});

test("flags a scheme whose units do not reconcile", () => {
  const broken = RECONCILING.replace("Closing Unit Balance: 350.000", "Closing Unit Balance: 999.000");
  const [scheme] = parseCasText(broken).folios[0].schemes;
  assert.equal(scheme.reconciliation.ok, false);
  assert.match(scheme.reconciliation.issues.join(" "), /does not reconcile/i);
  assert.equal(holdings(parseCasText(broken))[0].reconciled, false);
});

test("flags a scheme whose valuation does not reconcile", () => {
  const broken = RECONCILING.replace("INR 21,000.00", "INR 33,000.00");
  const [scheme] = parseCasText(broken).folios[0].schemes;
  assert.equal(scheme.reconciliation.ok, false);
  assert.match(scheme.reconciliation.issues.join(" "), /Valuation does not reconcile/i);
});

test("reports an ambiguous row instead of guessing at its columns", () => {
  const odd = RECONCILING.replace(
    "01-Jan-2024 ***Registration of Nominee***",
    "01-Jan-2024 Unlabelled Thing 100.00 200.00",
  );
  const cas = parseCasText(odd);
  assert.equal(cas.warnings.length, 1);
  assert.match(cas.warnings[0], /Ambiguous transaction row/);
});

test("holdings summarise one row per scheme with a live balance", () => {
  const rows = holdings(parseCasText(RECONCILING));
  assert.equal(rows.length, 1);
  assert.deepEqual(
    { units: rows[0].units, isin: rows[0].isin, value: rows[0].statementValue, ok: rows[0].reconciled },
    { units: 350, isin: "INF879O01019", value: 21000, ok: true },
  );
});

test("builds XIRR-ready cash flows with outflows negative", () => {
  const { flows } = cashFlows(parseCasText(RECONCILING));
  const byDate = Object.fromEntries(flows.map((f) => [f.date + ":" + f.amount, true]));

  assert.ok(byDate["2023-04-05:-10000"], "purchase is money leaving the investor");
  assert.ok(byDate["2023-05-05:-5000"], "SIP instalment is an outflow");
  assert.ok(byDate["2023-05-05:-0.25"], "stamp duty is an outflow");
  assert.ok(byDate["2023-06-10:2500"], "redemption is an inflow regardless of printed sign");
  assert.ok(byDate["2023-08-20:875"], "dividend payout is an inflow");
  assert.ok(byDate["2024-03-31:21000"], "terminal value closes the series");

  assert.deepEqual([...flows].sort((a, b) => a.date.localeCompare(b.date)), flows, "sorted by date");
  assert.ok(flows.some((f) => f.amount < 0) && flows.some((f) => f.amount > 0), "XIRR needs both signs");
});

const WITH_SWITCH = `
Consolidated Account Statement
01-Apr-2023 To 31-Mar-2024
CAMSCASWS
Axis Mutual Fund
Folio No: 99887766 PAN: ZZZZZ9999Z KYC: OK
AX01-Axis Bluechip Fund - Direct Growth Registrar : CAMS
ISIN: INF846K01131
Opening Unit Balance: 0.000
05-Apr-2023 Purchase 20,000.00 400.000 50.0000 400.000
15-Jul-2023 Switch Out to Axis Midcap (5,000.00) (100.000) 50.0000 300.000
Closing Unit Balance: 300.000
NAV on 31-Mar-2024: INR 70.0000
Valuation on 31-Mar-2024: INR 21,000.00
`;

test("switches are internal at portfolio scope and real at scheme scope", () => {
  const cas = parseCasText(WITH_SWITCH);
  const [scheme] = cas.folios[0].schemes;
  assert.equal(scheme.transactions[1].type, "SWITCH_OUT");
  assert.equal(scheme.reconciliation.ok, true, scheme.reconciliation.issues.join(" | "));

  const portfolio = cashFlows(cas, { scope: "portfolio" });
  assert.ok(
    !portfolio.flows.some((f) => f.amount === 5000),
    "a switch moves units between schemes; no rupee crosses the portfolio boundary",
  );

  const perScheme = cashFlows(cas, { scope: "scheme" });
  assert.ok(
    perScheme.flows.some((f) => f.date === "2023-07-15" && f.amount === 5000),
    "measuring one scheme alone, a switch out is a real inflow",
  );
});

test("names unreconciled schemes so callers can refuse to do arithmetic on them", () => {
  const broken = RECONCILING.replace("Closing Unit Balance: 350.000", "Closing Unit Balance: 12.000");
  const { unreconciledSchemes } = cashFlows(parseCasText(broken));
  assert.equal(unreconciledSchemes.length, 1);
  assert.match(unreconciledSchemes[0], /12345678\/90/);
});

test("parses multiple AMCs and folios in one statement", () => {
  const cas = parseCasText(RECONCILING + WITH_SWITCH.split("CAMSCASWS")[1]);
  assert.equal(cas.folios.length, 2);
  assert.deepEqual(cas.folios.map((f) => f.amc), ["PPFAS Mutual Fund", "Axis Mutual Fund"]);
});

/* ----------------------------------------------------------------- units --- */

test("parseNumberCell handles commas and accounting parentheses", () => {
  assert.equal(parseNumberCell("10,000.00"), 10000);
  assert.equal(parseNumberCell("(2,500.50)"), -2500.5);
  assert.equal(parseNumberCell("-50.000"), -50);
  assert.equal(parseNumberCell("0.001"), 0.001);
  assert.equal(parseNumberCell("N.A."), null);
  assert.equal(parseNumberCell(""), null);
});

test("toIsoDate accepts the spacing variants that appear in extracted text", () => {
  assert.equal(toIsoDate("05-Apr-2023"), "2023-04-05");
  assert.equal(toIsoDate("5 Apr 2023"), "2023-04-05");
  assert.equal(toIsoDate("05Apr2023"), "2023-04-05");
  assert.equal(toIsoDate("2023-04-05"), null);
});

test("maskPan replaces the numeric block only", () => {
  assert.equal(maskPan("ABCDE1234F"), "ABCDE****F");
});

test("classifier separates SIP, switch, merger and reversal", () => {
  assert.equal(classifyTransaction("Purchase", 10).type, "PURCHASE");
  assert.equal(classifyTransaction("SIP Purchase", 10).type, "PURCHASE_SIP");
  assert.equal(classifyTransaction("Systematic Investment", 10).type, "PURCHASE_SIP");
  // KFintech letter-spaces "S T P", which no plain substring check would catch.
  assert.equal(classifyTransaction("S T P In", 10).type, "SWITCH_IN");
  assert.equal(classifyTransaction("Switch In - Merger", 10).type, "SWITCH_IN_MERGER");
  assert.equal(classifyTransaction("Redemption", -10).type, "REDEMPTION");
  assert.equal(classifyTransaction("Rejection - payment not received", -10).type, "REVERSAL");
  assert.equal(classifyTransaction("Gift Transfer In Folio No: 123", 10).type, "GIFT_IN");
  assert.equal(classifyTransaction("Reinvestment of IDCW @ Rs. 1.50", 5).type, "DIVIDEND_REINVEST");
  assert.equal(classifyTransaction("IDCW - Reinvest @ Rs. 1.50", 5).type, "DIVIDEND_REINVEST");
  assert.equal(classifyTransaction("Dividend @ Rs. 3.00 per unit", null).type, "DIVIDEND_PAYOUT");
});

test("parseTransactionRow rejects a line that is not a transaction", () => {
  assert.equal(parseTransactionRow("Opening Unit Balance: 100.000"), null);
  assert.equal(parseTransactionRow("PPFAS Mutual Fund"), null);
});
