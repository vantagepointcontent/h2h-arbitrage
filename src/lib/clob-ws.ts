// Polymarket CLOB WebSocket client for real-time price streaming
// Connects to wss://ws-subscriptions-clob.polymarket.com/ws/market
// Features: exponential backoff reconnect, REST fallback, heartbeat

export interface WsPriceUpdate {
  tokenId: string;
  type: string;
  bestBid: number | null;
  bestAsk: number | null;
  lastTradePrice: number | null;
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

  // ── REST fallback: fetch prices for tokens when WS is down ──

  /** Fetch best bid/ask for a token via CLOB REST API. */
  static async fetchTokenPrice(tokenId: string): Promise<WsPriceUpdate | null> {
    try {
      const res = await fetch(
        `https://clob.polymarket.com/book?token_id=${tokenId}`,
        { cache: 'no-store' },
      );
      if (!res.ok) return null;
      const data = await res.json();
      const bids = (data as any).bids as { price: string }[] | undefined;
      const asks = (data as any).asks as { price: string }[] | undefined;

      let bestBid: number | null = null;
      let bestAsk: number | null = null;

      if (bids?.length) {
        bestBid = Math.max(...bids.map((b: any) => parseFloat(b.price)));
      }
      if (asks?.length) {
        bestAsk = Math.min(...asks.map((a: any) => parseFloat(a.price)));
      }

      if (bestBid === null && bestAsk === null) return null;

      return {
        tokenId,
        type: 'rest_fallback',
        bestBid,
        bestAsk,
        lastTradePrice: null,
        ts: Date.now(),
      };
    } catch {
      return null;
    }
  }

  /** REST fallback: fetch prices for all tracked tokens. */
  static async fetchAllPrices(tokenIds: string[]): Promise<WsPriceUpdate[]> {
    const results = await Promise.allSettled(
      tokenIds.map((tid) => this.fetchTokenPrice(tid)),
    );
    return results
      .filter((r): r is PromiseFulfilledResult<WsPriceUpdate> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter(Boolean);
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

      // price_change carries level updates — we track best from cache
      const lvl = msg.level;
      const side = msg.side;
      const price = lvl?.price != null ? parseFloat(lvl.price) : null;
      const ts = msg.timestamp ?? Date.now();

      // Update cache entry
      const cached = priceCache.get(assetId) ?? { bestBid: 0, bestAsk: 0, ts };
      if (side === 'BUY' && price != null) {
        cached.bestBid = Math.max(cached.bestBid, price);
      } else if (side === 'SELL' && price != null) {
        cached.bestAsk = Math.min(cached.bestAsk, price);
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

      const bids = msg.bids as { price: string }[] | undefined;
      const asks = msg.asks as { price: string }[] | undefined;

      let bestBid: number | null = null;
      let bestAsk: number | null = null;

      if (bids?.length) {
        bestBid = Math.max(...bids.map((b: any) => parseFloat(b.price)));
      }
      if (asks?.length) {
        bestAsk = Math.min(...asks.map((a: any) => parseFloat(a.price)));
      }

      if (bestBid != null || bestAsk != null) {
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
        ts: msg.timestamp ?? Date.now(),
      });
    }

    // Dispatch to interested subscribers
    if (updates.length > 0) {
      for (const [, sub] of this.subscribers) {
        const relevant = updates.filter((u) => sub.tokenIds.has(u.tokenId));
        if (relevant.length > 0) {
          sub.cb(relevant);
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
