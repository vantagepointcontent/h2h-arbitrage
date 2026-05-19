module.exports = {
  apps: [
    {
      name: 'h2h-arbitrage',
      script: 'node_modules/.bin/next',
      args: 'start',
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
  ],
};
