/**
 * Deterministic portfolio maths.
 *
 * Everything here is arithmetic, computed in code, not by a language model.
 * That is on purpose: XIRR and concentration ratios have exactly one right
 * answer, and an LLM doing them in its head is a liability. The model's job is
 * to explain these numbers, not to produce them.
 *
 * Nothing here recommends anything. It describes a portfolio.
 */

export interface Position {
  symbol: string;
  quantity: number;
  lastPrice: number;
  averagePrice?: number;
  sector?: string;
}

export interface AllocationRow {
  key: string;
  value: number;
  weightPct: number;
}

export function allocationBy(
  positions: Position[],
  dimension: (p: Position) => string,
): AllocationRow[] {
  const totals = new Map<string, number>();
  let grandTotal = 0;

  for (const position of positions) {
    const value = position.quantity * position.lastPrice;
    if (!Number.isFinite(value)) continue;
    const key = dimension(position) || "Unclassified";
    totals.set(key, (totals.get(key) ?? 0) + value);
    grandTotal += value;
  }

  if (grandTotal === 0) return [];

  return [...totals.entries()]
    .map(([key, value]) => ({
      key,
      value: round2(value),
      weightPct: round2((value / grandTotal) * 100),
    }))
    .sort((a, b) => b.value - a.value);
}

/**
 * Herfindahl-Hirschman Index over portfolio weights, 0-10000.
 *
 * Rough reading: under 1500 is diffuse, 1500-2500 is moderately concentrated,
 * above 2500 is concentrated. These are the standard antitrust thresholds
 * borrowed as a heuristic - they are a description, not a verdict.
 */
export function concentrationHHI(positions: Position[]): {
  hhi: number;
  effectiveHoldings: number;
  topWeightPct: number;
} {
  const rows = allocationBy(positions, (p) => p.symbol);
  if (rows.length === 0) return { hhi: 0, effectiveHoldings: 0, topWeightPct: 0 };

  const hhi = rows.reduce((sum, row) => sum + row.weightPct ** 2, 0);
  return {
    hhi: round2(hhi),
    // 1/HHI expressed as a count: "this behaves like N equal-weight holdings".
    effectiveHoldings: round2(10000 / hhi),
    topWeightPct: rows[0]!.weightPct,
  };
}

export interface CashFlow {
  /** ISO date, YYYY-MM-DD. Outflows negative, inflows positive. */
  date: string;
  amount: number;
}

/**
 * XIRR via bisection.
 *
 * Newton-Raphson is faster but diverges on irregular retail cash flow patterns
 * (many small SIP instalments plus one large redemption). Bisection is slower
 * and always converges inside the bracket, which is the correct trade for a tool
 * that runs a few times per conversation.
 */
export function xirr(flows: CashFlow[], tolerance = 1e-7, maxIterations = 200): number | null {
  if (flows.length < 2) return null;

  const parsed = flows
    .map((f) => ({ time: Date.parse(f.date), amount: f.amount }))
    .filter((f) => Number.isFinite(f.time) && Number.isFinite(f.amount))
    .sort((a, b) => a.time - b.time);

  if (parsed.length < 2) return null;

  const hasPositive = parsed.some((f) => f.amount > 0);
  const hasNegative = parsed.some((f) => f.amount < 0);
  if (!hasPositive || !hasNegative) return null; // no sign change, no root

  const start = parsed[0]!.time;
  const npv = (rate: number): number => {
    let total = 0;
    for (const flow of parsed) {
      const years = (flow.time - start) / (365 * 24 * 60 * 60 * 1000);
      total += flow.amount / Math.pow(1 + rate, years);
    }
    return total;
  };

  let low = -0.9999;
  let high = 10;
  let npvLow = npv(low);
  let npvHigh = npv(high);

  // Expand the upper bracket for spectacular returns before giving up.
  let expansions = 0;
  while (npvLow * npvHigh > 0 && expansions < 10) {
    high *= 2;
    npvHigh = npv(high);
    expansions++;
  }
  if (npvLow * npvHigh > 0) return null;

  for (let i = 0; i < maxIterations; i++) {
    const mid = (low + high) / 2;
    const npvMid = npv(mid);
    if (Math.abs(npvMid) < tolerance || high - low < tolerance) {
      return round4(mid * 100);
    }
    if (npvLow * npvMid < 0) {
      high = mid;
      npvHigh = npvMid;
    } else {
      low = mid;
      npvLow = npvMid;
    }
  }

  return round4(((low + high) / 2) * 100);
}

/** Drift between current weights and a stated target allocation. */
export function allocationDrift(
  current: AllocationRow[],
  target: Record<string, number>,
): Array<{ key: string; currentPct: number; targetPct: number; driftPct: number }> {
  const keys = new Set([...current.map((r) => r.key), ...Object.keys(target)]);
  const currentMap = new Map(current.map((r) => [r.key, r.weightPct]));

  return [...keys]
    .map((key) => {
      const currentPct = currentMap.get(key) ?? 0;
      const targetPct = target[key] ?? 0;
      return {
        key,
        currentPct: round2(currentPct),
        targetPct: round2(targetPct),
        driftPct: round2(currentPct - targetPct),
      };
    })
    .sort((a, b) => Math.abs(b.driftPct) - Math.abs(a.driftPct));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
