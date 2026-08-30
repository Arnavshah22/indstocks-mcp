/**
 * Access token lifecycle.
 *
 * Tokens expire 24 hours after issue, and until now that meant the dominant
 * failure mode of this server was a human editing a JSON config file and
 * restarting their MCP client every morning. `POST /generate/token` exists to fix
 * that: given the account's API key, MPIN and a current TOTP code, it mints a
 * fresh token that the running process can start using immediately.
 *
 * ## Two ways to refresh, and why the default is the cautious one
 *
 * The documented flow expects a six-digit code read off an authenticator app, so
 * the baseline is interactive: the `refresh_token` tool takes an MPIN and a code
 * and swaps the token without a restart. Nothing is stored.
 *
 * Supplying `totpSecret` instead lets this process derive that code itself, which
 * makes refresh fully unattended — and also means the seed and the MPIN sit
 * together in one place. Anyone who can read them can mint tokens for the account
 * indefinitely, which is precisely what the second factor exists to prevent. That
 * this server is read-only is no comfort here: the credential is not scoped to it,
 * and the same token places orders against the real API.
 *
 * So automatic refresh is opt-in, never inferred. Set it up deliberately or not
 * at all.
 *
 * One operational note worth knowing before wiring this into anything: the API
 * keeps a single live TOTP-issued token per account, so refreshing here revokes
 * whatever token another script or session is holding.
 */

import { BASE_URL, TOKEN_ENDPOINT } from "./endpoints.js";
import { secondsRemainingInWindow, totp } from "./totp.js";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export interface TotpCredentials {
  /** The `x-api-key` client id shown on the dashboard after TOTP setup. */
  apiKey: string;
  mpin: string;
  /** Base32 authenticator seed. Present only when unattended refresh is wanted. */
  totpSecret?: string;
}

export interface RefreshResult {
  issuedAt: number;
  expiresAt: number;
  /** Last four characters only — enough to confirm the token changed. */
  fingerprint: string;
  mode: "automatic" | "interactive";
}

export interface TokenStoreOptions {
  token?: string;
  credentials?: TotpCredentials;
  baseUrl?: string;
  timeoutMs?: number;
}

const TOKEN_LIFETIME_MS = 24 * 60 * 60 * 1000;

export class TokenStore {
  private token: string;
  private issuedAt: number | null = null;
  private inflight: Promise<RefreshResult> | null = null;
  private readonly credentials: TotpCredentials | null;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(options: TokenStoreOptions) {
    this.token = (options.token ?? "").trim();
    this.credentials = options.credentials ?? null;
    this.baseUrl = options.baseUrl ?? BASE_URL;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  get current(): string {
    return this.token;
  }

  get hasToken(): boolean {
    return this.token.length > 0;
  }

  /** True when this process holds everything needed to mint a token unattended. */
  get canAutoRefresh(): boolean {
    return Boolean(this.credentials?.apiKey && this.credentials?.mpin && this.credentials?.totpSecret);
  }

  /** True when `refresh_token` can work if the caller supplies a code. */
  get canRefreshInteractively(): boolean {
    return Boolean(this.credentials?.apiKey);
  }

  get status(): { hasToken: boolean; issuedAt: string | null; autoRefresh: boolean } {
    return {
      hasToken: this.hasToken,
      issuedAt: this.issuedAt ? new Date(this.issuedAt).toISOString() : null,
      autoRefresh: this.canAutoRefresh,
    };
  }

  /**
   * Mint a new token.
   *
   * Concurrent callers share one in-flight request. That is not just tidiness:
   * each successful call invalidates the previous token, so two races would leave
   * one caller holding a token the other had already revoked.
   */
  async refresh(manual?: { mpin?: string; totp?: string }): Promise<RefreshResult> {
    if (this.inflight) return this.inflight;
    this.inflight = this.performRefresh(manual).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async performRefresh(manual?: { mpin?: string; totp?: string }): Promise<RefreshResult> {
    const apiKey = this.credentials?.apiKey;
    if (!apiKey) {
      throw new AuthError(
        "Cannot generate a token: no API key configured. Set INDSTOCKS_API_KEY to the " +
          "client id shown on the dashboard after TOTP setup " +
          "(https://www.indstocks.com/app/api-trading/access-tokens).",
      );
    }

    const mpin = manual?.mpin ?? this.credentials?.mpin;
    if (!mpin) {
      throw new AuthError(
        "Cannot generate a token: no MPIN. Pass it to refresh_token, or set INDSTOCKS_MPIN.",
      );
    }

    let code = manual?.totp;
    let mode: RefreshResult["mode"] = "interactive";
    if (!code) {
      const secret = this.credentials?.totpSecret;
      if (!secret) {
        throw new AuthError(
          "Cannot generate a token: no TOTP code supplied and no seed configured. " +
            "Either pass the current six-digit code from your authenticator app, or set " +
            "INDSTOCKS_TOTP_SECRET to enable unattended refresh.",
        );
      }
      // A code minted with a second left on the clock is usually dead on arrival,
      // and the API reports that as an invalid TOTP rather than a stale one.
      if (secondsRemainingInWindow() < 3) {
        await new Promise((resolve) => setTimeout(resolve, 3_000));
      }
      code = totp(secret);
      mode = "automatic";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(new URL(TOKEN_ENDPOINT.path, this.baseUrl), {
        method: "POST",
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ mpin, totp: code }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new AuthError(
        `Token generation request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // Never echo the body: it was produced from a request carrying the MPIN.
      const hint =
        response.status === 401 || response.status === 403
          ? " Check the API key, the MPIN, and that the six-digit code is the current one — " +
            "codes roll over every 30 seconds and the server's clock must be roughly right."
          : "";
      throw new AuthError(`Token generation returned ${response.status}.${hint}`);
    }

    const body = (await response.json().catch(() => null)) as { token?: unknown } | null;
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!token) {
      throw new AuthError(
        "Token generation succeeded but the response carried no `token` field. " +
          "The API contract may have changed; re-check https://api-docs.indstocks.com/.",
      );
    }

    this.token = token;
    this.issuedAt = Date.now();

    return {
      issuedAt: this.issuedAt,
      expiresAt: this.issuedAt + TOKEN_LIFETIME_MS,
      fingerprint: token.slice(-4),
      mode,
    };
  }
}
