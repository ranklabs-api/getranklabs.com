// Scope of the Rank Labs Visibility Report. This file is the single source of
// truth for it: /pricing, /services, /faq and the JSON-LD all read from here.
//
// Everything in this file must be something the platform ACTUALLY does.
// Get Found in AI (on-page) comes from scoreEngines() in agents/report/index.js
// (weighted on-page checklist). Live AI-answer checks, when present in a report,
// are labeled separately from the on-page score.
// Single source of truth for the $499/mo Rank Labs Visibility Report scope.
export const REPORT_NAME = 'Rank Labs Visibility Report';
export const REPORT_SLUG = 'rank-labs-visibility-report';

// Concise card bullets (summary of the full scope below).
export const reportCardBullets = [
  'Weekly SEO audit report email (100+ checks), with a prioritized fix list',
  'Monthly email report (first week of each month): your Google search, Business Profile, traffic, leads & Get Found in AI score vs. last month',
  'Google organic + Maps (local pack) rankings for 25 keywords',
  'Ranking keywords & backlink summary',
  'Full technical crawl + Core Web Vitals, schema, sitemap/robots, SSL & email-domain (DNS) checks',
  'Get Found in AI on-page score, with sub-scores for ChatGPT, Gemini, Claude & Perplexity (schema, direct-answer structure, AI-crawler access & freshness).',
  'Business-detail conflict checks across 10 listing sites (name, address, phone) + reviews on Google and one other site',
  '3-competitor comparison',
  'Optional with your access: GA4, Search Console & Google Business Profile stats',
];

// Full scope, grouped (used on /pricing and /services).
export const reportFeatureGroups = [
  {
    title: 'Reports',
    items: [
      'Weekly SEO audit report email (100+ checks) with a prioritized fix list',
      'Monthly email report (first week of each month) comparing your results vs. last month',
    ],
  },
  {
    title: 'SEO',
    items: [
      'Google organic and Maps (local pack) rankings for 25 keywords',
      'Ranking keywords (keywords you rank for)',
      'Backlink summary',
    ],
  },
  {
    title: 'Get Found in AI (on-page)',
    items: [
      'Get Found in AI on-page score, with a sub-score per assistant (ChatGPT, Gemini, Claude, Perplexity) from the same on-page checks',
      'AI-crawler access checks: GPTBot, ClaudeBot, PerplexityBot and Google-Extended',
      'Direct-answer content structure and schema coverage',
    ],
  },
  {
    title: 'Technical',
    items: [
      'Full technical crawl',
      'Core Web Vitals',
      'Schema checks',
      'Sitemap / robots checks',
      'SSL and email-domain (DNS) setup checks',
    ],
  },
  {
    title: 'Listings & reviews',
    items: [
      'Business-detail conflict checks on Google, Bing, Apple Maps, Facebook, Yelp, BBB, Yellow Pages, Foursquare, MapQuest, and Angi or one industry directory',
      'Reviews on Google plus one other site',
    ],
  },
  {
    title: 'Competitors',
    items: ['3-competitor comparison'],
  },
  {
    title: 'Optional (with your access)',
    items: ['GA4', 'Google Search Console', 'Google Business Profile stats'],
  },
];

// Locked score explanation. Use verbatim wherever the Get Found in AI score is
// explained; never paraphrase it.
export const aiReadinessHonestyLine =
  'Get Found in AI (on-page) scores how well your pages are structured for AI assistants to read.';

// Plain-text summary for meta / JSON-LD / FAQ.
export const reportSummaryText =
  'Report-only, month-to-month report covering SEO + Get Found in AI (on-page): Google organic and Maps (local pack) rankings for 25 keywords, ranking keywords, backlink summary, full technical crawl, Core Web Vitals, schema, sitemap/robots, SSL and email-domain (DNS) setup checks, a Get Found in AI on-page score with sub-scores for ChatGPT, Gemini, Claude and Perplexity covering schema, direct-answer structure and AI-crawler access (on-page signals), business-detail conflict checks on Google, Bing, Apple Maps, Facebook, Yelp, BBB, Yellow Pages, Foursquare, MapQuest, and Angi or one industry directory, reviews on Google plus one other site, and a 3-competitor comparison. Optional with client access: GA4, Google Search Console, and Google Business Profile stats. Delivered as a weekly SEO audit report email plus a separate monthly email report (first week of each month).';
