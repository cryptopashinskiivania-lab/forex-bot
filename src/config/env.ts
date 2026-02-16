import dotenv from 'dotenv';
import path from 'path';

// Load .env from project root so it works regardless of process.cwd() (PM2/backup-safe)
const projectRoot = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(projectRoot, '.env') });

interface EnvConfig {
  BOT_TOKEN: string;
  GROQ_API_KEY: string;
  ADMIN_CHAT_ID?: string;
}

function getEnvVar(key: keyof EnvConfig): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const env: EnvConfig = {
  BOT_TOKEN: getEnvVar('BOT_TOKEN'),
  GROQ_API_KEY: getEnvVar('GROQ_API_KEY'),
  ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID,
};
