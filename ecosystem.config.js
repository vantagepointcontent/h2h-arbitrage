/**
 * H2H Arbitrage — PM2 Ecosystem Configuration
 *
 * Covers OPS-2 requirements:
 *   • Auto-restart on crash (max 10/min via restart_delay)
 *   • Log rotation (7d retention, 10MB max — see /etc/logrotate.d/h2h-pm2)
 *   • Graceful shutdown drain (kill_timeout + shutdown_listener)
 *   • Deploy hook integration (on_restart / on_online / on_stop)
 */
module.exports = {
  apps: [
    {
      name: 'h2h-arbitrage',
      script: './node_modules/next/dist/bin/next',
      args: 'start -p 3000 -H 0.0.0.0',
      cwd: '/home/scott/h2h-arbitrage',
      instances: 1,
      exec_mode: 'fork',

      // ── Restart policy ─────────────────────────────────────
      // restart_delay: 5000ms → max ~12 restarts per minute (spec: within 5s)
      // max_restarts: Infinity → never give up on crashes
      restart_delay: 5000,
      max_restarts: Infinity,
      // min_uptime: 30s → ignore restarts during warm boot phase
      min_uptime: 30000,

      // ── Graceful shutdown ───────────────────────────────────
      // kill_timeout: wait up to 30s for clean exit before SIGKILL
      kill_timeout: 30000,
      // shutdown_listener: true tells PM2 the process listens for SIGTERM
      shutdown_listener: true,
      // wait_ready: true makes PM2 wait for the 'online' event
      wait_ready: true,
      listen_timeout: 10000,

      // ── Environment ─────────────────────────────────────────
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        PREDICTIONHUNT_API_KEY: 'pmx_U46EX9BAvyqxGoq9kinrYIqRt3KTWoWTrOU9B-I8VGQ',
        // SEC-001: shared secret required on mutating /api/* from non-localhost
        H2H_API_TOKEN: '8f070c00782b4e90f004fec034ae2b7ded34f00251bb242cc8034cc97bd5a7f9',
        // Same token exposed to the browser UI (inlined at build time too —
        // keep .env.production in sync). Shared-secret gate, not real auth.
        NEXT_PUBLIC_H2H_API_TOKEN: '8f070c00782b4e90f004fec034ae2b7ded34f00251bb242cc8034cc97bd5a7f9',
        // ── ALERT-001: alert quality filters ──
        // TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID must be set in .env.production
        // (gitignored) or here for alerts to fire at all.
        TELEGRAM_MIN_ROI_PCT: '1.5',        // net ROI ≥ 1.5%
        TELEGRAM_MIN_PROFIT_USD: '5',       // expected profit ≥ $5
        TELEGRAM_MIN_STAKE_USD: '50',       // arb must support ≥ $50 stake
        TELEGRAM_MIN_PERSISTENCE_SEC: '60', // episode must have lived ≥ 60s
        TELEGRAM_COOLDOWN_MS: '300000',     // 5 min per-market cooldown
        LOG_DIR: '/home/scott/.pm2/logs',
        LOG_LEVEL: 'info',
        // SENTRY_DSN: 'https://...',  // uncomment and set your Sentry DSN
        // SENTRY_TRACES_SAMPLE_RATE: '0.1',
      },

      // ── Logging ─────────────────────────────────────────────
      log_file: '/home/scott/.pm2/logs/h2h-arbitrage.log',
      error_file: '/home/scott/.pm2/logs/h2h-arbitrage-error.log',
      out_file: '/home/scott/.pm2/logs/h2h-arbitrage-out.log',
      merge_logs: true,
      time: true,
      time_format: '[YYYY-MM-DD HH:mm:ss]',

      // ── Deploy hooks ────────────────────────────────────────
      // Scripts run in cwd with env vars available
      on_restart: '/home/scott/h2h-arbitrage/scripts/deploy-hooks.sh restart',
      on_online: '/home/scott/h2h-arbitrage/scripts/deploy-hooks.sh online',
      on_stop: '/home/scott/h2h-arbitrage/scripts/deploy-hooks.sh stop',

      // ── Resource limits ─────────────────────────────────────
      // 4G: server upgraded to 32GB RAM / 6 cores (2026-07-03). Previously 1G
      // (at 512M pm2 was SIGKILLing the app mid-scan-burst; Next.js RSS
      // legitimately peaks >512M under concurrent scan load).
      max_memory_restart: '4G',
    },
    {
      name: 'h2h-poller',
      script: './scripts/poll.mjs',
      cwd: '/home/scott/h2h-arbitrage',
      instances: 1,
      exec_mode: 'fork',

      // ── Restart policy ─────────────────────────────────────
      restart_delay: 5000,
      max_restarts: Infinity,
      min_uptime: 15000,

      // ── Graceful shutdown ───────────────────────────────────
      // 15s is plenty for poller (mid-cycle scan has 15s abort timeout)
      kill_timeout: 15000,
      shutdown_listener: true,

      // ── Environment ─────────────────────────────────────────
      env: {
        NODE_ENV: 'production',
        // Poller runs on the SAME machine as the app — use loopback, not the
        // Tailscale IP (100.86.7.30), which intermittently drops/times out
        // local connections and caused 'fetch failed' bursts.
        H2H_BASE_URL: 'http://localhost:3000',
        // SEC-001: poller calls the app over the Tailscale IP, so it must
        // authenticate its mutating requests with the shared token.
        H2H_API_TOKEN: '8f070c00782b4e90f004fec034ae2b7ded34f00251bb242cc8034cc97bd5a7f9',
      },

      // ── Logging ─────────────────────────────────────────────
      log_file: '/home/scott/.pm2/logs/h2h-poller.log',
      error_file: '/home/scott/.pm2/logs/h2h-poller-error.log',
      out_file: '/home/scott/.pm2/logs/h2h-poller-out.log',
      merge_logs: true,
      time: true,
      time_format: '[YYYY-MM-DD HH:mm:ss]',

      // ── Deploy hooks ────────────────────────────────────────
      on_restart: '/home/scott/h2h-arbitrage/scripts/deploy-hooks.sh restart',
      on_online: '/home/scott/h2h-arbitrage/scripts/deploy-hooks.sh online',
      on_stop: '/home/scott/h2h-arbitrage/scripts/deploy-hooks.sh stop',

      // ── Resource limits ─────────────────────────────────────
      max_memory_restart: '256M',
    },
    {
      name: 'h2h-watcher',
      script: './dist/ws-watcher.mjs',
      cwd: '/home/scott/h2h-arbitrage',
      instances: 1,
      exec_mode: 'fork',
      // Next.js auto-loads .env.local; plain node needs it explicitly
      // (Kalshi WS auth reads KALSHI_API_KEY_ID/KALSHI_API_PRIVATE_KEY).
      node_args: '--env-file=.env.local',

      // ── Restart policy ─────────────────────────────────────
      restart_delay: 5000,
      max_restarts: Infinity,
      min_uptime: 15000,

      // ── Graceful shutdown ───────────────────────────────────
      kill_timeout: 10000,
      shutdown_listener: true,

      // ── Environment ─────────────────────────────────────────
      env: {
        NODE_ENV: 'production',
        H2H_WATCHER_CAPITAL: '1000',
      },

      // ── Logging ─────────────────────────────────────────────
      log_file: '/home/scott/.pm2/logs/h2h-watcher.log',
      error_file: '/home/scott/.pm2/logs/h2h-watcher-error.log',
      out_file: '/home/scott/.pm2/logs/h2h-watcher-out.log',
      merge_logs: true,
      time: true,
      time_format: '[YYYY-MM-DD HH:mm:ss]',

      // ── Resource limits ─────────────────────────────────────
      max_memory_restart: '1G',
    },
  ],
};
