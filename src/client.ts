import { BASE_URL, ENDPOINTS, type EndpointName, type Provenance } from "./endpoints.js";
import { RateLimiter, sleep } from "./ratelimit.js";
import type { TokenStore } from "./auth.js";

export class IndStocksError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "IndStocksError";
  }
}

/**
 * Thrown when the token is missing, malformed, or expired.
 *
 * Tokens expire after 24 hours. This is the single most common failure mode for
 * this server, so it gets its own error type and an actionable message rather
 * than a generic 401.
 */
export class TokenExpiredError extends IndStocksError {
  constructor(body?: unknown) {
    super(
      "INDstocks token rejected (401). Tokens expire 24 hours after issue.\n" +
        "Call the refresh_token tool with your MPIN and the current six-digit code from " +
        "your authenticator app — that swaps the token in place, with no restart and no " +
        "config editing.\n" +
        "To make refresh automatic, set INDSTOCKS_API_KEY, INDSTOCKS_MPIN and " +
        "INDSTOCKS_TOTP_SECRET. Failing all that, regenerate by hand at " +
        "https://www.indstocks.com/app/api-trading/access-tokens.",
      401,
      body,
    );
    this.name = "TokenExpiredError";
  }
}

export interface ClientOptions {
  /** Owns the current token and knows how to mint a new one. */
  tokens: TokenStore;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Requests per second per endpoint. API documents 10. */
  ratePerSecond?: number;
}

export class IndStocksClient {
  private readonly tokens: TokenStore;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly limiter: RateLimiter;

  constructor(opts: ClientOptions) {
    // A store with credentials but no token yet is legitimate — it mints one on
    // first use — so there is nothing to validate here any more.
    this.tokens = opts.tokens;
    this.baseUrl = opts.baseUrl ?? BASE_URL;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 3;
    const rate = opts.ratePerSecond ?? 10;
    this.limiter = new RateLimiter(rate, rate);
  }

  /**
   * Make sure there is a token to send. Minting one up front beats firing a
   * request with an empty Authorization header purely to watch it 401.
   */
  private async ensureToken(): Promise<void> {
    if (this.tokens.hasToken) return;
    if (this.tokens.canAutoRefresh) {
      await this.tokens.refresh();
      return;
    }
    throw new IndStocksError(
      "No INDstocks token available. Set INDSTOCKS_TOKEN, or configure " +
        "INDSTOCKS_API_KEY + INDSTOCKS_MPIN + INDSTOCKS_TOTP_SECRET for automatic " +
        "generation, or call the refresh_token tool with your MPIN and a current " +
        "authenticator code.",
    );
  }

  /**
   * GET against a named endpoint. Retries on 429 and transient network errors
   * with exponential backoff. Never retries a 4xx other than 429 - if the request
   * is malformed, retrying it three times is just three malformed requests.
   */
  async get<T = unknown>(
    endpoint: EndpointName,
    query?: Record<string, string | number | undefined>,
    pathParams?: Record<string, string | number>,
  ): Promise<T> {
    const spec = ENDPOINTS[endpoint];
    const url = new URL(resolvePath(spec.path, pathParams), this.baseUrl);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    await this.ensureToken();

    let lastError: unknown;
    let refreshed = false;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await this.limiter.acquire(spec.path);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: this.tokens.current,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          signal: controller.signal,
        });

        if (response.status === 401 || response.status === 403) {
          // Expiry is the dominant failure mode of this API. When the process
          // holds the credentials to mint a token, spend one attempt doing that
          // instead of surfacing a dead end to the user. Once only: a rejected
          // MPIN would otherwise be retried into a lockout.
          if (!refreshed && this.tokens.canAutoRefresh) {
            refreshed = true;
            try {
              await this.tokens.refresh();
              continue;
            } catch (refreshError) {
              throw new IndStocksError(
                "Token expired and automatic refresh failed: " +
                  (refreshError instanceof Error ? refreshError.message : String(refreshError)),
                401,
              );
            }
          }
          throw new TokenExpiredError(await safeBody(response));
        }

        if (response.status === 429) {
          const backoff = 2 ** attempt * 500;
          lastError = new IndStocksError("Rate limited (429)", 429);
          await sleep(backoff);
          continue;
        }

        if (response.status === 404) {
          throw new IndStocksError(
            `404 for ${spec.path} (provenance: ${spec.provenance}).` +
              pathNotFoundHint(spec.provenance),
            404,
            await safeBody(response),
          );
        }

        if (!response.ok) {
          const body = await safeBody(response);
          if (response.status >= 500 && attempt < this.maxRetries) {
            lastError = new IndStocksError(`Upstream ${response.status}`, response.status, body);
            await sleep(2 ** attempt * 500);
            continue;
          }
          throw new IndStocksError(
            `INDstocks API returned ${response.status} for ${spec.path}`,
            response.status,
            body,
          );
        }

        return (await response.json()) as T;
      } catch (error) {
        if (error instanceof TokenExpiredError || error instanceof IndStocksError) {
          if (error.status === 429) {
            lastError = error;
            continue;
          }
          throw error;
        }
        // Network-level failure or timeout.
        lastError = error;
        if (attempt < this.maxRetries) {
          await sleep(2 ** attempt * 500);
          continue;
        }
      } finally {
        clearTimeout(timer);
      }
    }

    throw new IndStocksError(
      `Request to ${spec.path} failed after ${this.maxRetries + 1} attempts: ${String(lastError)}`,
    );
  }

  /** Fetch raw text. Used for the instruments master, which is served as CSV. */
  async getText(endpoint: EndpointName): Promise<string> {
    await this.ensureToken();
    const spec = ENDPOINTS[endpoint];

    const send = async (): Promise<Response> => {
      await this.limiter.acquire(spec.path);
      const controller = new AbortController();
      // The instrument master is megabytes; it gets a longer leash than a quote.
      const timer = setTimeout(() => controller.abort(), this.timeoutMs * 3);
      try {
        return await fetch(new URL(spec.path, this.baseUrl), {
          headers: { Authorization: this.tokens.current },
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    };

    let response = await send();
    if ((response.status === 401 || response.status === 403) && this.tokens.canAutoRefresh) {
      await this.tokens.refresh();
      response = await send();
    }
    if (response.status === 401 || response.status === 403) {
      throw new TokenExpiredError();
    }
    if (!response.ok) {
      throw new IndStocksError(`Instrument master fetch failed: ${response.status}`, response.status);
    }
    return await response.text();
  }
}

/**
 * Fill a `{name}` segment in an endpoint path template.
 *
 * Only historical data needs this today: it takes the candle interval as a path
 * segment (/market/historical/1day) rather than a query param. Getting that wrong
 * surfaces as a 404, not a validation error, so it is worth centralising.
 */
function resolvePath(template: string, params?: Record<string, string | number>): string {
  return template.replace(/[{]([A-Za-z0-9_]+)[}]/g, (_match, key: string) => {
    const value = params?.[key];
    if (value === undefined) {
      throw new IndStocksError(`Missing path parameter '${key}' for ${template}`);
    }
    return encodeURIComponent(String(value));
  });
}

/**
 * What a 404 means depends on how much we trust the path.
 *
 * This takes the wide `Provenance` as a parameter rather than comparing inline:
 * every endpoint is VERIFIED today, so an inline check narrows to a single literal
 * and TypeScript rejects it. The UNVERIFIED branch has to survive for the next
 * endpoint added from a docs page nobody could fully confirm.
 */
function pathNotFoundHint(provenance: Provenance): string {
  if (provenance === "UNVERIFIED") {
    return (
      " This path was not confirmed against the official docs. " +
      "Run the diagnose_endpoints tool, then correct src/endpoints.ts."
    );
  }
  return (
    " This path matches the official docs, so a 404 more likely means the account" +
    " is not entitled to this segment, or the API changed. Re-check" +
    " https://api-docs.indstocks.com/."
  );
}

async function safeBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}
