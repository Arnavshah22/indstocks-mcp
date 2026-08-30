// Sector classification.
//
// The reason this exists at all is that `analyze_allocation` used to take the
// sector as a string on each position, which in practice meant a language model
// recalling which bucket a company sits in. So the load-bearing assertion here is
// the precedence one: the published classification must beat anything supplied by
// the caller, or the grouping dimension goes back to being a guess.

import test from "node:test";
import assert from "node:assert/strict";

import { parseSectorCsv, SectorStore, classifyPositions } from "../dist/sectors.js";

const CSV = [
  "Company Name,Industry,Symbol,Series,ISIN Code",
  "Reliance Industries Ltd.,Oil Gas & Consumable Fuels,RELIANCE,EQ,INE002A01018",
  "Tata Consultancy Services Ltd.,Information Technology,TCS,EQ,INE467B01029",
  "HDFC Bank Ltd.,Financial Services,HDFCBANK,EQ,INE040A01034",
  // NSE seeds the file with placeholder rows for pending corporate actions.
  "Dummy Inox Green Ltd.,Construction,DUMMYINXGN,EQ,DUM510W01014",
  '"Bajaj Holdings, Ltd.",Financial Services,BAJAJHLDNG,EQ,INE118A01012',
].join("\r\n");

/** Stub global fetch for one test. */
function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: url.toString(), init });
    return handler(calls.length);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const csvResponse = () => new Response(CSV, { status: 200 });

/* ------------------------------------------------------------- parsing --- */

test("parses NSE's index constituent CSV", () => {
  const entries = parseSectorCsv(CSV);
  assert.equal(entries.length, 4, "the DUMMY placeholder row is dropped");

  const reliance = entries.find((e) => e.symbol === "RELIANCE");
  assert.deepEqual(
    { sector: reliance.sector, isin: reliance.isin, company: reliance.company },
    {
      sector: "Oil Gas & Consumable Fuels",
      isin: "INE002A01018",
      company: "Reliance Industries Ltd.",
    },
  );
});

test("drops placeholder rows rather than listing them as companies", () => {
  const entries = parseSectorCsv(CSV);
  assert.ok(!entries.some((e) => e.symbol.startsWith("DUMMY")));
  assert.ok(!entries.some((e) => e.isin.startsWith("DUM")), "a DUM… ISIN is not a listed company");
});

test("handles a company name containing a comma", () => {
  const entry = parseSectorCsv(CSV).find((e) => e.symbol === "BAJAJHLDNG");
  assert.equal(entry.company, "Bajaj Holdings, Ltd.");
  assert.equal(entry.sector, "Financial Services");
});

test("finds columns by header name, not position", () => {
  const reordered = [
    "ISIN Code,Symbol,Industry,Series,Company Name",
    "INE002A01018,RELIANCE,Oil Gas & Consumable Fuels,EQ,Reliance Industries Ltd.",
  ].join("\n");
  const [entry] = parseSectorCsv(reordered);
  assert.equal(entry.symbol, "RELIANCE");
  assert.equal(entry.sector, "Oil Gas & Consumable Fuels");
  assert.equal(entry.isin, "INE002A01018");
});

test("returns nothing rather than garbage for unusable input", () => {
  assert.deepEqual(parseSectorCsv(""), []);
  assert.deepEqual(parseSectorCsv("Company Name,Industry,Symbol,Series,ISIN Code"), []);
  assert.deepEqual(parseSectorCsv("total nonsense\nmore nonsense"), []);
});

/* --------------------------------------------------------------- store --- */

test("looks up by ISIN and by symbol", async () => {
  const stub = stubFetch(csvResponse);
  try {
    const store = new SectorStore("https://example.test/list.csv");
    await store.ensureLoaded();

    assert.equal(store.available, true);
    assert.equal(store.count, 4);
    assert.equal(store.lookup({ symbol: "TCS" }).sector, "Information Technology");
    assert.equal(store.lookup({ isin: "INE040A01034" }).sector, "Financial Services");
    assert.equal(store.lookup({ symbol: "tcs" }).sector, "Information Technology", "case insensitive");
    assert.equal(store.lookup({ symbol: "NOTLISTED" }), null);
  } finally {
    stub.restore();
  }
});

test("prefers ISIN over symbol when the two disagree", async () => {
  const stub = stubFetch(csvResponse);
  try {
    const store = new SectorStore("https://example.test/list.csv");
    await store.ensureLoaded();
    // Symbols get reused and reassigned after corporate actions; the ISIN does not.
    const hit = store.lookup({ symbol: "RELIANCE", isin: "INE467B01029" });
    assert.equal(hit.symbol, "TCS");
    assert.equal(hit.sector, "Information Technology");
  } finally {
    stub.restore();
  }
});

test("tolerates a scrip-code style prefix on the symbol", async () => {
  const stub = stubFetch(csvResponse);
  try {
    const store = new SectorStore("https://example.test/list.csv");
    await store.ensureLoaded();
    assert.equal(store.lookup({ symbol: "NSE_RELIANCE" }).symbol, "RELIANCE");
    assert.equal(store.lookup({ symbol: "NSE:TCS" }).symbol, "TCS");
  } finally {
    stub.restore();
  }
});

test("a failed feed degrades instead of throwing, and says so", async () => {
  const stub = stubFetch(() => new Response("nope", { status: 503 }));
  try {
    const store = new SectorStore("https://example.test/list.csv");
    await store.ensureLoaded(); // must not reject

    assert.equal(store.available, false);
    assert.equal(store.count, 0);
    assert.equal(store.lookup({ symbol: "TCS" }), null);
    assert.match(store.error, /503/);
    // "NSE was unreachable" and "this stock is not in the index" both leave a
    // position unclassified, but only one means the weights are wrong.
    assert.equal(store.status().available, false);
    assert.ok(store.status().lastError);
  } finally {
    stub.restore();
  }
});

test("does not re-fetch on every lookup after a failure", async () => {
  const stub = stubFetch(() => new Response("nope", { status: 503 }));
  try {
    const store = new SectorStore("https://example.test/list.csv");
    await store.ensureLoaded();
    await store.ensureLoaded();
    await store.ensureLoaded();
    assert.equal(stub.calls.length, 1, "a failing feed must not be hammered");
  } finally {
    stub.restore();
  }
});

test("collapses concurrent first loads into one request", async () => {
  const stub = stubFetch(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return csvResponse();
  });
  try {
    const store = new SectorStore("https://example.test/list.csv");
    await Promise.all([store.ensureLoaded(), store.ensureLoaded(), store.ensureLoaded()]);
    assert.equal(stub.calls.length, 1);
    assert.equal(store.count, 4);
  } finally {
    stub.restore();
  }
});

test("summarises the sector vocabulary", async () => {
  const stub = stubFetch(csvResponse);
  try {
    const store = new SectorStore("https://example.test/list.csv");
    await store.ensureLoaded();
    const counts = store.sectorCounts();
    assert.equal(counts[0].sector, "Financial Services", "sorted by population");
    assert.equal(counts[0].instruments, 2);
    assert.equal(counts.length, 3);
  } finally {
    stub.restore();
  }
});

/* ---------------------------------------------------------- precedence --- */

test("the published classification beats a caller-supplied sector", async () => {
  const stub = stubFetch(csvResponse);
  try {
    const store = new SectorStore("https://example.test/list.csv");
    await store.ensureLoaded();

    // This is the entire point of the feature. If a passed-in string could
    // override NSE, the grouping dimension would be model-generated again.
    const [classified] = classifyPositions(store, [
      { symbol: "TCS", sector: "Consumer Durables" },
    ]);
    assert.equal(classified.sector, "Information Technology");
    assert.equal(classified.provenance, "nse");
  } finally {
    stub.restore();
  }
});

test("a caller-supplied sector is used only where the index has no entry", async () => {
  const stub = stubFetch(csvResponse);
  try {
    const store = new SectorStore("https://example.test/list.csv");
    await store.ensureLoaded();

    const classified = classifyPositions(store, [
      { symbol: "TCS" },
      { symbol: "TINYCAP", sector: "Textiles" },
      { symbol: "ALSOTINY" },
    ]);

    assert.deepEqual(
      classified.map((c) => [c.sector, c.provenance]),
      [
        ["Information Technology", "nse"],
        ["Textiles", "caller"],
        ["Unclassified", "unclassified"],
      ],
    );
  } finally {
    stub.restore();
  }
});

test("classifies by ISIN when the position carries one", async () => {
  const stub = stubFetch(csvResponse);
  try {
    const store = new SectorStore("https://example.test/list.csv");
    await store.ensureLoaded();
    const [classified] = classifyPositions(store, [
      { symbol: "SOMETHING-ODD", isin: "INE002A01018" },
    ]);
    assert.equal(classified.sector, "Oil Gas & Consumable Fuels");
    assert.equal(classified.provenance, "nse");
  } finally {
    stub.restore();
  }
});

test("everything is unclassified when the feed is unavailable", async () => {
  const stub = stubFetch(() => new Response("nope", { status: 500 }));
  try {
    const store = new SectorStore("https://example.test/list.csv");
    await store.ensureLoaded();
    const classified = classifyPositions(store, [{ symbol: "TCS" }, { symbol: "RELIANCE" }]);
    assert.ok(classified.every((c) => c.provenance === "unclassified"));
    assert.equal(store.available, false, "callers can tell this apart from a coverage gap");
  } finally {
    stub.restore();
  }
});
