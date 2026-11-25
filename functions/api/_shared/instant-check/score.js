// Vendored from ranklabs-app@195f6e9 (agents/report/index.js scoreEngines,
// robotsAllowsBot, scoreFaqSignal, scoreEntitySignal, pageHasQaStructure,
// buildGEOScores site-wide projection; agents/lib/agent-readiness.js
// extractEntity and its helpers; agents/lib/schema-business-types.js).
// Do not edit logic here; re-vendor from a pinned SHA and regenerate the
// golden fixtures (tests/instant-check/fixtures/generate-golden.cjs).
//
// ESM port. Helper functions are copied verbatim. scoreEngines() and the
// buildGEOScores() projection (scoreSite below) are ported for the one case
// the instant check has — crawled pages and nothing else: the branches that
// read backlink, Business Profile, review, NAP-citation and outreach context
// are omitted, and each of those items is emitted exactly as the source emits
// it when that context is absent (needs_verification). freshContent is null,
// as buildGEOScores passes when the blog step did not run, so the fresh
// content item is needs_verification too. Golden parity with the source is
// asserted by tests/instant-check/score-golden.test.mjs.
//
// onPageFindings() at the bottom is NOT vendored: it is the instant check's
// own short, plain-English list built from the same signals.

// ── agents/lib/page-eligibility.js ──────────────────────────────────────────
const NON_HTML_EXTENSIONS = /\.(?:pdf|docx?|xlsx?|pptx?|zip|rar|7z|csv|xml|json|txt|jpe?g|png|gif|webp|svg|ico|mp3|wav|mp4|mov|avi|webm)(?:$|[?#])/i;

function isHtmlPage(page = {}) {
  if (page.is_html === false || page.resource_type === 'resource') return false;
  const contentType = String(page.content_type || page.mime_type || page.headers?.['content-type'] || '').toLowerCase();
  if (contentType && !contentType.includes('text/html') && !contentType.includes('application/xhtml+xml')) return false;
  const url = String(page.url || page.href || '');
  if (NON_HTML_EXTENSIONS.test(url)) return false;
  if (/download is starting/i.test(String(page.error || ''))) return false;
  return true;
}

function isIndexableHtmlPage(page = {}) {
  return isHtmlPage(page) && !(page.noindex || page.metrics?.noindex);
}


// ── agents/lib/schema-business-types.js ─────────────────────────────────────
// schema.org 30.1 (2026-09-16), extracted 2026-11-24 from
// https://schema.org/version/latest/schemaorg-current-https.jsonld via rdfs:subClassOf.
// These lists serve the prospect-report identity gap. Paying-client scoring
// keeps its existing extractEntity / SPECIFIC_BUSINESS_TYPES path unchanged.
// Organization alone is an identity, but merits a softer LocalBusiness suggestion.
const LOCAL_BUSINESS_TYPES = Object.freeze(`LocalBusiness AccountingService AdultEntertainment AmusementPark AnimalShelter ArchiveOrganization ArtGallery Attorney Audiology AutoBodyShop AutoDealer AutoPartsStore AutoRental AutoRepair AutoWash AutomatedTeller AutomotiveBusiness Bakery BankOrCreditUnion BarOrPub BeautySalon BedAndBreakfast BikeStore BookStore BowlingAlley Brewery CafeOrCoffeeShop Campground Casino ChildCare ClothingStore ComedyClub CommunityHealth ComputerStore ConvenienceStore CovidTestingFacility DaySpa Dentist DepartmentStore Dermatology DietNutrition Distillery DryCleaningOrLaundry Electrician ElectronicsStore Emergency EmergencyService EmploymentAgency EntertainmentBusiness ExerciseGym FastFoodRestaurant FinancialService FireStation Florist FoodEstablishment FurnitureStore GardenStore GasStation GeneralContractor Geriatric GolfCourse GovernmentOffice GroceryStore Gynecologic HVACBusiness HairSalon HardwareStore HealthAndBeautyBusiness HealthClub HobbyShop HomeAndConstructionBusiness HomeGoodsStore Hospital Hostel Hotel HousePainter IceCreamShop IndividualPhysician InsuranceAgency InternetCafe JewelryStore LegalService Library LiquorStore Locksmith LodgingBusiness MedicalBusiness MedicalClinic MensClothingStore Midwifery MobilePhoneStore Motel MotorcycleDealer MotorcycleRepair MovieRentalStore MovieTheater MovingCompany MusicStore NailSalon NightClub Notary Nursing Obstetric OfficeEquipmentStore Oncologic Ophthalmology Optician Optometric Otolaryngologic OutletStore PawnShop Pediatric PetStore Pharmacy Physician PhysiciansOffice Physiotherapy PlasticSurgery Plumber Podiatric PoliceStation PostOffice PrimaryCare ProfessionalService Psychiatric PublicHealth PublicSwimmingPool RadioStation RealEstateAgent RecyclingCenter Resort Restaurant RoofingContractor SelfStorage ShoeStore ShoppingCenter SkiResort SportingGoodsStore SportsActivityLocation SportsClub StadiumOrArena Store TattooParlor TelevisionStation TennisComplex TireShop TouristInformationCenter ToyStore TravelAgency VacationRental WholesaleStore Winery`.split(' '));
const ORGANIZATION_ONLY_TYPES = Object.freeze(`Organization Airline CollegeOrUniversity Consortium Cooperative Corporation DanceGroup DiagnosticLab EducationalOrganization ElementarySchool FundingAgency FundingScheme GovernmentOrganization HighSchool LibrarySystem MedicalOrganization MiddleSchool MusicGroup NGO NewsMediaOrganization OnlineBusiness OnlineMarketplace OnlineStore PerformingGroup PoliticalParty Preschool Project ResearchOrganization ResearchProject School SearchRescueOrganization SportsOrganization SportsTeam TheaterGroup VeterinaryCare WorkersUnion`.split(' '));
const localTypes = new Set(LOCAL_BUSINESS_TYPES);
const organizationTypes = new Set(ORGANIZATION_ONLY_TYPES);

function normalizeType(type) {
  return type.replace(/^https?:\/\/schema\.org\//, '').replace(/^schema:/, '');
}

function collectTypes(nodes) {
  const types = new Set();
  const seen = new Set();
  function walk(value) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    const declared = Array.isArray(value['@type']) ? value['@type'] : [value['@type']];
    for (const type of declared) if (typeof type === 'string') types.add(normalizeType(type));
    Object.values(value).forEach(walk);
  }
  walk(nodes);
  return [...types];
}

function classifyTypes(types) {
  const normalized = types.filter((type) => typeof type === 'string').map(normalizeType);
  const local = normalized.some((type) => localTypes.has(type));
  const organizationType = normalized.find((type) => organizationTypes.has(type)) || null;
  return { hasLocalBusiness: local, hasOrganizationOnly: !local && !!organizationType, organizationType };
}

function classifyNodes(nodes) {
  return classifyTypes(collectTypes(nodes));
}

function classifyPages(pages) {
  const types = pages.flatMap((page) => {
    const nodes = page.schema_nodes;
    const hasNodes = Array.isArray(nodes) ? nodes.length > 0 : !!nodes;
    return hasNodes ? collectTypes(nodes) : (page.schema_types || []);
  });
  return classifyTypes(types);
}

// ── agents/lib/agent-readiness.js (extractEntity and its helpers) ───────────
// ── Business-type specificity ───────────────────────────────────────────────
// Used to pick the single "primary business node" out of a page's JSON-LD
// graph, and to grade how identifiable that node's @type is. Organization
// and ProfessionalService are deliberately NOT in this set — they are the
// generic fallbacks a specific type should beat, handled separately in
// specificityRank().
const SPECIFIC_BUSINESS_TYPES = new Set([
  'MedicalBusiness', 'MedicalClinic', 'Physician', 'Dentist', 'Hospital', 'Pharmacy', 'VeterinaryCare',
  'LegalService', 'Attorney', 'Notary', 'AccountingService', 'FinancialService', 'InsuranceAgency',
  'RealEstateAgent', 'HomeAndConstructionBusiness', 'Plumber', 'Electrician', 'HVACBusiness',
  'RoofingContractor', 'GeneralContractor', 'MovingCompany', 'AutomotiveBusiness', 'AutoRepair',
  'Store', 'ClothingStore', 'GroceryStore', 'HardwareStore', 'JewelryStore', 'FurnitureStore', 'PetStore',
  'Restaurant', 'CafeOrCoffeeShop', 'Bakery', 'BarOrPub', 'FoodEstablishment',
  'HealthAndBeautyBusiness', 'DaySpa', 'HairSalon', 'BeautySalon', 'NailSalon', 'TattooParlor',
  'SportsActivityLocation', 'Gym', 'ExerciseGym', 'ChildCare', 'EducationalOrganization', 'School',
  'ProfessionalService', 'TravelAgency', 'LodgingBusiness', 'Hotel', 'EntertainmentBusiness',
  'EmergencyService', 'SelfStorage', 'Locksmith', 'Landscaper',
]);

function toArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

// ── JSON-LD graph flattening ─────────────────────────────────────────────────
// The crawler already flattens top-level @graph wrappers (see
// collectAgentReadinessSignals in agents/crawler/index.js), but extractEntity
// must also work directly on raw JSON-LD (tests, other callers), so it
// defensively flattens any remaining @graph and nested arrays itself.
function flattenNodes(input) {
  const out = [];
  const visit = (node) => {
    if (node == null) return;
    if (Array.isArray(node)) { for (const n of node) visit(n); return; }
    if (typeof node !== 'object') return;
    if (Array.isArray(node['@graph'])) { for (const n of node['@graph']) visit(n); return; }
    out.push(node);
  };
  visit(input);
  return out;
}

function typesOf(node) {
  return toArray(node && node['@type']).filter(Boolean);
}

// 4 = a genuinely specific LocalBusiness subtype (e.g. MedicalClinic);
// 3 = ProfessionalService; 2 = Organization; 1 = generic LocalBusiness;
// 0 = none of the above (not a business node we can anchor on).
function specificityRank(types) {
  if (types.some((t) => SPECIFIC_BUSINESS_TYPES.has(t) && t !== 'Organization' && t !== 'ProfessionalService')) return 4;
  if (types.includes('ProfessionalService')) return 3;
  if (types.includes('Organization')) return 2;
  if (types.includes('LocalBusiness')) return 1;
  return 0;
}

function normalizeOffer(o) {
  if (!o || typeof o !== 'object') return null;
  const priceSpec = o.priceSpecification && typeof o.priceSpecification === 'object' ? o.priceSpecification : null;
  const rawPrice = o.price !== undefined ? o.price : (priceSpec ? priceSpec.price : undefined);
  return {
    name: o.name || (o.itemOffered && typeof o.itemOffered === 'object' ? o.itemOffered.name : '') || '',
    price: rawPrice,
    priceCurrency: o.priceCurrency || (priceSpec ? priceSpec.priceCurrency : '') || '',
    availability: typeof o.availability === 'string' ? o.availability : '',
    availabilityStarts: o.availabilityStarts || '',
    validThrough: o.validThrough || (priceSpec ? priceSpec.validThrough : '') || '',
    hasSchedule: !!o.hasSchedule,
    hoursAvailable: o.hoursAvailable || null,
  };
}

// Offers come from hasOfferCatalog.itemListElement (each entry either a bare
// Offer or a ListItem wrapping one in `.item`) and/or top-level offers /
// makesOffer.
function collectOffers(node) {
  const out = [];
  const catalog = node.hasOfferCatalog;
  if (catalog && typeof catalog === 'object') {
    for (const raw of toArray(catalog.itemListElement)) {
      if (!raw) continue;
      const offerNode = raw.item && typeof raw.item === 'object' ? raw.item : raw;
      const norm = normalizeOffer(offerNode);
      if (norm) out.push(norm);
    }
  }
  for (const raw of [...toArray(node.offers), ...toArray(node.makesOffer)]) {
    const norm = normalizeOffer(raw);
    if (norm) out.push(norm);
  }
  return out;
}

function emptyEntity() {
  return {
    found: false, node: null, types: [], specificType: null, isSpecificType: false,
    id: '', name: '', url: '', logo: '', image: '', telephone: '', email: '', description: '',
    address: null, geo: null, openingHoursSpecification: [], openingHours: [], priceRange: '',
    offers: [], hasOfferCatalog: false, aggregateRating: null, reviews: [], sameAs: [],
    contactPoints: [], paymentAccepted: '', currenciesAccepted: '', potentialActions: [],
    hoursAvailable: null, medicalSpecialty: '', physicianNodes: [], faqPage: false, availabilitySignals: [],
  };
}

// ── extractEntity(schemaNodes) ───────────────────────────────────────────────
// Picks the single most specific business node out of a JSON-LD graph and
// returns a normalized, plain-object view of it. Never returns null — an
// empty-shaped entity (found: false) stands in for "no business node here"
// so callers never need a null check before reading a field.
function extractEntity(schemaNodesInput) {
  const nodes = flattenNodes(schemaNodesInput);
  if (!nodes.length) return emptyEntity();

  let best = null;
  let bestRank = 0;
  let bestTypes = [];
  for (const node of nodes) {
    const types = typesOf(node);
    const rank = specificityRank(types);
    if (rank > bestRank) { best = node; bestRank = rank; bestTypes = types; }
  }
  if (!best) return emptyEntity();

  const specificType = bestTypes.find((t) => SPECIFIC_BUSINESS_TYPES.has(t) && t !== 'Organization' && t !== 'ProfessionalService')
    || bestTypes.find((t) => t === 'ProfessionalService')
    || bestTypes.find((t) => t === 'Organization')
    || bestTypes.find((t) => t === 'LocalBusiness')
    || bestTypes[0] || null;

  const addressNode = best.address && typeof best.address === 'object' ? best.address : null;
  const geoNode = best.geo && typeof best.geo === 'object' ? best.geo : null;
  const offers = collectOffers(best);

  const potentialActions = [];
  for (const n of nodes) for (const a of toArray(n.potentialAction)) if (a) potentialActions.push(a);

  const reviews = [];
  for (const n of nodes) if (typesOf(n).includes('Review')) reviews.push(n);
  for (const r of toArray(best.review)) if (r && !reviews.includes(r)) reviews.push(r);

  const physicianNodes = nodes.filter((n) => typesOf(n).includes('Physician'));
  const faqPage = nodes.some((n) => typesOf(n).includes('FAQPage'));

  let logo = '';
  if (typeof best.logo === 'string') logo = best.logo;
  else if (best.logo && typeof best.logo === 'object') logo = best.logo.url || '';

  let image = '';
  if (typeof best.image === 'string') image = best.image;
  else if (Array.isArray(best.image)) image = best.image.find((i) => typeof i === 'string') || '';
  else if (best.image && typeof best.image === 'object') image = best.image.url || '';

  return {
    found: true,
    node: best,
    types: bestTypes,
    specificType,
    isSpecificType: bestRank === 4,
    id: best['@id'] || '',
    name: best.name || '',
    url: best.url || '',
    logo,
    image,
    telephone: best.telephone || '',
    email: best.email || '',
    description: best.description || '',
    address: addressNode,
    geo: geoNode,
    openingHoursSpecification: toArray(best.openingHoursSpecification).filter(Boolean),
    openingHours: toArray(best.openingHours).filter((h) => typeof h === 'string'),
    priceRange: best.priceRange || '',
    offers,
    hasOfferCatalog: !!best.hasOfferCatalog,
    aggregateRating: best.aggregateRating && typeof best.aggregateRating === 'object' ? best.aggregateRating : null,
    reviews,
    sameAs: toArray(best.sameAs).filter((s) => typeof s === 'string'),
    contactPoints: toArray(best.contactPoint).filter(Boolean),
    paymentAccepted: best.paymentAccepted || '',
    currenciesAccepted: best.currenciesAccepted || '',
    potentialActions,
    hoursAvailable: best.hoursAvailable || null,
    medicalSpecialty: best.medicalSpecialty || '',
    physicianNodes,
    faqPage,
    availabilitySignals: offers.filter((o) => o.availability).map((o) => ({
      availability: o.availability, availabilityStarts: o.availabilityStarts, validThrough: o.validThrough,
    })),
  };
}

// ── agents/report/index.js ──────────────────────────────────────────────────
// ── robots.txt parser ─────────────────────────────────────────────────────
// Returns true if the given botName is NOT disallowed from "/" in robots.txt.
// Treats missing robots.txt (empty string) as "allow all" → returns true.
// Logic: check specific User-agent block first, then fall back to wildcard (*).
// A "Disallow: /" in that block means blocked. "Allow: /" or no Disallow means not blocked.
function robotsAllowsBot(robotsTxt, botName) {
  if (!robotsTxt || !robotsTxt.trim()) return true; // no robots.txt = allow all

  const lines = robotsTxt.split(/\r?\n/).map(l => l.trim());

  // Parse into blocks: { agents: string[], rules: { allow: string[], disallow: string[] } }
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('#') || line === '') {
      // comment or blank — if we had an in-progress block, commit it
      if (current && current.agents.length > 0) {
        blocks.push(current);
        current = null;
      }
      continue;
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const field = line.substring(0, colonIdx).trim().toLowerCase();
    const value = line.substring(colonIdx + 1).trim();

    if (field === 'user-agent') {
      if (!current || current.hasRules) {
        // Start a new block
        if (current) blocks.push(current);
        current = { agents: [], allow: [], disallow: [], hasRules: false };
      }
      current.agents.push(value.toLowerCase());
    } else if (field === 'disallow' && current) {
      current.disallow.push(value);
      current.hasRules = true;
    } else if (field === 'allow' && current) {
      current.allow.push(value);
      current.hasRules = true;
    }
  }
  if (current && current.agents.length > 0) blocks.push(current);

  const botLower = botName.toLowerCase();

  // Find most specific matching block (exact bot name takes precedence over *)
  const specificBlock = blocks.find(b => b.agents.includes(botLower));
  const wildcardBlock = blocks.find(b => b.agents.includes('*'));

  function blockDisallowsRoot(block) {
    if (!block) return false;
    // If there's an explicit Allow: / it overrides Disallow
    if (block.allow.some(v => v === '/' || v === '')) return false;
    // Disallow: / (or Disallow: with empty value = allow all) means blocked from root
    return block.disallow.some(v => v === '/');
  }

  // Specific block wins; fall back to wildcard
  const relevantBlock = specificBlock || wildcardBlock;
  if (!relevantBlock) return true; // no matching rule = allow

  return !blockDisallowsRoot(relevantBlock);
}

// ── Fresh content check ───────────────────────────────────────────────────
// Returns true if there's at least one blog post/page with a date within
// the last `windowDays` days. Uses blog data (existing_posts[].date) or
// crawl sitemap lastmod if available.
function hasFreshContent(blogData, windowDays) {
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;

  // Check blog data (posts with parseable date strings)
  const posts = blogData?.existing_posts || [];
  for (const post of posts) {
    if (!post.date) continue;
    const d = Date.parse(post.date);
    if (!isNaN(d) && d >= cutoff) return true;
  }

  // Also check blog.timestamp itself (when the blog scan was done) as a
  // secondary signal — if the scan ran recently and found posts, the site is active.
  // We do NOT use the scan timestamp as a freshness proxy; dates must be explicit.

  return false;
}

// ── Did the blog gap step actually run? ───────────────────────────────────
// agents/blog/index.js does a live Playwright crawl of the customer's blog
// index. When it fails or times out, run-report.sh's fallback writes
// {"status":"skipped"} to blog.json — that object is truthy, so naive
// `blogData ? ... : ...` checks treat it as a genuine "we looked, found
// nothing" result. blogDataMeasured() tells the two apart: a real
// analyze() result always has an `existing_posts` array (possibly empty)
// and a `timestamp`; the skip stub has neither. Mirrors the GA4
// LIVE/CONFIGURED/DATA_UNAVAILABLE distinction — "we don't know" must
// never silently score or read as "we checked and it's bad".
function blogDataMeasured(blogData) {
  if (!blogData || typeof blogData !== 'object') return false;
  if (blogData.status === 'skipped') return false;
  return Array.isArray(blogData.existing_posts) || typeof blogData.timestamp === 'string';
}

// ── Per-Engine GEO Scores ────────────────────────────────────────────────────
// Scoring: pass earns weight; partial earns its earned_weight; needs_work and
// needs_verification earn 0. Each engine's weights sum to 100, so a score is
// % complete. grade: A ≥90, B ≥75, C ≥60, D ≥45, F else.
//
// context: { freshContent, hasBlogPosts, pages } — pages are the indexable
// crawled pages for the site-wide FAQ/entity signals.
function scoreEngines(crawlMetrics, context) {
  const m = crawlMetrics || {};
  const hasSchema   = !!(m.has_schema);
  const hasOG       = !!(m.has_og);
  const hasViewport = !!(m.has_viewport);
  const wordCount   = m.word_count || 0;
  const loadTimeMs  = (typeof m.load_time_ms === 'number' && m.load_time_ms > 0) ? m.load_time_ms : 9999;
  const hasTitle    = !!(m.title);
  const metaDesc    = m.meta_description || '';
  const hasMetaDesc = metaDesc.length > 0;
  const metaDescLen = metaDesc.length;
  const h1Count     = m.h1_count || 0;
  const robotsTxt   = m.robots_txt || '';  // raw robots.txt text from crawler

  // freshContent tri-state: true/false = the blog step ran and has an answer;
  // null = explicitly passed by buildGEOScores when the blog step didn't run
  // this week (skipped/failed) — unmeasured.
  const freshContentRaw = context && Object.prototype.hasOwnProperty.call(context, 'freshContent')
    ? context.freshContent : false;
  const freshContent = freshContentRaw === null ? null : !!freshContentRaw;

  // ── robots.txt bot checks ──
  const gptbotAllowed        = robotsAllowsBot(robotsTxt, 'GPTBot');
  const claudebotAllowed     = robotsAllowsBot(robotsTxt, 'ClaudeBot');
  const perplexitybotAllowed = robotsAllowsBot(robotsTxt, 'PerplexityBot');

  function robotsEvidence(allowed, botName) {
    if (!robotsTxt || !robotsTxt.trim()) return `no robots.txt — ${botName} allowed by default`;
    return allowed
      ? `robots.txt allows ${botName}`
      : `robots.txt blocks ${botName} from /`;
  }

  // ── Citation drivers, shared by every engine's FAQ/entity/depth items ──
  const signalPages = context?.pages?.length ? context.pages : [m];
  const faqSignal = scoreFaqSignal(signalPages);
  const entitySignal = scoreEntitySignal(signalPages);

  function signalItem(id, label, weight, signal) {
    return {
      id, label, weight,
      status: signal.status,
      ...(signal.status === 'partial' ? { earned_weight: Math.floor(weight / 2) } : {}),
      evidence: signal.evidence,
    };
  }

  function contentDepthItem(id, weight) {
    return {
      id,
      label: 'Substantial Content Depth',
      weight,
      status: wordCount >= 800 ? 'pass' : 'needs_work',
      evidence: `homepage word count: ${wordCount} (${wordCount >= 800 ? 'meets' : 'below'} 800-word threshold)`,
    };
  }

  function calcScore(items) {
    const earned = items.reduce((s, i) => {
      if (i.status === 'pass') return s + (i.weight || 0);
      if (i.status === 'partial') return s + (i.earned_weight || 0);
      return s;
    }, 0);
    const max    = items.reduce((s, i) => s + (i.weight || 0), 0);
    const pct    = max > 0 ? Math.round((earned / max) * 100) : 0;
    const grade  = pct >= 90 ? 'A' : pct >= 75 ? 'B' : pct >= 60 ? 'C' : pct >= 45 ? 'D' : 'F';
    return { score: pct, grade, earned, max, items };
  }

  // ── ChatGPT (Bing + GPTBot) ── 7 items, weights 35+25+15+10+8+4+3 = 100
  const chatgptItems = [
    signalItem('chatgpt_faq_direct_answer', 'Direct-Answer Content', 35, faqSignal),
    signalItem('chatgpt_entity_identity', 'Business Entity Identity', 25, entitySignal),
    contentDepthItem('chatgpt_content_depth', 15),
    {
      id: 'chatgpt_gptbot_access',
      label: 'GPTBot Crawl Access',
      weight: 10,
      status: gptbotAllowed ? 'pass' : 'needs_work',
      evidence: robotsEvidence(gptbotAllowed, 'GPTBot'),
    },
    {
      id: 'chatgpt_schema_markup',
      label: 'Structured Data / Schema Markup',
      weight: 8,
      status: hasSchema ? 'pass' : 'needs_work',
      evidence: hasSchema ? 'JSON-LD schema detected on page' : 'no JSON-LD schema found',
    },
    {
      id: 'chatgpt_og_social',
      label: 'Open Graph & Social Signals',
      weight: 4,
      status: hasOG ? 'pass' : 'needs_work',
      evidence: hasOG ? 'Open Graph tags detected' : 'no Open Graph tags found',
    },
    {
      id: 'chatgpt_meta_description',
      label: 'Meta Description Optimization',
      weight: 3,
      status: hasMetaDesc && metaDescLen >= 50 && metaDescLen <= 160 ? 'pass' : 'needs_work',
      evidence: hasMetaDesc
        ? (metaDescLen >= 50 && metaDescLen <= 160
            ? `meta description ${metaDescLen} chars (within 50–160)`
            : `meta description ${metaDescLen} chars (outside 50–160 range)`)
        : 'no meta description found',
    },
  ];

  // ── Gemini (Google + Knowledge Graph) ── 9 items, weights 25+20+18+12+10+5+4+3+3 = 100
  const geminiItems = [
    signalItem('gemini_faq_direct_answer', 'FAQ & Direct-Answer Content', 25, faqSignal),
    signalItem('gemini_entity_identity', 'Business Entity Identity', 20, entitySignal),
    {
      id: 'gemini_gbp',
      label: 'Google Business Profile Optimization',
      weight: 18,
      status: 'needs_verification',
      evidence: 'no GBP data available — needs verification',
    },
    {
      id: 'gemini_reviews',
      label: 'Review & Reputation Monitoring',
      weight: 12,
      status: 'needs_verification',
      evidence: 'review count and rating require manual verification (no API data available)',
    },
    contentDepthItem('gemini_content_depth', 10),
    {
      id: 'gemini_schema_markup',
      label: 'Structured Data / Schema Markup',
      weight: 5,
      status: hasSchema ? 'pass' : 'needs_work',
      evidence: hasSchema ? 'JSON-LD schema detected' : 'no JSON-LD schema found',
    },
    {
      id: 'gemini_page_speed',
      label: 'Page Speed Optimization (<3s)',
      weight: 4,
      status: loadTimeMs < 3000 ? 'pass' : 'needs_work',
      evidence: loadTimeMs < 9999
        ? `page load ${(loadTimeMs / 1000).toFixed(1)}s (${loadTimeMs < 3000 ? 'under' : 'over'} 3s threshold)`
        : 'load time not measured',
    },
    {
      id: 'gemini_mobile',
      label: 'Mobile-Friendly Verified',
      weight: 3,
      status: hasViewport ? 'pass' : 'needs_work',
      evidence: hasViewport ? 'viewport meta tag present' : 'no viewport meta tag detected',
    },
    {
      id: 'gemini_title_tags',
      label: 'Title Tags & Meta Strategy',
      weight: 3,
      status: hasTitle ? 'pass' : 'needs_work',
      evidence: hasTitle
        ? `title tag present: "${(m.title || '').substring(0, 60)}${(m.title || '').length > 60 ? '...' : ''}"`
        : 'no title tag found',
    },
  ];

  // ── Claude (Brave + ClaudeBot) ── 7 items, weights 30+20+20+12+8+6+4 = 100
  const claudeItems = [
    signalItem('claude_faq_direct_answer', 'FAQ & Direct-Answer Content', 30, faqSignal),
    signalItem('claude_entity_identity', 'Business Entity Identity', 20, entitySignal),
    contentDepthItem('claude_content_depth', 20),
    {
      id: 'claude_citation_consistency',
      label: 'Citation Consistency (NAP)',
      weight: 12,
      status: 'needs_verification',
      evidence: 'NAP consistency across GBP, Facebook, Foursquare requires manual verification',
    },
    {
      id: 'claude_backlinks',
      label: 'Authoritative Backlink Building',
      weight: 8,
      status: 'needs_verification',
      evidence: 'backlink data not available — needs verification',
    },
    {
      id: 'claude_claudebot_access',
      label: 'ClaudeBot Crawl Access',
      weight: 6,
      status: claudebotAllowed ? 'pass' : 'needs_work',
      evidence: robotsEvidence(claudebotAllowed, 'ClaudeBot'),
    },
    {
      id: 'claude_og_tags',
      label: 'Open Graph Tags',
      weight: 4,
      status: hasOG ? 'pass' : 'needs_work',
      evidence: hasOG ? 'Open Graph tags detected' : 'no Open Graph tags found',
    },
  ];

  // ── Perplexity (Proprietary + Google) ── 7 items, weights 35+20+15+10+8+7+5 = 100
  const perplexityItems = [
    signalItem('perplexity_faq_content', 'FAQ & Direct-Answer Content', 35, faqSignal),
    signalItem('perplexity_entity_identity', 'Business Entity Identity', 20, entitySignal),
    contentDepthItem('perplexity_content_depth', 15),
    {
      id: 'perplexity_fresh_content',
      label: 'Fresh Content Signals',
      weight: 10,
      // freshContent === null: the blog step didn't run — missing data, not a
      // finding, so needs_verification. Earns 0 points either way.
      status: freshContent === null ? 'needs_verification' : (freshContent ? 'pass' : 'needs_work'),
      evidence: freshContent === null
        ? 'blog freshness check did not run this week (scan skipped or failed) — unmeasured, not counted against you'
        : freshContent
          ? 'blog post published within last 90 days detected'
          : (context?.hasBlogPosts
              ? 'blog posts exist but none have a datestamp within 90 days'
              : 'no dated blog posts found — fresh content needed'),
    },
    {
      id: 'perplexity_bot_access',
      label: 'PerplexityBot Crawl Access',
      weight: 8,
      status: perplexitybotAllowed ? 'pass' : 'needs_work',
      evidence: robotsEvidence(perplexitybotAllowed, 'PerplexityBot'),
    },
    {
      id: 'perplexity_crawlable_structure',
      label: 'Clean, Crawlable Page Structure',
      weight: 7,
      status: (h1Count === 1 && wordCount > 0) ? 'pass' : 'needs_work',
      evidence: h1Count === 1
        ? `1 H1 tag, ${wordCount} words — clean structure`
        : (h1Count === 0
            ? 'no H1 tag found — heading structure missing'
            : `${h1Count} H1 tags found — should be exactly 1`),
    },
    {
      id: 'perplexity_schema_markup',
      label: 'Structured Data for Source Citation',
      weight: 5,
      status: hasSchema ? 'pass' : 'needs_work',
      evidence: hasSchema ? 'JSON-LD schema detected (citation-ready)' : 'no JSON-LD schema found',
    },
  ];

  const chatgpt    = { ...calcScore(chatgptItems),    engine: 'ChatGPT',    name: 'ChatGPT',    icon: '🤖', tagline: 'Bing + GPTBot',             source: 'Bing + GPTBot' };
  const gemini     = { ...calcScore(geminiItems),     engine: 'Gemini',     name: 'Gemini',     icon: '🔍', tagline: 'Google + Knowledge Graph',   source: 'Google + Knowledge Graph' };
  const claude     = { ...calcScore(claudeItems),     engine: 'Claude',     name: 'Claude',     icon: '🧠', tagline: 'Brave + ClaudeBot',          source: 'Brave + ClaudeBot' };
  const perplexity = { ...calcScore(perplexityItems), engine: 'Perplexity', name: 'Perplexity', icon: '⚡', tagline: 'Proprietary + Google',       source: 'Proprietary + Google' };

  const scores = [chatgpt.score, gemini.score, claude.score, perplexity.score];
  const overall_score = Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);

  return {
    chatgpt,
    gemini,
    claude,
    perplexity,
    overall_score,
    summary: `AI readiness (on-page): ${overall_score}/100`,
  };
}

// buildGEOScores(auditResults, crawlData, …) projection, for a crawl with no
// strategy/listing/blog/business data. crawlData = { metrics: homepage
// metrics, pages }.
function buildGEOScores(crawlData) {
  // ── Pull raw signals from crawl ──
  const homepageMetrics = crawlData?.metrics || {};
  const indexablePages = (crawlData?.pages || []).filter(isIndexableHtmlPage);
  const pageMetrics = indexablePages.map(page => page.metrics || {});
  const all = predicate => pageMetrics.length > 0 && pageMetrics.every(predicate);
  // Feed the existing engine scorer a conservative site-wide projection: an
  // on-page signal passes only when every indexable crawled page passes. The
  // homepage value remains only for fields that are truly site-level
  // (robots.txt) or for evidence text after coverage has passed.
  const m = pageMetrics.length ? {
    ...homepageMetrics,
    has_schema: all(metrics => metrics.has_schema),
    has_og: all(metrics => metrics.has_og),
    has_viewport: all(metrics => metrics.has_viewport),
    title: all(metrics => !!metrics.title) ? homepageMetrics.title : '',
    meta_description: all(metrics => {
      const length = (metrics.meta_description || '').length;
      return length >= 50 && length <= 160;
    }) ? homepageMetrics.meta_description : '',
    h1_count: all(metrics => metrics.h1_count === 1) ? 1 : 0,
    word_count: Math.min(...pageMetrics.map(metrics => metrics.word_count || 0)),
    load_time_ms: Math.max(...pageMetrics.map(metrics => metrics.load_time_ms || 0)),
  } : homepageMetrics;

  // ── Build context object for manual-item signals ──
  // null = the blog step didn't run — unmeasured, must not be scored as a
  // negative. The instant check never runs it.
  const blogData = null;
  const blogMeasured = blogDataMeasured(blogData);
  const freshContent = blogMeasured ? hasFreshContent(blogData, 90) : null;
  const hasBlogPosts = (blogData?.existing_posts?.length || 0) > 0;

  const context = {
    freshContent,
    hasBlogPosts,
    pages: indexablePages,
  };

  // ── Delegate to shared scorer ──
  const result = scoreEngines(m, context);
  const faqCoverage = scoreFaqSignal(indexablePages);
  const siteCoverage = {
    pages_evaluated: pageMetrics.length || 1,
    schema: pageMetrics.filter(metrics => metrics.has_schema).length,
    open_graph: pageMetrics.filter(metrics => metrics.has_og).length,
    viewport: pageMetrics.filter(metrics => metrics.has_viewport).length,
    valid_meta_description: pageMetrics.filter(metrics => {
      const length = (metrics.meta_description || '').length;
      return length >= 50 && length <= 160;
    }).length,
    single_h1: pageMetrics.filter(metrics => metrics.h1_count === 1).length,
    substantial_content: pageMetrics.filter(metrics => (metrics.word_count || 0) >= 800).length,
    faq_markup: faqCoverage.faq_markup,
    qa_structure: faqCoverage.qa_structure,
  };
  const contentDepthEvidence = `At least 800 words on ${siteCoverage.substantial_content}/${siteCoverage.pages_evaluated} indexable pages`;
  const coverageEvidence = {
    chatgpt_meta_description: `Valid meta descriptions on ${siteCoverage.valid_meta_description}/${siteCoverage.pages_evaluated} indexable pages`,
    chatgpt_content_depth: contentDepthEvidence,
    chatgpt_schema_markup: `Schema detected on ${siteCoverage.schema}/${siteCoverage.pages_evaluated} indexable pages`,
    chatgpt_og_social: `Open Graph detected on ${siteCoverage.open_graph}/${siteCoverage.pages_evaluated} indexable pages`,
    gemini_content_depth: contentDepthEvidence,
    gemini_schema_markup: `Schema detected on ${siteCoverage.schema}/${siteCoverage.pages_evaluated} indexable pages`,
    gemini_mobile: `Viewport metadata on ${siteCoverage.viewport}/${siteCoverage.pages_evaluated} indexable pages`,
    gemini_title_tags: `Title tags present on ${pageMetrics.filter(metrics => !!metrics.title).length}/${siteCoverage.pages_evaluated} indexable pages`,
    claude_content_depth: contentDepthEvidence,
    claude_og_tags: `Open Graph detected on ${siteCoverage.open_graph}/${siteCoverage.pages_evaluated} indexable pages`,
    perplexity_content_depth: contentDepthEvidence,
    perplexity_schema_markup: `Schema detected on ${siteCoverage.schema}/${siteCoverage.pages_evaluated} indexable pages`,
    perplexity_crawlable_structure: `Exactly one H1 on ${siteCoverage.single_h1}/${siteCoverage.pages_evaluated} indexable pages`,
  };
  for (const engine of ['chatgpt', 'gemini', 'claude', 'perplexity']) {
    for (const item of result[engine].items) if (coverageEvidence[item.id]) item.evidence = coverageEvidence[item.id];
  }

  return {
    chatgpt:       result.chatgpt,
    gemini:        result.gemini,
    claude:        result.claude,
    perplexity:    result.perplexity,
    overall_score: result.overall_score,
    coverage: siteCoverage,
    summary:       '',
  };
}

// The crawler already flattens @graph wrappers into metrics.schema_nodes
// (collectAgentReadinessSignals in agents/crawler/index.js); toPageShape lifts
// it to the page. Read both spots so older crawl artifacts still work.
function pageSchemaNodes(page) {
  const nodes = page?.schema_nodes || page?.metrics?.schema_nodes;
  return Array.isArray(nodes) ? nodes : [];
}

function pageHasFaqMarkup(page) {
  return pageSchemaNodes(page).some(node => {
    const types = node && node['@type'];
    return Array.isArray(types) ? types.includes('FAQPage') : types === 'FAQPage';
  });
}

// ── Citation-driver signals ─────────────────────────────────────────────────
// Pure site-level reads shared by all four engines. `pages` is the indexable
// crawl pages; a bare metrics object also works, which is how a single-page
// competitor crawl reaches these through scoreEngines().
function citationPageMetrics(page) {
  return page?.metrics || page || {};
}

const QA_MIN_ANSWER_WORDS = 20;
const FAQ_SECTION_RE = /\b(faqs?|frequently asked|common questions|q\s*&\s*a)\b/i;

// Visible Q&A heuristic, deliberately conservative: at least two distinct
// question-like headings (text ending in "?", or an FAQ section heading), each
// followed by QA_MIN_ANSWER_WORDS of visible text before the next heading. That
// answer check is what keeps marketing headings like "Ready to get started?"
// out. The crawler stores the heading outline but not sibling content, so
// answers are measured by locating headings inside metrics.visible_text, which
// is capped at 4000 chars. A heading past that cap cannot be confirmed and does
// not count, and neither do dt/summary pairs, which the crawler doesn't collect.
function pageHasQaStructure(page) {
  const metrics = citationPageMetrics(page);
  const text = (metrics.visible_text || '').toLowerCase();
  const located = [];
  let cursor = 0;
  for (const entry of metrics.heading_outline || []) {
    const heading = (entry?.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const at = heading ? text.indexOf(heading, cursor) : -1;
    if (at < 0) continue;
    cursor = at + heading.length;
    located.push({ heading, at, end: cursor });
  }
  const answered = located.filter((item, index) => {
    if (!item.heading.endsWith('?') && !FAQ_SECTION_RE.test(item.heading)) return false;
    const answer = text.slice(item.end, located[index + 1]?.at);
    return answer.split(/\s+/).filter(Boolean).length >= QA_MIN_ANSWER_WORDS;
  });
  return new Set(answered.map(item => item.heading)).size >= 2;
}

// pass: FAQPage markup or visible Q&A structure on any page. partial: valid
// meta descriptions on most pages with neither — a meta description is not an
// FAQ, so it can only ever earn half of the item. needs_work otherwise.
function scoreFaqSignal(pages) {
  const list = pages || [];
  const total = list.length || 1;
  const faq_markup = list.filter(page => pageHasFaqMarkup(page) || (citationPageMetrics(page).schema_types || []).includes('FAQPage')).length;
  const qa_structure = list.filter(pageHasQaStructure).length;
  const validMeta = list.filter(page => {
    const length = (citationPageMetrics(page).meta_description || '').length;
    return length >= 50 && length <= 160;
  }).length;
  const coverage = `FAQPage markup on ${faq_markup}/${total} indexable pages; visible Q&A structure on ${qa_structure}/${total}`;

  if (faq_markup > 0 || qa_structure > 0) return { status: 'pass', evidence: coverage, faq_markup, qa_structure };
  if (validMeta * 2 > total) {
    return {
      status: 'partial',
      evidence: `${coverage}. Partial credit only for direct-answer meta descriptions on ${validMeta}/${total} indexable pages — add an FAQ section with real questions and answers to earn the rest.`,
      faq_markup, qa_structure,
    };
  }
  return { status: 'needs_work', evidence: coverage, faq_markup, qa_structure };
}

function entityHasAddress(entity) {
  const address = entity.node?.address;
  if (typeof address === 'string') return address.trim().length > 0;
  const postal = Array.isArray(address) ? address[0] : address;
  return !!(postal?.streetAddress || (postal?.addressLocality && postal?.addressRegion));
}

// pass: a named business node (Organization / LocalBusiness / subtype) with an
// address. partial: named, but no usable address. needs_work: no such node —
// Product/WebPage/Breadcrumb JSON-LD says nothing about who or where, however
// much of it a site has. Pages are read one at a time because extractEntity
// keeps only the first node at a rank, which would let a thin node on one page
// hide the complete node on another.
function scoreEntitySignal(pages) {
  const list = pages || [];
  const total = list.length || 1;
  const entities = list.map(page => extractEntity(pageSchemaNodes(page))).filter(entity => entity.found && entity.name);
  const located = entities.filter(entityHasAddress);

  if (located.length) {
    const { specificType, name } = located[0];
    return { status: 'pass', evidence: `${specificType} "${name}" with an address in structured data on ${located.length}/${total} indexable pages` };
  }
  if (entities.length) {
    const { specificType, name } = entities[0];
    return { status: 'partial', evidence: `${specificType} "${name}" in structured data on ${entities.length}/${total} indexable pages, but no street address or city and region` };
  }
  return { status: 'needs_work', evidence: 'no named Organization or LocalBusiness entity found in structured data' };
}

// ── Instant check entry points ──────────────────────────────────────────────

// pages: crawl.js pages, homepage first. → { chatgpt, gemini, claude,
// perplexity, overall_score, coverage, summary } as buildGEOScores returns.
export function scoreSite(pages) {
  const list = Array.isArray(pages) ? pages : [];
  return buildGEOScores({ metrics: list[0]?.metrics || {}, pages: list });
}

// Not vendored. A short, deterministic list of on-page findings in plain
// English, each tied to a measured count from this crawl. Nothing here speaks
// to rankings, backlinks or Business Profiles: none of that is measured.
export const AI_CRAWLERS = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended'];
const THIN_WORDS = 300;

function ofCheckedPages(n, total, singularVerb, pluralVerb) {
  return `${n} of ${total} checked ${total === 1 ? 'page' : 'pages'} ${n === 1 ? singularVerb : pluralVerb}`;
}

function noneOfCheckedPages(total, rest) {
  return total === 1 ? `The page checked has ${rest}.` : `None of the ${total} pages checked has ${rest}.`;
}

function joinList(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function validMetaDescription(page) {
  const length = (citationPageMetrics(page).meta_description || '').length;
  return length >= 50 && length <= 160;
}

// → [{ id, label, detail }], most important first.
export function onPageFindings(pages, robotsTxt) {
  const all = Array.isArray(pages) ? pages : [];
  const indexable = all.filter(isIndexableHtmlPage);
  const list = indexable.length ? indexable : all;
  const total = list.length;
  const findings = [];

  const blocked = AI_CRAWLERS.filter(bot => !robotsAllowsBot(robotsTxt || '', bot));
  if (blocked.length) {
    findings.push({
      id: 'ai_crawlers_blocked',
      label: `robots.txt blocks ${joinList(blocked)}`,
      detail: `${blocked.length === 1 ? 'This AI crawler is' : 'These AI crawlers are'} disallowed from the whole site.`,
    });
  }
  if (!total) return findings;

  const identity = classifyPages(list);
  if (!identity.hasLocalBusiness && !identity.hasOrganizationOnly) {
    findings.push({
      id: 'no_entity_schema',
      label: 'No structured data says what this business is or where it operates',
      detail: noneOfCheckedPages(total, 'LocalBusiness or Organization structured data'),
    });
  }

  const faq = scoreFaqSignal(list);
  if (faq.faq_markup === 0 && faq.qa_structure === 0) {
    findings.push({
      id: 'no_faq',
      label: 'No question-and-answer content for AI assistants to quote',
      detail: noneOfCheckedPages(total, 'an FAQ section or FAQPage markup'),
    });
  } else if (faq.faq_markup === 0) {
    findings.push({
      id: 'qa_not_marked_up',
      label: 'Questions and answers are on the site but not marked up as an FAQ',
      detail: `${ofCheckedPages(faq.qa_structure, total, 'has', 'have')} visible questions and answers but no FAQPage markup.`,
    });
  }

  const thin = list.filter(page => (citationPageMetrics(page).word_count || 0) < THIN_WORDS).length;
  if (thin) {
    findings.push({
      id: 'thin_pages',
      label: `${thin} ${thin === 1 ? 'page has' : 'pages have'} too little content to be quoted`,
      detail: `${ofCheckedPages(thin, total, 'carries', 'carry')} under ${THIN_WORDS} words.`,
    });
  }

  const badMeta = list.filter(page => !validMetaDescription(page)).length;
  if (badMeta) {
    findings.push({
      id: 'missing_meta_descriptions',
      label: `${badMeta} ${badMeta === 1 ? 'page is' : 'pages are'} missing a usable meta description`,
      detail: `${ofCheckedPages(badMeta, total, 'has', 'have')} no meta description, or one outside 50–160 characters.`,
    });
  }
  return findings;
}

export {
  scoreEngines, robotsAllowsBot, scoreFaqSignal, scoreEntitySignal, pageHasQaStructure, extractEntity,
  classifyPages, isIndexableHtmlPage,
};
