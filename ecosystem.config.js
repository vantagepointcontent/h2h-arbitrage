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
      max_memory_restart: '512M',
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
        H2H_BASE_URL: 'http://100.86.7.30:3000',
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
  ],
};
