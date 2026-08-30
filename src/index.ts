#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { IndStocksClient, IndStocksError } from "./client.js";
import { TokenStore } from "./auth.js";
import { PriceStream, summariseWatch, type Tick } from "./stream.js";
import { SectorStore, classifyPositions } from "./sectors.js";
import { parseResponse, normaliseHoldings, type Holding } from "./schemas.js";
import { InstrumentStore } from "./instruments.js";
import { AmfiStore, expenseDrag } from "./amfi.js";
import { ENDPOINTS, DELIBERATELY_OMITTED, type EndpointName } from "./endpoints.js";
import {
  allocationBy,
  allocationDrift,
  concentrationHHI,
  xirr,
  type Position,
} from "./analytics.js";
import { extractCasText } from "./caspdf.js";
import { holdings as casHoldings, cashFlows as casCashFlows } from "./cas.js";
import { parseStatement, type AnyStatement } from "./statement.js";
import { depositoryHoldings, type DepositoryStatement } from "./casdepository.js";

const VERSION = "0.1.0";

// stdout is reserved for MCP JSON-RPC framing. Anything written there corrupts
// the protocol, so all diagnostics go to stderr.
const log = (...args: unknown[]) => console.error("[indstocks-mcp]", ...args);

/**
 * Credentials are read from the environment, not asked for in conversation.
 *
 * `refresh_token` will accept an MPIN and a code as arguments when it has to, but
 * anything passed that way is written into the transcript, so the environment is
 * the better place for them. Automatic refresh additionally needs the TOTP seed;
 * see the trade-off documented in auth.ts before enabling it.
 */
const tokens = new TokenStore({
  token: process.env.INDSTOCKS_TOKEN ?? "",
  credentials: process.env.INDSTOCKS_API_KEY
    ? {
        apiKey: process.env.INDSTOCKS_API_KEY,
        mpin: process.env.INDSTOCKS_MPIN ?? "",
        totpSecret: process.env.INDSTOCKS_TOTP_SECRET,
      }
    : undefined,
});
const client = new IndStocksClient({ tokens });
// Lazy: no socket is opened until something actually subscribes.
const stream = new PriceStream({ tokens, log });
const instruments = new InstrumentStore(client);
const amfi = new AmfiStore();
const sectors = new SectorStore();

const server = new McpServer({ name: "indstocks-mcp", version: VERSION });

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Return an API payload with its shape checked against the published docs.
 *
 * The `schema` block only appears when something failed to line up, so a healthy
 * response stays terse and a drifting one is impossible to miss. Validation never
 * withholds data: a mismatched payload is still returned, just flagged.
 */
function okParsed(endpoint: EndpointName, raw: unknown, extra?: Record<string, unknown>) {
  const parsed = parseResponse(endpoint, raw);
  return ok({
    ...extra,
    data: parsed.data,
    schema: parsed.validated ? undefined : { validated: false, warnings: parsed.warnings },
  });
}

function fail(error: unknown) {
  const message =
    error instanceof IndStocksError
      ? error.message
      : error instanceof Error
        ? error.message
        : String(error);
  return { content: [{ type: "text" as const, text: `ERROR: ${message}` }], isError: true };
}

/* ---------------------------------------------------------------- account -- */

server.registerTool(
  "get_profile",
  {
    title: "Get INDstocks profile",
    description:
      "Fetch the authenticated user's INDstocks profile. Cheapest way to confirm the API token is valid and not expired.",
    inputSchema: {},
  },
  async () => {
    try {
      return okParsed("profile", await client.get("profile"));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "get_funds",
  {
    title: "Get available funds",
    description: "Available cash balance and margin in the INDstocks account. Read-only.",
    inputSchema: {},
  },
  async () => {
    try {
      return okParsed("funds", await client.get("funds"));
    } catch (error) {
      return fail(error);
    }
  },
);

/* ------------------------------------------------------------ market data -- */

server.registerTool(
  "search_instruments",
  {
    title: "Search instruments",
    description:
      "Resolve a human symbol or company name (e.g. 'RELIANCE', 'HDFC Bank') to the numeric security_id and scrip code the API requires. Call this before any quote lookup.",
    inputSchema: {
      query: z.string().min(1).describe("Symbol or company name"),
      exchange: z.enum(["NSE", "BSE"]).optional().describe("Restrict to one exchange"),
      limit: z.number().int().min(1).max(50).default(10),
    },
  },
  async ({ query, exchange, limit }) => {
    try {
      const results = await instruments.search(query, limit, exchange);
      return ok({
        matched: results.length,
        masterSize: instruments.count,
        results: results.map(({ raw, ...rest }) => rest),
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "get_quotes",
  {
    title: "Get live quotes",
    description:
      "Live market quotes for one or more scrip codes (format: NSE_2885). Use search_instruments first to get scrip codes. Set mode='ltp' for last traded price only.",
    inputSchema: {
      scripCodes: z.array(z.string()).min(1).max(50).describe("e.g. ['NSE_2885','NSE_11536']"),
      mode: z.enum(["full", "ltp"]).default("full"),
    },
  },
  async ({ scripCodes, mode }) => {
    try {
      const endpoint: EndpointName = mode === "ltp" ? "quotesLtp" : "quotesFull";
      return okParsed(
        endpoint,
        await client.get(endpoint, { "scrip-codes": scripCodes.join(",") }),
      );
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "get_historical",
  {
    title: "Get historical candles",
    description:
      "Historical OHLCV candles for up to 5 scrip codes. Interval values are spelled out ('1day', '15minute'), never abbreviated. Dates are plain YYYY-MM-DD; 'to' is exclusive.",
    inputSchema: {
      scripCodes: z.array(z.string()).min(1).max(5).describe("e.g. ['NSE_2885']"),
      interval: z
        .enum([
          "1minute", "2minute", "3minute", "4minute", "5minute", "10minute",
          "15minute", "30minute", "60minute", "120minute", "180minute",
          "240minute", "1day", "1week", "1month",
        ])
        .default("1day"),
      from: z.string().describe("YYYY-MM-DD, inclusive"),
      to: z.string().describe("YYYY-MM-DD, exclusive"),
    },
  },
  async ({ scripCodes, interval, from, to }) => {
    try {
      // Anchor the range to IST, not UTC. A UTC midnight boundary lands at 05:30
      // IST and silently clips the first candles of an intraday session.
      const startTime = Date.parse(`${from}T00:00:00+05:30`);
      const endTime = Date.parse(`${to}T00:00:00+05:30`);
      if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
        return fail("from and to must be YYYY-MM-DD dates.");
      }
      return okParsed(
        "historical",
        await client.get(
          "historical",
          {
            "scrip-codes": scripCodes.join(","),
            start_time: startTime,
            end_time: endTime,
          },
          { interval },
        ),
        { interval },
      );
    } catch (error) {
      return fail(error);
    }
  },
);

/* -------------------------------------------------------------- portfolio -- */

server.registerTool(
  "get_holdings",
  {
    title: "Get holdings",
    description:
      "Long-term delivery holdings. Read-only. Returns quantity and average price per scrip but NO current price, market value or P&L — pass the returned security_ids to get_quotes to value the book. Alongside the raw payload, 'normalised' renames the API's total_qty/avg_price into the quantity/averagePrice vocabulary analyze_allocation expects, and builds the NSE scrip code for the quote lookup.",
    inputSchema: {},
  },
  async () => {
    try {
      const parsed = parseResponse("holdings", await client.get("holdings"));
      return ok({
        data: parsed.data,
        // Only reshape a payload that actually validated: renaming fields on a
        // response we did not recognise would launder a shape change into
        // confident-looking numbers.
        normalised: parsed.validated ? normaliseHoldings(parsed.data as Holding[]) : undefined,
        schema: parsed.validated ? undefined : { validated: false, warnings: parsed.warnings },
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "get_positions",
  {
    title: "Get open positions",
    description:
      "Open intraday and derivative positions. Read-only. Optionally filter by segment and product; omit both for the default view.",
    inputSchema: {
      segment: z.enum(["equity", "derivative"]).optional(),
      product: z.enum(["margin", "intraday", "cnc"]).optional(),
    },
  },
  async ({ segment, product }) => {
    try {
      return okParsed("positions", await client.get("positions", { segment, product }));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "get_order_book",
  {
    title: "View today's order book",
    description:
      "View today's orders and their fill status. This is a READ of the order book. This server cannot place, modify or cancel orders. Note that the order-book response shape is not published, so unlike the other endpoints it is passed through unvalidated — read the field names in the payload rather than assuming them.",
    inputSchema: {},
  },
  async () => {
    try {
      return okParsed("orderBook", await client.get("orderBook"));
    } catch (error) {
      return fail(error);
    }
  },
);

/* --------------------------------------------------------- mutual funds ---- */

server.registerTool(
  "search_mutual_funds",
  {
    title: "Search mutual fund schemes",
    description:
      "Search every Indian mutual fund scheme by name or AMC using AMFI's daily NAV feed. Free, no auth. The INDstocks trading API does not cover mutual funds, so this fills that gap.",
    inputSchema: {
      query: z.string().min(2).describe("e.g. 'parag parikh flexi cap direct growth'"),
      limit: z.number().int().min(1).max(50).default(15),
    },
  },
  async ({ query, limit }) => {
    try {
      const results = await amfi.search(query, limit);
      return ok({ matched: results.length, universeSize: amfi.count, results });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "get_scheme_nav",
  {
    title: "Get scheme NAV",
    description: "Latest published NAV for a specific AMFI scheme code.",
    inputSchema: { schemeCode: z.string().min(1) },
  },
  async ({ schemeCode }) => {
    try {
      const scheme = await amfi.byCodeLookup(schemeCode);
      return scheme ? ok(scheme) : fail(`No scheme found with code ${schemeCode}`);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "compare_expense_ratio",
  {
    title: "Compare regular vs direct plan drag",
    description:
      "Compound the difference between two expense ratios over a holding period. Pure arithmetic on the numbers you supply — it shows what a fee difference costs, it does not recommend a fund.",
    inputSchema: {
      amount: z.number().positive().describe("Amount invested, in rupees"),
      years: z.number().positive().max(50),
      assumedReturnPct: z.number().describe("Gross annual return assumption, e.g. 12"),
      regularExpensePct: z.number().min(0).max(5),
      directExpensePct: z.number().min(0).max(5),
    },
  },
  async ({ amount, years, assumedReturnPct, regularExpensePct, directExpensePct }) => {
    const result = expenseDrag(
      amount,
      years,
      assumedReturnPct,
      regularExpensePct,
      directExpensePct,
    );
    return ok({
      ...result,
      note: "Assumes a constant gross return. Real returns vary; this isolates the fee effect only.",
    });
  },
);

/* -------------------------------------------------------------- analytics -- */

const positionSchema = z.object({
  symbol: z.string(),
  isin: z
    .string()
    .optional()
    .describe("Preferred for sector lookup: unambiguous where a trading symbol is not."),
  quantity: z.number(),
  lastPrice: z.number(),
  averagePrice: z.number().optional(),
  sector: z
    .string()
    .optional()
    .describe(
      "Fallback only, used for instruments outside the NSE index. Do not supply a sector you " +
        "are recalling from memory — the published classification wins wherever it has an entry.",
    ),
});

server.registerTool(
  "analyze_allocation",
  {
    title: "Analyze portfolio allocation and concentration",
    description:
      "Compute allocation weights and concentration (HHI, effective holdings count) over a list of positions. Deterministic — computed in code, not estimated. Grouping by sector uses NSE's published macro-economic classification looked up by ISIN or symbol, not a sector you supply; instruments outside that index are reported as Unclassified and counted rather than guessed at. Optionally compare against a target allocation to show drift.",
    inputSchema: {
      positions: z.array(positionSchema).min(1),
      groupBy: z.enum(["symbol", "sector"]).default("symbol"),
      target: z
        .record(z.string(), z.number())
        .optional()
        .describe("Optional target weights, e.g. {\"Financials\": 30, \"IT\": 20}"),
    },
  },
  async ({ positions, groupBy, target }) => {
    try {
      const typed = positions as Position[];

      let dimension: (position: Position) => string = (position) => position.symbol;
      let classification: Record<string, unknown> | undefined;

      if (groupBy === "sector") {
        await sectors.ensureLoaded();
        const classified = classifyPositions(sectors, positions);
        const bySymbol = new Map(classified.map((entry) => [entry.symbol, entry]));
        dimension = (position) => bySymbol.get(position.symbol)?.sector ?? "Unclassified";

        const counts = { nse: 0, caller: 0, unclassified: 0 };
        for (const entry of classified) counts[entry.provenance]++;

        classification = {
          ...sectors.status(),
          resolvedFromIndex: counts.nse,
          callerSupplied: counts.caller,
          unclassified: counts.unclassified,
          unclassifiedSymbols: classified
            .filter((entry) => entry.provenance === "unclassified")
            .map((entry) => entry.symbol),
          warning: sectors.available
            ? undefined
            : "The NSE classification could not be loaded, so nothing was resolved from it. " +
              "These weights rest entirely on supplied sectors and are not authoritative.",
        };
      }

      const allocation = allocationBy(typed, dimension);
      return ok({
        allocation,
        concentration: concentrationHHI(typed),
        drift: target ? allocationDrift(allocation, target) : undefined,
        classification,
        note:
          "HHI above 2500 indicates a concentrated book. This is a description of the " +
          "portfolio, not advice." +
          (classification
            ? " Unclassified positions still carry their full weight in the totals; they are " +
              "simply not attributed to a sector."
            : ""),
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "compute_xirr",
  {
    title: "Compute XIRR",
    description:
      "Annualised return across irregular cash flows (SIP instalments, lumpsums, redemptions). Outflows negative, inflows positive. Include current portfolio value as a final positive flow dated today.",
    inputSchema: {
      cashFlows: z
        .array(z.object({ date: z.string().describe("YYYY-MM-DD"), amount: z.number() }))
        .min(2),
    },
  },
  async ({ cashFlows }) => {
    const result = xirr(cashFlows);
    return result === null
      ? fail("XIRR has no solution for these flows. Check that there is at least one negative and one positive amount.")
      : ok({ xirrPct: result, flowCount: cashFlows.length });
  },
);

/* --------------------------------------------------- consolidated statement */

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Parsed statements are cached by path + mtime.
 *
 * The three CAS tools are meant to be used together in one conversation, and
 * decoding a forty-page PDF three times to answer three questions about the same
 * file is pure waste. Keying on mtime means re-downloading a fresher statement to
 * the same path invalidates the entry on its own.
 */
const casCache = new Map<string, { mtimeMs: number; statement: AnyStatement }>();

async function loadCas(filePath: string, password?: string): Promise<AnyStatement> {
  const { stat } = await import("node:fs/promises");
  let mtimeMs: number;
  try {
    ({ mtimeMs } = await stat(filePath));
  } catch {
    // A raw ENOENT here reads as a server bug rather than a wrong path, and the
    // path is the one thing the caller can actually fix.
    throw new Error(
      "Cannot read " +
        filePath +
        ". Give the path to the CAS PDF as saved on this machine — the file is read " +
        "locally and never uploaded.",
    );
  }
  const cached = casCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.statement;
  const statement = parseStatement(await extractCasText(filePath, password));
  casCache.set(filePath, { mtimeMs, statement });
  return statement;
}

const DEPOSITORY_NOTE =
  "This is a depository statement: a holdings snapshot spanning every demat account, " +
  "including brokers other than INDmoney. It carries no transaction history, so XIRR " +
  "cannot be computed from it. Values are as printed on the statement date, not live. " +
  "The value column is identified by finding the one that sums to the statement's own " +
  "total rows — treat an account with reconciled=false as unread rather than as a number.";

function okDepositoryStatement(statement: DepositoryStatement) {
  const rows = depositoryHoldings(statement);
  const valued = rows.filter((row) => row.value !== null && row.reconciled);
  return ok({
    source: {
      fileType: statement.fileType,
      statementType: statement.statementType,
      period: statement.period,
    },
    pan: statement.pan,
    accountCount: statement.accounts.length,
    holdingCount: rows.length,
    totalStatedValue:
      valued.length > 0 ? round2(valued.reduce((sum, row) => sum + (row.value ?? 0), 0)) : null,
    holdings: rows,
    accounts: statement.accounts.map((account) => ({
      account:
        account.dpId && account.clientId
          ? account.dpId + "/" + account.clientId
          : account.kind,
      depository: account.depository,
      holdings: account.holdings.length,
      reconciliation: account.reconciliation,
    })),
    warnings: statement.warnings,
    note: DEPOSITORY_NOTE,
  });
}

/**
 * Allocation over a depository snapshot.
 *
 * Values are taken as printed rather than revalued: unlike a fund, an equity has
 * no NAV feed here, and the statement's own figure is the authority. Quantity is
 * pinned to 1 so the stated value passes through the same allocation maths
 * unchanged.
 */
function analyseDepository(statement: DepositoryStatement, groupBy: string) {
  const rows = depositoryHoldings(statement).filter(
    (row) => row.reconciled && row.value !== null,
  );
  const excluded = depositoryHoldings(statement)
    .filter((row) => !row.reconciled || row.value === null)
    .map((row) => ({
      holding: row.name || row.isin,
      reason: row.reconciled ? "no value column could be resolved" : "account did not reconcile",
    }));

  const dimension = (row: (typeof rows)[number]): string => {
    if (groupBy === "amc" || groupBy === "account") return row.account;
    if (groupBy === "category" || groupBy === "assetType") return row.assetType;
    return row.name || row.isin;
  };

  const positions: Position[] = rows.map((row) => ({
    symbol: dimension(row),
    quantity: 1,
    lastPrice: row.value as number,
  }));

  return ok({
    statementType: statement.statementType,
    asOf: statement.period.to,
    holdingsValued: rows.length,
    totalStatedValue: round2(rows.reduce((sum, row) => sum + (row.value ?? 0), 0)),
    holdings: rows,
    allocation: allocationBy(positions, (position) => position.symbol),
    concentration: concentrationHHI(positions),
    excluded,
    note: DEPOSITORY_NOTE,
  });
}

const RECONCILE_NOTE =
  "Each scheme is reconciled against the statement's own closing unit balance and " +
  "valuation. Treat any scheme with reconciled=false as unparsed rather than as a " +
  "number: report the discrepancy instead of doing arithmetic on it.";

server.registerTool(
  "parse_cas",
  {
    title: "Parse a consolidated account statement",
    description:
      "Parse a consolidated account statement PDF. Handles both kinds: a CAMS/KFintech registrar statement (mutual funds, with full transaction history) and an NSDL/CDSL depository statement (every demat account across every broker — equities, bonds and funds — as a holdings snapshot with no transactions). The kind is detected from the file. This is the only way to see what the investor ACTUALLY holds in mutual funds: the INDstocks API covers equity, F&O and currency but not mutual funds, and AMFI publishes only NAVs, never anybody's units. The PDF is read from local disk and parsed in process — it is never uploaded anywhere. Statements are usually password protected.",
    inputSchema: {
      filePath: z.string().describe("Path to the CAS PDF on this machine"),
      password: z
        .string()
        .optional()
        .describe("PDF password. Case sensitive; often the PAN in uppercase."),
      includeTransactions: z
        .boolean()
        .default(false)
        .describe("Include every transaction. Large — leave off unless the history is the question."),
    },
  },
  async ({ filePath, password, includeTransactions }) => {
    try {
      const parsed = await loadCas(filePath, password);
      if (parsed.kind === "depository") return okDepositoryStatement(parsed.statement);

      const cas = parsed.statement;
      const rows = casHoldings(cas);
      const statementValue = rows.reduce((sum, r) => sum + (r.statementValue ?? 0), 0);
      return ok({
        source: { fileType: cas.fileType, statementType: cas.statementType, period: cas.period },
        folioCount: cas.folios.length,
        schemeCount: rows.length,
        totalStatementValue: round2(statementValue),
        holdings: rows,
        unreconciled: rows.filter((r) => !r.reconciled).map((r) => r.folio + " / " + r.scheme),
        warnings: cas.warnings,
        transactions: includeTransactions
          ? cas.folios.flatMap((f) =>
              f.schemes.map((sc) => ({
                folio: f.folio,
                scheme: sc.name,
                reconciled: sc.reconciliation.ok,
                transactions: sc.transactions,
              })),
            )
          : undefined,
        note:
          RECONCILE_NOTE +
          " Valuations here are as of the statement date and are stale by construction; " +
          "use analyze_cas_portfolio to value the same units at today's published NAV.",
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "analyze_cas_portfolio",
  {
    title: "Value and analyse mutual fund holdings from a CAS",
    description:
      "Take the holdings in a CAS, revalue them at today's published AMFI NAV (matched by ISIN), and compute allocation weights and concentration. Answers what the mutual fund side of a portfolio looks like right now rather than on the statement date. Descriptive only — it does not rank or recommend anything.",
    inputSchema: {
      filePath: z.string().describe("Path to the CAS PDF on this machine"),
      password: z.string().optional(),
      groupBy: z
        .enum(["scheme", "amc", "category", "holding", "account", "assetType"])
        .default("scheme")
        .describe(
          "For a registrar statement: scheme, amc, or category (AMFI's own). For a depository " +
            "statement: holding, account, or assetType. The two vocabularies are interchangeable — " +
            "scheme/holding, amc/account and category/assetType mean the same thing on each. " +
            "There is deliberately no sector grouping: a flexi-cap fund spans every sector.",
        ),
    },
  },
  async ({ filePath, password, groupBy }) => {
    try {
      const parsed = await loadCas(filePath, password);
      if (parsed.kind === "depository") return analyseDepository(parsed.statement, groupBy);

      const cas = parsed.statement;
      const rows = casHoldings(cas);

      const valued: Array<{
        amc: string;
        folio: string;
        scheme: string;
        isin: string | null;
        units: number;
        costValue: number | null;
        currentNav: number;
        currentNavDate: string;
        currentValue: number;
        amfiSchemeCode: string;
        category: string;
      }> = [];
      const excluded: Array<{ scheme: string; reason: string }> = [];

      for (const row of rows) {
        if (!row.reconciled) {
          excluded.push({ scheme: row.scheme, reason: "did not reconcile against the statement" });
          continue;
        }
        const match = row.isin ? await amfi.byIsinLookup(row.isin) : null;
        if (!match) {
          excluded.push({
            scheme: row.scheme,
            reason: row.isin
              ? "ISIN " + row.isin + " is not in the AMFI feed"
              : "no ISIN on the statement",
          });
          continue;
        }
        valued.push({
          amc: row.amc,
          folio: row.folio,
          scheme: row.scheme,
          isin: row.isin,
          units: row.units,
          costValue: row.costValue,
          currentNav: match.nav,
          currentNavDate: match.date,
          currentValue: round2(row.units * match.nav),
          amfiSchemeCode: match.schemeCode,
          category: match.category || "Uncategorised",
        });
      }

      // Reuse the same deterministic maths the equity side uses: units are the
      // quantity and today's NAV is the price.
      const positions: Position[] = valued.map((v) => ({
        symbol: groupBy === "amc" ? v.amc : groupBy === "category" ? v.category : v.scheme,
        quantity: v.units,
        lastPrice: v.currentNav,
      }));

      const currentValue = valued.reduce((sum, v) => sum + v.currentValue, 0);
      const costValue = valued.reduce((sum, v) => sum + (v.costValue ?? 0), 0);

      return ok({
        asOf: valued[0]?.currentNavDate ?? null,
        schemesValued: valued.length,
        totalCurrentValue: round2(currentValue),
        totalCostValue: costValue > 0 ? round2(costValue) : null,
        holdings: valued,
        allocation: allocationBy(positions, (pos) => pos.symbol),
        concentration: concentrationHHI(positions),
        excluded,
        note:
          RECONCILE_NOTE +
          " Excluded schemes are listed rather than silently dropped, so the weights " +
          "above are only over what could actually be valued.",
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "compute_cas_xirr",
  {
    title: "Compute XIRR from a CAS",
    description:
      "Compute annualised return (XIRR) from the real, dated cash flows in a consolidated account statement. compute_xirr can already do the arithmetic, but nobody can hand-type years of SIP instalments — the statement has every one of them. Purchases and levies count as outflows, redemptions and dividend payouts as inflows, and the portfolio's current value closes the series.",
    inputSchema: {
      filePath: z.string().describe("Path to the CAS PDF on this machine"),
      password: z.string().optional(),
      scope: z
        .enum(["portfolio", "scheme"])
        .default("portfolio")
        .describe("portfolio treats switches between schemes as internal; scheme counts them."),
      valueAt: z
        .enum(["today", "statement"])
        .default("today")
        .describe("Close the series at today's AMFI NAV, or at the statement's own valuation."),
    },
  },
  async ({ filePath, password, scope, valueAt }) => {
    try {
      const parsed = await loadCas(filePath, password);
      if (parsed.kind === "depository") {
        // A snapshot has no dated flows. Any rate derived from it would be invented.
        return fail(
          "This is an NSDL/CDSL depository statement — a holdings snapshot with no transaction " +
            "history. XIRR needs dated cash flows, so it cannot be computed from this file. " +
            "For mutual fund returns, request a CAMS or KFintech consolidated account statement " +
            "and be sure to ask for the detailed version rather than the summary.",
        );
      }

      const cas = parsed.statement;

      let terminalValue: number | undefined;
      let terminalDate: string | undefined;
      const unpriced: string[] = [];
      if (valueAt === "today") {
        let total = 0;
        for (const row of casHoldings(cas)) {
          const match = row.isin ? await amfi.byIsinLookup(row.isin) : null;
          if (!match) {
            unpriced.push(row.scheme);
            continue;
          }
          total += row.units * match.nav;
        }
        // Quietly falling back to the statement valuation would change what the
        // number means, so a live total is only used when everything priced.
        if (unpriced.length === 0 && total > 0) {
          terminalValue = round2(total);
          terminalDate = new Date().toISOString().slice(0, 10);
        }
      }

      const { flows, skipped, unreconciledSchemes } = casCashFlows(cas, {
        scope,
        terminalValue,
        terminalDate,
      });
      const result = xirr(flows);
      if (result === null) {
        return fail(
          "XIRR has no solution for these flows. A statement covering only purchases, " +
            "with no redemption and no closing value, has no sign change and so no rate.",
        );
      }

      return ok({
        xirrPct: result,
        scope,
        valuedAt: terminalDate ?? "statement date",
        flowCount: flows.length,
        firstFlow: flows[0]?.date ?? null,
        skippedTransactions: skipped,
        unpricedSchemes: unpriced,
        unreconciledSchemes,
        note:
          RECONCILE_NOTE +
          " Skipped transactions are rows that move units without moving cash " +
          "(dividend reinvestments, and switches when scope=portfolio).",
      });
    } catch (error) {
      return fail(error);
    }
  },
);

/* -------------------------------------------------------------- sectors -- */

server.registerTool(
  "classify_sectors",
  {
    title: "Look up published sector classifications",
    description:
      "Resolve instruments to NSE's macro-economic sector by ISIN or trading symbol. This is NSE's published classification for Nifty Total Market constituents (around 750 names), not a judgement call: anything outside that index comes back unmatched rather than guessed. Call with no arguments to see the sector vocabulary and how many listed companies sit in each.",
    inputSchema: {
      symbols: z
        .array(z.string())
        .max(200)
        .optional()
        .describe("Trading symbols, e.g. ['RELIANCE', 'TCS']."),
      isins: z
        .array(z.string())
        .max(200)
        .optional()
        .describe("ISINs, e.g. ['INE002A01018']. Preferred over symbols where available."),
    },
  },
  async ({ symbols, isins }) => {
    try {
      await sectors.ensureLoaded();

      const queries = [
        ...(symbols ?? []).map((value) => ({ value, kind: "symbol" as const })),
        ...(isins ?? []).map((value) => ({ value, kind: "isin" as const })),
      ];

      if (queries.length === 0) {
        return ok({ ...sectors.status(), sectors: sectors.sectorCounts() });
      }

      const results = queries.map(({ value, kind }) => {
        const hit =
          kind === "symbol" ? sectors.lookup({ symbol: value }) : sectors.lookup({ isin: value });
        return hit
          ? {
              query: value,
              matched: true,
              symbol: hit.symbol,
              isin: hit.isin,
              company: hit.company,
              sector: hit.sector,
            }
          : { query: value, matched: false, sector: null };
      });

      return ok({
        ...sectors.status(),
        matched: results.filter((result) => result.matched).length,
        results,
        note:
          "An unmatched instrument sits outside the Nifty Total Market index. That is a gap in " +
          "coverage, not a sector called 'Other' — leave it unclassified rather than assigning one.",
      });
    } catch (error) {
      return fail(error);
    }
  },
);

/* ----------------------------------------------------------- live prices -- */

/**
 * A tick cannot interrupt the model mid-turn — MCP is request/response — so the
 * socket is used to decouple collection from asking rather than to push. These
 * tools are the two shapes that honestly fit: a bounded window, and a cache that
 * a later call reads instantly.
 */
const STREAM_NOTE =
  "Prices come from the live WebSocket feed, not a REST poll, so reads are instant " +
  "and cost no rate limit. Outside NSE market hours the feed is silent and no ticks " +
  "arrive — that is the market being closed, not a broken subscription.";

const scripCodeArray = (max: number) =>
  z
    .array(z.string())
    .min(1)
    .max(max)
    .describe("REST-style scrip codes, e.g. ['NSE_2885']. Use search_instruments to resolve them.");

const summariseTick = (tick: Tick) => ({
  scripCode: tick.scripCode ?? tick.instrument,
  ltp: tick.ltp,
  mode: tick.mode,
  exchangeTimestamp: new Date(tick.timestamp).toISOString(),
  ageMs: Date.now() - tick.receivedAt,
});

server.registerTool(
  "watch_prices",
  {
    title: "Watch live prices for a fixed window",
    description:
      "Subscribe to the live price feed, collect ticks for a set number of seconds, then return the series with a per-instrument summary (first, last, high, low, % change). This blocks for the requested duration, so keep it short. Instruments not already subscribed are unsubscribed again afterwards.",
    inputSchema: {
      scripCodes: scripCodeArray(25),
      seconds: z
        .number()
        .min(1)
        .max(60)
        .default(10)
        .describe("How long to watch. The call blocks for this long."),
      mode: z
        .enum(["ltp", "quote"])
        .default("ltp")
        .describe("ltp is just the last traded price; quote adds depth and OHLC."),
      includeTicks: z
        .boolean()
        .default(false)
        .describe("Return every tick as well as the summary. Noisy on liquid names."),
    },
  },
  async ({ scripCodes, seconds, mode, includeTicks }) => {
    try {
      const { ticks, durationMs } = await stream.watch(scripCodes, seconds, mode);
      const summary = summariseWatch(ticks);
      return ok({
        watchedFor: Math.round(durationMs / 100) / 10 + "s",
        tickCount: ticks.length,
        summary,
        ticks: includeTicks ? ticks.map(summariseTick) : undefined,
        note:
          ticks.length === 0
            ? "No ticks arrived. The market is most likely closed, or these instruments are not trading right now. " +
              STREAM_NOTE
            : STREAM_NOTE,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "stream_subscribe",
  {
    title: "Start streaming prices in the background",
    description:
      "Open a standing subscription so prices keep updating in the background. Nothing is returned tick by tick — call stream_quotes afterwards to read the latest values instantly, without spending a REST rate-limit token. Useful when the same names come up repeatedly in one conversation.",
    inputSchema: {
      scripCodes: scripCodeArray(500),
      mode: z.enum(["ltp", "quote"]).default("ltp"),
    },
  },
  async ({ scripCodes, mode }) => {
    try {
      const subscribed = await stream.subscribe(scripCodes, mode);
      return ok({
        subscribed: subscribed.length,
        status: stream.status(),
        note:
          "Ticks accumulate in the background. Read them with stream_quotes. " + STREAM_NOTE,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "stream_unsubscribe",
  {
    title: "Stop streaming prices",
    description:
      "Drop standing price subscriptions. Omit scripCodes to drop all of them and let the connection go idle.",
    inputSchema: {
      scripCodes: z
        .array(z.string())
        .optional()
        .describe("Scrip codes to drop. Omit to unsubscribe everything."),
    },
  },
  async ({ scripCodes }) => {
    try {
      const dropped = await stream.unsubscribe(scripCodes);
      return ok({ unsubscribed: dropped.length, status: stream.status() });
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "stream_quotes",
  {
    title: "Read the latest streamed prices",
    description:
      "Read the most recent tick for each streamed instrument. This is a cache lookup, not a network call: it returns immediately and costs no rate limit. Every row carries ageMs — check it before presenting a price as current, since a stale value means the feed went quiet, not that the price held steady.",
    inputSchema: {
      scripCodes: z
        .array(z.string())
        .optional()
        .describe("Restrict to these scrip codes. Omit for everything subscribed."),
    },
  },
  async ({ scripCodes }) => {
    try {
      const ticks = stream.snapshot(scripCodes);
      return ok({
        quotes: ticks.map(summariseTick),
        status: stream.status(),
        note:
          ticks.length === 0
            ? "Nothing cached yet. Call stream_subscribe first, and note that no ticks arrive while the market is closed."
            : STREAM_NOTE,
      });
    } catch (error) {
      return fail(error);
    }
  },
);

/* ------------------------------------------------------------------- auth -- */

server.registerTool(
  "refresh_token",
  {
    title: "Refresh the INDstocks access token",
    description:
      "Generate a fresh INDstocks access token and start using it immediately — no restart, no config editing. Tokens expire 24 hours after issue, and that expiry is the usual reason every other tool starts failing at once. If INDSTOCKS_TOTP_SECRET is configured the server derives the code itself and this needs no arguments; otherwise supply the current six-digit code from your authenticator app. Prefer setting credentials in the environment: an MPIN passed here is written into the conversation transcript. INDstocks keeps one live TOTP-issued token per account, so refreshing revokes any token another script or session is holding.",
    inputSchema: {
      mpin: z
        .string()
        .optional()
        .describe("Account MPIN. Omit if INDSTOCKS_MPIN is set in the environment."),
      totp: z
        .string()
        .regex(/^\d{6}$/, "A TOTP code is exactly six digits.")
        .optional()
        .describe("Current six-digit authenticator code. Omit if INDSTOCKS_TOTP_SECRET is set."),
    },
  },
  async ({ mpin, totp }) => {
    try {
      const result = await tokens.refresh({ mpin, totp });
      return ok({
        refreshed: true,
        mode: result.mode,
        issuedAt: new Date(result.issuedAt).toISOString(),
        expiresAt: new Date(result.expiresAt).toISOString(),
        // Enough to confirm the token actually changed, and nothing more: the
        // token itself is a bearer credential and does not belong in a transcript.
        tokenFingerprint: "..." + result.fingerprint,
        note:
          "Held in memory for this process only — not written to disk and not echoed back. " +
          "Any previously issued token for this account is now revoked.",
      });
    } catch (error) {
      return fail(error);
    }
  },
);

/* ------------------------------------------------------------ diagnostics -- */

server.registerTool(
  "diagnose_endpoints",
  {
    title: "Probe API endpoints",
    description:
      "Probe every configured endpoint and report which resolve on your account. Every path is currently verified against the official docs, so a failure here usually means an expired token or a segment your account is not entitled to, rather than a wrong path.",
    inputSchema: {},
  },
  async () => {
    const results: Array<Record<string, unknown>> = [];
    for (const [name, spec] of Object.entries(ENDPOINTS)) {
      if (name === "instruments") continue; // large payload, skip in a probe
      if (spec.path.includes("{")) {
        // Templated paths need parameters a blind probe cannot invent.
        results.push({
          endpoint: name,
          path: spec.path,
          provenance: spec.provenance,
          status: "SKIPPED",
          detail: "Takes a path parameter; exercise it through its own tool.",
        });
        continue;
      }
      try {
        await client.get(name as EndpointName);
        results.push({ endpoint: name, path: spec.path, provenance: spec.provenance, status: "OK" });
      } catch (error) {
        results.push({
          endpoint: name,
          path: spec.path,
          provenance: spec.provenance,
          status: error instanceof IndStocksError ? `FAILED (${error.status ?? "network"})` : "FAILED",
          detail: error instanceof Error ? error.message.split("\n")[0] : String(error),
        });
      }
    }
    return ok({
      results,
      auth: tokens.status,
      omittedByDesign: DELIBERATELY_OMITTED,
      note:
        "Order placement endpoints are intentionally not exposed. See README. " +
        "If everything failed at once, the token has most likely expired — call refresh_token.",
    });
  },
);

/* ------------------------------------------------------------------ start -- */

async function main() {
  if (!tokens.hasToken && !tokens.canAutoRefresh) {
    log("WARNING: no token, and no credentials to generate one. Every API tool will fail.");
    log("Set INDSTOCKS_TOKEN, or INDSTOCKS_API_KEY + INDSTOCKS_MPIN + INDSTOCKS_TOTP_SECRET");
    log("for unattended refresh, or call the refresh_token tool once the server is running.");
  } else if (tokens.canAutoRefresh) {
    log("token auto-refresh armed; expiry will be handled without intervention");
  }
  // A live socket is a ref'd handle: without this the process would outlive the
  // client that started it, still happily consuming ticks nobody can read.
  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    stream.close();
  };
  process.on("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });
  process.stdin.on("end", shutdown);
  process.on("beforeExit", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`v${VERSION} ready (read-only; no order placement)`);
}

main().catch((error) => {
  log("fatal:", error);
  process.exit(1);
});
