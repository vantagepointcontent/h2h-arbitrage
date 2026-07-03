// Kalshi WebSocket client — authenticated real-time orderbook streaming
// Production endpoint: wss://api.elections.kalshi.com/trade-api/ws/v2
// Auth: RSA-PSS SHA256 signed headers (same scheme as REST API)
//
// NOTE: The user's API key is restricted to api.elections.kalshi.com for WS.
// external-api-ws.kalshi.com returns 403 for this key.

import WebSocket from 'ws';
import { makeKalshiWsAuthHeaders } from './kalshi-auth';
import logger from './logger';

export interface KalshiOrderbookLevel {
  price: number; // dollars, e.g. 0.58
  quantity: number; // fixed-point contracts (2 decimals implied), e.g. 100.00
}

export interface KalshiOrderbookSnapshot {
  type: 'orderbook_snapshot';
  sid: number;
  seq: number;
  marketTicker: string;
  marketId: string;
  yes: KalshiOrderbookLevel[];
  no: KalshiOrderbookLevel[];
  ts: number;
}

export interface KalshiOrderbookDelta {
  type: 'orderbook_delta';
  sid: number;
  seq: number;
  marketTicker: string;
  marketId: string;
  side: 'yes' | 'no';
  price: number;
  delta: number; // positive = added liquidity, negative = removed
  ts: number;
}

export type KalshiWsMessage = KalshiOrderbookSnapshot | KalshiOrderbookDelta;

export type KalshiWsCallback = (msg: KalshiWsMessage) => void;

interface Subscriber {
  marketTicker: string;
  cb: KalshiWsCallback;
}

const WS_URL = 'wss://api.elections.kalshi.com/trade-api/ws/v2';
const HEARTBEAT_INTERVAL_MS = 10_000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

export class KalshiWsService {
  private ws: WebSocket | null = null;
  private connected = false;
  private reconnectAttempts = 0;
  private subscribers = new Map<string, Subscriber>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTickers = new Set<string>();

  connect(): void {
    // Idempotent: if a socket is already open or connecting, do nothing.
    // Multiple SSE sessions call connect() — creating a new socket here
    // would tear down the shared singleton connection mid-stream (B1).
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.resetReconnect();
    this.doConnect();
  }

  subscribe(marketTicker: string, cb: KalshiWsCallback, subKey: string): void {
    this.subscribers.set(subKey, { marketTicker, cb });
    this.pendingTickers.add(marketTicker);
    if (this.connected && this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(marketTicker);
    }
  }

  unsubscribe(subKey: string): void {
    const sub = this.subscribers.get(subKey);
    this.subscribers.delete(subKey);
    if (sub && !this.hasSubscriberForTicker(sub.marketTicker)) {
      this.sendUnsubscribe(sub.marketTicker);
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getSubscriberCount(): number {
    return this.subscribers.size;
  }

  disconnect(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  // ── Internal ───────────────────────────────────────────────

  private doConnect(): void {
    try {
      // Auth via signed headers on the upgrade request (RSA-PSS).
      // Query-param auth with PKCS#1 v1.5 signatures fails the handshake.
      this.ws = new WebSocket(WS_URL, { headers: makeKalshiWsAuthHeaders() });
    } catch (err) {
      logger.error('[kalshi-ws] failed to create websocket', { err });
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.startHeartbeat();
      this.flushPendingSubscriptions();
    };

    this.ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        this.handleMessage(ev.data);
      }
    };

    this.ws.onerror = () => {
      // onclose handles reconnect
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.stopHeartbeat();
      this.scheduleReconnect();
    };
  }

  private handleMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const type = msg.type;
    const inner = msg.msg || {};

    if (type === 'subscribed') {
      logger.debug('[kalshi-ws] subscribed ack', { id: msg.id, channel: inner.channel, sid: inner.sid });
      return;
    }

    if (type === 'orderbook_snapshot') {
      const marketTicker = inner.market_ticker;
      if (!marketTicker) return;

      const snapshot: KalshiOrderbookSnapshot = {
        type: 'orderbook_snapshot',
        sid: msg.sid,
        seq: msg.seq,
        marketTicker,
        marketId: inner.market_id,
        yes: this.parseLevels(inner.yes_dollars_fp),
        no: this.parseLevels(inner.no_dollars_fp),
        ts: inner.ts_ms ?? Date.now(),
      };
      this.dispatch(marketTicker, snapshot);
      return;
    }

    if (type === 'orderbook_delta') {
      const marketTicker = inner.market_ticker;
      if (!marketTicker) return;

      const side = inner.side;
      if (side !== 'yes' && side !== 'no') return;

      const delta: KalshiOrderbookDelta = {
        type: 'orderbook_delta',
        sid: msg.sid,
        seq: msg.seq,
        marketTicker,
        marketId: inner.market_id,
        side,
        price: parseFloat(inner.price_dollars),
        delta: parseFloat(inner.delta_fp),
        ts: inner.ts_ms ?? Date.now(),
      };
      this.dispatch(marketTicker, delta);
      return;
    }

    // Ignore other channels (ticker, fill, etc.)
  }

  private parseLevels(levels: any): KalshiOrderbookLevel[] {
    if (!Array.isArray(levels)) return [];
    return levels
      .filter((lvl) => Array.isArray(lvl) && lvl.length >= 2)
      .map((lvl) => ({
        price: parseFloat(lvl[0]),
        quantity: parseFloat(lvl[1]),
      }))
      .filter((lvl) => !isNaN(lvl.price) && !isNaN(lvl.quantity) && lvl.quantity > 0);
  }

  private dispatch(marketTicker: string, msg: KalshiWsMessage): void {
    for (const [, sub] of this.subscribers) {
      if (sub.marketTicker === marketTicker) {
        try {
          sub.cb(msg);
        } catch (err) {
          console.error('[kalshi-ws] subscriber callback error (dispatch continues):', err);
        }
      }
    }
  }

  private flushPendingSubscriptions(): void {
    const tickers = new Set<string>();
    for (const t of this.pendingTickers) tickers.add(t);
    for (const [, sub] of this.subscribers) tickers.add(sub.marketTicker);
    this.pendingTickers.clear();
    // B4: batch — one subscribe message with market_tickers array instead of
    // one message per ticker (faster warm-up on connect/reconnect).
    this.sendSubscribeBatch([...tickers]);
  }

  private sendSubscribe(marketTicker: string): void {
    this.sendSubscribeBatch([marketTicker]);
  }

  private sendSubscribeBatch(marketTickers: string[]): void {
    if (marketTickers.length === 0) return;
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      id: Date.now(),
      cmd: 'subscribe',
      params: {
        channels: ['orderbook_delta'],
        market_tickers: marketTickers,
        receive_snapshot: true,
        // NOTE: no depth cap here — Kalshi WS orderbook_delta streams the FULL book
        // by default. (A literal `depthP: Infinity` would JSON.stringify to null and
        // risk a rejected subscribe.) Full-depth requirement is satisfied by omission;
        // REST calls use depthP=Infinity as a query-string param in kalshi.ts.
      },
    }));
  }

  private sendUnsubscribe(marketTicker: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      id: Date.now(),
      cmd: 'unsubscribe',
      params: {
        channels: ['orderbook_delta'],
        market_tickers: [marketTicker],
      },
    }));
  }

  private hasSubscriberForTicker(ticker: string): boolean {
    for (const [, sub] of this.subscribers) {
      if (sub.marketTicker === ticker) return true;
    }
    return false;
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
    const delay = Math.min(RECONNECT_BASE_MS * Math.pow(2, this.reconnectAttempts), RECONNECT_MAX_MS);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.doConnect();
    }, delay);
  }
}

// Singleton — one WS connection shared across the server lifetime
export const kalshiWs = new KalshiWsService();

// Also expose a factory for isolated test sessions.
export function createKalshiWsService(): KalshiWsService {
  return new KalshiWsService();
}
