// NSDL / CDSL depository statements.
//
// These fixtures are synthetic, modelled on the published layout. No real
// statement is committed here and none should be.
//
// The thing most worth pinning is the value column. A depository table has
// different columns per section, and a mutual fund row can append cost and returns
// after the market value — so the column is not chosen by convention but by which
// one sums to the total the statement itself prints. When none does, the holdings
// must come back without values rather than attributed to the wrong figure.

import test from "node:test";
import assert from "node:assert/strict";

import {
  parseDepositoryText,
  parseDepositoryRow,
  resolveValueColumn,
  detectDepositoryType,
  depositoryHoldings,
} from "../dist/casdepository.js";
import { parseStatement, hasTransactions } from "../dist/statement.js";

const NSDL = [
  "NSDL Consolidated Account Statement",
  "Statement for the period from 01-Apr-2024 to 30-Apr-2024",
  "JOHN DOE (PAN: ABCDE1234F)",
  "NSDL Demat Account",
  "DP ID: IN300214 Client ID: 12345678",
  "Equity Shares",
  "ISIN Security Quantity Price Value",
  "INE002A01018 RELIANCE INDUSTRIES LIMITED 100.000 1,400.00 1,40,000.00",
  "INE467B01029 TATA CONSULTANCY SERVICES LTD 50.000 3,200.00 1,60,000.00",
  "Sub Total 3,00,000.00",
  "Mutual Fund Folios",
  "INF879O01027 PARAG PARIKH FLEXI CAP FUND 350.000 91.18 31,913.00",
  "Sub Total 31,913.00",
  "This statement is computer generated and does not require a signature.",
].join("\n");

test("detects both depositories", () => {
  assert.equal(detectDepositoryType(NSDL), "NSDL");
  assert.equal(
    detectDepositoryType("Central Depository Services (India) Limited\nsomething"),
    "CDSL",
  );
  assert.equal(detectDepositoryType("CAMS Consolidated Account Statement"), null);
});

test("reads the statement envelope and masks the PAN", () => {
  const statement = parseDepositoryText(NSDL, "NSDL");
  assert.deepEqual(statement.period, { from: "2024-04-01", to: "2024-04-30" });
  assert.equal(statement.pan, "ABCDE****F");
  assert.ok(!JSON.stringify(statement).includes("ABCDE1234F"));
  assert.equal(statement.statementType, "DEPOSITORY");
  assert.equal(statement.hasTransactions, false);
});

test("splits the demat account from the mutual fund folios", () => {
  const statement = parseDepositoryText(NSDL, "NSDL");
  assert.equal(statement.accounts.length, 2);

  const [demat, folios] = statement.accounts;
  assert.equal(demat.kind, "demat");
  assert.equal(demat.dpId, "IN300214");
  assert.equal(demat.clientId, "12345678");
  assert.equal(demat.holdings.length, 2);

  assert.equal(folios.kind, "mf_folio");
  assert.equal(folios.holdings.length, 1);
});

test("resolves the value column against the statement's own total", () => {
  const [demat] = parseDepositoryText(NSDL, "NSDL").accounts;
  assert.equal(demat.reconciliation.ok, true, demat.reconciliation.issues.join(" | "));
  assert.equal(demat.reconciliation.valueColumnFromRight, 0);
  assert.equal(demat.reconciliation.computedValue, 300000);
  assert.equal(demat.reconciliation.statedValue, 300000);
  assert.equal(demat.reconciliation.delta, 0);

  const reliance = demat.holdings.find((h) => h.isin === "INE002A01018");
  assert.equal(reliance.quantity, 100);
  assert.equal(reliance.value, 140000, "Indian digit grouping parses correctly");
  assert.equal(reliance.name, "RELIANCE INDUSTRIES LIMITED");
});

test("reports no values when no column matches the total", () => {
  // Better to say "the value column could not be identified" than to hand back
  // the price column as though it were the market value.
  const broken = NSDL.replace("Sub Total 3,00,000.00", "Sub Total 9,99,999.00");
  const [demat] = parseDepositoryText(broken, "NSDL").accounts;

  assert.equal(demat.reconciliation.ok, false);
  assert.match(demat.reconciliation.issues.join(" "), /No column of figures sums/);
  assert.equal(demat.reconciliation.valueColumnFromRight, null);
  assert.ok(demat.holdings.every((h) => h.value === null));
  assert.ok(demat.holdings.every((h) => h.quantity !== null), "quantities are still read");
});

test("flags an account with no total row to check against", () => {
  const noTotal = NSDL.replace("Sub Total 3,00,000.00", "");
  const [demat] = parseDepositoryText(noTotal, "NSDL").accounts;
  assert.equal(demat.reconciliation.ok, false);
  assert.match(demat.reconciliation.issues.join(" "), /No total row/);
  assert.ok(demat.holdings.every((h) => h.value === null));
});

test("sums the section sub-totals within one account", () => {
  const twoSections = [
    "NSDL Consolidated Account Statement",
    "NSDL Demat Account",
    "DP ID: IN300214 Client ID: 12345678",
    "Equity Shares",
    "INE002A01018 RELIANCE INDUSTRIES LIMITED 100.000 1,400.00 1,40,000.00",
    "Sub Total 1,40,000.00",
    "Corporate Bonds",
    "INE123A08010 SOME BOND 2028 10.000 1,000.00 10,000.00",
    "Sub Total 10,000.00",
  ].join("\n");

  const [account] = parseDepositoryText(twoSections, "NSDL").accounts;
  assert.equal(account.reconciliation.statedValue, 150000, "two sub-totals add up");
  assert.equal(account.reconciliation.ok, true, account.reconciliation.issues.join(" | "));
  assert.equal(account.holdings.find((h) => h.isin === "INE123A08010").assetType, "bond");
});

test("classifies asset types from the ISIN and the section heading", () => {
  const statement = parseDepositoryText(NSDL, "NSDL");
  const rows = depositoryHoldings(statement);
  assert.equal(rows.find((r) => r.isin === "INE002A01018").assetType, "equity");
  // An INF ISIN is a fund whatever section it turns up under.
  assert.equal(rows.find((r) => r.isin === "INF879O01027").assetType, "mutual_fund");
});

test("only lines carrying an ISIN become holdings", () => {
  // Column headers, totals and the footer disclaimer all have to fall away, and
  // none of them are enumerated anywhere — the ISIN anchor does that work.
  const rows = depositoryHoldings(parseDepositoryText(NSDL, "NSDL"));
  assert.equal(rows.length, 3);
  assert.ok(!rows.some((r) => /computer generated|Sub Total|Quantity/i.test(r.name)));
});

test("a statement it cannot read says so instead of reporting an empty portfolio", () => {
  // The failure this replaces: NSDL files were detected, handed to the registrar
  // parser, and came back as zero holdings and zero rupees with no warning at all.
  const unreadable = "NSDL Consolidated Account Statement\nscanned image, no text rows";
  const statement = parseDepositoryText(unreadable, "NSDL");
  assert.equal(statement.accounts.length, 0);
  assert.equal(statement.warnings.length, 1);
  assert.match(statement.warnings[0], /Do not read this as an empty portfolio/);
});

/* ------------------------------------------------------------------ rows -- */

test("parseDepositoryRow separates name from figures", () => {
  const row = parseDepositoryRow(
    "INE002A01018 RELIANCE INDUSTRIES LIMITED 100.000 1,400.00 1,40,000.00",
    "equity",
  );
  assert.equal(row.isin, "INE002A01018");
  assert.equal(row.name, "RELIANCE INDUSTRIES LIMITED");
  assert.deepEqual(row.numerics, [100, 1400, 140000]);
});

test("parseDepositoryRow ignores a line with no ISIN", () => {
  assert.equal(parseDepositoryRow("Sub Total 3,00,000.00", "equity"), null);
  assert.equal(parseDepositoryRow("ISIN Security Quantity Price Value", null), null);
});

test("resolveValueColumn picks the matching column, or nothing", () => {
  const rows = [
    { isin: "A", name: "", assetType: "equity", numerics: [100, 1400, 140000] },
    { isin: "B", name: "", assetType: "equity", numerics: [50, 3200, 160000] },
  ];
  assert.equal(resolveValueColumn(rows, 300000), 0, "rightmost column is the value");
  assert.equal(resolveValueColumn(rows, 4600), 1, "matches the price column when asked to");
  assert.equal(resolveValueColumn(rows, 150), 2, "matches the quantity column");
  assert.equal(resolveValueColumn(rows, 12345), null, "no fit means no guess");
});

/* --------------------------------------------------------------- routing -- */

test("parseStatement routes each format to its own parser", () => {
  const depository = parseStatement(NSDL);
  assert.equal(depository.kind, "depository");
  assert.equal(depository.statement.fileType, "NSDL");
  assert.equal(hasTransactions(depository), false, "a snapshot supports no XIRR");

  const rta = parseStatement(
    [
      "Consolidated Account Statement",
      "01-Apr-2023 To 31-Mar-2024",
      "KFINCASWS",
      "PPFAS Mutual Fund",
      "Folio No: 12345678 / 90 PAN: ABCDE1234F KYC: OK",
      "PP01-Parag Parikh Flexi Cap Fund - Direct Plan - Growth Registrar : KFINTECH",
      "Opening Unit Balance: 100.000",
      "05-Apr-2023 Purchase 10,000.00 200.000 50.0000 300.000",
      "Closing Unit Balance: 300.000",
      "NAV on 31-Mar-2024: INR 60.0000",
      "Valuation on 31-Mar-2024: INR 18,000.00",
    ].join("\n"),
  );
  assert.equal(rta.kind, "rta");
  assert.equal(rta.statement.folios.length, 1);
  assert.equal(hasTransactions(rta), true);
});

test("a registrar statement that yields no folios warns rather than reporting nothing", () => {
  const routed = parseStatement("Consolidated Account Statement\nnothing parseable here");
  assert.equal(routed.kind, "rta");
  assert.equal(routed.statement.folios.length, 0);
  assert.match(routed.statement.warnings.join(" "), /Do not read this as an empty portfolio/);
});
