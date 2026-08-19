#!/usr/bin/env node
/**
 * Dreamwork GitHub Job-List Franchise generator (growth mission B).
 *
 * Pulls fresh listings from the public Dreamwork API and renders a README.md
 * job table plus a data/listings.json snapshot for one list repo. The same
 * file is vendored into each public list repo at .github/scripts/update.mjs
 * and driven by the config.json sitting next to it; tools/job-lists in the
 * monorepo is the source of truth (see publish.sh).
 *
 * Zero dependencies on purpose: the public repos run this on a bare
 * actions/setup-node runner with nothing installed.
 *
 * Usage: node generate.mjs <config.json> [--out <dir>]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const API_BASE = process.env.DREAMWORK_API_BASE ?? "https://api.dreamworkhq.com";
const SITE_BASE = process.env.DREAMWORK_SITE_BASE ?? "https://www.dreamworkhq.com";
const PAGE_SIZE = 25; // anonymous plan cap on GET /listings
const FETCH_MAX_ATTEMPTS = 4;

function positiveIntegerEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer (received ${JSON.stringify(raw)})`);
  }
  return value;
}

const FETCH_TIMEOUT_MS = positiveIntegerEnv(
  "DREAMWORK_JOB_LIST_FETCH_TIMEOUT_MS",
  15_000,
);
const FETCH_RETRY_BASE_MS = positiveIntegerEnv(
  "DREAMWORK_JOB_LIST_FETCH_RETRY_BASE_MS",
  2_000,
);
const FETCH_RETRY_MAX_MS = positiveIntegerEnv(
  "DREAMWORK_JOB_LIST_FETCH_RETRY_MAX_MS",
  8_000,
);

const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA",
  "KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT",
  "VA","WA","WV","WI","WY","DC","PR",
]);

function parseArgs(argv) {
  const [configPath, ...rest] = argv;
  if (!configPath) {
    console.error("usage: node generate.mjs <config.json> [--out <dir>]");
    process.exit(1);
  }
  let out = dirname(resolve(configPath));
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--out" && rest[i + 1]) out = resolve(rest[++i]);
  }
  return { configPath: resolve(configPath), out };
}

function retryDelay(attempt) {
  return Math.min(FETCH_RETRY_BASE_MS * 2 ** (attempt - 1), FETCH_RETRY_MAX_MS);
}

function isTransientNetworkError(error, signal) {
  return signal.aborted || error instanceof TypeError || error?.name === "AbortError";
}

function networkFailureMessage(error, signal) {
  if (signal.aborted) return `timed out after ${FETCH_TIMEOUT_MS}ms`;
  return `network error: ${error instanceof Error ? error.message : String(error)}`;
}

async function fetchJson(url) {
  for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt++) {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    let res;

    try {
      res = await fetch(url, {
        headers: { "user-agent": "dreamwork-job-lists/1.0 (+https://www.dreamworkhq.com)" },
        signal,
      });
    } catch (error) {
      if (!isTransientNetworkError(error, signal)) throw error;
      const failure = networkFailureMessage(error, signal);
      if (attempt === FETCH_MAX_ATTEMPTS) {
        throw new Error(
          `GET ${url} failed after ${attempt} attempts: ${failure}`,
          { cause: error },
        );
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelay(attempt)));
      continue;
    }

    if (!res.ok) {
      const retriableStatus = res.status === 429 || res.status >= 500;
      if (retriableStatus && attempt < FETCH_MAX_ATTEMPTS) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelay(attempt)));
        continue;
      }
      const suffix = attempt > 1 ? ` after ${attempt} attempts` : "";
      throw new Error(`GET ${url} -> ${res.status}${suffix}`);
    }

    try {
      return await res.json();
    } catch (error) {
      if (!isTransientNetworkError(error, signal)) {
        throw new Error(`GET ${url} returned invalid JSON`, { cause: error });
      }
      const failure = networkFailureMessage(error, signal);
      if (attempt === FETCH_MAX_ATTEMPTS) {
        throw new Error(
          `GET ${url} failed after ${attempt} attempts: ${failure}`,
          { cause: error },
        );
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, retryDelay(attempt)));
    }
  }

  throw new Error(`GET ${url} exhausted its retry budget`);
}

/** Fetch listings for one source (query-param set), newest first. */
async function fetchSource(source, config) {
  const collected = [];
  const maxPages = config.maxPagesPerSource ?? 40;
  // Inventory lists must exhaust the source; fresh lists stop once the
  // display cap (plus dedupe headroom) is covered.
  const wanted =
    config.mode === "inventory" ? Infinity : (config.maxRows ?? 600) + 150;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
    for (const [k, v] of Object.entries(source)) {
      if (v !== null && v !== undefined && v !== "") params.set(k, String(v));
    }
    const data = await fetchJson(`${API_BASE}/listings?${params}`);
    const rows = data.listings ?? [];
    for (const row of rows) {
      if (keepRow(row, config, source)) collected.push(row);
    }
    const hasExactTotal = data.totalCapped !== true && Number.isFinite(data.total);
    if (config.mode === "inventory" && !hasExactTotal) {
      const sourceLabel = describeSource(source);
      throw new Error(
        `Inventory source total is capped or unavailable for ${sourceLabel}. Narrow the source into exact subqueries; refusing to publish a partial inventory.`,
      );
    }
    const reachedReportedEnd =
      hasExactTotal && (page + 1) * PAGE_SIZE >= data.total;
    // Hydration can drop a listing that retires between the API's id query and
    // detail query, so an exact-total page may be short before the reported
    // end. Inventory mode requires an exact reported end because the public
    // API returns an empty page at its hard offset ceiling even when more rows
    // exist. Fresh feeds may use a short capped/unknown page as their stop.
    const freshFeedReachedShortPage =
      config.mode !== "inventory" && !hasExactTotal && rows.length < PAGE_SIZE;
    if (reachedReportedEnd || freshFeedReachedShortPage) {
      return collected;
    }
    if (collected.length >= wanted) break;
  }
  if (config.mode === "inventory") {
    throw new Error(
      `Inventory source pagination limit reached for ${describeSource(source)} after ${maxPages} pages. Increase maxPagesPerSource or narrow the source; refusing to publish a partial inventory.`,
    );
  }
  return collected;
}

// Error label for a source. Partitioned sources differ only in
// remoteTypeExact, so include it or the labels collapse into one.
function describeSource(source) {
  const parts = [source.search, source.remoteTypeExact].filter(Boolean);
  const base = source.function ?? (parts.length ? "source" : null);
  if (!base) return JSON.stringify(source);
  return parts.length ? `${base} (${parts.join(", ")})` : base;
}

// US/non-US partitioning happens after fetch (international rows feed
// INTERNATIONAL.md), so keepRow only applies the audience filters.
function keepRow(row, config, source) {
  if (!row?.id || !row.title || !row.companyName) return false;
  // Staffing-agency reposts hide the employer behind "Confidential Employer"
  // or a machine-suffixed name like "Superloop 1733718881"; a public list
  // full of those reads as spam, so drop them.
  if (/\bconfidential\b/i.test(row.companyName)) return false;
  if (/\b\d{9,}\b/.test(row.companyName)) return false;
  if (config.titleInclude && !new RegExp(config.titleInclude, "i").test(row.title)) return false;
  const scopedFunctions = config.titleIncludeAllSourceFunctions;
  const applyTitleIncludeAll =
    !Array.isArray(scopedFunctions) || scopedFunctions.includes(source.function);
  if (
    applyTitleIncludeAll &&
    config.titleIncludeAll &&
    !config.titleIncludeAll.every((pattern) =>
      new RegExp(pattern, "i").test(row.title),
    )
  ) {
    return false;
  }
  if (config.titleExclude && new RegExp(config.titleExclude, "i").test(row.title)) return false;
  if (config.aiKinds && !config.aiKinds.includes(row.aiRoleKind)) return false;
  return true;
}

// Foreign markers that defeat the state-code heuristic: "Mumbai, IN" is India
// (not Indiana) and "IN, TN, Chennai" is Tamil Nadu (not Tennessee).
const NON_US_LOCATION = new RegExp(
  "\\b(" +
    [
      "canada|india|united kingdom|\\buk\\b|ireland|germany|france|netherlands|belgium|spain|portugal|italy|austria|switzerland|poland|romania|czech|slovakia|hungary|ukraine|sweden|norway|denmark|finland|estonia|latvia|lithuania|greece|turkey|israel|egypt|nigeria|kenya|south africa|uae|dubai|saudi|qatar|japan|china|taiwan|korea|vietnam|philippines|indonesia|malaysia|thailand|singapore|australia|new zealand|brazil|argentina|chile|colombia|peru|mexico|costa rica|guatemala",
      "london|toronto|vancouver|montreal|ottawa|calgary|edmonton|winnipeg|mississauga|quebec|mumbai|chennai|bengaluru|bangalore|hyderabad|pune|delhi|noida|gurgaon|gurugram|kolkata|ahmedabad|dublin|berlin|munich|paris|amsterdam|warsaw|krakow|madrid|barcelona|lisbon|milan|rome|vienna|prague|budapest|bucharest|zurich|geneva|stockholm|copenhagen|oslo|helsinki|athens|istanbul|tel aviv|cairo|lagos|nairobi|johannesburg|cape town|riyadh|doha|tokyo|osaka|shanghai|beijing|shenzhen|seoul|taipei|hong kong|jakarta|kuala lumpur|bangkok|manila|ho chi minh|hanoi|sydney|melbourne|brisbane|perth|auckland|wellington|s[ãa]o paulo|buenos aires|santiago|bogot[áa]|lima|mexico city|guadalajara|monterrey",
    ].join("|") +
    ")\\b",
  "i",
);

// Complete ISO-3166 alpha-3 set, mirrored from the API's CI-checked
// ISO_ALPHA3_TO_ALPHA2 mapping. Keep this standalone generator dependency-free.
const NON_US_ISO_ALPHA3_COUNTRY_CODES = new Set(
  (
    "ABW AFG AGO AIA ALA ALB AND ARE ARG ARM ASM ATA ATF ATG AUS AUT " +
    "AZE BDI BEL BEN BES BFA BGD BGR BHR BHS BIH BLM BLR BLZ BMU BOL " +
    "BRA BRB BRN BTN BVT BWA CAF CAN CCK CHE CHL CHN CIV CMR COD COG " +
    "COK COL COM CPV CRI CUB CUW CXR CYM CYP CZE DEU DJI DMA DNK DOM " +
    "DZA ECU EGY ERI ESH ESP EST ETH FIN FJI FLK FRA FRO FSM GAB GBR " +
    "GEO GGY GHA GIB GIN GLP GMB GNB GNQ GRC GRD GRL GTM GUF GUM GUY " +
    "HKG HMD HND HRV HTI HUN IDN IMN IND IOT IRL IRN IRQ ISL ISR ITA " +
    "JAM JEY JOR JPN KAZ KEN KGZ KHM KIR KNA KOR KWT LAO LBN LBR LBY " +
    "LCA LIE LKA LSO LTU LUX LVA MAC MAF MAR MCO MDA MDG MDV MEX MHL " +
    "MKD MLI MLT MMR MNE MNG MNP MOZ MRT MSR MTQ MUS MWI MYS MYT NAM " +
    "NCL NER NFK NGA NIC NIU NLD NOR NPL NRU NZL OMN PAK PAN PCN PER " +
    "PHL PLW PNG POL PRI PRK PRT PRY PSE PYF QAT REU ROU RUS RWA SAU " +
    "SDN SEN SGP SGS SHN SJM SLB SLE SLV SMR SOM SPM SRB SSD STP SUR " +
    "SVK SVN SWE SWZ SXM SYC SYR TCA TCD TGO THA TJK TKL TKM TLS TON " +
    "TTO TUN TUR TUV TWN TZA UGA UKR UMI URY USA UZB VAT VCT VEN VGB " +
    "VIR VNM VUT WLF WSM YEM ZAF ZMB ZWE"
  )
    .split(" ")
    .filter((code) => code !== "USA"),
);
const STRUCTURED_ALPHA3_LOCATION_PREFIX =
  /^([A-Z]{3})\s*[-–]\s*[A-Z0-9]{1,3}\s*[-–]\s*\S/i;

function hasExplicitNonUsAlpha3Country(location) {
  const match = location.match(STRUCTURED_ALPHA3_LOCATION_PREFIX);
  return (
    match !== null &&
    NON_US_ISO_ALPHA3_COUNTRY_CODES.has(match[1].toUpperCase())
  );
}

const ISO_ALPHA2_COUNTRY_CODES = (
  "AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ " +
  "BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ " +
  "CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ " +
  "DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR " +
  "GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY " +
  "HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP " +
  "KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY " +
  "MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ " +
  "NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN " +
  "PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL " +
  "SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR " +
  "TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW"
).split(" ");
const ENGLISH_REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" });

function countryNameKey(value) {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[.’']/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

const NON_US_COUNTRY_NAMES = new Set(
  ISO_ALPHA2_COUNTRY_CODES
    .filter((code) => code !== "US")
    .map((code) => countryNameKey(ENGLISH_REGION_NAMES.of(code))),
);
// Common English alternatives for names emitted differently by ICU.
for (const name of [
  "Cape Verde", "Czech Republic", "East Timor", "Ivory Coast",
  "North Korea", "Palestine", "Republic of the Congo", "Russia",
  "South Korea", "Syria", "Taiwan", "Turkey", "UAE", "UK", "Vatican City",
  "Vietnam",
]) {
  NON_US_COUNTRY_NAMES.add(countryNameKey(name));
}
// "Georgia" can be a US state in exactly the same trailing-name position.
NON_US_COUNTRY_NAMES.delete(countryNameKey("Georgia"));

function hasExplicitForeignCountryName(location) {
  const candidates = [];
  const trailing = location.match(/(?:,\s*|\(\s*)([^,()]+?)\s*\)?\s*$/);
  if (trailing) candidates.push(trailing[1]);
  const leadingStructured = location.match(
    /^(.+?)\s+[-–]\s+[^-–]+\s+[-–]\s+/,
  );
  if (leadingStructured) candidates.push(leadingStructured[1]);
  return candidates.some((name) =>
    NON_US_COUNTRY_NAMES.has(countryNameKey(name)),
  );
}

// Unambiguous US markers for locations that carry no state code, e.g. a bare
// "Austin" or "Round Rock, Texas". Deliberately omits names that collide with
// non-US places (Cambridge, Birmingham, Durham, Aurora, Alexandria, Georgia).
const US_LOCATION = new RegExp(
  "\\b(" +
    [
      "alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|wisconsin|wyoming",
      "nyc|brooklyn|manhattan|san francisco|los angeles|san jose|san diego|palo alto|mountain view|menlo park|sunnyvale|cupertino|santa clara|redwood city|berkeley|oakland|fremont|irvine|pasadena|burbank|el segundo|sacramento|seattle|bellevue|redmond|tacoma|spokane|portland|eugene|boise|austin|dallas|houston|fort worth|plano|frisco|san antonio|el paso|phoenix|scottsdale|tempe|chandler|tucson|las vegas|reno|salt lake city|denver|boulder|colorado springs|fort collins|chicago|milwaukee|madison|minneapolis|detroit|ann arbor|indianapolis|columbus|cleveland|cincinnati|pittsburgh|philadelphia|baltimore|bethesda|rockville|reston|mclean|arlington|boston|stamford|hartford|new haven|providence|hoboken|jersey city|buffalo|rochester|syracuse|albany|atlanta|charlotte|raleigh|chapel hill|greensboro|nashville|memphis|knoxville|chattanooga|huntsville|louisville|lexington|new orleans|baton rouge|jacksonville|orlando|tampa|miami|fort lauderdale|boca raton|st\\.? louis|kansas city|omaha|des moines|oklahoma city|tulsa|wichita|albuquerque|anchorage|honolulu",
    ].join("|") +
    ")\\b",
  "i",
);

/**
 * US detection. The public API added locationCountryCode later than this
 * script; fall back to a location-string heuristic when the field is absent.
 * (Heuristic mirrors the "Atlanta, GA is not Gabon" lesson: only trust
 * two-letter tokens that are genuinely US state codes in a state position,
 * and reject anything carrying a known foreign city/country marker first.)
 */
function looksUnitedStates(row) {
  const loc = row.location ?? "";
  if (
    loc &&
    (hasExplicitNonUsAlpha3Country(loc) ||
      hasExplicitForeignCountryName(loc))
  ) {
    return false;
  }
  if (row.locationCountryCode) return row.locationCountryCode === "US";
  if (!loc) return false;
  if (/\b(united states|usa|u\.s\.)\b/i.test(loc)) return true;
  if (NON_US_LOCATION.test(loc)) return false;
  if (/\bUS\b/.test(loc)) return true;
  if (US_LOCATION.test(loc)) return true;
  const suffix = loc.match(/,\s*([A-Z]{2})\s*(?:,|$|\()/);
  if (suffix && US_STATES.has(suffix[1])) return true;
  const prefix = loc.match(/^([A-Z]{2})\s*[-–]/);
  if (prefix && US_STATES.has(prefix[1])) return true;
  return false;
}

function dedupe(rows) {
  const byId = new Map();
  for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row);
  const byPosting = new Map();
  for (const row of byId.values()) {
    const key = `${row.companyName.toLowerCase().trim()}|${row.title.toLowerCase().trim()}|${(row.location ?? "").toLowerCase().trim()}`;
    const prev = byPosting.get(key);
    if (!prev || new Date(row.createdAt) > new Date(prev.createdAt)) byPosting.set(key, row);
  }
  return [...byPosting.values()].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  );
}

function selectLinkEligibleRows(rows, config) {
  if (config.linkMode !== "source") return rows;
  const minimum = config.minDirectLinkCoverageRatio;
  if (!Number.isFinite(minimum) || minimum <= 0 || minimum > 1) {
    throw new Error(
      "source link mode requires minDirectLinkCoverageRatio between 0 and 1",
    );
  }
  const directRows = rows.filter((row) => directSourceUrl(row));
  const excluded = rows.length - directRows.length;
  const ratio = rows.length === 0 ? 0 : directRows.length / rows.length;
  if (ratio < minimum) {
    throw new Error(
      `Direct-link coverage collapsed: ${directRows.length} of ${rows.length} eligible rows (${(ratio * 100).toFixed(1)}%; minimum ${(minimum * 100).toFixed(1)}%). Refusing to overwrite the list.`,
    );
  }
  if (excluded > 0) {
    console.warn(
      `${config.repo}: excluded ${excluded} rows without valid direct source URLs (${(ratio * 100).toFixed(1)}% retained)`,
    );
  }
  return directRows;
}

// ---------- rendering ----------

function esc(text) {
  // Escape everything that can break a markdown table cell or link label.
  return String(text)
    .replace(/[|[\]]/g, (c) => `\\${c}`)
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function isCommunityPresentation(config) {
  return config.presentation === "community";
}

function directSourceUrl(row) {
  const source = typeof row.sourceUrl === "string" ? row.sourceUrl : "";
  if (/[\u0000-\u001f\u007f]/.test(source)) return null;
  const raw = source.trim();
  if (!raw || /\s/u.test(raw)) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (parsed.username || parsed.password) return null;
    const hostname = parsed.hostname.toLowerCase().replace(/\.+$/, "");
    if (!hostname) return null;
    if (
      hostname === "dreamworkhq.com" ||
      hostname.endsWith(".dreamworkhq.com")
    ) {
      return null;
    }
    parsed.hostname = hostname;
    const encodeMarkdownDestination = (component) =>
      component.replace(/[()[\]\\|]/g, (character) =>
        `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
      );
    const candidate =
      `${parsed.protocol}//${parsed.host}` +
      encodeMarkdownDestination(parsed.pathname) +
      encodeMarkdownDestination(parsed.search) +
      encodeMarkdownDestination(parsed.hash);
    const reparsed = new URL(candidate);
    if (
      (reparsed.protocol !== "http:" && reparsed.protocol !== "https:") ||
      reparsed.username ||
      reparsed.password
    ) {
      return null;
    }
    return reparsed.href;
  } catch {
    return null;
  }
}

function jobUrl(row, config) {
  if (config.linkMode === "source") {
    const sourceUrl = directSourceUrl(row);
    if (!sourceUrl) {
      throw new Error(`Listing ${row.id ?? "(missing id)"} has no valid direct source URL`);
    }
    return sourceUrl;
  }
  return `${SITE_BASE}/job/${row.id}?utm_source=github&utm_campaign=${config.utmCampaign}`;
}

function companyUrl(row, config) {
  if (isCommunityPresentation(config) || !row.companyDomain) return null;
  return `${SITE_BASE}/c/${row.companyDomain}?utm_source=github&utm_campaign=${config.utmCampaign}`;
}

function trustedSalaryRange(row) {
  const source = row.salarySource?.trim().toLowerCase();
  if (source !== "posted" && source !== "extracted") return null;
  const { salaryMin: min, salaryMax: max } = row;
  if (!min || !max || min > max) return null;
  if (min >= 15 && max <= 300) return { min, max, period: "hourly" };
  if (min < 20000 || max > 900000) return null; // currency-conversion junk in corpus
  if (max > min * 6) return null; // implausible spread (e.g. $65K–$800K) → parse artifact
  return { min, max, period: "annual" };
}

function formatSalary(row) {
  const salary = trustedSalaryRange(row);
  if (!salary) return "";
  const { min, max } = salary;
  if (salary.period === "hourly") return `$${min}–$${max}/hr`;
  const k = (n) => `$${Math.round(n / 1000)}K`;
  return min === max ? k(min) : `${k(min)}–${k(max)}`;
}

function formatLocation(row) {
  let loc = esc(row.location ?? "");
  if (/^(anywhere|remote)$/i.test(loc)) loc = "";
  if (row.remoteType === "remote") return loc ? `Remote (${truncate(loc, 40)})` : "Remote";
  loc = truncate(loc || "—", 44);
  if (row.remoteType === "hybrid") return `${loc} (Hybrid)`;
  return loc;
}

function formatAge(row, now) {
  const seen = new Date(row.createdAt);
  const days = Math.max(0, Math.floor((now - seen) / 86400000));
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

const AI_KIND_LABELS = {
  ai_first: "AI-first",
  ai_explicit: "AI-focused",
  ai_enabled: "AI-enabled",
};

// No separate Apply column: the role link opens the Dreamwork job page,
// which is the apply path, and the duplicate URL per row would push
// inventory-size lists past GitHub's markdown render cutoff.
function renderTable(rows, config, now) {
  const showAi = Boolean(config.showAiColumn);
  const header = ["Company", "Role", "Location", ...(showAi ? ["AI focus"] : []), "Pay", "Added"];
  const lines = [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => " --- |").join("")}`,
  ];
  for (const row of rows) {
    const cUrl = companyUrl(row, config);
    const company = cUrl
      ? `**[${truncate(esc(row.companyName), 32)}](${cUrl})**`
      : `**${truncate(esc(row.companyName), 32)}**`;
    const role = `[${truncate(esc(row.title), 72)}](${jobUrl(row, config)})`;
    const cells = [
      company,
      role,
      formatLocation(row),
      ...(showAi ? [AI_KIND_LABELS[row.aiRoleKind] ?? ""] : []),
      formatSalary(row),
      formatAge(row, now),
    ];
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines.join("\n");
}

// GitHub's anchor algorithm: lowercase, drop punctuation, spaces to hyphens.
function anchorSlug(text) {
  return text.toLowerCase().replace(/[^a-z0-9 -]/g, "").trim().replace(/ +/g, "-");
}

/**
 * Group rows into sections by the configured listing field. Unlabelled tiny
 * groups are pooled into "Other" so large, varied boards stay browsable;
 * explicitly labelled groups are preserved because the config defines their
 * intended information architecture. Returns { toc, body }.
 */
function renderSections(rows, config, now) {
  if (!config.groupBy) {
    return { toc: "", body: renderTable(rows, config, now) };
  }
  const groups = new Map();
  for (const row of rows) {
    const rawKey = row[config.groupBy] || "Other";
    const key = config.groupLabels?.[rawKey] ?? rawKey;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const minGroupSize = config.groupLabels ? 1 : 5;
  const named = [...groups.entries()].filter(([k, v]) => k !== "Other" && v.length >= minGroupSize);
  named.sort((a, b) => b[1].length - a[1].length);
  const leftovers = [...groups.entries()]
    .filter(([k, v]) => k === "Other" || v.length < minGroupSize)
    .flatMap(([, v]) => v)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const sections = [...named];
  if (leftovers.length > 0) sections.push(["Other", leftovers]);

  const toc = sections
    .map(([name, list]) => {
      const title = `${name} (${list.length})`;
      return `- [${name}](#${anchorSlug(title)}) · ${list.length} roles`;
    })
    .join("\n");
  const body = sections
    .map(([name, list]) => `### ${name} (${list.length})\n\n${renderTable(list, config, now)}`)
    .join("\n\n");
  return { toc: `${toc}\n`, body };
}

function renderGrowthReadme(rows, config, now) {
  const updated = now.toISOString().slice(0, 10);
  const matchesUrl = `${SITE_BASE}/?utm_source=github&utm_medium=readme_cta&utm_campaign=${config.utmCampaign}`;
  const { toc, body } = renderSections(rows, config, now);
  const inventoryScope =
    rows.length >= (config.usOpenTotal ?? rows.length)
      ? `All **${rows.length}** currently open roles are listed.`
      : `The **${rows.length}** newest of **${config.usOpenTotal}** currently open roles are listed (GitHub caps how much of a page it renders).`;
  const totalMatchingLabel = `${(config.totalMatching ?? 0).toLocaleString("en-US")}${config.totalMatchingCapped ? "+" : ""}`;
  const statsLine =
    config.mode === "inventory"
      ? `Last updated: **${updated}**. ${inventoryScope} The crawler rechecks every listing daily, so closed roles drop off automatically. Salary shows when the posting discloses it. Click a role to see details and apply.`
      : `Last updated: **${updated}**. Showing the **${rows.length}** most recently indexed roles, curated from **${totalMatchingLabel}** open listings on Dreamwork. Salary shows when the posting discloses it. Click a role to see details and apply.`;
  const intlLine = config.intlCount
    ? `\nHiring outside the US? **${config.intlCount}** international roles are listed separately in [INTERNATIONAL.md](INTERNATIONAL.md).\n`
    : "";

  const siblings = (config.siblings ?? [])
    .map((s) => `- [${s.label}](https://github.com/${s.repo})`)
    .join("\n");

  const faq = (config.faq ?? [])
    .map((f) => `<details>\n<summary><strong>${f.q}</strong></summary>\n\n${f.a}\n\n</details>`)
    .join("\n\n");

  const repoFull = `${config.owner}/${config.repo}`;
  const shieldRoles = `https://img.shields.io/badge/open_roles-${rows.length}-7C3AED?labelColor=131318&style=flat-square`;
  const shieldUpdated = `https://img.shields.io/github/last-commit/${repoFull}?label=updated&color=3B82F6&labelColor=131318&style=flat-square`;
  const linkRow = [
    `<a href="${SITE_BASE}/?utm_source=github&utm_medium=link_row&utm_campaign=${config.utmCampaign}">dreamworkhq.com</a>`,
    `<a href="${SITE_BASE}/blog?utm_source=github&utm_medium=link_row&utm_campaign=${config.utmCampaign}">Blog</a>`,
    `<a href="${SITE_BASE}/research?utm_source=github&utm_medium=link_row&utm_campaign=${config.utmCampaign}">Hiring research</a>`,
    `<a href="../../issues">Report a listing</a>`,
  ].join("\n  ·\n  ");

  const bannerAlt = "Dreamwork puts your job search in Pro mode by ranking live roles for your resume";
  const ctaAlt = "Match my resume";

  return `<a href="${matchesUrl}">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./static/img/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="./static/img/banner-light.svg">
    <img src="./static/img/banner-light.svg" alt="${bannerAlt}" width="100%">
  </picture>
</a>

<h1 align="center">${config.title}</h1>

<p align="center">${config.tagline}</p>

<p align="center">
  <img src="${shieldRoles}" alt="${rows.length} open roles">
  <img src="${shieldUpdated}" alt="last updated">
</p>

<p align="center">
  <a href="${matchesUrl}">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="./static/img/btn-matches-dark.svg">
      <source media="(prefers-color-scheme: light)" srcset="./static/img/btn-matches-light.svg">
      <img src="./static/img/btn-matches-light.svg" width="340" alt="${ctaAlt}">
    </picture>
  </a>
</p>

<p align="center">
  ${linkRow}
</p>

Star this repo and new roles land in your GitHub feed every day. Listings come from [Dreamwork](${matchesUrl}), which crawls 400,000+ jobs directly from company career pages.

${statsLine}
${intlLine}
${config.legend ? `${config.legend}\n` : ""}${toc ? `\n${toc}` : ""}
<!-- TABLE_START (auto-generated: do not edit by hand; edits are overwritten daily) -->

${body}

<!-- TABLE_END -->

Rather not scan a table? [Dreamwork](${matchesUrl}) matches your resume against every role in this list and can apply for you. The free tier shows all your matches.

## More daily lists

${siblings}
- [Dreamwork Research, live hiring data](${SITE_BASE}/research?utm_source=github&utm_medium=readme_links&utm_campaign=${config.utmCampaign})
- [How to use Dreamwork, guides and tutorials](${SITE_BASE}/how-to?utm_source=github&utm_medium=readme_links&utm_campaign=${config.utmCampaign})

## FAQ

${faq}

## How this list is built

A [GitHub Action](.github/workflows/update.yml) runs once a day. It queries Dreamwork's public listings API, filters for ${config.keywords}, removes duplicates, and rewrites this README. The raw snapshot lives in [\`data/listings.json\`](data/listings.json). Listings are crawled directly from company career pages and ATS boards (Greenhouse, Lever, Ashby, Workday, and others), so links go to real, currently open postings. Found a bad listing? [Open an issue](../../issues).
`;
}

function representedCompanyCount(rows) {
  return new Set(
    rows.map((row) => String(row.companyName).trim().toLowerCase()),
  ).size;
}

function addedInLast24Hours(rows, now) {
  const nowMs = now.getTime();
  const cutoffMs = nowMs - 24 * 60 * 60 * 1000;
  return rows.filter((row) => {
    const createdMs = new Date(row.createdAt).getTime();
    return (
      Number.isFinite(createdMs) &&
      createdMs >= cutoffMs &&
      createdMs <= nowMs
    );
  }).length;
}

function renderCommunityReadme(rows, config, now) {
  const updated = now.toISOString().slice(0, 10);
  const companies = representedCompanyCount(rows);
  const addedToday = addedInLast24Hours(rows, now);
  const { toc, body } = renderSections(rows, config, now);
  return `# ${config.title}

${config.tagline}

**${rows.length} open internships** · **${companies} companies** · **${addedToday} added in the last 24 hours** · Updated **${updated}**

Indexed from company career pages and maintained by [Dreamwork](https://github.com/dreamworkhq).

${toc ? `${toc}\n` : ""}<!-- TABLE_START (auto-generated: do not edit by hand; edits are overwritten daily) -->

${body}

<!-- TABLE_END -->

## How this list is built

A [GitHub Action](.github/workflows/update.yml) refreshes this list once a day from Dreamwork's public job index. It filters for ${config.keywords}, removes duplicates, and drops listings after the crawler can no longer verify that they are open. The raw snapshot is available in [\`data/listings.json\`](data/listings.json).

Found a bad or missing listing? [Open an issue](../../issues).
`;
}

function renderReadme(rows, config, now) {
  return isCommunityPresentation(config)
    ? renderCommunityReadme(rows, config, now)
    : renderGrowthReadme(rows, config, now);
}

function renderIntl(rows, config, now) {
  const updated = now.toISOString().slice(0, 10);
  const matchesUrl = `${SITE_BASE}/?utm_source=github&utm_medium=intl_readme&utm_campaign=${config.utmCampaign}`;
  const { toc, body } = renderSections(rows, config, now);
  return `# ${config.title}: international

Roles outside the United States, from the same daily crawl as [the US list](README.md). Locations are shown per row; grouping by country will come once the public API exposes country codes.

Last updated: **${updated}**. **${rows.length}** currently open international roles. Click a role to see details and apply, or let [Dreamwork](${matchesUrl}) match them to your resume.

${toc ? `${toc}\n` : ""}<!-- TABLE_START (auto-generated: do not edit by hand; edits are overwritten daily) -->

${body}

<!-- TABLE_END -->
`;
}

/**
 * GitHub stops rendering markdown files around 500 KiB; trim rows until the
 * rendered document fits with margin, so a growing corpus degrades to
 * "newest N" instead of an unrendered wall of text.
 */
const RENDER_LIMIT_BYTES = 460000;
function fitToRenderLimit(rows, render) {
  let n = rows.length;
  let text = render(rows);
  while (Buffer.byteLength(text) > RENDER_LIMIT_BYTES && n > 50) {
    n = Math.floor(n * 0.9);
    text = render(rows.slice(0, n));
  }
  return { text, kept: n };
}

function renderJson(rows, config, now) {
  return `${JSON.stringify(
    {
      generatedAt: now.toISOString(),
      source:
        config.linkMode === "source"
          ? "dreamwork-public-job-index"
          : "https://www.dreamworkhq.com",
      list: config.repo,
      count: rows.length,
      listings: rows.map((row) => {
        const salary = trustedSalaryRange(row);
        return {
          id: row.id,
          title: row.title,
          company: row.companyName,
          companyDomain: row.companyDomain ?? null,
          location: row.location ?? null,
          remoteType: row.remoteType ?? null,
          salaryMin: salary?.min ?? null,
          salaryMax: salary?.max ?? null,
          salaryPeriod: salary?.period ?? null,
          aiRoleKind: row.aiRoleKind ?? null,
          postedAt: row.postedAt ?? null,
          firstIndexedAt: row.createdAt,
          url: jobUrl(row, config),
        };
      }),
    },
    null,
    2,
  )}\n`;
}

const DEFAULT_MIN_PREVIOUS_COUNT_RATIO = 0.7;
const DEFAULT_MIN_PREVIOUS_OVERLAP_RATIO = 0.4;

function loadPreviousSnapshot(out, config) {
  const snapshotPath = join(out, "data", "listings.json");
  if (!existsSync(snapshotPath)) return null;
  let snapshot;
  try {
    snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Existing ${snapshotPath} is not valid JSON; refusing to overwrite it.`,
      { cause: error },
    );
  }
  if (
    snapshot?.list !== config.repo ||
    !Array.isArray(snapshot.listings) ||
    snapshot.listings.some((listing) => !listing?.id)
  ) {
    throw new Error(
      `Existing ${snapshotPath} does not match ${config.repo}; refusing to overwrite it.`,
    );
  }
  return snapshot;
}

function assertPreviousSnapshotHealth(rows, previous, config) {
  if (!previous || previous.listings.length === 0) return;
  if (process.env.DREAMWORK_JOB_LIST_ALLOW_SNAPSHOT_RESET === "1") {
    console.warn(
      `${config.repo}: bypassing previous-snapshot health gate via DREAMWORK_JOB_LIST_ALLOW_SNAPSHOT_RESET=1`,
    );
    return;
  }
  const previousIds = new Set(previous.listings.map((listing) => listing.id));
  const currentIds = new Set(rows.map((row) => row.id));
  const overlap = [...previousIds].filter((id) => currentIds.has(id)).length;
  const countRatio = rows.length / previousIds.size;
  const overlapRatio = overlap / previousIds.size;
  const minCountRatio =
    config.minPreviousCountRatio ?? DEFAULT_MIN_PREVIOUS_COUNT_RATIO;
  // Inventory lists should retain most IDs between runs. A capped fresh feed
  // intentionally rolls over as newly indexed jobs enter the newest window,
  // so its durable safety signal is count retention rather than ID overlap.
  const minOverlapRatio =
    config.minPreviousOverlapRatio ??
    (config.mode === "fresh" ? 0 : DEFAULT_MIN_PREVIOUS_OVERLAP_RATIO);
  if (countRatio < minCountRatio || overlapRatio < minOverlapRatio) {
    throw new Error(
      `Snapshot health check failed: ${rows.length} current rows vs ${previousIds.size} previous (${(countRatio * 100).toFixed(1)}% count retention), ${overlap} retained ids (${(overlapRatio * 100).toFixed(1)}% overlap). Minimums are ${(minCountRatio * 100).toFixed(1)}% count and ${(minOverlapRatio * 100).toFixed(1)}% overlap. Refusing to overwrite the list.`,
    );
  }
}

// ---------- main ----------

const { configPath, out } = parseArgs(process.argv.slice(2));
const config = JSON.parse(readFileSync(configPath, "utf8"));
const now = new Date();

let all = [];
let totalMatching = 0;
let totalMatchingCapped = false;
for (const source of config.sources) {
  const params = new URLSearchParams({ limit: "1" });
  for (const [k, v] of Object.entries(source)) {
    if (v !== null && v !== undefined && v !== "") params.set(k, String(v));
  }
  const head = await fetchJson(`${API_BASE}/listings?${params}`);
  totalMatching += head.total ?? 0;
  totalMatchingCapped ||= head.totalCapped === true;
  all = all.concat(await fetchSource(source, config));
}
config.totalMatching = totalMatching;
config.totalMatchingCapped = totalMatchingCapped;

// Partition and pick the display set.
// inventory mode: every verified-open matching role (US in README,
// the rest in INTERNATIONAL.md). fresh mode: the newest maxRows.
const deduped = dedupe(all);
const linkEligibleRows = selectLinkEligibleRows(deduped, config);
const usRows = linkEligibleRows.filter((row) => looksUnitedStates(row));
const intlRows = linkEligibleRows.filter((row) => !looksUnitedStates(row));
let readmeRows = config.usOnly ? usRows : linkEligibleRows;
if (config.mode !== "inventory") {
  readmeRows = readmeRows.slice(0, config.maxRows ?? 600);
}

config.usOpenTotal = readmeRows.length;

if (readmeRows.length < (config.minRows ?? 10)) {
  throw new Error(
    `Only ${readmeRows.length} rows after filtering; refusing to overwrite the list (minRows=${config.minRows ?? 10}).`,
  );
}

const intl =
  config.international && intlRows.length >= 25
    ? fitToRenderLimit(intlRows, (r) => renderIntl(r, config, now))
    : null;
const intlKept = intl?.kept ?? 0;
config.intlCount = intlKept;

const readme = fitToRenderLimit(readmeRows, (r) => renderReadme(r, config, now));
const jsonRows = (config.usOnly ? usRows.concat(intlRows.slice(0, intlKept)) : readmeRows).slice(0, 1500);
assertPreviousSnapshotHealth(jsonRows, loadPreviousSnapshot(out, config), config);

// All remote fetch, filtering, rendering, and health checks complete before
// the first output mutation, so a failed run preserves the last good snapshot.
mkdirSync(join(out, "data"), { recursive: true });
if (intl) writeFileSync(join(out, "INTERNATIONAL.md"), intl.text);
writeFileSync(join(out, "README.md"), readme.text);
writeFileSync(join(out, "data", "listings.json"), renderJson(jsonRows, config, now));
console.log(
  `${config.repo}: README ${readme.kept} rows (${config.mode ?? "fresh"}), intl ${intlKept}, json ${jsonRows.length}, ${totalMatching} matching upstream -> ${out}`,
);
