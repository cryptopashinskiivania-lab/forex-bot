/**
 * Тест мьютекса в SchedulerService: при повторном вызове runScheduledCheck
 * во время выполнения первый цикл ещё не завершён — второй вызов должен пропуститься
 * и в console.warn должно появиться сообщение о пропуске.
 */
import { SchedulerService } from '../src/services/SchedulerService';
import type { Bot } from 'grammy';
import { database } from '../src/db/database';

// Включаем задержку в SchedulerService, чтобы первый запуск "висел" 1.5 сек и второй успел увидеть isRunning === true
process.env.TEST_SCHEDULER_MUTEX_DELAY_MS = '1500';

// Чтобы первый запуск после задержки быстро завершился (без долгого fetchSharedCalendarToday)
const originalGetUsers = database.getUsers.bind(database);
database.getUsers = () => [];

const warnings: string[] = [];
const originalWarn = console.warn;

function captureWarn(...args: unknown[]): void {
  const msg = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  warnings.push(msg);
  originalWarn.apply(console, args);
}

async function run(): Promise<void> {
  console.log('\n🧪 SchedulerService mutex test\n');
  console.log('============================================================');

  const scheduler = new SchedulerService();
  const mockBot = {
    api: {
      sendMessage: async () => {},
    },
  } as unknown as Bot;

  type SchedulerWithRun = { runScheduledCheck(bot: Bot): Promise<void> };
  const runCheck = (scheduler as unknown as SchedulerWithRun).runScheduledCheck.bind(scheduler);

  // Первый вызов запускаем без await — он установит isRunning и уйдёт в задержку 1.5 сек
  const firstRunPromise = runCheck(mockBot);

  // Сразу второй вызов: должен увидеть isRunning === true и выйти с предупреждением
  console.warn = captureWarn;
  await runCheck(mockBot);
  console.warn = originalWarn;

  const skipMessage = '[Scheduler] Previous check still running, skipping...';
  const found = warnings.some((w) => w.includes('Previous check still running, skipping'));

  if (!found) {
    console.error('❌ Expected console.warn with:', skipMessage);
    console.error('   Captured warnings:', warnings);
    process.exit(1);
  }

  console.log('✅ Second call skipped and warned: "Previous check still running, skipping..."');

  // Дожидаемся завершения первого запуска, чтобы тест не висел
  await firstRunPromise;

  database.getUsers = originalGetUsers;

  console.log('============================================================');
  console.log('\n📊 Result: mutex protection works.\n');
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
