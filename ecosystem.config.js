module.exports = {
  apps: [
    {
      name: 'forex-bot',
      script: 'dist/bot.js',
      node_args: '--max-old-space-size=256',
      // Автоматический перезапуск при падении
      autorestart: true,
      // Максимум 10 перезапусков за 15 минут (защита от бесконечного цикла)
      max_restarts: 10,
      min_uptime: '10s',
      // Задержка между перезапусками (3 секунды)
      restart_delay: 3000,
      // Перезапуск если память превышает 300MB
      max_memory_restart: '300M',
      // Логи
      error_file: './logs/pm2-error.log',
      out_file: './logs/pm2-out.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      // Merge stdout и stderr в один лог
      merge_logs: true,
      // Переменные окружения
      env: {
        NODE_ENV: 'production',
      },
      // Корректное завершение: отправить SIGINT, ждать 5 секунд
      kill_timeout: 5000,
      listen_timeout: 10000,
      // Экспоненциальная задержка при частых перезапусках
      exp_backoff_restart_delay: 1000,
    },
  ],
};
