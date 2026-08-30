// The client's behaviour when a token expires mid-session.
//
// Expiry is this API's dominant failure mode, so what happens on a 401 is worth
// pinning: refresh once and retry when the process holds the credentials, fail
// with an actionable message when it does not, and never grind a rejected MPIN
// through the retry loop.

import test from "node:test";
import assert from "node:assert/strict";

import { IndStocksClient, TokenExpiredError } from "../dist/client.js";
import { TokenStore } from "../dist/auth.js";

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const record = { url: url.toString(), init };
    calls.push(record);
    return handler(record, calls.length);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const isTokenCall = (record) => record.url.includes("/generate/token");
const autoStore = (token) =>
  new TokenStore({ token, credentials: { apiKey: "K", mpin: "1234", totpSecret: SECRET } });

test("refreshes once and retries when the token has expired", async () => {
  let dataCalls = 0;
  const stub = stubFetch((record) => {
    if (isTokenCall(record)) return json({ token: "NEW-TOKEN" });
    dataCalls++;
    // The first data call carries the stale token and is rejected.
    return dataCalls === 1 ? json({ error: "expired" }, 401) : json({ ok: true, id: 7 });
  });
  try {
    const tokens = autoStore("STALE-TOKEN");
    const client = new IndStocksClient({ tokens });
    const result = await client.get("profile");

    assert.deepEqual(result, { ok: true, id: 7 });
    assert.equal(dataCalls, 2, "one failed call, one retry");
    assert.equal(stub.calls.filter(isTokenCall).length, 1, "exactly one refresh");

    const dataRequests = stub.calls.filter((c) => !isTokenCall(c));
    assert.equal(dataRequests[0].init.headers.Authorization, "STALE-TOKEN");
    assert.equal(dataRequests[1].init.headers.Authorization, "NEW-TOKEN", "retry uses the new token");
    assert.equal(tokens.current, "NEW-TOKEN");
  } finally {
    stub.restore();
  }
});

test("mints a token up front rather than firing a request with an empty header", async () => {
  const stub = stubFetch((record) =>
    isTokenCall(record) ? json({ token: "MINTED" }) : json({ ok: true }));
  try {
    const client = new IndStocksClient({ tokens: autoStore("") });
    await client.get("profile");

    assert.ok(isTokenCall(stub.calls[0]), "token is generated before the first data call");
    assert.equal(stub.calls[1].init.headers.Authorization, "MINTED");
    assert.equal(stub.calls.filter((c) => !isTokenCall(c)).length, 1, "no wasted 401 round trip");
  } finally {
    stub.restore();
  }
});

test("without credentials a 401 explains every way out", async () => {
  const stub = stubFetch(() => json({ error: "expired" }, 401));
  try {
    const client = new IndStocksClient({ tokens: new TokenStore({ token: "STALE" }) });
    await assert.rejects(
      () => client.get("profile"),
      (error) => {
        assert.ok(error instanceof TokenExpiredError);
        assert.match(error.message, /refresh_token/, "names the tool that fixes it in place");
        assert.match(error.message, /INDSTOCKS_TOTP_SECRET/, "names the unattended option");
        return true;
      },
    );
    assert.equal(stub.calls.length, 1, "no refresh attempted without credentials");
  } finally {
    stub.restore();
  }
});

test("does not retry a refresh that the API rejected", async () => {
  // A wrong MPIN retried three times is three chances to lock the account.
  const stub = stubFetch((record) =>
    isTokenCall(record) ? json({ error: "bad mpin" }, 401) : json({ error: "expired" }, 401));
  try {
    const client = new IndStocksClient({ tokens: autoStore("STALE") });
    await assert.rejects(() => client.get("profile"), /automatic refresh failed/);
    assert.equal(stub.calls.filter(isTokenCall).length, 1, "the refresh is attempted once, not retried");
  } finally {
    stub.restore();
  }
});

test("gives up after one refresh if the fresh token is also rejected", async () => {
  const stub = stubFetch((record) =>
    isTokenCall(record) ? json({ token: "ALSO-BAD" }) : json({ error: "expired" }, 401));
  try {
    const client = new IndStocksClient({ tokens: autoStore("STALE") });
    await assert.rejects(() => client.get("profile"), TokenExpiredError);
    assert.equal(stub.calls.filter(isTokenCall).length, 1, "must not loop refreshing forever");
  } finally {
    stub.restore();
  }
});

test("refuses to call at all with no token and no way to get one", async () => {
  const stub = stubFetch(() => json({ ok: true }));
  try {
    const client = new IndStocksClient({ tokens: new TokenStore({}) });
    await assert.rejects(() => client.get("profile"), /No INDstocks token available/);
    assert.equal(stub.calls.length, 0, "nothing is sent");
  } finally {
    stub.restore();
  }
});

test("getText refreshes on expiry too", async () => {
  let dataCalls = 0;
  const stub = stubFetch((record) => {
    if (isTokenCall(record)) return json({ token: "NEW" });
    dataCalls++;
    return dataCalls === 1
      ? new Response("nope", { status: 401 })
      : new Response("symbol,name\nRELIANCE,Reliance", { status: 200 });
  });
  try {
    const client = new IndStocksClient({ tokens: autoStore("STALE") });
    const text = await client.getText("instruments");
    assert.match(text, /RELIANCE/);
    assert.equal(stub.calls.filter(isTokenCall).length, 1);
  } finally {
    stub.restore();
  }
});
