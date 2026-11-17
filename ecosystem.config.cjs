// pm2 config for the bot. Start it from this folder with: npm run pm2:start
module.exports = {
  apps: [
    {
      name: 'shorts-bot',
      script: 'index.js',
      cwd: __dirname,
      exec_mode: 'fork',
      // One only: a second bot would requeue the first one's uploads when it starts.
      instances: 1,
      autorestart: true,
      watch: false,
      // Backs off instead of restart-looping if MongoDB is down at boot.
      exp_backoff_restart_delay: 1000,
      max_memory_restart: '1G',
      time: true,
      merge_logs: true,
      out_file: 'logs/bot.log',
      error_file: 'logs/bot.log',
    },
  ],
};
