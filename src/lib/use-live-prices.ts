"use client";

import { useState, useEffect, useRef, useCallback } from "react";

interface PlatformPrice {
  yesBid: number;
  yesAsk: number;
  noBid: number;
  noAsk: number;
  lastPrice: number;
  lastUpdated?: Date | null;
  bidVolume?: number;
  askVolume?: number;
}

interface PmOutcomePrice {
  yesPrice: number;
  noPrice: number;
  bestBid: number;
  bestAsk: number;
  lastTradePrice: number;
  lastUpdated?: Date | null;
  bidVolume?: number;
  askVolume?: number;
}

interface LivePriceOutcome {
  artist: string;
  platformA: PlatformPrice | null;
  platformB: PmOutcomePrice | null;
}

interface UseLivePricesOptions {
  kalshiUrl?: string;
  pmUrl?: string;
  capital?: number;
  enabled?: boolean;
}

export function useLivePrices({ kalshiUrl, pmUrl, capital = 10, enabled = true }: UseLivePricesOptions) {
  const [outcomes, setOutcomes] = useState<LivePriceOutcome[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<"idle" | "connecting" | "active" | "disconnected">("idle");
  const [error, setError] = useState<string | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const prevPricesRef = useRef<Map<string, { yesBid: number; yesAsk: number; noBid: number; noAsk: number; yesPrice: number; bestBid: number; bestAsk: number }>>(new Map());

  const connect = useCallback(() => {
    if (!kalshiUrl || !pmUrl || !enabled) return;

    setConnectionStatus("connecting");
    setError(null);

    // Close existing connection if any
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const params = new URLSearchParams();
    params.set("kalshiUrl", kalshiUrl);
    params.set("pmUrl", pmUrl);
    params.set("capital", String(capital));

    const es = new EventSource(`/api/ws/live-scan?${params.toString()}`);
    eventSourceRef.current = es;

    es.onopen = () => {
      setConnectionStatus("active");
    };

    es.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data);
        if (data.error) {
          setError(data.error);
          setConnectionStatus("disconnected");
          es.close();
          return;
        }
        if (data.type === "status") {
          // Status messages, ignore for now
          return;
        }
        if (data.type === "result") {
          const newOutcomes: LivePriceOutcome[] = data.result.outcomes.map((o: any) => {
            const artist = o.artist;

            // Platform A (Kalshi) — the live engine only provides ask prices
            // (it stores asks in the orderbook). We don't have separate bid
            // values, so we set bid = ask (the Bookmaker1on1 component only
            // uses yesAsk/noAsk for spread calculations; bid is cosmetic).
            const platformA: PlatformPrice | null = o.kalshiYesAsk !== null || o.kalshiNoAsk !== null ? {
              yesBid: o.kalshiYesAsk ?? 0,
              yesAsk: o.kalshiYesAsk ?? 0,
              noBid: o.kalshiNoAsk ?? 0,
              noAsk: o.kalshiNoAsk ?? 0,
              lastPrice: 0,
              lastUpdated: new Date(o.lastUpdate),
              bidVolume: o.kalshiYesDepth || o.kalshiNoDepth || 0,
              askVolume: o.kalshiYesDepth || o.kalshiNoDepth || 0,
            } : null;

            // Platform B (Polymarket) — pmYesAsk is the YES ask, pmNoAsk is the NO ask.
            // bestAsk should be the YES ask (pmYesAsk), NOT the NO ask (pmNoAsk).
            // bestBid is not available from the live engine; use 0 as sentinel.
            const platformB: PmOutcomePrice | null = o.pmYesAsk !== null || o.pmNoAsk !== null ? {
              yesPrice: o.pmYesAsk ?? 0,
              noPrice: o.pmNoAsk ?? 0,
              bestBid: 0,
              bestAsk: o.pmYesAsk ?? 0,
              lastTradePrice: 0,
              lastUpdated: new Date(o.lastUpdate),
              bidVolume: o.pmYesDepth || o.pmNoDepth || 0,
              askVolume: o.pmYesDepth || o.pmNoDepth || 0,
            } : null;

            return { artist, platformA, platformB };
          });

          // Update previous prices
          const newPrev = new Map<string, typeof prevPricesRef.current[number]>();
          newOutcomes.forEach((o) => {
            if (o.platformA && o.platformB) {
              newPrev.set(o.artist, {
                yesBid: o.platformA.yesBid,
                yesAsk: o.platformA.yesAsk,
                noBid: o.platformA.noBid,
                noAsk: o.platformA.noAsk,
                yesPrice: o.platformB.yesPrice,
                bestBid: o.platformB.bestBid,
                bestAsk: o.platformB.bestAsk,
              });
            }
          });
          prevPricesRef.current = newPrev;

          setOutcomes(newOutcomes);
        }
      } catch (err) {
        console.error("[useLivePrices] Error parsing WS message:", err);
      }
    };

    es.onerror = () => {
      // BUG-06: Don't close the EventSource on transient errors. EventSource
      // has built-in auto-reconnect — closing on every error killed the live
      // scan permanently after ~1 minute (any transient SSE error = dead).
      // Only treat CLOSED readyState as fatal (server explicitly closed).
      if (es.readyState === EventSource.CLOSED) {
        setConnectionStatus("disconnected");
        setError("Stream disconnected by server.");
        if (eventSourceRef.current) {
          eventSourceRef.current.close();
          eventSourceRef.current = null;
        }
      } else {
        // readyState === CONNECTING — browser is auto-reconnecting.
        setConnectionStatus("connecting");
      }
    };
  }, [kalshiUrl, pmUrl, capital, enabled]);

  const disconnect = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    setConnectionStatus("idle");
    setOutcomes([]);
  }, []);

  useEffect(() => {
    if (enabled && kalshiUrl && pmUrl) {
      connect();
    } else {
      disconnect();
    }

    return () => {
      disconnect();
    };
  }, [connect, disconnect, enabled, kalshiUrl, pmUrl]);

  return {
    outcomes,
    connectionStatus,
    error,
    connect,
    disconnect,
  };
}