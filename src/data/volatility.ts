/**
 * Volatility rules for forex news events
 * Each rule matches if ALL keywords are found in the news title
 */
export interface VolatilityRule {
  keywords: string[];
  pips: string;
  currency?: string; // Optional: if specified, only matches events for this currency
}

export const VOLATILITY_RULES: VolatilityRule[] = [
  // === USD ===
  { keywords: ["non-farm", "employment", "change"], pips: "65 pips", currency: "USD" }, // NFP
  { keywords: ["unemployment", "rate"], pips: "65 pips", currency: "USD" },
  { keywords: ["average", "hourly", "earnings"], pips: "65 pips", currency: "USD" },
  
  { keywords: ["cpi", "m/m"], pips: "40 pips", currency: "USD" }, // Covers Core CPI too usually
  { keywords: ["cpi", "y/y"], pips: "40 pips", currency: "USD" },
  
  { keywords: ["fomc", "statement"], pips: "34 pips", currency: "USD" },
  { keywords: ["federal", "funds", "rate"], pips: "34 pips", currency: "USD" },
  { keywords: ["fomc", "press", "conference"], pips: "34 pips", currency: "USD" },
  
  { keywords: ["ism", "services", "pmi"], pips: "22 pips", currency: "USD" },
  { keywords: ["jolts", "job", "openings"], pips: "22 pips", currency: "USD" },
  { keywords: ["retail", "sales"], pips: "22 pips", currency: "USD" }, // Covers Core Retail Sales
  
  { keywords: ["ppi", "m/m"], pips: "19 pips", currency: "USD" }, // Covers Core PPI
  
  { keywords: ["employment", "cost", "index"], pips: "18 pips", currency: "USD" },
  
  { keywords: ["pce", "price", "index"], pips: "16 pips", currency: "USD" }, // Core PCE
  { keywords: ["gdp", "q/q"], pips: "16 pips", currency: "USD" }, // Covers Prelim, Final, Advance
  
  { keywords: ["ism", "manufacturing", "pmi"], pips: "14 pips", currency: "USD" },
  { keywords: ["flash", "manufacturing"], pips: "14 pips", currency: "USD" }, // Flash Manuf & Services
  { keywords: ["flash", "services"], pips: "14 pips", currency: "USD" },
  
  { keywords: ["consumer", "confidence"], pips: "9 pips", currency: "USD" }, // CB Consumer Confidence
  { keywords: ["uom", "consumer", "sentiment"], pips: "13 pips", currency: "USD" }, // Prelim/Revised UoM
  { keywords: ["uom", "inflation"], pips: "13 pips", currency: "USD" },
  
  { keywords: ["unemployment", "claims"], pips: "12 pips", currency: "USD" },
  { keywords: ["adp", "non-farm"], pips: "12 pips", currency: "USD" },
  
  { keywords: ["powell", "speaks"], pips: "10 pips", currency: "USD" },
  { keywords: ["powell", "testifies"], pips: "8 pips", currency: "USD" },
  
  { keywords: ["pending", "home", "sales"], pips: "8 pips", currency: "USD" },
  { keywords: ["fomc", "minutes"], pips: "5 pips", currency: "USD" },

  // === EUR ===
  { keywords: ["main", "refinancing", "rate"], pips: "37 pips", currency: "EUR" },
  { keywords: ["monetary", "policy", "statement"], pips: "37 pips", currency: "EUR" },
  { keywords: ["ecb", "press", "conference"], pips: "37 pips", currency: "EUR" },
  
  { keywords: ["flash", "manufacturing"], pips: "18 pips", currency: "EUR" }, // German/French Flash
  { keywords: ["flash", "services"], pips: "18 pips", currency: "EUR" },

  // === GBP ===
  { keywords: ["gdp", "m/m"], pips: "20 pips", currency: "GBP" },
  { keywords: ["retail", "sales"], pips: "22 pips", currency: "GBP" },
  { keywords: ["bailey", "speaks"], pips: "6 pips", currency: "GBP" },
  { keywords: ["flash", "manufacturing"], pips: "22 pips", currency: "GBP" }, // Estimating based on retail sales volatility
  { keywords: ["flash", "services"], pips: "22 pips", currency: "GBP" },
];

/**
 * Find volatility for a news title (WHITELIST approach)
 * 
 * This function uses a whitelist approach: VOLATILITY_RULES is an exhaustive list.
 * - If a match is found: returns the volatility string (e.g., "14 pips")
 * - If NO match is found: returns strictly null (no fallback values)
 * 
 * @param title News title (case-insensitive search)
 * @param currency Currency code (e.g., "USD", "EUR", "GBP") - optional but recommended for better matching
 * @returns Volatility string if found, null otherwise (strictly null if not in whitelist)
 */
export function getVolatility(title: string, currency?: string): string | null {
  const titleLower = title.toLowerCase().trim();
  
  // Sort rules by number of keywords (more specific first) to match longer patterns first
  const sortedRules = [...VOLATILITY_RULES].sort((a, b) => b.keywords.length - a.keywords.length);
  
  for (const rule of sortedRules) {
    // Check currency match (if currency is specified in rule and provided)
    if (rule.currency && currency && rule.currency !== currency) {
      continue;
    }
    
    // Check if ALL keywords are present in the title
    const allKeywordsMatch = rule.keywords.every(keyword => 
      titleLower.includes(keyword.toLowerCase())
    );
    
    if (allKeywordsMatch) {
      return rule.pips;
    }
  }
  
  // Whitelist approach: return null if no match found (no fallback values)
  return null;
}
