import type { IndStocksClient } from "./client.js";

/**
 * The instrument master maps human symbols ("RELIANCE") to the numeric
 * security_id and scrip code the API actually wants ("2885", "NSE_2885").
 *
 * It is large and changes about once a day, so it is fetched once and cached in
 * memory for the process lifetime, with a hard TTL.
 */

export interface Instrument {
  securityId: string;
  scripCode: string;
  symbol: string;
  name: string;
  exchange: string;
  segment: string;
  raw: Record<string, string>;
}

const TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

export class InstrumentStore {
  private instruments: Instrument[] = [];
  private fetchedAt = 0;
  private inflight: Promise<void> | null = null;

  constructor(private readonly client: IndStocksClient) {}

  private get stale(): boolean {
    return this.instruments.length === 0 || Date.now() - this.fetchedAt > TTL_MS;
  }

  async ensureLoaded(): Promise<void> {
    if (!this.stale) return;
    // Collapse concurrent loads: several tools may race on first use.
    if (this.inflight) return this.inflight;
    this.inflight = this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(): Promise<void> {
    const body = await this.client.getText("instruments");
    const trimmed = body.trimStart();
    this.instruments = trimmed.startsWith("{") || trimmed.startsWith("[")
      ? parseJsonMaster(trimmed)
      : parseCsvMaster(body);
    this.fetchedAt = Date.now();
  }

  /**
   * Ranked search. Exact symbol match wins, then prefix, then substring on name.
   * Deliberately simple - no fuzzy matching, because silently returning the wrong
   * instrument is worse than returning nothing.
   */
  async search(query: string, limit = 10, exchange?: string): Promise<Instrument[]> {
    await this.ensureLoaded();
    const q = query.trim().toUpperCase();
    if (!q) return [];

    const pool = exchange
      ? this.instruments.filter((i) => i.exchange.toUpperCase() === exchange.toUpperCase())
      : this.instruments;

    const scored: Array<{ inst: Instrument; score: number }> = [];
    for (const inst of pool) {
      const symbol = inst.symbol.toUpperCase();
      const name = inst.name.toUpperCase();
      let score = -1;
      if (symbol === q) score = 0;
      else if (symbol.startsWith(q)) score = 1;
      else if (name.startsWith(q)) score = 2;
      else if (symbol.includes(q)) score = 3;
      else if (name.includes(q)) score = 4;
      if (score >= 0) scored.push({ inst, score });
      if (scored.length > 5000) break; // guard against pathological queries
    }

    scored.sort((a, b) => a.score - b.score || a.inst.symbol.length - b.inst.symbol.length);
    return scored.slice(0, limit).map((s) => s.inst);
  }

  async resolve(symbolOrId: string, exchange = "NSE"): Promise<Instrument | null> {
    const results = await this.search(symbolOrId, 1, exchange);
    return results[0] ?? null;
  }

  get count(): number {
    return this.instruments.length;
  }
}

function pick(row: Record<string, string>, keys: string[]): string {
  for (const key of keys) {
    const found = Object.keys(row).find((k) => k.toLowerCase().replace(/[^a-z]/g, "") === key);
    if (found && row[found]) return row[found];
  }
  return "";
}

function toInstrument(row: Record<string, string>): Instrument {
  const securityId = pick(row, ["securityid", "id", "token", "instrumenttoken"]);
  const exchange = pick(row, ["exchange", "exch", "exchangesegment"]) || "NSE";
  const explicitScrip = pick(row, ["scripcode", "scrip"]);
  return {
    securityId,
    scripCode: explicitScrip || (securityId ? `${exchange}_${securityId}` : ""),
    symbol: pick(row, ["tradingsymbol", "symbol", "ticker"]),
    name: pick(row, ["name", "companyname", "description"]),
    exchange,
    segment: pick(row, ["segment", "instrumenttype"]),
    raw: row,
  };
}

function parseJsonMaster(body: string): Instrument[] {
  const parsed = JSON.parse(body) as unknown;
  const rows: unknown[] = Array.isArray(parsed)
    ? parsed
    : ((parsed as { data?: unknown[] }).data ?? []);
  return rows
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .map((r) => {
      const flat: Record<string, string> = {};
      for (const [k, v] of Object.entries(r)) flat[k] = v == null ? "" : String(v);
      return toInstrument(flat);
    })
    .filter((i) => i.symbol);
}

/** Minimal RFC-4180-ish CSV parser. Handles quoted fields containing commas. */
function parseCsvMaster(body: string): Instrument[] {
  const lines = body.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const headers = splitCsvLine(lines[0]!);
  const out: Instrument[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]!);
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => {
      row[h.trim()] = (cells[idx] ?? "").trim();
    });
    const inst = toInstrument(row);
    if (inst.symbol) out.push(inst);
  }
  return out;
}

/** Shared with sectors.ts, which parses NSE's index constituent CSVs. */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!;
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current);
  return cells;
}
