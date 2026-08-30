// TokenStore: minting and swapping the access token.
//
// `fetch` is stubbed throughout — these assert the request this code *sends*
// (headers, body, field names) against the documented contract, and the state it
// keeps afterwards. Nothing here touches the network or a real account.

import test from "node:test";
import assert from "node:assert/strict";

import { TokenStore, AuthError } from "../dist/auth.js";

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

/** Install a fetch stub for one test and hand back the calls it captured. */
function stubFetch(handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: url.toString(), init });
    return handler(calls.length);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

const okToken = (token) =>
  new Response(JSON.stringify({ token }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

test("posts the documented request and adopts the returned token", async () => {
  const stub = stubFetch(() => okToken("FRESH-TOKEN-9999"));
  try {
    const store = new TokenStore({
      credentials: { apiKey: "CLIENT-ID", mpin: "1234", totpSecret: SECRET },
    });
    const result = await store.refresh();

    assert.equal(stub.calls.length, 1);
    const { url, init } = stub.calls[0];
    assert.equal(url, "https://api.indstocks.com/generate/token");
    assert.equal(init.method, "POST");
    // Token generation authenticates with x-api-key, NOT Authorization.
    assert.equal(init.headers["x-api-key"], "CLIENT-ID");
    assert.equal(init.headers.Authorization, undefined);

    const body = JSON.parse(init.body);
    assert.equal(body.mpin, "1234");
    assert.match(body.totp, /^\d{6}$/, "a six-digit code is derived from the seed");

    assert.equal(store.current, "FRESH-TOKEN-9999");
    assert.equal(store.hasToken, true);
    assert.equal(result.mode, "automatic");
    assert.equal(result.fingerprint, "9999", "only the tail is reported back");
    assert.equal(result.expiresAt - result.issuedAt, 24 * 60 * 60 * 1000);
  } finally {
    stub.restore();
  }
});

test("uses a caller-supplied code and MPIN when no seed is configured", async () => {
  const stub = stubFetch(() => okToken("INTERACTIVE-TOKEN"));
  try {
    const store = new TokenStore({ credentials: { apiKey: "CLIENT-ID", mpin: "" } });
    assert.equal(store.canAutoRefresh, false);
    assert.equal(store.canRefreshInteractively, true);

    const result = await store.refresh({ mpin: "9999", totp: "123456" });
    const body = JSON.parse(stub.calls[0].init.body);
    assert.equal(body.mpin, "9999");
    assert.equal(body.totp, "123456");
    assert.equal(result.mode, "interactive");
    assert.equal(store.current, "INTERACTIVE-TOKEN");
  } finally {
    stub.restore();
  }
});

test("an explicit code overrides the configured seed", async () => {
  const stub = stubFetch(() => okToken("T"));
  try {
    const store = new TokenStore({
      credentials: { apiKey: "K", mpin: "1111", totpSecret: SECRET },
    });
    await store.refresh({ totp: "000000" });
    assert.equal(JSON.parse(stub.calls[0].init.body).totp, "000000");
  } finally {
    stub.restore();
  }
});

test("refuses without an API key, an MPIN, or any way to get a code", async () => {
  const bare = new TokenStore({});
  await assert.rejects(() => bare.refresh(), AuthError);
  await assert.rejects(() => bare.refresh(), /INDSTOCKS_API_KEY/);

  const noMpin = new TokenStore({ credentials: { apiKey: "K", mpin: "" } });
  await assert.rejects(() => noMpin.refresh({ totp: "123456" }), /MPIN/);

  const noCode = new TokenStore({ credentials: { apiKey: "K", mpin: "1234" } });
  await assert.rejects(() => noCode.refresh(), /INDSTOCKS_TOTP_SECRET/);
});

test("surfaces a rejected credential without echoing the response body", async () => {
  const stub = stubFetch(() =>
    new Response(JSON.stringify({ error: "bad mpin", mpin: "1234" }), { status: 401 }),
  );
  try {
    const store = new TokenStore({ credentials: { apiKey: "K", mpin: "1234", totpSecret: SECRET } });
    await assert.rejects(
      () => store.refresh(),
      (error) => {
        assert.ok(error instanceof AuthError);
        assert.match(error.message, /401/);
        assert.match(error.message, /six-digit code is the current one/);
        // The request carried the MPIN; the response may quote it straight back.
        assert.ok(!error.message.includes("1234"), "must not echo the upstream body");
        return true;
      },
    );
    assert.equal(store.hasToken, false, "a failed refresh leaves the old state alone");
  } finally {
    stub.restore();
  }
});

test("rejects a 200 that carries no token rather than storing an empty one", async () => {
  const stub = stubFetch(() =>
    new Response(JSON.stringify({ access_token: "wrong-field-name" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  try {
    const store = new TokenStore({ credentials: { apiKey: "K", mpin: "1", totpSecret: SECRET } });
    await assert.rejects(() => store.refresh(), /no `token` field/);
    assert.equal(store.hasToken, false);
  } finally {
    stub.restore();
  }
});

test("collapses concurrent refreshes into one request", async () => {
  // Each successful call revokes the previous token, so two racing refreshes
  // would leave one caller holding something already dead.
  const stub = stubFetch(async (n) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return okToken("TOKEN-" + n);
  });
  try {
    const store = new TokenStore({ credentials: { apiKey: "K", mpin: "1", totpSecret: SECRET } });
    const [a, b, c] = await Promise.all([store.refresh(), store.refresh(), store.refresh()]);
    assert.equal(stub.calls.length, 1, "one in-flight request shared by all callers");
    assert.equal(a.fingerprint, b.fingerprint);
    assert.equal(b.fingerprint, c.fingerprint);
    assert.equal(store.current, "TOKEN-1");
  } finally {
    stub.restore();
  }
});

test("status reports what the process can do without leaking the token", () => {
  const auto = new TokenStore({
    token: "SECRET-TOKEN-VALUE",
    credentials: { apiKey: "K", mpin: "1", totpSecret: SECRET },
  });
  const status = auto.status;
  assert.deepEqual(status, { hasToken: true, issuedAt: null, autoRefresh: true });
  assert.ok(!JSON.stringify(status).includes("SECRET-TOKEN-VALUE"));

  const manual = new TokenStore({ token: "T" });
  assert.equal(manual.canAutoRefresh, false);
  assert.equal(manual.canRefreshInteractively, false);
});
