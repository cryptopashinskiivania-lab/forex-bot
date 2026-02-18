/**
 * PM2 ecosystem config for forex-news-bot.
 * Scaling: heap 3GB, cautious restart limits (see SCALING_AND_OPTIMIZATION.md).
 * cwd = project root so bot.db and .env are always found regardless of where pm2 start was run.
 */
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'forex-bot',
      script: 'start-bot.js',
      cwd: path.resolve(__dirname),
      node_args: '--max-old-space-size=3072',
      instances: 1,
      exec_mode: 'fork',
      max_restarts: 20,
      min_uptime: '1m',
      restart_delay: 2000,
      env: {
        NODE_ENV: 'production',
      },
      env_development: {
        NODE_ENV: 'development',
      },
    },
  ],
};
