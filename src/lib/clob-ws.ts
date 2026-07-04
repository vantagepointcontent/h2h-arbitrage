// Polymarket CLOB WebSocket client for real-time price streaming
// Connects to wss://ws-subscriptions-clob.polymarket.com/ws/market
// Features: exponential backoff reconnect, REST fallback, heartbeat

export interface WsPriceUpdate {
  tokenId: string;
  type: string;
  bestBid: number | null;
  bestAsk: number | null;
  lastTradePrice: number | null;
  book?: {
    bids: { price: number; size: number }[];
    asks: { price: number; size: number }[];
  };
  ts: number;
}

export type WsCallback = (updates: WsPriceUpdate[]) => void;

interface Subscriber {
  tokenIds: Set<string>;
  cb: WsCallback;
}

// Connection state
const WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const HEARTBEAT_INTERVAL_MS = 10_000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const SUBSCRIBE_DEBOUNCE_MS = 200;

// Per-token best bid/ask cache (populated from WS snapshots)
const priceCache = new Map<string, { bestBid: number; bestAsk: number; ts: number }>();

// Bounded-memory guard: evict cache entries older than 30 min, every 5 min.
// Prevents unbounded growth in long-running processes (audit F4 fix).
const PRICE_CACHE_TTL_MS = 30 * 60_000;
setInterval(() => {
  const cutoff = Date.now() - PRICE_CACHE_TTL_MS;
  for (const [key, entry] of priceCache) {
    if (entry.ts < cutoff) priceCache.delete(key);
  }
}, 5 * 60_000).unref?.();

export class ClobWsService {
  private ws: WebSocket | null = null;
  private connected = false;
  private reconnectAttempts = 0;
  private subscribers = new Map<string, Subscriber>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscribeTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTokenIds = new Set<string>();

  // ── Public API ────────────────────────────────────────────

  connect(): void {
    // Idempotent: if a socket is already open or connecting, do nothing.
    // Multiple SSE sessions call connect() — creating a new socket here
    // would tear down the shared singleton connection mid-stream (B1).
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.resetReconnect();
    try {
      this.ws = new WebSocket(WS_URL);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.flushSubscribe();
      this.startHeartbeat();
    };

    this.ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data === 'string') {
        this.handleMessage(ev.data);
      }
    };

    this.ws.onerror = (_ev) => {
      // onclose will fire after onerror; handled there
    };

    this.ws.onclose = (_ev) => {
      this.connected = false;
      this.stopHeartbeat();
      this.scheduleReconnect();
    };
  }

  /** Subscribe to price updates for a set of token IDs. */
  subscribe(tokenIds: string[], cb: WsCallback, subKey: string): void {
    this.subscribers.set(subKey, {
      tokenIds: new Set(tokenIds),
      cb,
    });
    // Queue the new token IDs for subscription sync
    for (const tid of tokenIds) {
      this.pendingTokenIds.add(tid);
    }
    if (this.connected) {
      this.flushSubscribe();
    }
  }

  unsubscribe(subKey: string): void {
    this.subscribers.delete(subKey);
  }

  /** Disconnect and clean up. */
  disconnect(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.subscribeTimer) clearTimeout(this.subscribeTimer);
    if (this.ws) {
      this.ws.onclose = null; // suppress close handler
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  /** Get the current subscriber count (for diagnostics). */
  getSubscriberCount(): number {
    return this.subscribers.size;
  }

  // ── Internal ─────────────────────────────────────────────

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    // Handle pong — nothing to do
    if (msg.type === 'pong') return;

    // Collect updates relevant to our subscribers
    const updates: WsPriceUpdate[] = [];

    if (msg.type === 'best_bid_ask') {
      const assetId = msg.asset_id;
      if (!assetId) return;

      const bidStr = msg.bid?.price ?? msg.bid_price;
      const askStr = msg.ask?.price ?? msg.ask_price;

      const bestBid = bidStr != null ? parseFloat(String(bidStr)) : null;
      const bestAsk = askStr != null ? parseFloat(String(askStr)) : null;

      // Update cache
      if (bestBid != null || bestAsk != null) {
        priceCache.set(assetId, {
          bestBid: bestBid ?? priceCache.get(assetId)?.bestBid ?? 0,
          bestAsk: bestAsk ?? priceCache.get(assetId)?.bestAsk ?? 0,
          ts: Date.now(),
        });
      }

      updates.push({
        tokenId: assetId,
        type: 'best_bid_ask',
        bestBid,
        bestAsk,
        lastTradePrice: null,
        ts: msg.timestamp ?? Date.now(),
      });
    } else if (msg.type === 'price_change') {
      const assetId = msg.asset_id;
      if (!assetId) return;

      // price_change carries level updates — we track best from cache.
      // B3 fix: the old logic was monotonic (bestAsk could only improve),
      // so when liquidity was pulled the cache kept a stale better-than-real
      // ask and fabricated phantom arbs. Now:
      //  - a non-empty level at a better price improves the cached best
      //  - an emptied level (size 0) AT the cached best invalidates that side
      //    (set to 0 = unknown; downstream treats <=0 as no-data and the next
      //    'book' snapshot or REST reconcile restores truth)
      const lvl = msg.level;
      const side = msg.side;
      const price = lvl?.price != null ? parseFloat(lvl.price) : null;
      const size = lvl?.size != null ? parseFloat(lvl.size) : null;
      const ts = msg.timestamp ?? Date.now();

      const cached = priceCache.get(assetId) ?? { bestBid: 0, bestAsk: 0, ts };
      if (side === 'BUY' && price != null) {
        if (size != null && size <= 0) {
          if (cached.bestBid > 0 && Math.abs(price - cached.bestBid) < 1e-9) cached.bestBid = 0;
        } else if (cached.bestBid <= 0 || price > cached.bestBid) {
          cached.bestBid = price;
        }
      } else if (side === 'SELL' && price != null) {
        if (size != null && size <= 0) {
          if (cached.bestAsk > 0 && Math.abs(price - cached.bestAsk) < 1e-9) cached.bestAsk = 0;
        } else if (cached.bestAsk <= 0 || price < cached.bestAsk) {
          cached.bestAsk = price;
        }
      }
      cached.ts = ts;
      priceCache.set(assetId, cached);

      updates.push({
        tokenId: assetId,
        type: 'price_change',
        bestBid: cached.bestBid,
        bestAsk: cached.bestAsk,
        lastTradePrice: null,
        ts,
      });
    } else if (msg.type === 'last_trade_price') {
      const assetId = msg.asset_id;
      if (!assetId) return;

      const lastTradePrice = msg.last_trade_price != null
        ? parseFloat(String(msg.last_trade_price))
        : null;

      updates.push({
        tokenId: assetId,
        type: 'last_trade_price',
        bestBid: null,
        bestAsk: null,
        lastTradePrice,
        ts: msg.timestamp ?? Date.now(),
      });
    } else if (msg.type === 'book') {
      // Full orderbook snapshot — extract best bid/ask
      const assetId = msg.asset_id;
      if (!assetId) return;

      const bids = msg.bids as { price: string; size: string }[] | undefined;
      const asks = msg.asks as { price: string; size: string }[] | undefined;

      let bestBid: number | null = null;
      let bestAsk: number | null = null;

      if (bids?.length) {
        bestBid = Math.max(...bids.map((b: any) => parseFloat(b.price)));
      }
      if (asks?.length) {
        bestAsk = Math.min(...asks.map((a: any) => parseFloat(a.price)));
      }

      const parsedBids = bids
        ?.map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
        .filter((b) => b.price > 0 && b.size > 0)
        .sort((a, b) => b.price - a.price) ?? [];
      const parsedAsks = asks
        ?.map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
        .filter((a) => a.price > 0 && a.size > 0)
        .sort((a, b) => a.price - b.price) ?? [];

      if (bestBid != null || bestAsk != null || parsedBids.length > 0 || parsedAsks.length > 0) {
        priceCache.set(assetId, {
          bestBid: bestBid ?? priceCache.get(assetId)?.bestBid ?? 0,
          bestAsk: bestAsk ?? priceCache.get(assetId)?.bestAsk ?? 0,
          ts: msg.timestamp ?? Date.now(),
        });
      }

      updates.push({
        tokenId: assetId,
        type: 'book',
        bestBid,
        bestAsk,
        lastTradePrice: null,
        book: { bids: parsedBids, asks: parsedAsks },
        ts: msg.timestamp ?? Date.now(),
      });
    }

    // Dispatch to interested subscribers
    if (updates.length > 0) {
      for (const [, sub] of this.subscribers) {
        const relevant = updates.filter((u) => sub.tokenIds.has(u.tokenId));
        if (relevant.length > 0) {
          try {
            sub.cb(relevant);
          } catch (err) {
            console.error('[clob-ws] subscriber callback error (dispatch continues):', err);
          }
        }
      }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private resetReconnect(): void {
    this.reconnectAttempts = 0;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = Math.min(
      RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts),
      RECONNECT_MAX_MS,
    );
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private flushSubscribe(): void {
    if (this.subscribeTimer) clearTimeout(this.subscribeTimer);
    this.subscribeTimer = setTimeout(() => {
      this.doSubscribe();
      this.subscribeTimer = null;
    }, SUBSCRIBE_DEBOUNCE_MS);
  }

  private doSubscribe(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;

    const allTokens = new Set<string>();
    for (const [, sub] of this.subscribers) {
      for (const tid of sub.tokenIds) {
        allTokens.add(tid);
      }
    }
    // Also include pending tokens
    for (const tid of this.pendingTokenIds) {
      allTokens.add(tid);
    }
    this.pendingTokenIds.clear();

    if (allTokens.size === 0) return;

    this.ws.send(JSON.stringify({
      type: 'market',
      assets_ids: [...allTokens],
      custom_feature_enabled: true,
    }));
  }
}

// Singleton — one WS connection shared across the server lifetime
export const clobWs = new ClobWsService();
