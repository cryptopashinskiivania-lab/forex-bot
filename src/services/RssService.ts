import Parser from 'rss-parser';
import { database } from '../db/database';

export interface RssNewsItem {
  title: string;
  link: string;
  summary: string;
  source: string;
  pubDate?: Date;
}

export class RssService {
  private parser: Parser;
  private readonly feedUrl = 'https://www.fxstreet.com/rss/news';
  // Include all major currencies and assets keywords for broad coverage
  // Filtering per user is done in SchedulerService based on their monitored assets
  private readonly keywords = [
    'Breaking', 'Central Bank', 'Fed', 'ECB', 'BOE', 'BOJ', 'RBNZ',
    'USD', 'EUR', 'GBP', 'JPY', 'CAD', 'AUD', 'NZD', 'CHF',
    'Gold', 'XAU', 'GOLD',
    'Bitcoin', 'BTC', 'Cryptocurrency', 'Crypto',
    'Oil', 'Crude', 'WTI', 'Brent'
  ];
  private readonly timeWindowMinutes = 10;

  constructor() {
    this.parser = new Parser({
      customFields: {
        item: ['description', 'content:encoded', 'pubDate'],
      },
    });
  }

  /**
   * Get latest news from RSS feed filtered by time and keywords
   */
  async getLatestNews(): Promise<RssNewsItem[]> {
    try {
      console.log(`[RssService] Fetching RSS feed from ${this.feedUrl}`);
      const feed = await this.parser.parseURL(this.feedUrl);
      
      if (!feed.items || feed.items.length === 0) {
        console.log('[RssService] No items found in RSS feed');
        return [];
      }

      const now = new Date();
      const timeThreshold = new Date(now.getTime() - this.timeWindowMinutes * 60 * 1000);

      const filteredItems: RssNewsItem[] = [];

      for (const item of feed.items) {
        // Check if item is within time window
        let itemDate: Date | null = null;
        
        if (item.pubDate) {
          itemDate = new Date(item.pubDate);
        } else if (item.isoDate) {
          itemDate = new Date(item.isoDate);
        }

        if (!itemDate || itemDate < timeThreshold) {
          continue; // Skip items older than 10 minutes
        }

        // Combine title, description, and content for keyword matching
        const searchText = [
          item.title || '',
          item.contentSnippet || item.content || '',
          item.description || '',
        ]
          .join(' ')
          .toUpperCase();

        // Check if any keyword matches
        const hasKeyword = this.keywords.some((keyword) =>
          searchText.includes(keyword.toUpperCase())
        );

        if (!hasKeyword) {
          continue; // Skip items without relevant keywords
        }

        // Extract summary (prefer contentSnippet, fallback to description, then content)
        const summary =
          item.contentSnippet ||
          item.description ||
          (item.content ? this.extractTextFromHtml(item.content) : '') ||
          '';

        filteredItems.push({
          title: item.title || 'Untitled',
          link: item.link || '',
          summary: summary.substring(0, 500), // Limit summary length
          source: 'FXStreet',
          pubDate: itemDate,
        });
      }

      console.log(`[RssService] Found ${filteredItems.length} relevant news items from last ${this.timeWindowMinutes} minutes`);
      return filteredItems;
    } catch (error) {
      console.error('[RssService] Error fetching RSS feed:', error);
      return [];
    }
  }

  /**
   * Extract plain text from HTML content
   */
  private extractTextFromHtml(html: string): string {
    // Simple HTML tag removal (for basic cases)
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim();
  }
}
