/**
 * Force update Telegram bot menu commands
 * Run: npx ts-node scripts/update_menu.ts
 */
import 'dotenv/config';
import { Bot } from 'grammy';

async function main() {
  const botToken = process.env.BOT_TOKEN;
  
  if (!botToken) {
    console.error('❌ Error: BOT_TOKEN environment variable is not set');
    console.error('Please make sure you have a .env file with BOT_TOKEN defined');
    process.exit(1);
  }

  const bot = new Bot(botToken);

  try {
    console.log('🔄 Updating Telegram bot menu commands...');
    
    await bot.api.setMyCommands([
      { command: 'start', description: '🚀 Запуск' },
      { command: 'daily', description: '📊 Сводка за сегодня' },
      { command: 'tomorrow', description: '📅 Календарь на завтра' },
      { command: 'settings', description: '⚙️ Настройки активов' },
      { command: 'ask', description: '❓ Вопрос эксперту' },
      { command: 'id', description: '🆔 Мой ID' },
      { command: 'help', description: 'ℹ️ Помощь' },
    ]);

    console.log('✅ Menu updated successfully!');
    console.log('The new menu should appear in Telegram after a few seconds.');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error updating menu:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

main();
