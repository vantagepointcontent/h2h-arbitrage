// H2H Arbitrage - PM2 Ecosystem Configuration
// OPS-2: auto-restart, log rotation, graceful shutdown, deploy hooks
module.exports = {
  apps: [
    {
      name: 'h2h-arbitrage',
      // OPS-008: wrapper script kills lingering process on port 3000 first
      script: './scripts/start-app.sh',
      interpreter: 'bash',
      cwd: '/home/scott/h2h-arbitrage',
      instances: 1,
      exec_mode: 'fork',

      // Restart policy
      restart_delay: 5000,
      max_restarts: Infinity,
      min_uptime: 30000,

      // Graceful shutdown - OPS-008: shorter timeout + SIGINT for faster port release
      kill_timeout: 10000,
      kill_signal: 'SIGINT',
      shutdown_listener: true,
      wait_ready: true,
      listen_timeout: 10000,

      // Environment
      env: {
        NODE_ENV: 'production',
        PORT: '3000',
        // Full scans execute in disposable child processes. Keep server worker
        // capacity aligned with poller concurrency so recurring scans are not
        // rejected in capacity bursts while still bounding CPU/memory.
        H2H_SCAN_CONCURRENCY: '3',
        H2H_SCAN_WORKER_TIMEOUT_MS: '21000',
        H2H_POLL_CONCURRENCY: '3',
        H2H_SCAN_TIMEOUT_MS: '21000',
        // Full per-outcome scan diagnostics overwhelm the event loop under the
        // poller's normal burst load. Enable only for short local investigations.
        DEBUG_H2H: '0',
        PREDICTIONHUNT_API_KEY: 'pmx_U46EX9BAvyqxGoq9kinrYIqRt3KTWoWTrOU9B-I8VGQ',
        H2H_API_TOKEN: process.env.H2H_API_TOKEN,
        NEXT_PUBLIC_H2H_API_TOKEN: process.env.NEXT_PUBLIC_H2H_API_TOKEN,
        TELEGRAM_MIN_ROI_PCT: '1.5',
        TELEGRAM_MIN_PROFIT_USD: '5',
        TELEGRAM_MIN_STAKE_USD: '50',
        TELEGRAM_MIN_PERSISTENCE_SEC: '60',
        TELEGRAM_COOLDOWN_MS: '300000',
        LOG_DIR: '/home/scott/.pm2/logs',
        LOG_LEVEL: 'info',
      },

      // Logging
      log_file: '/home/scott/.pm2/logs/h2h-arbitrage.log',
      error_file: '/home/scott/.pm2/logs/h2h-arbitrage-error.log',
      out_file: '/home/scott/.pm2/logs/h2h-arbitrage-out.log',
      merge_logs: true,
      time: true,
      time_format: '[YYYY-MM-DD HH:mm:ss]',

      max_memory_restart: '4G'
    },
    {
      name: 'h2h-poller',
      script: './scripts/poll.mjs',
      cwd: '/home/scott/h2h-arbitrage',
      instances: 1,
      exec_mode: 'fork',

      restart_delay: 5000,
      max_restarts: Infinity,
      min_uptime: 15000,

      kill_timeout: 15000,
      shutdown_listener: true,

      env: {
        NODE_ENV: 'production',
        H2H_BASE_URL: 'http://localhost:3000',
        // Every eligible saved market must receive a successful durable full
        // scan at least hourly. Adaptive tiers may run sooner, never later.
        H2H_SAVED_MARKET_FRESHNESS_SLA_MS: '3600000',
        H2H_POLL_CONCURRENCY: '3',
        // Parallel scans routinely take 8-20s under production load. Keep the
        // adaptive floor above sequential-run history so healthy workers can
        // finish publication before the poller aborts their requests.
        H2H_SCAN_MIN_TIMEOUT_MS: '18000',
        H2H_SCAN_TIMEOUT_MS: '21000',
        H2H_API_TOKEN: process.env.H2H_API_TOKEN
      },

      log_file: '/home/scott/.pm2/logs/h2h-poller.log',
      error_file: '/home/scott/.pm2/logs/h2h-poller-error.log',
      out_file: '/home/scott/.pm2/logs/h2h-poller-out.log',
      merge_logs: true,
      time: true,
      time_format: '[YYYY-MM-DD HH:mm:ss]',

      max_memory_restart: '256M',
      cron_restart: '0 4 * * *',
    },
    {
      name: 'h2h-watcher',
      script: './dist/ws-watcher.mjs',
      cwd: '/home/scott/h2h-arbitrage',
      instances: 1,
      exec_mode: 'fork',
      node_args: '--env-file=.env.local',

      restart_delay: 5000,
      max_restarts: Infinity,
      min_uptime: 15000,

      kill_timeout: 10000,
      shutdown_listener: true,

      env: {
        NODE_ENV: 'production',
        H2H_WATCHER_CAPITAL: '1000'
      },

      log_file: '/home/scott/.pm2/logs/h2h-watcher.log',
      error_file: '/home/scott/.pm2/logs/h2h-watcher-error.log',
      out_file: '/home/scott/.pm2/logs/h2h-watcher-out.log',
      merge_logs: true,
      time: true,
      time_format: '[YYYY-MM-DD HH:mm:ss]',

      max_memory_restart: '1G'
    },
    {
      name: 'h2h-valuer',
      script: './dist/position-valuer.mjs',
      cwd: '/home/scott/h2h-arbitrage',
      instances: 1,
      exec_mode: 'fork',
      // Full Kalshi order-book depth is authenticated; load the same local
      // credentials file as the watcher without duplicating secrets in PM2 config.
      node_args: '--env-file=.env.local',

      restart_delay: 5000,
      max_restarts: Infinity,
      min_uptime: 15000,

      kill_timeout: 15000,
      shutdown_listener: true,

      env: {
        NODE_ENV: 'production',
      },

      log_file: '/home/scott/.pm2/logs/h2h-valuer.log',
      error_file: '/home/scott/.pm2/logs/h2h-valuer-error.log',
      out_file: '/home/scott/.pm2/logs/h2h-valuer-out.log',
      merge_logs: true,
      time: true,
      time_format: '[YYYY-MM-DD HH:mm:ss]',

      max_memory_restart: '256M'
    },
    {
      name: 'h2h-ragnar',
      script: './.h2h-releases/active/.next/ragnar-consumer.mjs',
      cwd: '/home/scott/h2h-arbitrage',
      instances: 1,
      exec_mode: 'fork',
      restart_delay: 5000,
      max_restarts: Infinity,
      min_uptime: 15000,
      kill_timeout: 10000,
      shutdown_listener: true,
      env: {
        NODE_ENV: 'production',
        H2H_BASE_URL: 'http://localhost:3000',
        H2H_RAGNAR_INTERVAL_MS: '10000',
        H2H_RAGNAR_BATCH_SIZE: '25',
        H2H_RAGNAR_TIMEOUT_MS: '30000',
        H2H_API_TOKEN: process.env.H2H_API_TOKEN,
      },
      log_file: '/home/scott/.pm2/logs/h2h-ragnar.log',
      error_file: '/home/scott/.pm2/logs/h2h-ragnar-error.log',
      out_file: '/home/scott/.pm2/logs/h2h-ragnar-out.log',
      merge_logs: true,
      time: true,
      time_format: '[YYYY-MM-DD HH:mm:ss]',
      max_memory_restart: '256M',
    },
    {
      name: 'h2h-release-monitor',
      script: './scripts/release-manager.mjs',
      args: 'monitor --interval-ms 60000',
      cwd: '/home/scott/h2h-arbitrage',
      instances: 1,
      exec_mode: 'fork',
      restart_delay: 5000,
      min_uptime: 10000,
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'production',
      },
      log_file: '/home/scott/.pm2/logs/h2h-release-monitor.log',
      error_file: '/home/scott/.pm2/logs/h2h-release-monitor-error.log',
      out_file: '/home/scott/.pm2/logs/h2h-release-monitor-out.log',
      merge_logs: true,
      time: true,
      time_format: '[YYYY-MM-DD HH:mm:ss]',
      max_memory_restart: '128M'
    },
    {
      name: 'h2h-disk-monitor',
      script: './scripts/disk-capacity-monitor.mjs',
      cwd: '/home/scott/h2h-arbitrage',
      instances: 1,
      exec_mode: 'fork',
      restart_delay: 5000,
      min_uptime: 10000,
      kill_timeout: 5000,
      env: {
        NODE_ENV: 'production',
        H2H_DISK_RESERVE_BYTES: '15000000000',
        H2H_DISK_RESERVE_INODES: '100000',
      },
      log_file: '/home/scott/.pm2/logs/h2h-disk-monitor.log',
      error_file: '/home/scott/.pm2/logs/h2h-disk-monitor-error.log',
      out_file: '/home/scott/.pm2/logs/h2h-disk-monitor-out.log',
      merge_logs: true,
      time: true,
      time_format: '[YYYY-MM-DD HH:mm:ss]',
      max_memory_restart: '128M'
    },
    {
      name: 'h2h-storage-retention',
      script: './scripts/storage-retention.mjs',
      args: '--live --daemon',
      cwd: '/home/scott/h2h-arbitrage',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      cron_restart: '30 3 * * *',
      env: {
        NODE_ENV: 'production',
      },
      log_file: '/home/scott/.pm2/logs/h2h-storage-retention.log',
      error_file: '/home/scott/.pm2/logs/h2h-storage-retention-error.log',
      out_file: '/home/scott/.pm2/logs/h2h-storage-retention-out.log',
      merge_logs: true,
      time: true,
      time_format: '[YYYY-MM-DD HH:mm:ss]',
      max_memory_restart: '128M'
    },
  ]
};