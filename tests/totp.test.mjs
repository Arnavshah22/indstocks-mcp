// TOTP generation, checked against the published RFC vectors.
//
// This is the one piece of the auth path with no visible failure mode: a wrong
// code comes back from the API as "invalid TOTP", indistinguishable from a typo,
// a clock skew, or a bad seed. The RFC 6238 vectors settle it.

import test from "node:test";
import assert from "node:assert/strict";

import { base32Decode, totp, secondsRemainingInWindow } from "../dist/totp.js";

// RFC 6238 Appendix B uses the ASCII seed "12345678901234567890", which is this
// in base32. The published codes are 8 digits; a 6-digit code is its last six.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

const RFC_VECTORS = [
  { seconds: 59, code8: "94287082" },
  { seconds: 1111111109, code8: "07081804" },
  { seconds: 1111111111, code8: "14050471" },
  { seconds: 1234567890, code8: "89005924" },
  { seconds: 2000000000, code8: "69279037" },
  { seconds: 20000000000, code8: "65353130" },
];

test("matches the RFC 6238 SHA-1 vectors at 8 digits", () => {
  for (const { seconds, code8 } of RFC_VECTORS) {
    assert.equal(
      totp(RFC_SECRET, { atMs: seconds * 1000, digits: 8 }),
      code8,
      `vector at t=${seconds}`,
    );
  }
});

test("matches the same vectors truncated to the 6 digits the API wants", () => {
  for (const { seconds, code8 } of RFC_VECTORS) {
    assert.equal(totp(RFC_SECRET, { atMs: seconds * 1000 }), code8.slice(-6), `t=${seconds}`);
  }
});

test("a code is stable across its 30-second window and changes after it", () => {
  const base = 1111111109 * 1000;
  const inWindow = totp(RFC_SECRET, { atMs: base });
  // 1111111109 is 29 seconds into its step, so +1s crosses into the next one.
  assert.equal(totp(RFC_SECRET, { atMs: base - 1000 }), inWindow, "same step, same code");
  assert.notEqual(totp(RFC_SECRET, { atMs: base + 2000 }), inWindow, "next step, new code");
});

test("normalises the spacing and case authenticator seeds are shown in", () => {
  const expected = totp(RFC_SECRET, { atMs: 59_000 });
  assert.equal(totp("gezd gnbv gy3t qojq gezd gnbv gy3t qojq", { atMs: 59_000 }), expected);
  assert.equal(totp("GEZD-GNBV-GY3T-QOJQ-GEZD-GNBV-GY3T-QOJQ", { atMs: 59_000 }), expected);
});

test("base32Decode matches the RFC 4648 vectors", () => {
  const cases = [
    ["MY======", "f"],
    ["MZXQ====", "fo"],
    ["MZXW6===", "foo"],
    ["MZXW6YQ=", "foob"],
    ["MZXW6YTB", "fooba"],
    ["MZXW6YTBOI======", "foobar"],
  ];
  for (const [encoded, decoded] of cases) {
    assert.equal(base32Decode(encoded).toString("utf8"), decoded, encoded);
  }
});

test("rejects a seed that is not base32 rather than producing a wrong code", () => {
  // Silently decoding garbage would yield a plausible-looking six digits that the
  // API rejects for no discoverable reason.
  assert.throws(() => base32Decode("not-base32!"), /not valid base32/);
  assert.throws(() => base32Decode(""), /empty/);
  assert.throws(() => base32Decode("ABC1DEF"), /not valid base32/, "1 is not in the alphabet");
});

test("secondsRemainingInWindow counts down within the step", () => {
  assert.equal(secondsRemainingInWindow(0, 30), 30);
  assert.equal(secondsRemainingInWindow(1_000, 30), 29);
  assert.equal(secondsRemainingInWindow(29_000, 30), 1);
  assert.equal(secondsRemainingInWindow(30_000, 30), 30);
});
