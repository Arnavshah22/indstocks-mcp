/**
 * AMFI NAV feed.
 *
 * The INDstocks trading API covers equity, F&O and currency. It does NOT cover
 * mutual funds. Since most Indian retail portfolios are mostly mutual funds, a
 * portfolio tool without MF data answers the wrong question.
 *
 * AMFI publishes a free daily NAV dump for every scheme in the country. No key,
 * no auth, no scraping. That is the gap-filler.
 *
 * Format is semicolon-delimited with AMC name lines and category header lines
 * interleaved between data rows, so it needs a small stateful parser.
 */

const AMFI_NAV_ALL = "https://portal.amfiindia.com/spages/NAVAll.txt";
const TTL_MS = 6 * 60 * 60 * 1000; // NAVs publish once per business day

export interface Scheme {
  schemeCode: string;
  isinGrowth: string;
  isinReinvest: string;
  /** Fund name including plan and option, e.g. "Axis Bluechip Fund - Direct Plan - Growth". */
  schemeName: string;
  plan: string | null;
  option: string | null;
  nav: number;
  date: string;
  amc: string;
  category: string;
}

export class AmfiStore {
  private schemes: Scheme[] = [];
  private byCode = new Map<string, Scheme>();
  // A CAS identifies a fund by ISIN, never by AMFI scheme code, so revaluing
  // parsed holdings at today's NAV needs this second index.
  private byIsin = new Map<string, Scheme>();
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(private readonly url: string = AMFI_NAV_ALL) {}

  private get stale(): boolean {
    return this.schemes.length === 0 || Date.now() - this.fetchedAt > TTL_MS;
  }

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
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(this.url, { signal: controller.signal });
      if (!response.ok) {
        throw new Error(`AMFI NAV fetch failed: ${response.status}`);
      }
      const text = await response.text();
      this.schemes = parseNavAll(text);
      this.byCode = new Map(this.schemes.map((s) => [s.schemeCode, s]));
      this.byIsin = new Map();
      for (const scheme of this.schemes) {
        // Growth and reinvest plans are separate ISINs pointing at one NAV row.
        for (const isin of [scheme.isinGrowth, scheme.isinReinvest]) {
          const key = isin.trim().toUpperCase();
          if (key && key !== "-" && !this.byIsin.has(key)) this.byIsin.set(key, scheme);
        }
      }
      this.fetchedAt = Date.now();
    } finally {
      clearTimeout(timer);
    }
  }

  async search(query: string, limit = 15): Promise<Scheme[]> {
    await this.ensureLoaded();
    const terms = query.trim().toUpperCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const scored: Array<{ scheme: Scheme; score: number }> = [];
    for (const scheme of this.schemes) {
      const haystack = `${scheme.schemeName} ${scheme.amc}`.toUpperCase();
      let matched = 0;
      for (const term of terms) {
        if (haystack.includes(term)) matched++;
      }
      if (matched === terms.length) {
        // Prefer shorter names: "Direct Growth" beats "Direct Growth - Bonus Option".
        scored.push({ scheme, score: scheme.schemeName.length });
      }
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, limit).map((s) => s.scheme);
  }

  async byCodeLookup(schemeCode: string): Promise<Scheme | null> {
    await this.ensureLoaded();
    return this.byCode.get(schemeCode.trim()) ?? null;
  }

  async byIsinLookup(isin: string): Promise<Scheme | null> {
    await this.ensureLoaded();
    return this.byIsin.get(isin.trim().toUpperCase()) ?? null;
  }

  get count(): number {
    return this.schemes.length;
  }
}

export function parseNavAll(text: string): Scheme[] {
  const out: Scheme[] = [];
  let currentAmc = "";
  let currentCategory = "";

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    // Header row of the data table.
    if (line.startsWith("Scheme Code")) continue;

    const parts = line.split(";");

    if (parts.length < 6) {
      // Non-data line. Category headers contain "Schemes(" e.g.
      // "Open Ended Schemes(Equity Scheme - Large Cap Fund)".
      // Everything else at this position is an AMC name.
      if (/Schemes?\s*\(/i.test(line)) {
        currentCategory = line;
      } else {
        currentAmc = line;
      }
      continue;
    }

    // NAV and date are read from the RIGHT, not by fixed index.
    //
    // AMFI widened this feed from six columns to eight by inserting `Plan` and
    // `Option` between the scheme name and the NAV. Reading index 4 as the NAV
    // then yielded "Direct Plan", which is not a number, so every single row was
    // discarded and the whole mutual fund universe silently came back empty.
    // Anchoring on the last two fields survives that kind of change.
    const nav = Number.parseFloat(parts[parts.length - 2] ?? "");
    if (!Number.isFinite(nav)) continue; // "N.A." rows for suspended schemes

    const wide = parts.length >= 8;
    const plan = wide ? (parts[4] ?? "").trim() : "";
    const option = wide ? (parts[5] ?? "").trim() : "";
    const baseName = (parts[3] ?? "").trim();

    out.push({
      schemeCode: (parts[0] ?? "").trim(),
      isinGrowth: (parts[1] ?? "").trim(),
      isinReinvest: (parts[2] ?? "").trim(),
      // Plan and option used to live inside the name column and search queries
      // ("... direct growth") still depend on matching them, so recombine rather
      // than expose a bare fund name that no realistic query would hit.
      schemeName: [baseName, plan, option].filter((part) => part && part !== "-").join(" - "),
      plan: plan || null,
      option: option || null,
      nav,
      date: (parts[parts.length - 1] ?? "").trim(),
      amc: currentAmc,
      category: currentCategory,
    });
  }

  return out;
}

/**
 * Regular vs direct plan drag.
 *
 * Pure arithmetic on numbers the user supplies. It does not tell anyone what to
 * buy - it shows what a given expense ratio difference compounds to. The user
 * draws their own conclusion.
 */
export function expenseDrag(
  amount: number,
  years: number,
  assumedReturnPct: number,
  regularExpensePct: number,
  directExpensePct: number,
): { regular: number; direct: number; difference: number } {
  const grow = (expense: number) =>
    amount * Math.pow(1 + (assumedReturnPct - expense) / 100, years);
  const regular = grow(regularExpensePct);
  const direct = grow(directExpensePct);
  return {
    regular: round2(regular),
    direct: round2(direct),
    difference: round2(direct - regular),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
