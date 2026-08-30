/**
 * Live price feed over WebSocket.
 *
 * ## What "streaming" can honestly mean inside an MCP server
 *
 * MCP is request/response. A tool call returns once, and nothing this server does
 * can interrupt the model mid-turn to hand it a tick. So a socket cannot be piped
 * to the model, and pretending otherwise would just produce a tool that blocks and
 * returns a wall of stale numbers.
 *
 * What it can do is decouple *collection* from *asking*:
 *
 *   - a background subscription keeps a cache of the latest tick per instrument,
 *     so a price read is a map lookup — instant, always sub-second fresh, and it
 *     never spends a REST rate-limit token;
 *   - a bounded watch window collects ticks for a stated number of seconds and
 *     returns the series, which is the one shape that maps cleanly onto a single
 *     tool call.
 *
 * Both are exposed. Neither claims to push.
 *
 * ## Connection facts that shape the code
 *
 * Auth is an `Authorization` header on the handshake, which the WHATWG WebSocket
 * API has no way to set — Node's built-in accepts a non-standard options argument
 * for exactly this, which is why the constructor is cast below rather than a `ws`
 * dependency being added.
 *
 * The API allows 3 concurrent connections per user and 3000 instruments each. This
 * class holds exactly one socket, so the other two stay free for whatever else the
 * user is running.
 */

import type { TokenStore } from "./auth.js";

export const PRICE_STREAM_URL = "wss://ws-prices.indstocks.com/api/v1/ws/prices";

/** Documented ceiling for a single connection. */
export const MAX_INSTRUMENTS = 3000;

export type StreamMode = "ltp" | "quote";
export type StreamState = "closed" | "connecting" | "open";

export interface Tick {
  /** Instrument token exactly as the server sent it. */
  instrument: string;
  /** Resolved back to the REST-style scrip code, when unambiguous. */
  scripCode: string | null;
  mode: StreamMode;
  /** Exchange timestamp, epoch ms. */
  timestamp: number;
  /** Our clock, so staleness can be reported honestly. */
  receivedAt: number;
  ltp: number | null;
  /** Full payload; quote mode carries depth and OHLC that LTP mode does not. */
  data: Record<string, unknown>;
}

/**
 * Node's WebSocket accepts a non-standard options object for handshake headers.
 * The DOM lib types the second parameter as protocols, so the constructor is
 * re-typed here rather than casting at every call site.
 */
type HeaderCapableWebSocket = new (
  url: string,
  options?: { headers?: Record<string, string> },
) => WebSocket;

/** REST scrip codes are `NSE_2885`; the socket wants `NSE:2885`. */
export function toStreamInstrument(scripCode: string): string {
  return scripCode.trim().replace("_", ":").toUpperCase();
}

/** `NSE:2885` -> `NSE_2885`. */
export function fromStreamInstrument(instrument: string): string {
  return instrument.trim().replace(":", "_").toUpperCase();
}

/** `NSE:2885` -> `2885`, which is how ticks identify themselves. */
export function instrumentToken(instrument: string): string {
  const colon = instrument.indexOf(":");
  return colon === -1 ? instrument.trim() : instrument.slice(colon + 1).trim();
}

export interface PriceStreamOptions {
  tokens: TokenStore;
  url?: string;
  /** Must write to stderr: stdout carries MCP framing. */
  log?: (...args: unknown[]) => void;
  connectTimeoutMs?: number;
  maxReconnectDelayMs?: number;
}

export class StreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StreamError";
  }
}

export class PriceStream {
  private socket: WebSocket | null = null;
  private state: StreamState = "closed";
  private connecting: Promise<void> | null = null;
  /** Keyed by WS instrument (`NSE:2885`) so resubscribe after a drop is exact. */
  private readonly subscriptions = new Map<string, StreamMode>();
  /** Keyed by bare token, which is all a tick carries. */
  private readonly latest = new Map<string, Tick>();
  /** Bare token -> scrip codes subscribed under it. More than one means ambiguity. */
  private readonly tokenOwners = new Map<string, Set<string>>();
  private readonly listeners = new Set<(tick: Tick) => void>();

  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private shutdown = false;
  private refreshedForAuth = false;
  private ticksReceived = 0;
  private lastTickAt: number | null = null;
  private lastError: string | null = null;

  private readonly tokens: TokenStore;
  private readonly url: string;
  private readonly log: (...args: unknown[]) => void;
  private readonly connectTimeoutMs: number;
  private readonly maxReconnectDelayMs: number;

  constructor(options: PriceStreamOptions) {
    this.tokens = options.tokens;
    this.url = options.url ?? PRICE_STREAM_URL;
    this.log = options.log ?? (() => {});
    this.connectTimeoutMs = options.connectTimeoutMs ?? 10_000;
    this.maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30_000;
  }

  /* ------------------------------------------------------------ lifecycle -- */

  async connect(): Promise<void> {
    if (this.state === "open") return;
    if (this.connecting) return this.connecting;

    this.shutdown = false;
    this.connecting = this.openSocket().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async openSocket(): Promise<void> {
    if (!this.tokens.hasToken && this.tokens.canAutoRefresh) {
      await this.tokens.refresh();
    }
    if (!this.tokens.hasToken) {
      throw new StreamError(
        "Cannot open the price stream without a token. Set INDSTOCKS_TOKEN, or call " +
          "refresh_token first.",
      );
    }

    this.state = "connecting";
    const WS = WebSocket as unknown as HeaderCapableWebSocket;
    // The token is read at connect time, not construction time, so a reconnect
    // after refresh_token automatically uses the new credential.
    const socket = new WS(this.url, {
      headers: { Authorization: this.tokens.current },
    });
    this.socket = socket;

    try {
      await this.awaitOpen(socket);
    } catch (error) {
      // Leave no half-open state behind: a stream stuck reporting "connecting"
      // makes status() lie about why prices stopped arriving.
      this.state = "closed";
      this.socket = null;
      try {
        socket.close();
      } catch {
        /* already dead */
      }
      throw error;
    }

    socket.addEventListener("message", (event) => this.handleMessage(event));
    socket.addEventListener("close", (event) => this.handleClose(event));
  }

  private awaitOpen(socket: WebSocket): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new StreamError(`Price stream did not connect within ${this.connectTimeoutMs}ms.`));
        try {
          socket.close();
        } catch {
          /* already dead */
        }
      }, this.connectTimeoutMs);

      socket.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          this.state = "open";
          this.reconnectAttempts = 0;
          this.refreshedForAuth = false;
          this.lastError = null;
          this.log("price stream connected");
          // A reconnect inherits whatever was subscribed before the drop.
          this.resubscribeAll();
          resolve();
        },
        { once: true },
      );

      socket.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          // The event carries no detail by design; the close code is the signal.
          this.lastError = "socket error";
          reject(
            new StreamError(
              "Price stream connection failed. The access token rides on the handshake, " +
                "so this is usually an expired or invalid token — try refresh_token. It can " +
                "also mean the account already holds the maximum of 3 live connections.",
            ),
          );
        },
        { once: true },
      );
    });
  }

  // Typed structurally rather than as CloseEvent: the DOM lib is not loaded, and
  // the close code is the only field this needs.
  private handleClose(event: { code: number }): void {
    this.state = "closed";
    this.socket = null;
    if (this.shutdown) return;

    this.lastError = `closed (code ${event.code})`;
    this.log(`price stream closed (code ${event.code}); reconnecting`);

    // 1008 is the usual signal for a rejected credential. Try exactly one refresh
    // before falling into the backoff loop, so an expired token self-heals instead
    // of reconnecting into the same rejection forever.
    const looksLikeAuth = event.code === 1008 || event.code === 4001 || event.code === 4401;
    if (looksLikeAuth && !this.refreshedForAuth && this.tokens.canAutoRefresh) {
      this.refreshedForAuth = true;
      this.tokens
        .refresh()
        .then(() => this.scheduleReconnect(0))
        .catch((error) => {
          this.lastError = `token refresh failed: ${String(error)}`;
          this.scheduleReconnect();
        });
      return;
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(delayMs?: number): void {
    if (this.shutdown || this.reconnectTimer) return;
    if (this.subscriptions.size === 0) return; // nothing to come back for

    const delay =
      delayMs ??
      Math.min(this.maxReconnectDelayMs, 2 ** Math.min(this.reconnectAttempts, 6) * 500);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((error) => {
        this.lastError = String(error instanceof Error ? error.message : error);
        this.scheduleReconnect();
      });
    }, delay);
    // Never hold the process open purely to retry a socket nobody is reading.
    this.reconnectTimer.unref?.();
  }

  /** Close for good. Safe to call when never connected. */
  close(): void {
    this.shutdown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.subscriptions.clear();
    this.listeners.clear();
    const socket = this.socket;
    this.socket = null;
    this.state = "closed";
    if (socket) {
      try {
        socket.close(1000, "client shutdown");
      } catch {
        /* already dead */
      }
    }
  }

  /* --------------------------------------------------------- subscriptions -- */

  async subscribe(scripCodes: string[], mode: StreamMode = "ltp"): Promise<string[]> {
    const instruments = scripCodes.map(toStreamInstrument).filter(Boolean);
    if (instruments.length === 0) return [];

    const total = new Set([...this.subscriptions.keys(), ...instruments]).size;
    if (total > MAX_INSTRUMENTS) {
      throw new StreamError(
        `That would subscribe ${total} instruments; one connection allows ${MAX_INSTRUMENTS}. ` +
          "Unsubscribe something first.",
      );
    }

    for (const instrument of instruments) {
      this.subscriptions.set(instrument, mode);
      const token = instrumentToken(instrument);
      const owners = this.tokenOwners.get(token) ?? new Set<string>();
      owners.add(fromStreamInstrument(instrument));
      this.tokenOwners.set(token, owners);
    }

    // Only send a delta when the socket was already up. On a fresh connection the
    // open handler resubscribes everything recorded above, so sending here too
    // would put a duplicate subscribe on the wire for every first subscription.
    const wasOpen = this.state === "open";
    await this.connect();
    if (wasOpen) this.send({ action: "subscribe", mode, instruments });
    return instruments;
  }

  async unsubscribe(scripCodes?: string[]): Promise<string[]> {
    const instruments =
      scripCodes && scripCodes.length > 0
        ? scripCodes.map(toStreamInstrument)
        : [...this.subscriptions.keys()];
    if (instruments.length === 0) return [];

    // Group by the mode each was subscribed under: the server wants it echoed back.
    const byMode = new Map<StreamMode, string[]>();
    for (const instrument of instruments) {
      const mode = this.subscriptions.get(instrument);
      if (!mode) continue;
      const list = byMode.get(mode) ?? [];
      list.push(instrument);
      byMode.set(mode, list);

      this.subscriptions.delete(instrument);
      const token = instrumentToken(instrument);
      const owners = this.tokenOwners.get(token);
      if (owners) {
        owners.delete(fromStreamInstrument(instrument));
        if (owners.size === 0) {
          this.tokenOwners.delete(token);
          this.latest.delete(token);
        }
      }
    }

    if (this.state === "open") {
      for (const [mode, list] of byMode) {
        this.send({ action: "unsubscribe", mode, instruments: list });
      }
    }
    return instruments;
  }

  private resubscribeAll(): void {
    const byMode = new Map<StreamMode, string[]>();
    for (const [instrument, mode] of this.subscriptions) {
      const list = byMode.get(mode) ?? [];
      list.push(instrument);
      byMode.set(mode, list);
    }
    for (const [mode, instruments] of byMode) {
      this.send({ action: "subscribe", mode, instruments });
    }
  }

  private send(payload: unknown): void {
    const socket = this.socket;
    if (!socket || this.state !== "open") return;
    try {
      socket.send(JSON.stringify(payload));
    } catch (error) {
      this.lastError = `send failed: ${String(error)}`;
    }
  }

  /* ----------------------------------------------------------- ticks ------- */

  private handleMessage(event: MessageEvent): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    } catch {
      return; // heartbeats and other non-JSON frames are explicitly ignorable
    }

    const message = parsed as {
      mode?: unknown;
      instrument?: unknown;
      timestamp?: unknown;
      data?: unknown;
    };
    if (typeof message.instrument !== "string" || typeof message.data !== "object" || !message.data) {
      return; // heartbeat or an ack, not a tick
    }

    const token = instrumentToken(message.instrument);
    const data = message.data as Record<string, unknown>;
    const ltpRaw = data.ltp;
    const owners = this.tokenOwners.get(token);

    const tick: Tick = {
      instrument: message.instrument,
      // Only claim a mapping when exactly one subscription owns the token; the
      // feed identifies ticks by bare token, so NSE:2885 and BSE:2885 would collide.
      scripCode: owners && owners.size === 1 ? [...owners][0]! : null,
      mode: message.mode === "quote" ? "quote" : "ltp",
      timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
      receivedAt: Date.now(),
      ltp: typeof ltpRaw === "number" ? ltpRaw : null,
      data,
    };

    this.latest.set(token, tick);
    this.ticksReceived++;
    this.lastTickAt = tick.receivedAt;

    for (const listener of this.listeners) {
      try {
        listener(tick);
      } catch {
        // A listener must never take the socket down with it.
      }
    }
  }

  /** Subscribe to every tick. Returns an unsubscribe function. */
  onTick(listener: (tick: Tick) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Latest tick per instrument, newest first. */
  snapshot(scripCodes?: string[]): Tick[] {
    if (!scripCodes || scripCodes.length === 0) {
      return [...this.latest.values()].sort((a, b) => b.receivedAt - a.receivedAt);
    }
    const wanted = scripCodes.map((code) => instrumentToken(toStreamInstrument(code)));
    return wanted
      .map((token) => this.latest.get(token))
      .filter((tick): tick is Tick => tick !== undefined);
  }

  status(): {
    state: StreamState;
    subscribed: number;
    instruments: string[];
    ticksReceived: number;
    lastTickAgeMs: number | null;
    reconnectAttempts: number;
    lastError: string | null;
  } {
    return {
      state: this.state,
      subscribed: this.subscriptions.size,
      instruments: [...this.subscriptions.keys()].map(fromStreamInstrument),
      ticksReceived: this.ticksReceived,
      lastTickAgeMs: this.lastTickAt === null ? null : Date.now() - this.lastTickAt,
      reconnectAttempts: this.reconnectAttempts,
      lastError: this.lastError,
    };
  }

  /**
   * Collect ticks for a bounded window.
   *
   * Instruments that were not already subscribed are unsubscribed again at the
   * end, so a short observation cannot silently dismantle a standing subscription
   * someone else set up.
   */
  async watch(
    scripCodes: string[],
    seconds: number,
    mode: StreamMode = "ltp",
  ): Promise<{ ticks: Tick[]; durationMs: number }> {
    const preexisting = new Set(
      scripCodes.map(toStreamInstrument).filter((i) => this.subscriptions.has(i)),
    );

    await this.subscribe(scripCodes, mode);
    const collected: Tick[] = [];
    const stop = this.onTick((tick) => collected.push(tick));
    const startedAt = Date.now();

    try {
      await new Promise((resolve) => setTimeout(resolve, Math.round(seconds * 1000)));
    } finally {
      stop();
      const temporary = scripCodes
        .map(toStreamInstrument)
        .filter((instrument) => !preexisting.has(instrument))
        .map(fromStreamInstrument);
      if (temporary.length > 0) await this.unsubscribe(temporary);
    }

    return { ticks: collected, durationMs: Date.now() - startedAt };
  }
}

export interface WatchSummary {
  scripCode: string;
  ticks: number;
  first: number | null;
  last: number | null;
  high: number | null;
  low: number | null;
  changePct: number | null;
}

/** Reduce a watch window to one row per instrument. Plain arithmetic, no opinion. */
export function summariseWatch(ticks: Tick[]): WatchSummary[] {
  const groups = new Map<string, Tick[]>();
  for (const tick of ticks) {
    const key = tick.scripCode ?? tick.instrument;
    const list = groups.get(key) ?? [];
    list.push(tick);
    groups.set(key, list);
  }

  const round2 = (n: number) => Math.round(n * 100) / 100;

  return [...groups.entries()].map(([scripCode, group]) => {
    const prices = group
      .map((tick) => tick.ltp)
      .filter((price): price is number => typeof price === "number");
    if (prices.length === 0) {
      return { scripCode, ticks: group.length, first: null, last: null, high: null, low: null, changePct: null };
    }
    const first = prices[0]!;
    const last = prices[prices.length - 1]!;
    return {
      scripCode,
      ticks: group.length,
      first,
      last,
      high: Math.max(...prices),
      low: Math.min(...prices),
      changePct: first === 0 ? null : round2(((last - first) / first) * 100),
    };
  });
}
