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
        PREDICTIONHUNT_API_KEY: 'pmx_U46EX9BAvyqxGoq9kinrYIqRt3KTWoWTrOU9B-I8VGQ',
        H2H_API_TOKEN: '8f070c00782b4e90f004fec034ae2b7ded34f00251bb242cc8034cc97bd5a7f9',
        NEXT_PUBLIC_H2H_API_TOKEN: '8f070c00782b4e90f004fec034ae2b7ded34f00251bb242cc8034cc97bd5a7f9',
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
        H2H_API_TOKEN: '8f070c00782b4e90f004fec034ae2b7ded34f00251bb242cc8034cc97bd5a7f9'
      },

      log_file: '/home/scott/.pm2/logs/h2h-poller.log',
      error_file: '/home/scott/.pm2/logs/h2h-poller-error.log',
      out_file: '/home/scott/.pm2/logs/h2h-poller-out.log',
      merge_logs: true,
      time: true,
      time_format: '[YYYY-MM-DD HH:mm:ss]',

      max_memory_restart: '256M'
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
  ]
};