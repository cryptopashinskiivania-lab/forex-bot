import Groq from 'groq-sdk';
import { env } from '../config/env';

export interface AnalysisResult {
  score: number;
  sentiment: 'Pos' | 'Neg' | 'Neutral';
  summary: string;
  reasoning: string;
  affected_pairs: string[];
}

export class AnalysisService {
  private groq: Groq;
  // Cache for AI analysis results (10 minutes TTL)
  private cache = new Map<string, { result: any, expires: number }>();
  private readonly CACHE_TTL = 10 * 60 * 1000; // 10 minutes in milliseconds

  constructor() {
    this.groq = new Groq({ apiKey: env.GROQ_API_KEY });
    console.log('Initializing AnalysisService with Groq (llama-3.3-70b-versatile)');
  }

  private getCacheKey(method: string, text: string, source?: string): string {
    // Create a simple hash of the input to use as cache key
    const input = `${method}:${text}:${source || ''}`;
    // Simple hash function
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
      const char = input.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(36);
  }

  async analyzeNews(text: string, source?: string): Promise<AnalysisResult> {
    // Check cache first
    const cacheKey = this.getCacheKey('analyzeNews', text, source);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      console.log(`[AnalysisService] Using cached analysis (expires in ${Math.round((cached.expires - Date.now()) / 1000)}s)`);
      return cached.result;
    }

    const sourceNote = source && source !== 'ForexFactory' 
      ? `\nВАЖНО: Источник новости - "${source}". Если это слухи, геополитика или другие неофициальные источники, обрати особое внимание на волатильность настроений и потенциальное влияние на рынок.`
      : '';
    
    const systemPrompt = `ROLE: Ты старший количественный аналитик Форекс с 15-летним опытом в макро-трейдинге.

CONTEXT: Пользователь - профессиональный трейдер. Ему нужен строго фактический, математически обоснованный анализ новостных событий.

TASK: Проанализируй предоставленную финансовую новость/данные.

METHODOLOGY (Chain-of-Thought):
1. DECONSTRUCT: Определи ключевое событие, фактические числа vs прогноз.
2. DIAGNOSE: Сравни с историческими нормами волатильности. Это отклонение?
3. DEVELOP: Сформулируй причинно-следственную связь (например, "Более высокий CPI → вероятность повышения ставки ФРС растет → сила USD").
4. DELIVER: Выведи вердикт в формате JSON/Text.

CONSTRAINTS:
- Никаких абстрактных фраз ("Рынок интересен"). Используй конкретные термины ("Ожидается волатильность > 50 пунктов").
- Если источник НЕ ForexFactory, рассматривай как "Слухи/Неподтверждено" до подтверждения.
- Язык: Русский.

КРИТИЧЕСКИЕ ТРЕБОВАНИЯ - СТРОГИЙ JSON ВЫВОД:
1. Ты ДОЛЖЕН вывести ТОЛЬКО валидный JSON. Без markdown, без блоков кода, без \`\`\`json тегов, без объяснений, без текста до или после JSON.
2. Твой ответ должен начинаться с { и заканчиваться }. Ничего больше.
3. Score: 0-10 (0 = нерелевантно для форекс, 10 = огромное влияние на валютные рынки)
4. Фокус на влияние на эти пары: GBPUSD, EURUSD, NZDUSD, USDJPY
5. Summary: Максимум 25 слов, на русском языке - краткое описание ЧТО произошло
6. Reasoning: Максимум 30 слов, на русском языке - объяснение ПОЧЕМУ это важно и теоретическое влияние (например, "Инфляция выше прогноза → рост ставки → позитив для USD")
7. Sentiment: Один из "Pos", "Neg", или "Neutral"
8. Если в новости указаны числа (Actual vs Forecast), объясни отклонение в reasoning${sourceNote}

OUTPUT FORMAT (только JSON, без другого текста):
{
  "score": <число 0-10>,
  "sentiment": "Pos" | "Neg" | "Neutral",
  "summary": "<максимум 25 слов на русском - ЧТО произошло>",
  "reasoning": "<максимум 30 слов на русском - ПОЧЕМУ это важно и влияние>",
  "affected_pairs": ["GBPUSD", "EURUSD", ...]
}

Текст новости для анализа:
${text}`;

    try {
      const completion = await this.groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: 'Ты профессиональный аналитик рынка Форекс. Всегда отвечай только валидным JSON, без markdown, без объяснений.'
          },
          {
            role: 'user',
            content: systemPrompt
          }
        ],
        temperature: 0.3,
        max_tokens: 600
      });

      // Extract text from Groq API response
      const responseText = completion.choices[0]?.message?.content;
      
      if (!responseText) {
        console.error('API Response structure:', JSON.stringify(completion, null, 2));
        throw new Error('No text in API response');
      }

      // Clean the response - remove markdown code blocks if present
      const cleanText = responseText.replace(/```json|```/g, '').trim();
      
      // Parse JSON
      const analysis: AnalysisResult = JSON.parse(cleanText);
      
      // Validate the result
      if (typeof analysis.score !== 'number' || analysis.score < 0 || analysis.score > 10) {
        throw new Error('Invalid score in analysis result');
      }
      
      if (!['Pos', 'Neg', 'Neutral'].includes(analysis.sentiment)) {
        throw new Error('Invalid sentiment in analysis result');
      }
      
      if (typeof analysis.reasoning !== 'string' || !analysis.reasoning.trim()) {
        throw new Error('Missing or invalid reasoning in analysis result');
      }
      
      if (!Array.isArray(analysis.affected_pairs)) {
        throw new Error('Invalid affected_pairs in analysis result');
      }
      
      // Store in cache
      this.cache.set(cacheKey, {
        result: analysis,
        expires: Date.now() + this.CACHE_TTL
      });
      
      return analysis;
    } catch (error) {
      console.error('=== Groq API Error ===');
      console.error('Error:', error);
      if (error instanceof Error) {
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
      }
      console.error('========================');
      throw new Error(`Failed to analyze news: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async analyzeDailySchedule(eventsText: string): Promise<string> {
    // Check cache first
    const cacheKey = this.getCacheKey('analyzeDailySchedule', eventsText);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      console.log(`[AnalysisService] Using cached daily schedule analysis (expires in ${Math.round((cached.expires - Date.now()) / 1000)}s)`);
      return cached.result;
    }

    const systemPrompt = `ROLE: Ты старший количественный аналитик Форекс с 15-летним опытом в макро-трейдинге.

CONTEXT: Пользователь - профессиональный трейдер. Ему нужен строго фактический, математически обоснованный анализ событий календаря.

TASK: Проанализируй список событий на сегодня и предоставь детальный анализ.

METHODOLOGY (Chain-of-Thought):
1. DECONSTRUCT: Определи ключевые события, фактические числа vs прогнозы для каждого.
2. DIAGNOSE: Сравни прогнозы с историческими нормами. Какие отклонения ожидаются?
3. DEVELOP: Сформулируй причинно-следственные связи для каждого события (например, "ВВП > 2.5% → подтверждение роста экономики → вероятность повышения ставки → сила USD").
4. DELIVER: Выведи структурированный анализ.

CONSTRAINTS:
- Никаких абстрактных фраз ("Рынок волатилен"). Используй конкретные термины ("Ожидается волатильность > 50 пунктов для GBPUSD").
- Язык: Русский.

ФОРМАТ ВЫВОДА:
📊 ═══════════════════════════════
     ДЕТАЛЬНЫЙ АНАЛИЗ ДНЯ
═══════════════════════════════

💭 Общее настроение:
▸ [Одно предложение о том, чего ожидает рынок сегодня]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📌 СОБЫТИЯ:

🔴 HIGH IMPACT
├─ 🕒 [Время] | 🇺🇸/🇪🇺/🇬🇧/🇯🇵/🇳🇿 [Валюта]
├─ 📋 [Название события]
├─ 📊 Прогноз: [значение] | Предыдущее: [значение]
└─ 💡 АНАЛИЗ:
   ▸ [Ожидаемое направление и логика]
   ▸ [Влияние на валютные пары конкретно]
   ▸ [Ожидаемая волатильность в pips если возможно оценить]

[Повторить для каждого High события]

🟠 MEDIUM IMPACT
├─ 🕒 [Время] | [Флаг] [Валюта]
├─ 📋 [Название события]
├─ 📊 Прогноз: [значение] | Предыдущее: [значение]
└─ 💡 АНАЛИЗ:
   ▸ [Краткая оценка влияния]

[Повторить для каждого Medium события]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

🎯 КЛЮЧЕВОЙ ФОКУС:
▸ [Пара]: [Причина, почему эта пара наиболее важна]
▸ Риски: [Основные риски дня]
▸ Возможности: [Торговые возможности]

ВАЖНО:
- Используй финансовую логику: объясняй связи между данными и движением валют
- Если есть прогнозы (Forecast) и предыдущие значения (Previous), используй их для анализа
- Фокусируйся на парах: GBPUSD, EURUSD, NZDUSD, USDJPY
- Используй точные флаги стран: 🇺🇸 для USD, 🇪🇺 для EUR, 🇬🇧 для GBP, 🇯🇵 для JPY, 🇳🇿 для NZD

События дня:
${eventsText}

Выведи анализ СТРОГО в указанном формате выше.`;

    try {
      const completion = await this.groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: 'Ты старший трейдер Форекс. Анализируй события детально, используя финансовую логику. Отвечай на русском языке в формате Markdown.'
          },
          {
            role: 'user',
            content: systemPrompt
          }
        ],
        temperature: 0.4,
        max_tokens: 1500
      });

      const responseText = completion.choices[0]?.message?.content;
      
      if (!responseText) {
        throw new Error('No text in API response');
      }

      // Clean the response
      const cleanText = responseText.trim();
      
      // Store in cache
      this.cache.set(cacheKey, {
        result: cleanText,
        expires: Date.now() + this.CACHE_TTL
      });
      
      return cleanText;
    } catch (error) {
      console.error('=== Groq API Error (analyzeDailySchedule) ===');
      console.error('Error:', error);
      throw new Error(`Failed to analyze daily schedule: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async answerQuestion(question: string, context?: string): Promise<string> {
    // Check cache first
    const cacheKey = this.getCacheKey('answerQuestion', question, context);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      console.log(`[AnalysisService] Using cached question answer (expires in ${Math.round((cached.expires - Date.now()) / 1000)}s)`);
      return cached.result;
    }

    const contextNote = context 
      ? `\n\nТЕКУЩИЙ КОНТЕКСТ РЫНКА:\n${context}`
      : '';
    
    const systemPrompt = `ROLE: Ты ментор по Форекс с глубокими знаниями рынка и практическим опытом.

CONTEXT: Пользователь задает вопрос о торговле на Форекс.${contextNote}

TASK: Ответь на вопрос пользователя на основе текущего контекста рынка (если доступен) или общей теории торговли.

CONSTRAINTS:
- Будь кратким, профессиональным и практичным
- Используй конкретные примеры, когда это возможно
- Если вопрос связан с текущими событиями и есть контекст, используй его
- Язык: Русский

Вопрос пользователя:
${question}`;

    try {
      const completion = await this.groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: 'Ты ментор по Форекс. Отвечай на вопросы кратко, профессионально и практично. Используй русский язык.'
          },
          {
            role: 'user',
            content: systemPrompt
          }
        ],
        temperature: 0.5,
        max_tokens: 800
      });

      const responseText = completion.choices[0]?.message?.content;
      
      if (!responseText) {
        throw new Error('No text in API response');
      }

      // Clean the response
      const cleanText = responseText.trim();
      
      // Store in cache
      this.cache.set(cacheKey, {
        result: cleanText,
        expires: Date.now() + this.CACHE_TTL
      });
      
      return cleanText;
    } catch (error) {
      console.error('=== Groq API Error (answerQuestion) ===');
      console.error('Error:', error);
      throw new Error(`Failed to answer question: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  async analyzeResults(eventsText: string): Promise<string> {
    // Check cache first
    const cacheKey = this.getCacheKey('analyzeResults', eventsText);
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      console.log(`[AnalysisService] Using cached results analysis (expires in ${Math.round((cached.expires - Date.now()) / 1000)}s)`);
      return cached.result;
    }

    const systemPrompt = `ROLE: Ты старший количественный аналитик Форекс с 15-летним опытом в макро-трейдинге.

CONTEXT: Пользователь - профессиональный трейдер. Ему нужен строго фактический анализ результатов экономических событий.

TASK: Проанализируй результаты экономических новостей за сегодня.

METHODOLOGY (Chain-of-Thought):
1. DECONSTRUCT: Определи ключевые события, которые уже вышли (есть фактические данные).
2. DIAGNOSE: Сравни фактические данные с прогнозами. Какие отклонения произошли?
3. DEVELOP: Сформулируй причинно-следственные связи для каждого события (например, "CPI вышел 3.5% vs прогноз 3.2% → инфляция выше ожиданий → давление на ФРС повысить ставку → бычий сигнал для USD").
4. DELIVER: Выведи структурированный анализ.

CONSTRAINTS:
- Никаких абстрактных фраз ("Рынок волатилен"). Используй конкретные термины ("Отклонение от прогноза на +0.3% создало волатильность 60 пунктов для EURUSD").
- Язык: Русский.

ФОРМАТ ВЫВОДА:
📊 ═══════════════════════════════
           ИТОГИ ДНЯ
═══════════════════════════════

📋 Общий вывод:
▸ [1-2 предложения о том, как результаты повлияли на рынок]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📊 РЕЗУЛЬТАТЫ:

🔴 [Время] | 🇺🇸/🇪🇺/🇬🇧/🇯🇵/🇳🇿 [Валюта]
├─ 📋 [Название события]
├─ 📈 Факт:    [значение]
├─ 📊 Прогноз: [значение]
├─ 📉 Пред:    [значение]
├─ ━━━━━━━━━━━━━━━━━━━━━━━━
├─ 🎯 Отклонение: [+/-X%] (🟢сильные/🟡нейтральные/🔴слабые данные)
└─ 💡 АНАЛИЗ:
   ▸ [Объяснение отклонения]
   ▸ [Влияние на валюту]
   ▸ [Влияние на конкретные пары: EURUSD/GBPUSD/USDJPY]
   ▸ [Фактическая наблюдаемая волатильность если известна]

[Повторить для каждого события с результатами]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

⚡ КЛЮЧЕВЫЕ СЮРПРИЗЫ:
▸ [Событие 1]: Отклонение [X%] → [влияние на пары]
▸ [Событие 2]: Отклонение [X%] → [влияние на пары]

🎯 ИТОГОВОЕ ВЛИЯНИЕ НА ПАРЫ:
▸ EURUSD: [направление и причина]
▸ GBPUSD: [направление и причина]
▸ USDJPY: [направление и причина]

ВАЖНО:
- Используй финансовую логику: объясняй связи между данными и движением валют
- Фокусируйся на ОТКЛОНЕНИЯХ от прогноза
- Фокусируйся на парах: GBPUSD, EURUSD, NZDUSD, USDJPY
- Используй точные флаги стран: 🇺🇸 для USD, 🇪🇺 для EUR, 🇬🇧 для GBP, 🇯🇵 для JPY, 🇳🇿 для NZD
- Используй цветовые индикаторы: 🟢 для сильных данных выше прогноза, 🔴 для слабых данных ниже прогноза, 🟡 для нейтральных

События с результатами:
${eventsText}

Выведи анализ СТРОГО в указанном формате выше.`;

    try {
      const completion = await this.groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: 'Ты старший трейдер Форекс. Анализируй результаты событий детально, фокусируясь на отклонениях от прогнозов. Отвечай на русском языке в формате Markdown.'
          },
          {
            role: 'user',
            content: systemPrompt
          }
        ],
        temperature: 0.4,
        max_tokens: 1500
      });

      const responseText = completion.choices[0]?.message?.content;
      
      if (!responseText) {
        throw new Error('No text in API response');
      }

      // Clean the response
      const cleanText = responseText.trim();
      
      // Store in cache
      this.cache.set(cacheKey, {
        result: cleanText,
        expires: Date.now() + this.CACHE_TTL
      });
      
      return cleanText;
    } catch (error) {
      console.error('=== Groq API Error (analyzeResults) ===');
      console.error('Error:', error);
      throw new Error(`Failed to analyze results: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
