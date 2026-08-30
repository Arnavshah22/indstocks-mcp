/**
 * Sector classification for Indian equities.
 *
 * `analyze_allocation` has always been able to group by sector, but the sector
 * itself arrived as an optional string on each position — which in practice meant
 * a language model recalling which bucket a company belongs in. The arithmetic on
 * top was deterministic and the input was not, which is the one combination this
 * codebase is supposed to avoid: a confident number resting on a guess.
 *
 * NSE publishes its own macro-economic sector for every constituent of the Nifty
 * Total Market index — about 750 names, keyed by both symbol and ISIN, free and
 * unauthenticated. That is the authority used here.
 *
 * ## Coverage is finite, and saying so matters
 *
 * The index is broad but not exhaustive: a thinly traded microcap outside it has
 * no entry. Such a holding is reported as `Unclassified` and counted, never
 * quietly folded into a neighbouring bucket. And "NSE was unreachable" is kept
 * distinct from "this stock is not in the index" — both leave a position
 * unclassified, but only one of them means the weights are wrong.
 */

import { splitCsvLine } from "./instruments.js";

export const NSE_TOTAL_MARKET_URL =
  "https://nsearchives.nseindia.com/content/indices/ind_niftytotalmarket_list.csv";

const TTL_MS = 24 * 60 * 60 * 1000; // index composition changes semi-annually
const FAILURE_TTL_MS = 60 * 1000; // don't hammer NSE after a failure

export interface SectorEntry {
  symbol: string;
  isin: string;
  company: string;
  sector: string;
}

/**
 * Parse NSE's index constituent CSV.
 *
 * Columns are `Company Name, Industry, Symbol, Series, ISIN Code`. NSE seeds the
 * file with placeholder rows for pending corporate actions — `DUMMYINXGN` and the
 * like, carrying invented `DUM…` ISINs — which would otherwise land in the symbol
 * index as real companies. Requiring a genuine Indian ISIN prefix drops them.
 */
export function parseSectorCsv(text: string): SectorEntry[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length < 2) return [];

  const headers = splitCsvLine(lines[0]!).map((h) => h.trim().toLowerCase());
  const columnOf = (...names: string[]): number => {
    for (const name of names) {
      const index = headers.indexOf(name);
      if (index !== -1) return index;
    }
    return -1;
  };

  const companyAt = columnOf("company name", "company");
  const sectorAt = columnOf("industry", "sector", "macro-economic sector");
  const symbolAt = columnOf("symbol");
  const isinAt = columnOf("isin code", "isin");
  if (sectorAt === -1 || symbolAt === -1) return [];

  const out: SectorEntry[] = [];
  for (const line of lines.slice(1)) {
    const cells = splitCsvLine(line).map((cell) => cell.trim());
    const symbol = (cells[symbolAt] ?? "").toUpperCase();
    const isin = (isinAt === -1 ? "" : cells[isinAt] ?? "").toUpperCase();
    const sector = cells[sectorAt] ?? "";
    if (!symbol || !sector) continue;
    if (!isin.startsWith("IN")) continue; // placeholder row, not a listed company
    out.push({
      symbol,
      isin,
      company: companyAt === -1 ? "" : cells[companyAt] ?? "",
      sector,
    });
  }
  return out;
}

export interface SectorLookup {
  symbol?: string | null;
  isin?: string | null;
}

export class SectorStore {
  private bySymbol = new Map<string, SectorEntry>();
  private byIsin = new Map<string, SectorEntry>();
  private entries: SectorEntry[] = [];
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;
  private failedAt = 0;
  private lastError: string | null = null;

  constructor(private readonly url: string = NSE_TOTAL_MARKET_URL) {}

  private get stale(): boolean {
    if (this.entries.length > 0) return Date.now() - this.fetchedAt > TTL_MS;
    // Nothing loaded: retry, but not on every single lookup after a failure.
    return this.failedAt === 0 || Date.now() - this.failedAt > FAILURE_TTL_MS;
  }

  /**
   * Load the classification. Never throws: a missing sector feed should degrade an
   * allocation to "Unclassified with a stated reason", not fail the whole call.
   */
  async ensureLoaded(): Promise<void> {
    if (!this.stale) return;
    if (this.inflight) return this.inflight;
    this.inflight = this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(this.url, {
        signal: controller.signal,
        // NSE serves archives to plain clients, but a bare fetch UA is the kind of
        // thing their edge occasionally refuses.
        headers: { "User-Agent": "Mozilla/5.0 (compatible; indstocks-mcp)" },
      });
      if (!response.ok) throw new Error(`NSE returned ${response.status}`);

      const parsed = parseSectorCsv(await response.text());
      if (parsed.length === 0) throw new Error("NSE feed parsed to zero rows");

      this.entries = parsed;
      this.bySymbol = new Map(parsed.map((entry) => [entry.symbol, entry]));
      this.byIsin = new Map(parsed.map((entry) => [entry.isin, entry]));
      this.fetchedAt = Date.now();
      this.failedAt = 0;
      this.lastError = null;
    } catch (error) {
      this.failedAt = Date.now();
      this.lastError = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * ISIN first: it is unambiguous, whereas a trading symbol can be reused across
   * exchanges and reassigned after a corporate action.
   */
  lookup({ symbol, isin }: SectorLookup): SectorEntry | null {
    if (isin) {
      const hit = this.byIsin.get(isin.trim().toUpperCase());
      if (hit) return hit;
    }
    if (symbol) {
      const bare = symbol.trim().toUpperCase();
      const hit = this.bySymbol.get(bare);
      if (hit) return hit;
      // Tolerate a scrip-code style prefix ("NSE_RELIANCE" / "NSE:RELIANCE").
      const stripped = bare.replace(/^[A-Z]+[_:]/, "");
      if (stripped !== bare) return this.bySymbol.get(stripped) ?? null;
    }
    return null;
  }

  get count(): number {
    return this.entries.length;
  }

  get available(): boolean {
    return this.entries.length > 0;
  }

  get error(): string | null {
    return this.lastError;
  }

  /** Every sector name in the classification, with how many names sit in each. */
  sectorCounts(): Array<{ sector: string; instruments: number }> {
    const counts = new Map<string, number>();
    for (const entry of this.entries) {
      counts.set(entry.sector, (counts.get(entry.sector) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([sector, instruments]) => ({ sector, instruments }))
      .sort((a, b) => b.instruments - a.instruments);
  }

  status(): {
    source: string;
    universeSize: number;
    available: boolean;
    lastError: string | null;
    fetchedAt: string | null;
  } {
    return {
      source: "NSE Nifty Total Market index — macro-economic sector classification",
      universeSize: this.count,
      available: this.available,
      lastError: this.lastError,
      fetchedAt: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null,
    };
  }
}

export type SectorProvenance = "nse" | "caller" | "unclassified";

export interface ClassifiedPosition {
  symbol: string;
  isin?: string | null;
  sector: string;
  provenance: SectorProvenance;
}

/**
 * Resolve a sector for each position.
 *
 * NSE wins over a caller-supplied string wherever it has an entry. That ordering
 * is the whole point: letting a passed-in `sector` override the published
 * classification would put the model back in charge of the grouping dimension.
 * The caller's value is a fallback for the tail NSE does not cover, and how often
 * it was used is reported so the mix stays visible.
 */
export function classifyPositions(
  store: SectorStore,
  positions: Array<{ symbol: string; isin?: string | null; sector?: string | null }>,
): ClassifiedPosition[] {
  return positions.map((position) => {
    const hit = store.lookup({ symbol: position.symbol, isin: position.isin });
    if (hit) {
      return { symbol: position.symbol, isin: position.isin, sector: hit.sector, provenance: "nse" };
    }
    if (position.sector && position.sector.trim()) {
      return {
        symbol: position.symbol,
        isin: position.isin,
        sector: position.sector.trim(),
        provenance: "caller",
      };
    }
    return {
      symbol: position.symbol,
      isin: position.isin,
      sector: "Unclassified",
      provenance: "unclassified",
    };
  });
}
