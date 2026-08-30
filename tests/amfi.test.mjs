// AMFI NAV feed parsing.
//
// The feed is a semicolon-delimited dump with AMC names and category headers
// interleaved between data rows, and AMFI has widened it once already: `Plan` and
// `Option` were inserted between the scheme name and the NAV, taking rows from six
// fields to eight. Reading the NAV by fixed index then produced NaN for every row
// and the entire fund universe came back empty — with no error, because an empty
// universe looks exactly like a search that matched nothing.
//
// These tests pin both layouts so that failure mode cannot return.

import test from "node:test";
import assert from "node:assert/strict";

import { parseNavAll } from "../dist/amfi.js";

const CURRENT = [
  "Scheme Code;ISIN Div Payout/ ISIN Growth;ISIN Div Reinvestment;Scheme Name;Plan;Option;Net Asset Value;Date",
  " ",
  "Open Ended Schemes(Equity Scheme - Flexi Cap Fund)",
  " ",
  "PPFAS Mutual Fund",
  " ",
  "122639;INF879O01027;-;Parag Parikh Flexi Cap Fund;Direct Plan;Growth;91.1767;28-Aug-2026",
  "122640;INF879O01019;-;Parag Parikh Flexi Cap Fund;Regular Plan;Growth;83.0832;28-Aug-2026",
  "999999;INF000000001;-;Suspended Fund;Direct Plan;Growth;N.A.;28-Aug-2026",
].join("\r\n");

const LEGACY = [
  "Scheme Code;ISIN Div Payout/ISIN Growth;ISIN Div Reinvestment;Scheme Name;Net Asset Value;Date",
  " ",
  "Open Ended Schemes(Equity Scheme - Large Cap Fund)",
  " ",
  "Axis Mutual Fund",
  " ",
  "112277;INF846K01131;-;Axis Bluechip Fund - Direct Plan - Growth;70.1234;28-Aug-2026",
].join("\r\n");

test("parses the current eight-column feed", () => {
  const schemes = parseNavAll(CURRENT);
  assert.equal(schemes.length, 2, "the N.A. row is skipped, the two priced rows are not");

  const [direct, regular] = schemes;
  assert.equal(direct.schemeCode, "122639");
  assert.equal(direct.isinGrowth, "INF879O01027");
  assert.equal(direct.nav, 91.1767);
  assert.equal(direct.date, "28-Aug-2026");
  assert.equal(direct.plan, "Direct Plan");
  assert.equal(direct.option, "Growth");
  assert.equal(regular.nav, 83.0832);
});

test("recombines plan and option into the searchable scheme name", () => {
  // Plan and option used to be inside the name column. A query like
  // "parag parikh flexi cap direct growth" only matches if they still are.
  const [direct] = parseNavAll(CURRENT);
  assert.equal(direct.schemeName, "Parag Parikh Flexi Cap Fund - Direct Plan - Growth");
  const haystack = direct.schemeName.toUpperCase();
  for (const term of ["PARAG", "PARIKH", "FLEXI", "DIRECT", "GROWTH"]) {
    assert.ok(haystack.includes(term), `search term ${term} must still match the name`);
  }
});

test("still parses the legacy six-column feed", () => {
  const [scheme] = parseNavAll(LEGACY);
  assert.equal(scheme.schemeCode, "112277");
  assert.equal(scheme.schemeName, "Axis Bluechip Fund - Direct Plan - Growth");
  assert.equal(scheme.nav, 70.1234);
  assert.equal(scheme.date, "28-Aug-2026");
  assert.equal(scheme.plan, null);
  assert.equal(scheme.option, null);
});

test("tracks the interleaved AMC and category headers", () => {
  const [scheme] = parseNavAll(CURRENT);
  assert.equal(scheme.amc, "PPFAS Mutual Fund");
  assert.equal(scheme.category, "Open Ended Schemes(Equity Scheme - Flexi Cap Fund)");
});

test("a widened feed does not empty the universe", () => {
  // The regression itself: every row silently dropped, no error raised.
  assert.ok(parseNavAll(CURRENT).length > 0, "eight-column rows must survive parsing");
  assert.ok(parseNavAll(LEGACY).length > 0, "six-column rows must survive parsing");
});
