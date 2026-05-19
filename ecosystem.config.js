module.exports = {
  apps: [
    {
      name: 'h2h-arbitrage',
      script: './node_modules/next/dist/bin/next',
      args: 'start -p 3000 -H 0.0.0.0',
      cwd: '/home/scott/h2h-arbitrage',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
      },
      log_file: '/home/scott/.pm2/logs/h2h-arbitrage.log',
      error_file: '/home/scott/.pm2/logs/h2h-arbitrage-error.log',
      out_file: '/home/scott/.pm2/logs/h2h-arbitrage-out.log',
      merge_logs: true,
      time: true,
    },
    {
      name: 'h2h-poller',
      script: './scripts/poll.mjs',
      cwd: '/home/scott/h2h-arbitrage',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        H2H_BASE_URL: 'http://100.86.7.30:3000',
      },
      log_file: '/home/scott/.pm2/logs/h2h-poller.log',
      error_file: '/home/scott/.pm2/logs/h2h-poller-error.log',
      out_file: '/home/scott/.pm2/logs/h2h-poller-out.log',
      merge_logs: true,
      time: true,
    },
  ],
};
