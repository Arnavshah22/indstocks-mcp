/**
 * NSDL / CDSL consolidated account statements.
 *
 * These are *depository* statements and a different animal from the CAMS/KFintech
 * ones in `cas.ts`:
 *
 *   - they cover **every demat account**, not just the INDmoney one, so they are
 *     the only view of equities held through other brokers;
 *   - they carry equities, bonds and mutual funds side by side;
 *   - and they are a **holdings snapshot, not a ledger**. There is no dated
 *     transaction history, which means no XIRR can be computed from one. Callers
 *     must refuse rather than produce a number from nothing.
 *
 * ## Why this is line-based and not column-based
 *
 * The reference implementation (casparser) parses these with fixed x-coordinate
 * column bands, plus a long tail of heuristics for rendering quirks — echoed
 * values, pledged holdings printing two numbers, lone digits landing in the wrong
 * column. That tuning is specific to one PDF engine's coordinate space, and
 * transplanting it blind to another would produce a parser that looks complete and
 * is quietly wrong about somebody's entire portfolio.
 *
 * So rows are anchored on the one token that is unambiguous and position
 * independent: the ISIN. Everything after it up to the first number is the
 * security name, and the numbers that follow are the figures.
 *
 * ## Which number is the value?
 *
 * That still leaves the question of which trailing column holds the market value —
 * these tables carry different columns for equity, MF and bond sections, and MF
 * rows can append cost and returns columns after it. Rather than guess, the
 * statement is asked: it prints "Sub Total" / "Total" rows, so the value column is
 * whichever one *sums to the stated total*. That is disambiguation by arithmetic,
 * not by convention, and when no column matches the holdings are returned flagged
 * rather than silently attributed to the wrong figure.
 */

import { maskPan, parseNumberCell, toIsoDate } from "./cas.js";

export type DepositoryType = "NSDL" | "CDSL";
export type DepositoryAssetType = "equity" | "mutual_fund" | "bond" | "other";

/** Equity and bond ISINs start INE/IN9; mutual fund units start INF. */
const ISIN_RE = /\b(IN[EF9][0-9A-Z]{8}\d)\b/;
const NUMERIC_TOKEN_RE = /^-?(?:[\d,]+(?:\.\d+)?|\.\d+)$/;

const PERIOD_RE =
  /period\s+(?:from\s+)?(\d{1,2}-[A-Za-z]{3}-\d{4})\s+to\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i;
const PAN_RE = /\(\s*PAN\s*:\s*([A-Z]{5}\d{4}[A-Z])\s*\)/i;
const DP_CLIENT_RE = /DP\s*ID\s*:?\s*(\S+?)\s+Client\s*ID\s*:?\s*(\w+)/i;
const DEMAT_HEADER_RE = /^(NSDL|CDSL)\s+Demat\s+Account\b/i;
const MF_FOLIO_HEADER_RE = /^Mutual\s+Fund\s+Folios\b/i;
const TOTAL_ROW_RE = /^(sub\s*total|grand\s*total|total)\b/i;

const SECTION_PATTERNS: Array<{ pattern: RegExp; type: DepositoryAssetType }> = [
  { pattern: /^Equity\s+Shares?\b/i, type: "equity" },
  { pattern: /^Mutual\s+Funds?\b/i, type: "mutual_fund" },
  { pattern: /^Corporate\s+Bonds?\b/i, type: "bond" },
  { pattern: /^Government\s+Securit/i, type: "bond" },
];

export interface DepositoryHolding {
  isin: string;
  name: string;
  assetType: DepositoryAssetType;
  quantity: number | null;
  /** Market value as stated. Null when no column reconciled to the totals. */
  value: number | null;
  /** Every number on the row, for when a column needs checking by hand. */
  figures: number[];
}

export interface DepositoryReconciliation {
  ok: boolean;
  computedValue: number | null;
  statedValue: number | null;
  delta: number | null;
  /** Which column from the right was taken as the value, once resolved. */
  valueColumnFromRight: number | null;
  issues: string[];
}

export interface DepositoryAccount {
  kind: "demat" | "mf_folio";
  depository: DepositoryType | null;
  dpId: string | null;
  clientId: string | null;
  holdings: DepositoryHolding[];
  reconciliation: DepositoryReconciliation;
}

export interface DepositoryStatement {
  fileType: DepositoryType;
  statementType: "DEPOSITORY";
  period: { from: string | null; to: string | null };
  /** Masked, as in the RTA parser: the digits are replaced. */
  pan: string | null;
  accounts: DepositoryAccount[];
  /**
   * Always empty. Depository statements are snapshots — there is no transaction
   * history in them, so nothing downstream should try to derive a return.
   */
  hasTransactions: false;
  warnings: string[];
}

/* ------------------------------------------------------------------ rows -- */

interface RawRow {
  isin: string;
  name: string;
  numerics: number[];
  assetType: DepositoryAssetType;
}

/**
 * Split a holdings row on its ISIN.
 *
 * Returns null for any line without one, which conveniently excludes headers,
 * totals, footers and disclaimer prose without needing to enumerate them.
 */
export function parseDepositoryRow(
  line: string,
  sectionType: DepositoryAssetType | null,
): RawRow | null {
  const match = ISIN_RE.exec(line);
  if (!match) return null;

  const isin = match[1]!.toUpperCase();
  const after = line.slice(match.index + isin.length).trim();
  const tokens = after.split(/\s+/).filter(Boolean);

  const nameParts: string[] = [];
  const numerics: number[] = [];
  for (const token of tokens) {
    if (NUMERIC_TOKEN_RE.test(token)) {
      const value = parseNumberCell(token);
      if (value !== null) {
        numerics.push(value);
        continue;
      }
    }
    // A word appearing after the numbers have started belongs to a trailing
    // column (a status flag, say), not to the security name.
    if (numerics.length === 0) nameParts.push(token);
  }

  // An ISIN's own prefix is the most reliable asset hint; INE covers both equity
  // and corporate bonds, so the section heading breaks that tie when present.
  const fromIsin: DepositoryAssetType = isin.startsWith("INF") ? "mutual_fund" : "equity";
  const assetType =
    sectionType && !(sectionType === "equity" && fromIsin === "mutual_fund")
      ? sectionType
      : fromIsin;

  return { isin, name: nameParts.join(" ").trim(), numerics, assetType };
}

/**
 * Work out which trailing column is the market value by matching the stated total.
 *
 * Checks the rightmost few columns and returns the offset whose column sums to the
 * total the statement prints. Null means no column matched, which is a signal to
 * flag the account rather than to pick one anyway.
 */
export function resolveValueColumn(
  rows: RawRow[],
  statedTotal: number,
  tolerance = 1,
): number | null {
  const maxOffset = Math.min(4, Math.max(...rows.map((row) => row.numerics.length), 0));
  for (let offset = 0; offset < maxOffset; offset++) {
    let sum = 0;
    let usable = 0;
    for (const row of rows) {
      const value = row.numerics[row.numerics.length - 1 - offset];
      if (typeof value === "number") {
        sum += value;
        usable++;
      }
    }
    if (usable === 0) continue;
    if (Math.abs(sum - statedTotal) <= Math.max(tolerance, Math.abs(statedTotal) * 0.005)) {
      return offset;
    }
  }
  return null;
}

/* ---------------------------------------------------------------- parser -- */

interface AccountDraft {
  kind: "demat" | "mf_folio";
  depository: DepositoryType | null;
  dpId: string | null;
  clientId: string | null;
  rows: RawRow[];
  statedTotal: number | null;
}

function finaliseAccount(draft: AccountDraft): DepositoryAccount {
  const issues: string[] = [];
  let valueOffset: number | null = null;

  if (draft.rows.length > 0 && draft.statedTotal !== null) {
    valueOffset = resolveValueColumn(draft.rows, draft.statedTotal);
    if (valueOffset === null) {
      issues.push(
        `No column of figures sums to the stated total of ${draft.statedTotal}. ` +
          "The value column could not be identified, so holdings are reported without values.",
      );
    }
  } else if (draft.rows.length > 0) {
    issues.push(
      "No total row was found for this account, so the value column could not be " +
        "confirmed against anything. Quantities are reported; values are not.",
    );
  }

  const holdings: DepositoryHolding[] = draft.rows.map((row) => ({
    isin: row.isin,
    name: row.name,
    assetType: row.assetType,
    // The first figure on the row is the balance in units or shares.
    quantity: row.numerics.length > 0 ? row.numerics[0]! : null,
    value:
      valueOffset === null
        ? null
        : row.numerics[row.numerics.length - 1 - valueOffset] ?? null,
    figures: row.numerics,
  }));

  const computed = holdings.reduce((sum, holding) => sum + (holding.value ?? 0), 0);
  const computedValue = valueOffset === null ? null : Math.round(computed * 100) / 100;
  const delta =
    computedValue !== null && draft.statedTotal !== null
      ? Math.round((computedValue - draft.statedTotal) * 100) / 100
      : null;

  return {
    kind: draft.kind,
    depository: draft.depository,
    dpId: draft.dpId,
    clientId: draft.clientId,
    holdings,
    reconciliation: {
      ok: issues.length === 0,
      computedValue,
      statedValue: draft.statedTotal,
      delta,
      valueColumnFromRight: valueOffset,
      issues,
    },
  };
}

export function detectDepositoryType(text: string): DepositoryType | null {
  if (text.includes("NSDL Consolidated Account Statement") || text.includes("About NSDL")) {
    return "NSDL";
  }
  if (text.includes("Central Depository Services (India) Limited")) return "CDSL";
  return null;
}

/**
 * Parse the text of an NSDL or CDSL statement.
 *
 * Structure is driven by whatever the document labels itself: account headers open
 * a section, total rows close it. Anything unrecognised is skipped rather than
 * forced into the previous account, and a statement that yields no holdings at all
 * says so in `warnings` instead of returning a confident-looking zero.
 */
export function parseDepositoryText(text: string, fileType: DepositoryType): DepositoryStatement {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const statement: DepositoryStatement = {
    fileType,
    statementType: "DEPOSITORY",
    period: { from: null, to: null },
    pan: null,
    accounts: [],
    hasTransactions: false,
    warnings: [],
  };

  let current: AccountDraft | null = null;
  let section: DepositoryAssetType | null = null;
  const drafts: AccountDraft[] = [];

  // Returns the draft rather than assigning it: writes to `current` have to happen
  // at the call site, or the compiler never sees it hold a non-null value and
  // narrows it to `never` at every read below.
  const openAccount = (
    kind: "demat" | "mf_folio",
    depository: DepositoryType | null,
  ): AccountDraft => {
    const draft: AccountDraft = {
      kind,
      depository,
      dpId: null,
      clientId: null,
      rows: [],
      statedTotal: null,
    };
    drafts.push(draft);
    return draft;
  };

  for (const line of lines) {
    if (!statement.period.from) {
      const period = PERIOD_RE.exec(line);
      if (period) {
        statement.period = { from: toIsoDate(period[1]!), to: toIsoDate(period[2]!) };
      }
    }
    if (!statement.pan) {
      const pan = PAN_RE.exec(line);
      if (pan) statement.pan = maskPan(pan[1]!.toUpperCase());
    }

    const demat = DEMAT_HEADER_RE.exec(line);
    if (demat) {
      current = openAccount("demat", demat[1]!.toUpperCase() as DepositoryType);
      section = null;
      continue;
    }
    if (MF_FOLIO_HEADER_RE.test(line)) {
      current = openAccount("mf_folio", null);
      section = null;
      continue;
    }

    if (current) {
      const ids = DP_CLIENT_RE.exec(line);
      if (ids) {
        current.dpId = ids[1]!;
        current.clientId = ids[2]!;
        continue;
      }
    }

    const sectionHit = SECTION_PATTERNS.find(({ pattern }) => pattern.test(line));
    if (sectionHit && !ISIN_RE.test(line)) {
      section = sectionHit.type;
      continue;
    }

    // A total row closes the current run of holdings. The last one seen wins, so
    // a "Grand Total" after several "Sub Total"s does not double count.
    if (TOTAL_ROW_RE.test(line) && !ISIN_RE.test(line)) {
      const numbers = line
        .split(/\s+/)
        .map((token) => (NUMERIC_TOKEN_RE.test(token) ? parseNumberCell(token) : null))
        .filter((value): value is number => value !== null);
      if (current && numbers.length > 0) {
        const total = numbers[numbers.length - 1]!;
        // Sum the section totals rather than taking the last: an account holding
        // both equities and funds prints one per section.
        current.statedTotal = /^sub\s*total/i.test(line)
          ? (current.statedTotal ?? 0) + total
          : current.statedTotal ?? total;
      }
      continue;
    }

    const row = parseDepositoryRow(line, section);
    if (row) {
      if (!current) {
        // Holdings before any account header: still real data, so keep them under
        // an unattributed account rather than dropping them.
        current = openAccount("demat", fileType);
      }
      current.rows.push(row);
    }
  }

  statement.accounts = drafts.filter((draft) => draft.rows.length > 0).map(finaliseAccount);

  if (statement.accounts.length === 0) {
    statement.warnings.push(
      `This looks like a ${fileType} statement, but no holdings could be read from it. ` +
        "Rows are located by ISIN, so an image-only or unusually formatted PDF will yield " +
        "nothing. Do not read this as an empty portfolio.",
    );
  }

  return statement;
}

/* ----------------------------------------------------------- derived view -- */

export interface DepositoryHoldingRow {
  account: string;
  depository: DepositoryType | null;
  isin: string;
  name: string;
  assetType: DepositoryAssetType;
  quantity: number | null;
  value: number | null;
  reconciled: boolean;
}

export function depositoryHoldings(statement: DepositoryStatement): DepositoryHoldingRow[] {
  const rows: DepositoryHoldingRow[] = [];
  for (const account of statement.accounts) {
    const label =
      account.dpId && account.clientId
        ? `${account.dpId}/${account.clientId}`
        : account.kind === "mf_folio"
          ? "Mutual fund folios"
          : "Demat account";
    for (const holding of account.holdings) {
      rows.push({
        account: label,
        depository: account.depository,
        isin: holding.isin,
        name: holding.name,
        assetType: holding.assetType,
        quantity: holding.quantity,
        value: holding.value,
        reconciled: account.reconciliation.ok,
      });
    }
  }
  return rows;
}
