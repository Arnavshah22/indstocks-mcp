/**
 * CAMS / KFintech Consolidated Account Statement parser.
 *
 * The INDstocks API covers equity, F&O and currency but not mutual funds, and
 * AMFI only publishes NAVs — the price of a fund, never *your* units in it. A CAS
 * is the one document that states what an investor actually holds across every
 * AMC, with the full transaction history behind it. That history is also the only
 * realistic source of dated cash flows for an honest XIRR.
 *
 * This module is deliberately pure text -> structured data. PDF decoding lives in
 * `caspdf.ts` so that the risky, format-sensitive half can be unit tested against
 * fixtures without a PDF engine in the loop.
 *
 * ## Correctness posture
 *
 * A silently mis-parsed statement is worse than no parser at all: it produces
 * confident, wrong rupee figures. So every scheme is reconciled against figures
 * the statement itself asserts —
 *
 *   opening balance + sum(transaction units) == closing balance
 *   closing balance * NAV                   == stated valuation
 *
 * and any scheme that fails is flagged. Callers are expected to refuse to do
 * arithmetic on an unreconciled scheme rather than quietly averaging it in.
 *
 * The layout follows the CAMS/KFin DETAILED CAS structure as implemented by
 * casparser (github.com/codereverser/casparser), which is the de-facto reference.
 * Field regexes below are modelled on that project's.
 */

export type CasFileType = "CAMS" | "KFINTECH" | "NSDL" | "CDSL" | "UNKNOWN";
export type CasStatementType = "DETAILED" | "SUMMARY" | "UNKNOWN";

export type CasTransactionType =
  | "PURCHASE"
  | "PURCHASE_SIP"
  | "REDEMPTION"
  | "DIVIDEND_PAYOUT"
  | "DIVIDEND_REINVEST"
  | "SWITCH_IN"
  | "SWITCH_IN_MERGER"
  | "SWITCH_OUT"
  | "SWITCH_OUT_MERGER"
  | "STT_TAX"
  | "STAMP_DUTY_TAX"
  | "TDS_TAX"
  | "SEGREGATION"
  | "GIFT_IN"
  | "GIFT_OUT"
  | "REVERSAL"
  | "MISC";

export interface CasTransaction {
  /** ISO YYYY-MM-DD. */
  date: string;
  description: string;
  amount: number | null;
  units: number | null;
  nav: number | null;
  balance: number | null;
  type: CasTransactionType;
  dividendRate: number | null;
}

export interface SchemeReconciliation {
  ok: boolean;
  /** Closing balance implied by opening + transactions. */
  computedClosing: number | null;
  /** Closing balance the statement asserts. */
  statedClosing: number | null;
  unitsDelta: number | null;
  /** closingBalance * NAV, compared against the stated valuation. */
  computedValuation: number | null;
  statedValuation: number | null;
  valuationDelta: number | null;
  issues: string[];
}

export interface CasScheme {
  name: string;
  isin: string | null;
  rta: string | null;
  advisor: string | null;
  openingBalance: number | null;
  closingBalance: number | null;
  navDate: string | null;
  nav: number | null;
  valuation: number | null;
  costValue: number | null;
  transactions: CasTransaction[];
  reconciliation: SchemeReconciliation;
}

export interface CasFolio {
  folio: string;
  amc: string;
  /** Masked: the four digits are replaced, so a folio stays attributable
   *  without the file handing back a complete national identifier. */
  pan: string | null;
  kycOk: boolean | null;
  schemes: CasScheme[];
}

export interface CasStatement {
  fileType: CasFileType;
  statementType: CasStatementType;
  period: { from: string | null; to: string | null };
  folios: CasFolio[];
  /** Lines that looked like data but could not be parsed confidently. */
  warnings: string[];
}

/* ------------------------------------------------------------------ regexes -- */

const FOLIO_LINE_RE =
  /Folio\s+No\s*:\s*(\d+(?:\s*\/\s*\d+)?)(?:.*?PAN\s*:\s*([A-Z]{5}\d{4}[A-Z]))?(?:.*?KYC\s*:\s*(OK|NOT OK))?/i;
const INLINE_ISIN_RE = /ISIN\s*:\s*([A-Z0-9]+)/i;
const ISIN_ANYWHERE_RE = /\bINF[0-9A-Z]{8}\d\b/;
const FULL_ISIN_RE = /^INF[0-9A-Z]{8}\d$/;
const INLINE_ADVISOR_RE = /\(\s*Advisor\s*:\s*([^)]+?)\)/i;
const RTA_TOKEN_RE = /\b(CAMS|KFINTECH|KFIN|KARVY)\b/i;
const OPEN_BAL_RE = /Opening\s+Unit\s+Balance\s*:?\s*([\d,.]+)/i;
const CLOSE_BAL_RE = /Closing\s+Unit\s+Balance\s*:?\s*([\d,.]+)/i;
const NAV_RE = /NAV\s+on\s+(\d{1,2}-[A-Za-z]{3}-\d{4})\s*:\s*INR\s*([\d,.]+)/i;
const VALUATION_RE =
  /(?:Valuation|Market\s+Value)\s+on\s+(\d{1,2}-[A-Za-z]{3}-\d{4})\s*:\s*INR\s*([\d,.]+)/i;
const COST_VALUE_RE = /Total\s+Cost\s+Value\s*:?\s*([\d,.]+)/i;
const STMT_PERIOD_RE = /(\d{1,2}-[A-Za-z]{3}-\d{4})\s+To\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/i;
const AMC_RE = /^(.+?\s+(?:MF|Mutual\s*Fund|Fund\s*House))$/i;
const DATE_LED_RE = /^\s*(\d{1,2}[-\s]*[A-Za-z]{3}[-\s]*\d{4})\s+(.*)$/;
/** A scheme header opens with a registrar code followed by a dash: "PP01-Parag…". */
const SCHEME_CODE_RE = /^(?=[A-Z0-9 ]{0,40}[A-Z])[A-Z0-9]+(?: [A-Z0-9]+)*-/i;
const REGISTRAR_RE = /Registrar\s*:/i;

const DIVIDEND_RE = /(?:div\.|dividend|idcw)[\s\S]*?@\s*Rs\.\s*([\d.]+)/i;
const REINVEST_RE = /reinvest/i;
const STP_RE = /\bs\s*t\s*p\b|systematic\s+transfer/i;
const REVERSAL_RE =
  /reversal|rejection|dishonoured|mismatch|insufficient\s+balance|payment\s+not\s+received/i;

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/* ------------------------------------------------------------------ helpers -- */

/** "05-Apr-2023", "05 Apr 2023" and "05Apr2023" all appear in the wild. */
export function toIsoDate(raw: string): string | null {
  const m = /^(\d{1,2})[-\s]*([A-Za-z]{3})[-\s]*(\d{4})$/.exec(raw.trim());
  if (!m) return null;
  const month = MONTHS[m[2]!.toLowerCase()];
  if (!month) return null;
  return `${m[3]}-${month}-${m[1]!.padStart(2, "0")}`;
}

/**
 * Parse a rupee/unit cell. Accounting parentheses mean negative, and the
 * thousands separators are Indian-grouped but still plain commas.
 */
export function parseNumberCell(raw: string): number | null {
  const t = raw.trim();
  if (!t) return null;
  const negative = /^\(.*\)$/.test(t);
  const cleaned = t.replace(/[()]/g, "").replace(/,/g, "");
  if (!/^-?\d*\.?\d+$/.test(cleaned)) return null;
  const value = Number.parseFloat(cleaned);
  if (!Number.isFinite(value)) return null;
  return negative ? -value : value;
}

const NUMERIC_TOKEN_RE = /^\(?-?[\d,]*\.?\d+\)?$/;

/** Mask the numeric block of a PAN: ABCDE1234F -> ABCDE****F. */
export function maskPan(pan: string): string {
  return pan.replace(/\d{4}/, "****");
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/* --------------------------------------------------------- classification --- */

/**
 * Map a description plus the sign of the units column onto a transaction type.
 * Ported from casparser's classifier: the units sign is what separates an
 * inflow from an outflow, and the description only refines which kind.
 */
export function classifyTransaction(
  description: string,
  units: number | null,
): { type: CasTransactionType; dividendRate: number | null } {
  const d = description.toLowerCase();

  const div = DIVIDEND_RE.exec(d);
  if (div) {
    return {
      type: REINVEST_RE.test(d) ? "DIVIDEND_REINVEST" : "DIVIDEND_PAYOUT",
      dividendRate: Number.parseFloat(div[1]!),
    };
  }

  if (units === null) {
    if (d.includes("stt")) return { type: "STT_TAX", dividendRate: null };
    if (d.includes("stamp")) return { type: "STAMP_DUTY_TAX", dividendRate: null };
    if (d.includes("tds")) return { type: "TDS_TAX", dividendRate: null };
    return { type: "MISC", dividendRate: null };
  }

  if (units > 0) {
    if (d.includes("gift")) return { type: "GIFT_IN", dividendRate: null };
    if (d.includes("switch") || STP_RE.test(d)) {
      return {
        type: d.includes("merger") ? "SWITCH_IN_MERGER" : "SWITCH_IN",
        dividendRate: null,
      };
    }
    if (d.includes("segregat")) return { type: "SEGREGATION", dividendRate: null };
    if (
      d.includes("sip") ||
      d.includes("systematic") ||
      /instal+ment/i.test(d) ||
      /sys[\s\S]+?invest/i.test(d)
    ) {
      return { type: "PURCHASE_SIP", dividendRate: null };
    }
    return { type: "PURCHASE", dividendRate: null };
  }

  // units < 0
  if (d.includes("gift")) return { type: "GIFT_OUT", dividendRate: null };
  if (REVERSAL_RE.test(d)) return { type: "REVERSAL", dividendRate: null };
  if (d.includes("switch") || STP_RE.test(d)) {
    return {
      type: d.includes("merger") ? "SWITCH_OUT_MERGER" : "SWITCH_OUT",
      dividendRate: null,
    };
  }
  return { type: "REDEMPTION", dividendRate: null };
}

/* -------------------------------------------------------------- detection --- */

export function detectFileType(text: string): CasFileType {
  if (text.includes("CAMSCASWS")) return "CAMS";
  if (text.includes("KFINCASWS")) return "KFINTECH";
  if (text.includes("NSDL Consolidated Account Statement") || text.includes("About NSDL")) {
    return "NSDL";
  }
  if (text.includes("Central Depository Services (India) Limited")) return "CDSL";
  // Fall back to the registrar named against the schemes themselves.
  const rta = RTA_TOKEN_RE.exec(text);
  if (rta) return /CAMS/i.test(rta[1]!) ? "CAMS" : "KFINTECH";
  return "UNKNOWN";
}

export function detectStatementType(text: string): CasStatementType {
  const m = /consolidated\s+account\s+(statement|summary)/i.exec(text);
  if (!m) return "UNKNOWN";
  return m[1]!.toLowerCase() === "summary" ? "SUMMARY" : "DETAILED";
}

/* ----------------------------------------------------- transaction parsing -- */

/**
 * Split a transaction row into its columns.
 *
 * The description column is free text and can itself end in a number (KFintech
 * leaks the SIP instalment number into it), so the columns are taken from the
 * *right*: the last four numeric tokens are amount / units / NAV / balance, and
 * anything before them stays in the description. A row with a single trailing
 * number is a levy line (stamp duty, STT, TDS) that carries an amount but no
 * units. Anything else is reported rather than guessed at.
 */
export function parseTransactionRow(
  line: string,
): { transaction: CasTransaction } | { unparsed: string } | null {
  const m = DATE_LED_RE.exec(line);
  if (!m) return null;

  const date = toIsoDate(m[1]!);
  if (!date) return null;

  const tokens = m[2]!.trim().split(/\s+/).filter(Boolean);
  const numeric: number[] = [];
  let cut = tokens.length;
  while (cut > 0) {
    const tok = tokens[cut - 1]!;
    if (!NUMERIC_TOKEN_RE.test(tok)) break;
    const value = parseNumberCell(tok);
    if (value === null) break;
    numeric.unshift(value);
    cut--;
  }

  const describe = (upto: number) => tokens.slice(0, upto).join(" ").trim();

  if (numeric.length >= 4) {
    const [amount, units, nav, balance] = numeric.slice(-4) as [
      number,
      number,
      number,
      number,
    ];
    // Extra trailing numerics belong to the description, not the table.
    const description = describe(cut + (numeric.length - 4));
    const { type, dividendRate } = classifyTransaction(description, units);
    return {
      transaction: { date, description, amount, units, nav, balance, type, dividendRate },
    };
  }

  if (numeric.length === 1) {
    const description = describe(cut);
    const { type, dividendRate } = classifyTransaction(description, null);
    return {
      transaction: {
        date,
        description,
        amount: numeric[0]!,
        units: null,
        nav: null,
        balance: null,
        type,
        dividendRate,
      },
    };
  }

  if (numeric.length === 0) {
    const description = describe(cut);
    // Dated marker rows ("***Registration of Nominee***", KYC/address updates)
    // legitimately carry no figures at all.
    return {
      transaction: {
        date,
        description,
        amount: null,
        units: null,
        nav: null,
        balance: null,
        type: "MISC",
        dividendRate: null,
      },
    };
  }

  return { unparsed: line };
}

/* ------------------------------------------------------------ reconciliation */

const UNIT_TOLERANCE = 0.001;

function reconcile(scheme: Omit<CasScheme, "reconciliation">): SchemeReconciliation {
  const issues: string[] = [];
  const opening = scheme.openingBalance;
  const stated = scheme.closingBalance;

  let computedClosing: number | null = null;
  let unitsDelta: number | null = null;
  if (opening !== null) {
    const moved = scheme.transactions.reduce((sum, t) => sum + (t.units ?? 0), 0);
    computedClosing = round(opening + moved, 4);
    if (stated !== null) {
      unitsDelta = round(computedClosing - stated, 4);
      if (Math.abs(unitsDelta) > UNIT_TOLERANCE) {
        issues.push(
          `Unit balance does not reconcile: opening ${opening} + transactions = ` +
            `${computedClosing}, but the statement says ${stated} (off by ${unitsDelta}).`,
        );
      }
    }
  } else {
    issues.push("No opening unit balance found; unit reconciliation skipped.");
  }

  let computedValuation: number | null = null;
  let valuationDelta: number | null = null;
  if (stated !== null && scheme.nav !== null) {
    computedValuation = round(stated * scheme.nav, 2);
    if (scheme.valuation !== null) {
      valuationDelta = round(computedValuation - scheme.valuation, 2);
      // Statements round per-scheme, so allow a rupee or half a basis point.
      const tolerance = Math.max(1, Math.abs(scheme.valuation) * 0.005);
      if (Math.abs(valuationDelta) > tolerance) {
        issues.push(
          `Valuation does not reconcile: ${stated} units x NAV ${scheme.nav} = ` +
            `${computedValuation}, but the statement says ${scheme.valuation}.`,
        );
      }
    }
  }

  return {
    ok: issues.length === 0,
    computedClosing,
    statedClosing: stated,
    unitsDelta,
    computedValuation,
    statedValuation: scheme.valuation,
    valuationDelta,
    issues,
  };
}

/* ------------------------------------------------------------------- parser -- */

interface SchemeDraft extends Omit<CasScheme, "reconciliation"> {}

function newScheme(headerText: string): SchemeDraft {
  return {
    name: cleanSchemeName(headerText),
    isin: extractIsin(headerText),
    rta: extractRta(headerText),
    advisor: extractAdvisor(headerText),
    openingBalance: null,
    closingBalance: null,
    navDate: null,
    nav: null,
    valuation: null,
    costValue: null,
    transactions: [],
  };
}

function extractIsin(header: string): string | null {
  const inline = INLINE_ISIN_RE.exec(header);
  if (inline && FULL_ISIN_RE.test(inline[1]!)) return inline[1]!.toUpperCase();
  // A labelled ISIN can wrap mid-value across the "Registrar :" label, leaving a
  // truncated capture; a complete one found anywhere in the header beats it.
  const anywhere = ISIN_ANYWHERE_RE.exec(header);
  return anywhere ? anywhere[0].toUpperCase() : null;
}

function extractRta(header: string): string | null {
  const m = RTA_TOKEN_RE.exec(header);
  if (!m) return null;
  const token = m[1]!.toUpperCase();
  return token === "KFIN" || token === "KARVY" ? "KFINTECH" : token;
}

function extractAdvisor(header: string): string | null {
  const m = INLINE_ADVISOR_RE.exec(header);
  return m ? m[1]!.trim() : null;
}

function cleanSchemeName(header: string): string {
  let name = header;
  name = name.replace(INLINE_ADVISOR_RE, " ");
  name = name.replace(/[-\s]*ISIN\s*:\s*[A-Z0-9]*/gi, " ");
  name = name.replace(/Registrar\s*:\s*\S*/gi, " ");
  name = name.replace(/\((?:formerly|erstwhile|Demat)[^)]*\)/gi, " ");
  return name.replace(/\s+/g, " ").trim();
}

/** Labelled rows and folio/AMC headers end a scheme's wrapped header block. */
function endsSchemeHeader(line: string): boolean {
  return (
    OPEN_BAL_RE.test(line) ||
    CLOSE_BAL_RE.test(line) ||
    NAV_RE.test(line) ||
    VALUATION_RE.test(line) ||
    COST_VALUE_RE.test(line) ||
    FOLIO_LINE_RE.test(line) ||
    DATE_LED_RE.test(line)
  );
}

function isSchemeHeader(line: string): boolean {
  // A labelled row is never a header. This guard is load-bearing rather than
  // defensive: SCHEME_CODE_RE happily matches the "NAV on 31-" prefix of a NAV
  // row, which would otherwise open a phantom scheme and orphan the real one.
  if (endsSchemeHeader(line)) return false;
  return REGISTRAR_RE.test(line) || SCHEME_CODE_RE.test(line);
}

/**
 * Parse the text of a CAMS/KFintech DETAILED CAS.
 *
 * Everything is driven off labelled rows the statement prints itself, so an
 * unfamiliar block is skipped and recorded in `warnings` rather than being
 * force-fitted into the previous scheme.
 */
export function parseCasText(text: string): CasStatement {
  const rawLines = text.split(/\r?\n/).map((l) => l.trim());
  const lines = rawLines.filter((l) => l.length > 0);

  const statement: CasStatement = {
    fileType: detectFileType(text),
    statementType: detectStatementType(text),
    period: { from: null, to: null },
    folios: [],
    warnings: [],
  };

  let currentAmc = "";
  let folio: CasFolio | null = null;
  let scheme: SchemeDraft | null = null;
  // A scheme header wraps across physical lines; collect until a labelled row.
  let headerBuffer: string[] | null = null;

  /**
   * Close the open scheme and return the next value for `scheme`.
   *
   * This returns rather than assigning because every assignment to `scheme` has
   * to happen at the call site: if the only writes lived in a closure, the
   * compiler would never see it hold a non-null value and would narrow it to
   * `never` at the reads below.
   */
  const closeScheme = (): null => {
    if (folio && scheme) folio.schemes.push({ ...scheme, reconciliation: reconcile(scheme) });
    return null;
  };
  const closeFolio = () => {
    if (folio && folio.schemes.length > 0) statement.folios.push(folio);
  };

  for (const line of lines) {
    if (!statement.period.from) {
      const p = STMT_PERIOD_RE.exec(line);
      if (p) {
        statement.period = { from: toIsoDate(p[1]!), to: toIsoDate(p[2]!) };
        continue;
      }
    }

    // An open scheme header keeps absorbing lines until a labelled row appears.
    if (headerBuffer) {
      if (!endsSchemeHeader(line) && headerBuffer.length < 4) {
        headerBuffer.push(line);
        continue;
      }
      scheme = closeScheme();
      scheme = newScheme(headerBuffer.join(" "));
      headerBuffer = null;
    }

    const folioMatch = FOLIO_LINE_RE.exec(line);
    if (folioMatch) {
      scheme = closeScheme();
      closeFolio();
      folio = {
        folio: folioMatch[1]!.replace(/\s+/g, ""),
        amc: currentAmc,
        pan: folioMatch[2] ? maskPan(folioMatch[2].toUpperCase()) : null,
        kycOk: folioMatch[3] ? /^OK$/i.test(folioMatch[3]) : null,
        schemes: [],
      };
      continue;
    }

    if (isSchemeHeader(line)) {
      headerBuffer = [line];
      continue;
    }

    const amcMatch = AMC_RE.exec(line);
    if (amcMatch && !DATE_LED_RE.test(line)) {
      currentAmc = amcMatch[1]!.trim();
      continue;
    }

    if (scheme) {
      const open = OPEN_BAL_RE.exec(line);
      if (open) {
        scheme.openingBalance = parseNumberCell(open[1]!);
        continue;
      }
      const close = CLOSE_BAL_RE.exec(line);
      if (close) {
        scheme.closingBalance = parseNumberCell(close[1]!);
        continue;
      }
      const nav = NAV_RE.exec(line);
      if (nav) {
        scheme.navDate = toIsoDate(nav[1]!);
        scheme.nav = parseNumberCell(nav[2]!);
        continue;
      }
      const val = VALUATION_RE.exec(line);
      if (val) {
        scheme.valuation = parseNumberCell(val[2]!);
        continue;
      }
      const cost = COST_VALUE_RE.exec(line);
      if (cost) {
        scheme.costValue = parseNumberCell(cost[1]!);
        continue;
      }

      const row = parseTransactionRow(line);
      if (row && "transaction" in row) {
        scheme.transactions.push(row.transaction);
        continue;
      }
      if (row && "unparsed" in row) {
        statement.warnings.push(`Ambiguous transaction row skipped: ${row.unparsed}`);
        continue;
      }
    }
  }

  if (headerBuffer) {
    scheme = closeScheme();
    scheme = newScheme(headerBuffer.join(" "));
  }
  scheme = closeScheme();
  closeFolio();

  return statement;
}

/* ----------------------------------------------------------- derived views -- */

export interface CasHolding {
  amc: string;
  folio: string;
  scheme: string;
  isin: string | null;
  units: number;
  navDate: string | null;
  nav: number | null;
  /** Value as stated on the statement date. Stale by construction. */
  statementValue: number | null;
  costValue: number | null;
  reconciled: boolean;
}

/** Current (as-of-statement) holdings, one row per scheme with a non-zero balance. */
export function holdings(statement: CasStatement): CasHolding[] {
  const out: CasHolding[] = [];
  for (const f of statement.folios) {
    for (const s of f.schemes) {
      if (s.closingBalance === null || Math.abs(s.closingBalance) < UNIT_TOLERANCE) continue;
      out.push({
        amc: f.amc,
        folio: f.folio,
        scheme: s.name,
        isin: s.isin,
        units: s.closingBalance,
        navDate: s.navDate,
        nav: s.nav,
        statementValue: s.valuation,
        costValue: s.costValue,
        reconciled: s.reconciliation.ok,
      });
    }
  }
  return out;
}

export interface CashFlow {
  date: string;
  amount: number;
}

/**
 * Which transaction types move money across the boundary of the portfolio, and
 * in which direction. Positive means cash arriving with the investor.
 *
 * Switches and dividend reinvestments are internal: units move between schemes
 * but no rupee enters or leaves. Counting them at portfolio level would inflate
 * both sides of the XIRR and distort the answer, so they are excluded there and
 * included only when measuring a single scheme in isolation.
 */
const FLOW_SIGN: Partial<Record<CasTransactionType, -1 | 1>> = {
  PURCHASE: -1,
  PURCHASE_SIP: -1,
  REDEMPTION: 1,
  DIVIDEND_PAYOUT: 1,
  STT_TAX: -1,
  STAMP_DUTY_TAX: -1,
  TDS_TAX: -1,
  REVERSAL: 1,
};
const INTERNAL_SIGN: Partial<Record<CasTransactionType, -1 | 1>> = {
  SWITCH_IN: -1,
  SWITCH_IN_MERGER: -1,
  SWITCH_OUT: 1,
  SWITCH_OUT_MERGER: 1,
};

export interface CashFlowOptions {
  /**
   * "portfolio" treats the whole CAS as one book and drops internal transfers.
   * "scheme" measures schemes in isolation, so a switch is a real flow.
   */
  scope?: "portfolio" | "scheme";
  /** Terminal value, dated. Defaults to the summed statement valuation. */
  terminalValue?: number;
  terminalDate?: string;
}

/**
 * Build an XIRR-ready cash flow series from a parsed statement.
 *
 * This is the point of parsing a CAS at all: `compute_xirr` has always been able
 * to do the arithmetic, but nobody can hand-type six years of SIP instalments, so
 * in practice it had no inputs. The statement has every one of them, dated.
 */
export function cashFlows(
  statement: CasStatement,
  options: CashFlowOptions = {},
): { flows: CashFlow[]; skipped: number; unreconciledSchemes: string[] } {
  const scope = options.scope ?? "portfolio";
  const flows: CashFlow[] = [];
  const unreconciled: string[] = [];
  let skipped = 0;
  let statementValue = 0;
  let lastDate: string | null = null;

  for (const f of statement.folios) {
    for (const s of f.schemes) {
      if (!s.reconciliation.ok) unreconciled.push(`${f.folio} / ${s.name}`);
      if (s.valuation !== null) statementValue += s.valuation;
      if (s.navDate && (!lastDate || s.navDate > lastDate)) lastDate = s.navDate;

      for (const t of s.transactions) {
        const sign = FLOW_SIGN[t.type] ?? (scope === "scheme" ? INTERNAL_SIGN[t.type] : undefined);
        if (sign === undefined || t.amount === null) {
          skipped++;
          continue;
        }
        flows.push({ date: t.date, amount: sign * Math.abs(t.amount) });
      }
    }
  }

  const terminalDate = options.terminalDate ?? lastDate;
  const terminalValue = options.terminalValue ?? statementValue;
  if (terminalDate && terminalValue > 0) {
    flows.push({ date: terminalDate, amount: terminalValue });
  }

  flows.sort((a, b) => a.date.localeCompare(b.date));
  return { flows, skipped, unreconciledSchemes: unreconciled };
}
