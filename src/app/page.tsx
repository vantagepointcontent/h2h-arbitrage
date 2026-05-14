'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Zap,
  Scan,
  ArrowUpRight,
  ArrowDownRight,
  Link2,
  Activity,
  Clock,
  TrendingUp,
  ExternalLink,
  Loader2,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';

interface ArbitrageInfo {
  strategy: string;
  kalshiStake: number;
  pmStake: number;
  expectedProfit: number;
  roiPct: number;
  buyPlatform: 'kalshi' | 'polymarket' | null;
  buyPrice: number;
  sellPlatform: 'kalshi' | 'polymarket' | null;
  sellPrice: number;
}

interface UnifiedOutcome {
  artist: string;
  kalshi: {
    ticker: string;
    yesBid: number;
    yesAsk: number;
    noBid: number;
    noAsk: number;
    lastPrice: number;
    volume24h?: string;
  } | null;
  polymarket: {
    marketId: string;
    conditionId: string;
    yesPrice: number;
    noPrice: number;
    bestBid: number;
    bestAsk: number;
    lastTradePrice: number;
    volume?: string;
    liquidity?: string;
  } | null;
  arbitrage: ArbitrageInfo;
}

interface ScanResult {
  eventTitle: string;
  kalshiEventTicker: string;
  pmEventSlug: string;
  pmEventId: string;
  kalshiCount: number;
  pmCount: number;
  matchedCount: number;
  outcomes: UnifiedOutcome[];
}

export default function Home() {
  const [kalshiUrl, setKalshiUrl] = useState('https://kalshi.com/markets/kxfeaturedrake/who-will-be-featured-on-drake-album/kxfeaturedrake');
  const [pmUrl, setPmUrl] = useState('https://polymarket.com/event/who-will-be-featured-on-iceman');
  const [capital, setCapital] = useState(1000);
  const [result, setResult] = useState<ScanResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const [expandedArtist, setExpandedArtist] = useState<string | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const scan = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/scan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kalshiUrl, polymarketUrl: pmUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setResult(data);
      setLastUpdated(new Date());
    } catch (err: any) {
      if (!silent) setError(err.message || 'Scan failed');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [kalshiUrl, pmUrl]);

  const startPolling = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    setIsPolling(true);
    pollRef.current = setInterval(() => scan(true), 1000);
  }, [scan]);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setIsPolling(false);
  }, []);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  const handleScan = async () => {
    await scan(false);
    startPolling();
  };

  const formatPrice = (p: number) => `${(p * 100).toFixed(1)}¢`;
  const formatDollar = (n: number) => `$${n.toFixed(2)}`;

  const kalshiDeepLink = (ticker: string) => `https://kalshi.com/markets/${ticker}`;
  const pmDeepLink = (slug: string) => `https://polymarket.com/event/${slug}`;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#e5e5e5]">
      {/* Header */}
      <header className="border-b border-[#1a1a1a] bg-[#0f0f0f]">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-[#22c55e]/10 flex items-center justify-center">
              <Zap className="w-5 h-5 text-[#22c55e]" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">H2H Arbitrage</h1>
              <p className="text-xs text-[#737373]">Kalshi × Polymarket · Head-to-Head Scanner</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {isPolling && (
              <>
                <span className="flex items-center gap-1.5 text-xs text-[#22c55e]">
                  <span className="w-2 h-2 rounded-full bg-[#22c55e] live-dot" />
                  Live
                </span>
                <span className="text-xs text-[#737373]">
                  {lastUpdated ? `${Math.floor((Date.now() - lastUpdated.getTime()) / 1000)}s ago` : ''}
                </span>
              </>
            )}
            {isPolling && (
              <button
                onClick={stopPolling}
                className="px-3 py-1.5 text-xs rounded-md bg-[#1a1a1a] hover:bg-[#262626] text-[#e5e5e5] transition-colors"
              >
                Stop
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 py-6">
        {/* Input Section */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-xl border border-[#1a1a1a] bg-[#0f0f0f] p-5 mb-6"
        >
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm font-medium text-[#a3a3a3]">
                <Link2 className="w-4 h-4" />
                Kalshi URL
              </label>
              <input
                type="text"
                value={kalshiUrl}
                onChange={(e) => setKalshiUrl(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg bg-[#1a1a1a] border border-[#262626] text-sm text-[#e5e5e5] placeholder-[#525252] focus:outline-none focus:border-[#22c55e] focus:ring-1 focus:ring-[#22c55e]/30 transition-all"
                placeholder="https://kalshi.com/markets/..."
              />
            </div>
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm font-medium text-[#a3a3a3]">
                <Link2 className="w-4 h-4" />
                Polymarket URL
              </label>
              <input
                type="text"
                value={pmUrl}
                onChange={(e) => setPmUrl(e.target.value)}
                className="w-full px-3 py-2.5 rounded-lg bg-[#1a1a1a] border border-[#262626] text-sm text-[#e5e5e5] placeholder-[#525252] focus:outline-none focus:border-[#22c55e] focus:ring-1 focus:ring-[#22c55e]/30 transition-all"
                placeholder="https://polymarket.com/event/..."
              />
            </div>
          </div>

          <div className="flex items-center gap-3 flex-wrap">
            <button
              onClick={handleScan}
              disabled={loading}
              className="flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#22c55e] text-black font-semibold text-sm hover:bg-[#16a34a] transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Scan className="w-4 h-4" />}
              {loading ? 'Scanning...' : 'Scan Markets'}
            </button>

            <div className="flex items-center gap-2 ml-auto">
              <label className="text-xs text-[#737373]">Capital:</label>
              <input
                type="number"
                value={capital}
                onChange={(e) => setCapital(Number(e.target.value))}
                className="w-24 px-2 py-1.5 rounded-md bg-[#1a1a1a] border border-[#262626] text-sm text-[#e5e5e5] focus:outline-none focus:border-[#22c55e]"
              />
            </div>
          </div>

          {error && (
            <div className="mt-3 flex items-center gap-2 text-sm text-[#ef4444]">
              <AlertCircle className="w-4 h-4" />
              {error}
            </div>
          )}
        </motion.div>

        {/* Results */}
        <AnimatePresence>
          {result && (
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              animate={{ opacity: 1, y: 0 }}
              className="space-y-4"
            >
              {/* Stats Bar */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard
                  label="Kalshi Markets"
                  value={result.kalshiCount}
                  icon={<Activity className="w-4 h-4" />}
                  color="blue"
                />
                <StatCard
                  label="Polymarket Markets"
                  value={result.pmCount}
                  icon={<Activity className="w-4 h-4" />}
                  color="purple"
                />
                <StatCard
                  label="Matched Pairs"
                  value={result.matchedCount}
                  icon={<Link2 className="w-4 h-4" />}
                  color="green"
                />
                <StatCard
                  label="Event"
                  value={result.eventTitle.length > 20 ? result.eventTitle.slice(0, 20) + '...' : result.eventTitle}
                  icon={<Clock className="w-4 h-4" />}
                  color="yellow"
                />
              </div>

              {/* Outcomes Table */}
              <div className="rounded-xl border border-[#1a1a1a] bg-[#0f0f0f] overflow-hidden">
                <div className="px-4 py-3 border-b border-[#1a1a1a] flex items-center justify-between">
                  <h2 className="text-sm font-semibold">All Outcomes</h2>
                  <div className="flex items-center gap-2 text-xs text-[#737373]">
                    <span className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-[#22c55e]" /> Matched
                    </span>
                    <span className="flex items-center gap-1">
                      <span className="w-2 h-2 rounded-full bg-[#262626]" /> Single
                    </span>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[#1a1a1a] text-xs text-[#737373]">
                        <th className="px-4 py-2 text-left font-medium">Artist / Outcome</th>
                        <th className="px-4 py-2 text-center font-medium">Kalshi YES</th>
                        <th className="px-4 py-2 text-center font-medium">Kalshi NO</th>
                        <th className="px-4 py-2 text-center font-medium">PM YES</th>
                        <th className="px-4 py-2 text-center font-medium">PM NO</th>
                        <th className="px-4 py-2 text-center font-medium">Arbitrage</th>
                        <th className="px-4 py-2 text-right font-medium"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1a1a1a]">
                      {result.outcomes.map((outcome) => {
                        const isMatched = !!outcome.kalshi && !!outcome.polymarket;
                        const isExpanded = expandedArtist === outcome.artist;
                        const arb = outcome.arbitrage;
                        const hasArb = arb.roiPct > 0;

                        return (
                          <>
                            <tr
                              key={outcome.artist}
                              className={`transition-colors ${isMatched ? 'bg-[#22c55e]/[0.02]' : ''} hover:bg-[#1a1a1a]/50`}
                            >
                              <td className="px-4 py-3">
                                <div className="flex items-center gap-2">
                                  <span className={`text-sm font-medium ${isMatched ? 'text-[#22c55e]' : 'text-[#a3a3a3]'}`}>
                                    {outcome.artist}
                                  </span>
                                  {isMatched && (
                                    <span className="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-[#22c55e]/10 text-[#22c55e]">
                                      MATCHED
                                    </span>
                                  )}
                                </div>
                              </td>
                              <td className="px-4 py-3 text-center">
                                {outcome.kalshi ? (
                                  <div className="space-y-0.5">
                                    <div className="text-[#e5e5e5] font-mono text-xs">{formatPrice(outcome.kalshi.yesBid)}–{formatPrice(outcome.kalshi.yesAsk)}</div>
                                  </div>
                                ) : (
                                  <span className="text-[#404040]">—</span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-center">
                                {outcome.kalshi ? (
                                  <div className="text-[#e5e5e5] font-mono text-xs">{formatPrice(outcome.kalshi.noBid)}–{formatPrice(outcome.kalshi.noAsk)}</div>
                                ) : (
                                  <span className="text-[#404040]">—</span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-center">
                                {outcome.polymarket ? (
                                  <div className="space-y-0.5">
                                    <div className="text-[#e5e5e5] font-mono text-xs">{formatPrice(outcome.polymarket.bestBid)}–{formatPrice(outcome.polymarket.bestAsk)}</div>
                                  </div>
                                ) : (
                                  <span className="text-[#404040]">—</span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-center">
                                {outcome.polymarket ? (
                                  <div className="text-[#e5e5e5] font-mono text-xs">{formatPrice(outcome.polymarket.noPrice)}</div>
                                ) : (
                                  <span className="text-[#404040]">—</span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-center">
                                {isMatched ? (
                                  <div className="flex flex-col items-center">
                                    <span className={`text-xs font-bold ${hasArb ? 'text-[#22c55e]' : 'text-[#737373]'}`}>
                                      {hasArb ? `+${arb.roiPct.toFixed(2)}%` : 'No arb'}
                                    </span>
                                    {hasArb && (
                                      <span className="text-[10px] text-[#737373]">{formatDollar(arb.expectedProfit)} profit</span>
                                    )}
                                  </div>
                                ) : (
                                  <span className="text-[#404040]">—</span>
                                )}
                              </td>
                              <td className="px-4 py-3 text-right">
                                <div className="flex items-center justify-end gap-1">
                                  {outcome.kalshi && (
                                    <a
                                      href={kalshiDeepLink(outcome.kalshi.ticker)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="p-1 rounded hover:bg-[#1a1a1a] text-[#737373] hover:text-[#e5e5e5] transition-colors"
                                      title="Open in Kalshi"
                                    >
                                      <ExternalLink className="w-3.5 h-3.5" />
                                    </a>
                                  )}
                                  {outcome.polymarket && (
                                    <a
                                      href={pmDeepLink(result.pmEventSlug)}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="p-1 rounded hover:bg-[#1a1a1a] text-[#737373] hover:text-[#e5e5e5] transition-colors"
                                      title="Open in Polymarket"
                                    >
                                      <ExternalLink className="w-3.5 h-3.5" />
                                    </a>
                                  )}
                                  {isMatched && (
                                    <button
                                      onClick={() => setExpandedArtist(isExpanded ? null : outcome.artist)}
                                      className="p-1 rounded hover:bg-[#1a1a1a] text-[#737373] hover:text-[#e5e5e5] transition-colors"
                                    >
                                      <TrendingUp className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>

                            {/* Expanded Arbitrage Detail */}
                            <AnimatePresence>
                              {isExpanded && isMatched && (
                                <motion.tr
                                  initial={{ height: 0, opacity: 0 }}
                                  animate={{ height: 'auto', opacity: 1 }}
                                  exit={{ height: 0, opacity: 0 }}
                                  className="bg-[#22c55e]/[0.02]"
                                >
                                  <td colSpan={7} className="px-4 py-3">
                                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                                      <div className="rounded-lg bg-[#1a1a1a] p-3">
                                        <p className="text-[10px] text-[#737373] uppercase font-semibold mb-1">Strategy</p>
                                        <p className="text-sm text-[#e5e5e5] font-medium">{arb.strategy}</p>
                                      </div>
                                      <div className="rounded-lg bg-[#1a1a1a] p-3">
                                        <p className="text-[10px] text-[#737373] uppercase font-semibold mb-1">Position Size ({formatDollar(capital)})</p>
                                        <div className="space-y-1">
                                          <div className="flex justify-between text-xs">
                                            <span className="text-[#a3a3a3]">Kalshi</span>
                                            <span className="text-[#e5e5e5] font-mono">{formatDollar(arb.kalshiStake)}</span>
                                          </div>
                                          <div className="flex justify-between text-xs">
                                            <span className="text-[#a3a3a3]">Polymarket</span>
                                            <span className="text-[#e5e5e5] font-mono">{formatDollar(arb.pmStake)}</span>
                                          </div>
                                        </div>
                                      </div>
                                      <div className="rounded-lg bg-[#1a1a1a] p-3">
                                        <p className="text-[10px] text-[#737373] uppercase font-semibold mb-1">Expected P&L</p>
                                        <div className="flex items-baseline gap-2">
                                          <span className={`text-lg font-bold ${arb.expectedProfit >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
                                            {arb.expectedProfit >= 0 ? '+' : ''}{formatDollar(arb.expectedProfit)}
                                          </span>
                                          <span className="text-xs text-[#737373]">{arb.roiPct.toFixed(2)}% ROI</span>
                                        </div>
                                      </div>
                                    </div>
                                  </td>
                                </motion.tr>
                              )}
                            </AnimatePresence>
                          </>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  color,
}: {
  label: string;
  value: string | number;
  icon: React.ReactNode;
  color: 'green' | 'blue' | 'purple' | 'yellow';
}) {
  const colors = {
    green: 'bg-[#22c55e]/10 text-[#22c55e]',
    blue: 'bg-[#3b82f6]/10 text-[#3b82f6]',
    purple: 'bg-[#a855f7]/10 text-[#a855f7]',
    yellow: 'bg-[#eab308]/10 text-[#eab308]',
  };

  return (
    <div className="rounded-xl border border-[#1a1a1a] bg-[#0f0f0f] p-4">
      <div className="flex items-center gap-2 mb-2">
        <span className={`w-7 h-7 rounded-md flex items-center justify-center ${colors[color]}`}>
          {icon}
        </span>
        <span className="text-xs text-[#737373]">{label}</span>
      </div>
      <div className="text-xl font-bold text-[#e5e5e5]">{value}</div>
    </div>
  );
}
