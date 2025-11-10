/**
 * PM2 生态配置文件
 * 用于管理 Sentra Agent 主进程
 */

module.exports = {
  apps: [
    {
      name: 'sentra-agent',
      script: './Main.js',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '1G',
      env: {
        NODE_ENV: 'production',
      },
      env_development: {
        NODE_ENV: 'development',
      },
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      merge_logs: true,
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 4000,
      kill_timeout: 5000,
      wait_ready: false,
      listen_timeout: 3000,
      instance_var: 'INSTANCE_ID',
      time: true,
      append_env_to_name: false,
    }
  ]
};
