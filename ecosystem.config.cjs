/**
 * PM2 ecosystem config for AirCommit
 *
 * Usage:
 *   pm2 start ecosystem.config.cjs
 *   pm2 save
 *   pm2 startup  (follow the printed command for auto-start on reboot)
 */
const path = require('path');

module.exports = {
  apps: [
    {
      name: 'aircommit',
      script: path.resolve(__dirname, 'src', 'index.js'),
      instances: 'max',
      exec_mode: 'cluster',
      max_memory_restart: '512M',
      autorestart: true,
      watch: false,
      env_production: {
        NODE_ENV: 'production',
      },
      // Log rotation
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: path.resolve(__dirname, 'logs', 'err.log'),
      out_file: path.resolve(__dirname, 'logs', 'out.log'),
      merge_logs: true,
      max_restarts: 10,
      min_uptime: '10s',
      restart_delay: 5000,
    }
  ]
};
