// src/lib/web.ts

export type WebResult = {
  didWeb: boolean;
  webContext: string;
};

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

type DynamicRetrievalOpts = {
  threshold?: number;
};

type WebSearchOptions = {
  maxResults?: number;
  timeoutMs?: number;
  dynamicRetrieval?: DynamicRetrievalOpts;
};

export function isWeatherLikeQuery(q: string) {
  const s = (q || "").toLowerCase();
  return (
    s.includes("sää") ||
    s.includes("ennuste") ||
    s.includes("lämpö") ||
    s.includes("lämpötila") ||
    s.includes("tuuli") ||
    s.includes("sade") ||
    s.includes("weather") ||
    s.includes("forecast") ||
    s.includes("temperature") ||
    s.includes("wind") ||
    s.includes("rain") ||
    s.includes("clima") ||
    s.includes("tiempo") ||
    s.includes("temperatura") ||
    s.includes("viento") ||
    s.includes("lluvia") ||
    s.includes("pronóstico") ||
    s.includes("pronostico")
  );
}

function isNewsLikeQuery(q: string) {
  const s = cleanText(q).toLowerCase();

  return (
    s.includes("uuti") ||
    s.includes("uutiset") ||
    s.includes("ulkomaan uutiset") ||
    s.includes("maailman uutiset") ||
    s.includes("päivän uutiset") ||
    s.includes("paivan uutiset") ||
    s.includes("tuoreimmat uutiset") ||
    s.includes("news") ||
    s.includes("latest news") ||
    s.includes("world news") ||
    s.includes("international news") ||
    s.includes("top news") ||
    s.includes("breaking news") ||
    s.includes("noticias") ||
    s.includes("últimas noticias") ||
    s.includes("ultimas noticias") ||
    s.includes("noticias del mundo") ||
    s.includes("internacionales")
  );
}

function isGenericNewsQuery(q: string) {
  const s = cleanText(q).toLowerCase();

  const genericPatterns = [
    "hae päivän ulkomaan uutiset",
    "päivän ulkomaan uutiset",
    "ulkomaan uutiset",
    "päivän uutiset",
    "paivan uutiset",
    "tämän päivän uutiset",
    "taman paivan uutiset",
    "maailman uutiset",
    "tuoreimmat uutiset",
    "uusimmat uutiset",
    "latest news",
    "news today",
    "today news",
    "top news",
    "world news",
    "international news",
    "latest world news",
    "breaking news",
    "noticias de hoy",
    "últimas noticias",
    "ultimas noticias",
    "noticias del mundo",
  ];

  return genericPatterns.some((p) => s === p || s.includes(p));
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  if (!ms || ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("webSearch timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function cleanText(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim();
}

function fmtMaybe(n: any, suffix: string) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "";
  return `${Math.round(x)}${suffix}`;
}

function fmtDateYYYYMMDD(d: string) {
  return String(d || "").slice(0, 10);
}

function decodeHtmlEntities(input: string): string {
  return String(input || "")
    .replace(/<!\[CDATA\[(.*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : "";
    });
}

function stripHtml(s: string): string {
  return decodeHtmlEntities(String(s || "").replace(/<[^>]+>/g, " "));
}

function xmlTagValue(block: string, tag: string): string {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = String(block || "").match(re);
  return m?.[1] ? cleanText(stripHtml(m[1])) : "";
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, "");
  } catch {
    return "";
  }
}

function dedupeResults(items: WebSearchResult[]): WebSearchResult[] {
  const seen = new Set<string>();
  const out: WebSearchResult[] = [];

  for (const it of items) {
    const url = cleanText(it.url);
    const title = cleanText(it.title);
    const key = `${url}__${title}`.toLowerCase();
    if (!url && !title) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title,
      url,
      snippet: cleanText(it.snippet),
    });
  }

  return out;
}

// --- Geocoding via Open-Meteo (no key) ---
async function geocodePlace(place: string): Promise<{ name: string; lat: number; lon: number; admin1?: string; country?: string } | null> {
  const url =
    "https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=" +
    encodeURIComponent(place);

  const res = await fetch(url, { method: "GET" });
  if (!res.ok) return null;

  const j: any = await res.json().catch(() => null);
  const r = j?.results?.[0];
  if (!r) return null;

  const lat = Number(r.latitude);
  const lon = Number(r.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const name = String(r.name || place);
  const admin1 = r.admin1 ? String(r.admin1) : undefined;
  const country = r.country ? String(r.country) : undefined;

  return { name, lat, lon: lon, admin1, country };
}

function guessPlaceFromWeatherQuery(qRaw: string): string | null {
  const q = cleanText(qRaw);
  if (!q) return null;
  if (!isWeatherLikeQuery(q)) return null;

  const patterns: RegExp[] = [
    /(?:sää|ennuste|lämpötila|lämpö|tuuli|sade)\s+(?:paikassa\s+|kohteessa\s+|)\s*([A-Za-zÀ-ÿ0-9'’\-]+(?:\s+[A-Za-zÀ-ÿ0-9'’\-]+){0,2})\s*$/i,
    /(?:weather|forecast|temperature|wind|rain)\s+(?:in\s+|at\s+)?([A-Za-zÀ-ÿ0-9'’\-]+(?:\s+[A-Za-zÀ-ÿ0-9'’\-]+){0,2})\s*$/i,
    /(?:tiempo|clima|pronóstico|pronostico|temperatura|viento|lluvia)\s+(?:en\s+)?([A-Za-zÀ-ÿ0-9'’\-]+(?:\s+[A-Za-zÀ-ÿ0-9'’\-]+){0,2})\s*$/i,
    /(?:in|at|en)\s+([A-Za-zÀ-ÿ0-9'’\-]+(?:\s+[A-Za-zÀ-ÿ0-9'’\-]+){0,2})\s*$/i,
  ];

  for (const re of patterns) {
    const m = q.match(re);
    if (m?.[1]) {
      const cand = cleanText(m[1]);
      if (cand) return cand;
    }
  }

  const stop = new Set([
    "mikä","mika","millainen","minkälainen","minkalainen","anna","kerro","on","oli","nyt","tänään","tanaan","huomenna",
    "tämän","taman","päivän","paivan","päivä","paiva","viikko","viikon","vko","vk","7pv","7päivää","7paivaa","7",
    "ensi","seuraava","seuraavan","tuleva","tulevan","tulevat",
    "sää","saa","ennuste","lämpö","lammo","lampö","lämpötila","lampotila","tuuli","sade","aurinko","pilvi","pilvinen","sadetta","sataa",
    "what","whats","what's","is","the","a","an","in","at","today","tomorrow","now","week","weekly","next","upcoming",
    "weather","forecast","temperature","wind","rain",
    "qué","que","cuál","cual","cómo","como","hace","en","el","la","los","las","un","una","hoy","mañana","manana","ahora",
    "semana","semanal","próxima","proxima","siguiente","tiempo","clima","temperatura","viento","lluvia","pronóstico","pronostico",
    "please","por","favor",
  ]);

  const cleaned = q.replace(/[?.!,;:()]/g, " ").replace(/\s+/g, " ").trim();
  const tokens = cleaned.split(" ").filter(Boolean);

  const good: string[] = [];
  for (const tok of tokens) {
    const t = tok.toLowerCase();
    if (stop.has(t)) continue;
    if (/^\d+$/.test(t)) continue;
    good.push(tok);
  }

  if (!good.length) return null;

  const candidates: string[] = [];
  candidates.push(good.slice(0, 3).join(" "));
  candidates.push(good.slice(0, 2).join(" "));
  candidates.push(good.slice(0, 1).join(" "));
  candidates.push(good.slice(-3).join(" "));
  candidates.push(good.slice(-2).join(" "));
  candidates.push(good.slice(-1).join(" "));

  const uniq = Array.from(new Set(candidates.map((c) => cleanText(c)).filter(Boolean)));
  return uniq[0] || null;
}

function placeVariants(place: string): string[] {
  const p = cleanText(place);
  if (!p) return [];

  const variants = new Set<string>();
  variants.add(p);
  variants.add(p.toLowerCase());
  variants.add(p.charAt(0).toUpperCase() + p.slice(1));
  variants.add(p.replace(/(ssa|ssä|sta|stä)$/i, ""));
  variants.add(p.replace(/(essa|essä)$/i, "e"));

  const first = p.split(" ")[0];
  if (first) variants.add(first);

  return Array.from(variants).map((x) => cleanText(x)).filter(Boolean);
}

// --- Weather context (7 day) via Open-Meteo (no key) ---
async function weatherContext(query: string): Promise<string> {
  const q = cleanText(query);
  if (!isWeatherLikeQuery(q)) return "";

  const guessed = guessPlaceFromWeatherQuery(q);
  const tail = guessed || process.env.AJX_DEFAULT_PLACE || "Torrevieja";
  const candidates = placeVariants(tail);

  let geo: { name: string; lat: number; lon: number; admin1?: string; country?: string } | null = null;
  for (const c of candidates) {
    geo = await geocodePlace(c);
    if (geo) break;
  }
  if (!geo) return "";

  const forecastUrl =
    "https://api.open-meteo.com/v1/forecast?timezone=auto" +
    "&current=temperature_2m,wind_speed_10m,weather_code" +
    "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max" +
    "&forecast_days=7" +
    "&latitude=" + encodeURIComponent(String(geo.lat)) +
    "&longitude=" + encodeURIComponent(String(geo.lon));

  const res = await fetch(forecastUrl, { method: "GET" });
  if (!res.ok) return "";

  const j: any = await res.json().catch(() => null);
  if (!j) return "";

  const placeLineParts = [geo.name];
  if (geo.admin1) placeLineParts.push(geo.admin1);
  if (geo.country) placeLineParts.push(geo.country);

  const curT = fmtMaybe(j?.current?.temperature_2m, "°C");
  const curW = fmtMaybe(j?.current?.wind_speed_10m, " km/h");

  const times: any[] = Array.isArray(j?.daily?.time) ? j.daily.time : [];
  const tMaxArr: any[] = Array.isArray(j?.daily?.temperature_2m_max) ? j.daily.temperature_2m_max : [];
  const tMinArr: any[] = Array.isArray(j?.daily?.temperature_2m_min) ? j.daily.temperature_2m_min : [];
  const popArr: any[] = Array.isArray(j?.daily?.precipitation_probability_max) ? j.daily.precipitation_probability_max : [];
  const windMaxArr: any[] = Array.isArray(j?.daily?.wind_speed_10m_max) ? j.daily.wind_speed_10m_max : [];

  const lines: string[] = [];
  lines.push("WEB-KONTEKSTI (sää, 7 pv)");
  lines.push(`Paikka: ${placeLineParts.join(", ")}`);

  const curBits = [curT ? `Nyt: ${curT}` : "", curW ? `tuuli ${curW}` : ""].filter(Boolean);
  if (curBits.length) lines.push(curBits.join(", "));

  if (times.length) {
    lines.push("Ennuste (päiväkohtainen):");
    const n = Math.min(7, times.length, tMaxArr.length || 999, tMinArr.length || 999);
    for (let i = 0; i < n; i++) {
      const d = fmtDateYYYYMMDD(times[i]);
      const tMin = fmtMaybe(tMinArr[i], "°C");
      const tMax = fmtMaybe(tMaxArr[i], "°C");
      const pop = fmtMaybe(popArr[i], "%");
      const wMax = fmtMaybe(windMaxArr[i], " km/h");

      const parts = [
        `${d}:`,
        tMin && tMax ? `${tMin}–${tMax}` : tMax ? `max ${tMax}` : tMin ? `min ${tMin}` : "",
        pop ? `sade ${pop}` : "",
        wMax ? `tuuli max ${wMax}` : "",
      ].filter(Boolean);

      lines.push(`- ${parts.join(" | ")}`);
    }
  }

  lines.push("(Lähde: Open-Meteo)");
  return lines.join("\n").trim();
}

// =========================
// NO-KEY: Crypto + FX helpers
// =========================

function isCryptoLikeQuery(q: string): boolean {
  const s = cleanText(q).toLowerCase();
  return (
    s.includes("bitcoin") ||
    s.includes("btc") ||
    s.includes("ethereum") ||
    s.includes("eth") ||
    s.includes("solana") ||
    s.includes("sol") ||
    s.includes("dogecoin") ||
    s.includes("doge") ||
    s.includes("krypt") ||
    s.includes("crypto")
  );
}

function guessCryptoIds(q: string): { ids: string[]; symbols: string[] } {
  const s = cleanText(q).toLowerCase();

  const map: Array<{ id: string; sym: string; keys: string[] }> = [
    { id: "bitcoin", sym: "BTC", keys: ["bitcoin", "btc"] },
    { id: "ethereum", sym: "ETH", keys: ["ethereum", "eth"] },
    { id: "solana", sym: "SOL", keys: ["solana", "sol"] },
    { id: "dogecoin", sym: "DOGE", keys: ["dogecoin", "doge"] },
    { id: "cardano", sym: "ADA", keys: ["cardano", "ada"] },
    { id: "ripple", sym: "XRP", keys: ["xrp", "ripple"] },
  ];

  const ids: string[] = [];
  const symbols: string[] = [];
  for (const m of map) {
    if (m.keys.some((k) => s.includes(k))) {
      ids.push(m.id);
      symbols.push(m.sym);
    }
  }

  if (!ids.length && isCryptoLikeQuery(s)) {
    ids.push("bitcoin");
    symbols.push("BTC");
  }

  return { ids, symbols };
}

async function cryptoPriceContext(query: string): Promise<string> {
  const q = cleanText(query);
  if (!q) return "";
  if (!isCryptoLikeQuery(q)) return "";

  const { ids, symbols } = guessCryptoIds(q);
  if (!ids.length) return "";

  const url =
    "https://api.coingecko.com/api/v3/simple/price?include_last_updated_at=true&vs_currencies=eur&ids=" +
    encodeURIComponent(ids.join(","));

  const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
  if (!res.ok) return "";

  const j: any = await res.json().catch(() => null);
  if (!j || typeof j !== "object") return "";

  const lines: string[] = [];
  lines.push("WEB-KONTEKSTI (krypto, reaaliaika)");
  lines.push("(Lähde: CoinGecko)");

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const sym = symbols[i] || id.toUpperCase();
    const eur = j?.[id]?.eur;
    const updatedAt = j?.[id]?.last_updated_at;

    const priceNum = Number(eur);
    if (!Number.isFinite(priceNum)) continue;

    const upd = Number(updatedAt);
    const updStr = Number.isFinite(upd) && upd > 0 ? new Date(upd * 1000).toISOString() : "";

    lines.push(`- ${sym}: ${priceNum} EUR${updStr ? ` (päivitetty ${updStr})` : ""}`);
  }

  return lines.length > 2 ? lines.join("\n").trim() : "";
}

function isFxLikeQuery(q: string): boolean {
  const s = cleanText(q).toLowerCase();

  if (s.includes("dollarin") && s.includes("euro")) return true;
  if (s.includes("usd") && s.includes("eur")) return true;
  if (s.includes("kurssi") && (s.includes("usd") || s.includes("dollari")) && (s.includes("eur") || s.includes("euro"))) return true;

  if (s.includes("usd") && s.includes("eur")) return true;
  if (s.includes("dollar") && s.includes("euro")) return true;
  if (s.includes("exchange rate") && (s.includes("usd") || s.includes("dollar")) && (s.includes("eur") || s.includes("euro"))) return true;

  if (s.includes("dólar") && s.includes("euro")) return true;
  if (s.includes("dolar") && s.includes("euro")) return true;

  return false;
}

async function fxRateContext(query: string): Promise<string> {
  const q = cleanText(query);
  if (!q) return "";
  if (!isFxLikeQuery(q)) return "";

  const url = "https://api.exchangerate.host/latest?base=USD&symbols=EUR";
  const res = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
  if (!res.ok) return "";

  const j: any = await res.json().catch(() => null);
  const rate = Number(j?.rates?.EUR);
  if (!Number.isFinite(rate)) return "";

  const date = cleanText(j?.date || "");
  const lines: string[] = [];
  lines.push("WEB-KONTEKSTI (valuutta, reaaliaika)");
  lines.push(`- USD → EUR: ${rate}${date ? ` (päivä: ${date})` : ""}`);
  lines.push("(Lähde: exchangerate.host)");
  return lines.join("\n").trim();
}

// =========================
// NO-KEY: News helper
// =========================

async function fetchRssItems(url: string, maxResults: number): Promise<WebSearchResult[]> {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      "User-Agent": "Mozilla/5.0 AJX-AI",
    },
  });

  if (!res.ok) return [];

  const xml = await res.text().catch(() => "");
  if (!xml) return [];

  const items = xml.match(/<item>([\s\S]*?)<\/item>/gi) || [];
  const out: WebSearchResult[] = [];

  for (const item of items.slice(0, maxResults)) {
    const title = xmlTagValue(item, "title");
    const link = xmlTagValue(item, "link");
    const pubDate = xmlTagValue(item, "pubDate");
    const description = xmlTagValue(item, "description");
    const source = xmlTagValue(item, "source");

    const snippet = [source, pubDate, description].filter(Boolean).join(" | ");

    out.push({
      title,
      url: link,
      snippet: cleanText(snippet),
    });
  }

  return dedupeResults(out);
}

async function googleNewsTopicWorld(maxResults: number): Promise<WebSearchResult[]> {
  return fetchRssItems("https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en", maxResults);
}

async function googleNewsTopicTop(maxResults: number): Promise<WebSearchResult[]> {
  return fetchRssItems("https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en", maxResults);
}

async function googleNewsSearch(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const url =
    "https://news.google.com/rss/search?q=" +
    encodeURIComponent(cleanText(query)) +
    "&hl=en-US&gl=US&ceid=US:en";

  return fetchRssItems(url, maxResults);
}

async function newsContext(query: string, maxResults: number): Promise<string> {
  const q = cleanText(query);
  if (!q) return "";
  if (!isNewsLikeQuery(q)) return "";

  let results: WebSearchResult[] = [];

  if (isGenericNewsQuery(q)) {
    const world = await googleNewsTopicWorld(maxResults);
    const top = await googleNewsTopicTop(maxResults);
    results = dedupeResults([...world, ...top]).slice(0, maxResults);
  } else {
    results = await googleNewsSearch(q, maxResults);
  }

  if (!results.length) return "";

  const lines: string[] = [];
  lines.push("WEB-KONTEKSTI (uutiset)");
  lines.push("(Lähde: Google News RSS)");

  results.forEach((r, idx) => {
    const title = cleanText(r.title);
    const url = cleanText(r.url);
    const snippet = cleanText(r.snippet);
    const domain = extractDomain(url);

    lines.push(`${idx + 1}. ${title || "(ei otsikkoa)"}`);
    if (domain) lines.push(`   Lähde: ${domain}`);
    if (url) lines.push(`   ${url}`);
    if (snippet) lines.push(`   ${snippet}`);
  });

  return lines.join("\n").trim();
}

function formatWebContext(results: WebSearchResult[]): string {
  if (!results.length) return "";
  const lines: string[] = [];
  lines.push("WEB-KONTEKSTI (hakutulokset)");
  results.forEach((r, idx) => {
    const title = cleanText(r.title);
    const url = cleanText(r.url);
    const snippet = cleanText(r.snippet);
    const domain = extractDomain(url);

    lines.push(`${idx + 1}. ${title || "(ei otsikkoa)"}`);
    if (domain) lines.push(`   Lähde: ${domain}`);
    if (url) lines.push(`   ${url}`);
    if (snippet) lines.push(`   ${snippet}`);
  });
  return lines.join("\n");
}

async function tavilySearch(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return [];
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: maxResults,
      include_answer: false,
      include_images: false,
    }),
  });
  if (!res.ok) return [];
  const data = (await res.json().catch(() => null)) as any;
  const items = Array.isArray(data?.results) ? data.results : [];
  return dedupeResults(
    items.slice(0, maxResults).map((it: any) => ({
      title: cleanText(it?.title || ""),
      url: cleanText(it?.url || ""),
      snippet: cleanText(it?.content || it?.snippet || ""),
    }))
  );
}

async function serperSearch(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) return [];
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": apiKey,
    },
    body: JSON.stringify({ q: query, num: Math.min(10, maxResults) }),
  });
  if (!res.ok) return [];
  const data = (await res.json().catch(() => null)) as any;
  const items = Array.isArray(data?.organic) ? data.organic : [];
  return dedupeResults(
    items.slice(0, maxResults).map((it: any) => ({
      title: cleanText(it?.title || ""),
      url: cleanText(it?.link || ""),
      snippet: cleanText(it?.snippet || ""),
    }))
  );
}

async function braveSearch(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const apiKey = process.env.BRAVE_API_KEY;
  if (!apiKey) return [];
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(10, maxResults)));

  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": apiKey,
    },
  });
  if (!res.ok) return [];
  const data = (await res.json().catch(() => null)) as any;
  const items = Array.isArray(data?.web?.results) ? data.web.results : [];
  return dedupeResults(
    items.slice(0, maxResults).map((it: any) => ({
      title: cleanText(it?.title || ""),
      url: cleanText(it?.url || ""),
      snippet: cleanText(it?.description || ""),
    }))
  );
}

async function bingSearch(query: string, maxResults: number): Promise<WebSearchResult[]> {
  const apiKey = process.env.BING_API_KEY;
  if (!apiKey) return [];
  const url = new URL("https://api.bing.microsoft.com/v7.0/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(Math.min(10, maxResults)));
  url.searchParams.set("responseFilter", "Webpages");

  const res = await fetch(url.toString(), {
    headers: {
      "Ocp-Apim-Subscription-Key": apiKey,
    },
  });
  if (!res.ok) return [];
  const data = (await res.json().catch(() => null)) as any;
  const items = Array.isArray(data?.webPages?.value) ? data.webPages.value : [];
  return dedupeResults(
    items.slice(0, maxResults).map((it: any) => ({
      title: cleanText(it?.name || ""),
      url: cleanText(it?.url || ""),
      snippet: cleanText(it?.snippet || ""),
    }))
  );
}

export async function webSearch(query: string, opts: WebSearchOptions = {}): Promise<WebResult> {
  const q = cleanText(query);
  if (!q) return { didWeb: false, webContext: "" };

  const maxResults = Math.max(1, Math.min(10, opts.maxResults ?? 6));
  const timeoutMs = opts.timeoutMs ?? 12000;

  try {
    const wctx = await withTimeout(weatherContext(q), timeoutMs);
    if (wctx && wctx.trim()) return { didWeb: true, webContext: wctx.trim() };
  } catch {
    //
  }

  try {
    const nctx = await withTimeout(newsContext(q, maxResults), timeoutMs);
    if (nctx && nctx.trim()) return { didWeb: true, webContext: nctx.trim() };
  } catch {
    //
  }

  try {
    const cctx = await withTimeout(cryptoPriceContext(q), timeoutMs);
    if (cctx && cctx.trim()) return { didWeb: true, webContext: cctx.trim() };
  } catch {
    //
  }

  try {
    const fctx = await withTimeout(fxRateContext(q), timeoutMs);
    if (fctx && fctx.trim()) return { didWeb: true, webContext: fctx.trim() };
  } catch {
    //
  }

  const run = async (): Promise<WebSearchResult[]> => {
    const r1 = await tavilySearch(q, maxResults);
    if (r1.length) return r1;

    const r2 = await serperSearch(q, maxResults);
    if (r2.length) return r2;

    const r3 = await braveSearch(q, maxResults);
    if (r3.length) return r3;

    const r4 = await bingSearch(q, maxResults);
    if (r4.length) return r4;

    return [];
  };

  const results = await withTimeout(run(), timeoutMs).catch(() => []);
  const ctx = formatWebContext(results);

  return { didWeb: !!ctx, webContext: ctx };
}

// -----------------------------------------------------------------------------
// Compatibility export
// -----------------------------------------------------------------------------
export async function fetchWeatherIfAsked(query: string): Promise<string | null> {
  const q = cleanText(query);
  if (!q) return null;
  if (!isWeatherLikeQuery(q)) return null;

  try {
    const ctx = await weatherContext(q);
    const out = (ctx || "").trim();
    return out ? out : null;
  } catch {
    return null;
  }
}