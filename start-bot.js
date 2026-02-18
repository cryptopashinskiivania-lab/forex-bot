/**
 * PM2 entry: runs bot with same command as "npm run start" (heap + ts-node).
 */
require('child_process').spawn(
  process.execPath,
  ['--max-old-space-size=3072', '-r', 'ts-node/register', 'src/bot.ts'],
  { stdio: 'inherit', cwd: __dirname, windowsHide: true }
).on('exit', function (code) {
  process.exit(code);
});
