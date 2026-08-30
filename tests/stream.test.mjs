// PriceStream against a local server speaking the documented feed protocol.
//
// The things worth pinning are the ones a live smoke test would never catch
// reliably: that the token really rides on the handshake, that scrip codes are
// translated between the REST and socket spellings, that a dropped connection
// resubscribes rather than going quiet, and that a temporary watch does not
// dismantle a standing subscription.

import test from "node:test";
import assert from "node:assert/strict";

import { PriceStream, summariseWatch, toStreamInstrument, fromStreamInstrument } from "../dist/stream.js";
import { TokenStore } from "../dist/auth.js";
import { startFakeFeed, waitFor } from "./helpers/fakefeed.mjs";

const tokenStore = (token = "TEST-TOKEN") => new TokenStore({ token });

/** Build a stream pointed at a fake feed, and make sure it is closed afterwards. */
async function withStream(feedOptions, run) {
  const feed = await startFakeFeed(feedOptions);
  const stream = new PriceStream({ tokens: tokenStore(), url: feed.url, connectTimeoutMs: 3000 });
  try {
    await run({ feed, stream });
  } finally {
    stream.close();
    await feed.stop();
  }
}

const ltpTick = (token, ltp) => ({
  mode: "ltp",
  instrument: token,
  timestamp: Date.now(),
  data: { ltp },
});

test("scrip code spellings convert both ways", () => {
  // REST says NSE_2885; the socket says NSE:2885. Getting this backwards yields a
  // subscription the server silently never honours.
  assert.equal(toStreamInstrument("NSE_2885"), "NSE:2885");
  assert.equal(toStreamInstrument("nse_2885"), "NSE:2885");
  assert.equal(fromStreamInstrument("NSE:2885"), "NSE_2885");
});

test("carries the access token on the handshake", async () => {
  await withStream({}, async ({ feed, stream }) => {
    await stream.subscribe(["NSE_2885"]);
    assert.equal(feed.connections.length, 1);
    assert.equal(feed.connections[0].headers.authorization, "TEST-TOKEN");
  });
});

test("sends the documented subscribe payload", async () => {
  await withStream({}, async ({ feed, stream }) => {
    await stream.subscribe(["NSE_2885", "NSE_11536"], "quote");
    await waitFor(() => feed.connections[0]?.messages.length > 0, { label: "subscribe message" });
    assert.deepEqual(feed.connections[0].messages[0], {
      action: "subscribe",
      mode: "quote",
      instruments: ["NSE:2885", "NSE:11536"],
    });
  });
});

test("caches ticks and resolves them back to the REST scrip code", async () => {
  await withStream({}, async ({ feed, stream }) => {
    await stream.subscribe(["NSE_2885"]);
    feed.push(ltpTick("2885", 1426));
    await waitFor(() => stream.snapshot().length > 0, { label: "a tick" });

    const [tick] = stream.snapshot();
    assert.equal(tick.ltp, 1426);
    assert.equal(tick.scripCode, "NSE_2885", "the feed sends a bare token; we map it back");
    assert.equal(tick.mode, "ltp");
    assert.ok(tick.receivedAt > 0);

    assert.equal(stream.snapshot(["NSE_2885"]).length, 1, "snapshot filters by scrip code");
    assert.equal(stream.snapshot(["NSE_9999"]).length, 0);
  });
});

test("refuses to guess when one token is subscribed on two exchanges", async () => {
  await withStream({}, async ({ feed, stream }) => {
    // Ticks identify themselves by bare token, so NSE:2885 and BSE:2885 are
    // indistinguishable on the wire. Reporting either one would be a coin flip.
    await stream.subscribe(["NSE_2885", "BSE_2885"]);
    feed.push(ltpTick("2885", 100));
    await waitFor(() => stream.snapshot().length > 0, { label: "ambiguous tick" });
    assert.equal(stream.snapshot()[0].scripCode, null);
  });
});

test("ignores heartbeats and other non-tick frames", async () => {
  await withStream({}, async ({ feed, stream }) => {
    await stream.subscribe(["NSE_2885"]);
    feed.pushRaw("ping");
    feed.pushRaw("{not json");
    feed.push({ type: "ack", action: "subscribe" });
    feed.push(ltpTick("2885", 200));
    await waitFor(() => stream.snapshot().length > 0, { label: "the real tick" });

    assert.equal(stream.snapshot().length, 1, "only the tick was cached");
    assert.equal(stream.status().ticksReceived, 1);
    assert.equal(stream.status().state, "open", "junk frames must not kill the socket");
  });
});

test("unsubscribe tells the server and clears the cache", async () => {
  await withStream({}, async ({ feed, stream }) => {
    await stream.subscribe(["NSE_2885"]);
    feed.push(ltpTick("2885", 300));
    await waitFor(() => stream.snapshot().length > 0, { label: "a tick" });

    await stream.unsubscribe(["NSE_2885"]);
    const messages = feed.connections[0].messages;
    await waitFor(() => messages.some((m) => m.action === "unsubscribe"), {
      label: "unsubscribe message",
    });

    assert.deepEqual(messages.find((m) => m.action === "unsubscribe"), {
      action: "unsubscribe",
      mode: "ltp",
      instruments: ["NSE:2885"],
    });
    // A first subscribe is recorded before the socket opens and replayed by the
    // open handler; sending it again as a delta would double every subscription.
    assert.equal(
      messages.filter((m) => m.action === "subscribe").length,
      1,
      "the initial subscribe must go out exactly once",
    );
    assert.equal(stream.snapshot().length, 0, "a dropped instrument leaves no stale price behind");
    assert.equal(stream.status().subscribed, 0);
  });
});

test("resubscribes everything after the connection drops", async () => {
  await withStream({}, async ({ feed, stream }) => {
    await stream.subscribe(["NSE_2885", "NSE_11536"]);
    await waitFor(() => feed.connections[0]?.messages.length > 0, { label: "first subscribe" });

    feed.dropAll();
    await waitFor(() => feed.live().length === 1 && feed.connections.length === 2, {
      timeoutMs: 6000,
      label: "reconnect",
    });
    await waitFor(() => feed.connections[1].messages.length > 0, { label: "resubscribe" });

    // A silent reconnect that forgets its subscriptions is the worst outcome:
    // the socket looks healthy and no prices ever arrive again.
    assert.deepEqual(feed.connections[1].messages[0], {
      action: "subscribe",
      mode: "ltp",
      instruments: ["NSE:2885", "NSE:11536"],
    });

    feed.push(ltpTick("2885", 999));
    await waitFor(() => stream.snapshot(["NSE_2885"])[0]?.ltp === 999, { label: "post-reconnect tick" });
  });
});

test("watch collects a window and summarises it", async () => {
  await withStream({}, async ({ feed, stream }) => {
    const watching = stream.watch(["NSE_2885"], 1, "ltp");
    await waitFor(() => feed.connections[0]?.messages.length > 0, { label: "watch subscribe" });

    for (const price of [100, 105, 95, 102]) feed.push(ltpTick("2885", price));

    const { ticks } = await watching;
    assert.equal(ticks.length, 4);

    const [summary] = summariseWatch(ticks);
    assert.deepEqual(
      { first: summary.first, last: summary.last, high: summary.high, low: summary.low },
      { first: 100, last: 102, high: 105, low: 95 },
    );
    assert.equal(summary.changePct, 2);
    assert.equal(summary.scripCode, "NSE_2885");
  });
});

test("watch leaves a standing subscription alone but cleans up its own", async () => {
  await withStream({}, async ({ feed, stream }) => {
    await stream.subscribe(["NSE_2885"]);
    await stream.watch(["NSE_2885", "NSE_11536"], 1);

    const still = stream.status().instruments;
    assert.ok(still.includes("NSE_2885"), "the pre-existing subscription survives the watch");
    assert.ok(!still.includes("NSE_11536"), "the temporary one is dropped again");
  });
});

test("enforces the documented per-connection instrument ceiling", async () => {
  await withStream({}, async ({ stream }) => {
    const tooMany = Array.from({ length: 3001 }, (_, i) => `NSE_${i}`);
    await assert.rejects(() => stream.subscribe(tooMany), /3000/);
  });
});

test("reports a connection failure instead of hanging", async () => {
  await withStream({ rejectWith: 401 }, async ({ stream }) => {
    await assert.rejects(() => stream.subscribe(["NSE_2885"]), /connection failed|did not connect/i);
    assert.equal(stream.status().state, "closed");
  });
});

test("refuses to connect with no token and no way to get one", async () => {
  const feed = await startFakeFeed();
  try {
    const stream = new PriceStream({ tokens: new TokenStore({}), url: feed.url });
    await assert.rejects(() => stream.subscribe(["NSE_2885"]), /without a token/);
    stream.close();
  } finally {
    await feed.stop();
  }
});

test("close is idempotent and stops the reconnect loop", async () => {
  const feed = await startFakeFeed();
  const stream = new PriceStream({ tokens: tokenStore(), url: feed.url });
  try {
    await stream.subscribe(["NSE_2885"]);
    stream.close();
    stream.close();

    assert.equal(stream.status().state, "closed");
    assert.equal(stream.status().subscribed, 0);

    const seen = feed.connections.length;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(feed.connections.length, seen, "a closed stream must not keep reconnecting");
  } finally {
    await feed.stop();
  }
});
