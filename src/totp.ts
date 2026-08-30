/**
 * RFC 6238 time-based one-time passwords.
 *
 * INDstocks' documented token flow expects a six-digit code typed out of an
 * authenticator app. That is fine for a human at a keyboard and useless for a
 * process that wants to refresh its own credential at 3am, so this module can
 * derive the same code from the TOTP seed the dashboard shows during setup.
 *
 * Deriving codes locally is exactly what the authenticator app does — there is no
 * trick here — but it does mean the seed is only as protected as wherever it is
 * stored. `auth.ts` documents that trade-off; this file just does the arithmetic.
 */

import { createHmac } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Decode an RFC 4648 base32 secret.
 *
 * Authenticator seeds are handed out in groups separated by spaces or dashes and
 * are sometimes lower case, so those are normalised away rather than rejected.
 */
export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/[\s=-]/g, "");
  if (cleaned.length === 0) throw new Error("TOTP secret is empty.");

  const bytes: number[] = [];
  let value = 0;
  let bits = 0;

  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(
        `TOTP secret contains '${char}', which is not valid base32. ` +
          "Use the key the dashboard shows when setting up the authenticator, not the QR image.",
      );
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

export interface TotpOptions {
  /** Milliseconds since the epoch. Injectable so the RFC vectors can be tested. */
  atMs?: number;
  stepSeconds?: number;
  digits?: number;
}

/** Generate the current TOTP code for a base32 secret. */
export function totp(secret: string, options: TotpOptions = {}): string {
  const atMs = options.atMs ?? Date.now();
  const stepSeconds = options.stepSeconds ?? 30;
  const digits = options.digits ?? 6;

  const counter = BigInt(Math.floor(atMs / 1000 / stepSeconds));
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(counter);

  const digest = createHmac("sha1", base32Decode(secret)).update(counterBytes).digest();

  // Dynamic truncation: the low nibble of the last byte picks a 4-byte window,
  // and the top bit is masked off so the result is always positive.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** digits).padStart(digits, "0");
}

/**
 * Seconds left before the current code rolls over.
 *
 * A code generated with a second to spare is often dead by the time the request
 * reaches the server, which surfaces as a baffling "invalid TOTP" rather than as
 * a timing problem — so the caller waits out a nearly-expired window instead.
 */
export function secondsRemainingInWindow(atMs: number = Date.now(), stepSeconds = 30): number {
  return stepSeconds - Math.floor(atMs / 1000) % stepSeconds;
}
