import { Bot } from 'grammy';

// Message queue system to prevent overlapping messages
interface QueuedMessage {
  chatId: string | number;
  text: string;
  options?: { parse_mode?: 'Markdown' | 'HTML' };
}

const messageQueue: QueuedMessage[] = [];
let isProcessingQueue = false;
let botInstance: Bot | null = null;

const MAX_QUEUE_LENGTH = 2000;

/**
 * Initialize the message queue with a bot instance
 */
export function initializeQueue(bot: Bot): void {
  botInstance = bot;
  
  // Start processing queue every 2 seconds
  setInterval(processQueue, 2000);
  console.log('[Queue] Message queue processor started (interval: 2 seconds)');
}

/**
 * Add a message to the queue for later processing
 */
export function addToQueue(chatId: string | number, text: string, options?: { parse_mode?: 'Markdown' | 'HTML' }): void {
  if (!botInstance) {
    console.error('[Queue] Bot instance not initialized. Call initializeQueue first.');
    return;
  }

  if (messageQueue.length >= MAX_QUEUE_LENGTH) {
    console.warn(`[Queue] Queue full (max ${MAX_QUEUE_LENGTH}). Message to chat ${chatId} dropped.`);
    return;
  }

  messageQueue.push({ chatId, text, options });
  if (process.env.LOG_LEVEL === 'debug') {
    console.log(`[Queue] Message added. Queue length: ${messageQueue.length}`);
  }
}

/**
 * Process the message queue (runs every 2 seconds)
 */
async function processQueue(): Promise<void> {
  if (isProcessingQueue || messageQueue.length === 0 || !botInstance) {
    return;
  }

  isProcessingQueue = true;
  const message = messageQueue.shift();

  if (message) {
    try {
      await botInstance.api.sendMessage(message.chatId, message.text, message.options);
      console.log(`[Queue] Message sent to chat ${message.chatId}. Remaining in queue: ${messageQueue.length}`);
    } catch (error) {
      console.error(`[Queue] Error sending message to chat ${message.chatId}:`, error);
    }
  }

  isProcessingQueue = false;
}
