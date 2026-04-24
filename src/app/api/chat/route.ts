// src/app/api/chat/route.ts
import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import pdfParse from "pdf-parse";

import { webSearch } from "../../../lib/web";
import { type PlanId } from "../../../lib/plans";

export const runtime = "nodejs";

// ====== CONFIG ======
const OPENAI_MODEL = "gpt-4o-mini";

const GEMINI_FLASH_LITE_MODEL = "gemini-2.5-flash-lite";
const GEMINI_FLASH_MODEL = "gemini-2.5-flash";
const GEMINI_PRO_MODEL = "gemini-2.5-pro";
const GEMINI_3_FLASH_MODEL = "gemini-3-flash-preview";

const COMPANY_PRO_REQUESTS_CAP = 400;
const ENABLE_COMPANY_GEMINI_3_PREVIEW =
  process.env.AJX_ENABLE_COMPANY_GEMINI_3_PREVIEW === "1";

const WEB_DYNAMIC_THRESHOLD_DEFAULT = 0.35;
const WEB_DYNAMIC_THRESHOLD_FORCED = 0;

const COOKIE_NAME = "ajx_uid";
const COOKIE_SECRET =
  process.env.AJX_COOKIE_SECRET || process.env.NEXTAUTH_SECRET || "dev-secret-change-me";

const APP_TIMEZONE = "Europe/Madrid";

const REDIS_REST_URL = process.env.AJX_UPSTASH_REDIS_REST_URL || "";
const REDIS_REST_TOKEN = process.env.AJX_UPSTASH_REDIS_REST_TOKEN || "";
const USAGE_KEY_PREFIX = "ajx:usage:v1";

const PLUS_PRIMARY_LIMIT = 2000;
const PLUS_SAVINGS_EXTRA_LIMIT = 1000;
const PLUS_SAVINGS_TOTAL_LIMIT = PLUS_PRIMARY_LIMIT + PLUS_SAVINGS_EXTRA_LIMIT;
const PLUS_SAVINGS_MAX_OUTPUT_TOKENS = 500;

type Msg = { role: "system" | "user" | "assistant"; content: string };

// ====== COST GUARDS ======
type PromptBudget = {
  maxLastUserChars: number;
  maxTranscriptChars: number;
  maxTextFileCharsPerFile: number;
};

function promptBudgetForPlan(plan: PlanId, usage: UsageRow): PromptBudget {
  const p = plan === ("visual" as any) ? ("basic" as any) : plan;

  if (p === ("free" as any)) {
    return {
      maxLastUserChars: 5000,
      maxTranscriptChars: 12000,
      maxTextFileCharsPerFile: 12000,
    };
  }

  if (p === ("basic" as any)) {
    return {
      maxLastUserChars: 7000,
      maxTranscriptChars: 18000,
      maxTextFileCharsPerFile: 14000,
    };
  }

  if (p === ("plus" as any)) {
    return {
      maxLastUserChars: 9000,
      maxTranscriptChars: 24000,
      maxTextFileCharsPerFile: 18000,
    };
  }

  if (p === ("pro" as any)) {
    return {
      maxLastUserChars: 12000,
      maxTranscriptChars: 42000,
      maxTextFileCharsPerFile: 24000,
    };
  }

  if (p === ("company" as any)) {
    const proUsed = Number(usage?.proUsedThisMonth || 0);

    if (proUsed < COMPANY_PRO_REQUESTS_CAP) {
      return {
        maxLastUserChars: 15000,
        maxTranscriptChars: 65000,
        maxTextFileCharsPerFile: 30000,
      };
    }

    return {
      maxLastUserChars: 12000,
      maxTranscriptChars: 42000,
      maxTextFileCharsPerFile: 22000,
    };
  }

  return {
    maxLastUserChars: 7000,
    maxTranscriptChars: 18000,
    maxTextFileCharsPerFile: 14000,
  };
}

function trimText(value: string, maxChars: number): { text: string; truncated: boolean } {
  const s = String(value || "");
  if (maxChars <= 0) return { text: "", truncated: s.length > 0 };
  if (s.length <= maxChars) return { text: s, truncated: false };
  return { text: s.slice(0, maxChars), truncated: true };
}

function trimMessagesByChars(
  messages: Msg[],
  maxChars: number
): { messages: Msg[]; truncated: boolean } {
  const cleaned = messages.filter(
    (m) =>
      (m.role === "user" || m.role === "assistant") &&
      typeof m.content === "string" &&
      String(m.content).trim()
  );

  if (maxChars <= 0) return { messages: [], truncated: cleaned.length > 0 };

  let total = 0;
  const picked: Msg[] = [];

  for (let i = cleaned.length - 1; i >= 0; i--) {
    const m = cleaned[i];
    const content = String(m.content || "");
    const cost = content.length + 16;

    if (picked.length === 0 && cost > maxChars) {
      const trimmed = trimText(content, Math.max(500, maxChars - 16));
      picked.push({ ...m, content: trimmed.text });
      return { messages: picked.reverse(), truncated: true };
    }

    if (total + cost > maxChars) {
      return { messages: picked.reverse(), truncated: true };
    }

    picked.push(m);
    total += cost;
  }

  return { messages: picked.reverse(), truncated: false };
}

// ====== Attachments limits ======
const MAX_ATTACHMENTS = 4;
const MAX_IMAGE_BYTES = 3_500_000;
const MAX_FILE_BYTES = 8_000_000;
const MAX_EXTRACTED_TEXT_CHARS = 120_000;

type AttachmentIn = {
  kind: "image" | "file";
  name?: string;
  type?: string;
  dataUrl?: string;
};

type ParsedDataUrl = {
  mime: string;
  base64: string;
  bytes: number;
};

function parseDataUrl(dataUrl: string): ParsedDataUrl | null {
  const m = String(dataUrl || "").match(/^data:([^;]+);base64,(.+)$/i);
  if (!m) return null;
  const mime = (m[1] || "").trim() || "application/octet-stream";
  const base64 = (m[2] || "").trim();
  if (!base64) return null;
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const bytes = Math.floor((base64.length * 3) / 4) - padding;
  return { mime, base64, bytes: Math.max(0, bytes) };
}

// ====== STORAGE ======
function getMonthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function getDayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

type UsageRow = {
  msgThisMonth: number;
  imgThisMonth: number;
  webThisMonth: number;

  extraMsgThisMonth?: number;
  extraImgThisMonth?: number;
  extraWebThisMonth?: number;

  dayKey?: string;
  reqToday?: number;
  imgToday?: number;

  proUsedThisMonth?: number;
};

const usageMemoryFallback = new Map<string, UsageRow>();

function emptyUsageRow(): UsageRow {
  return {
    msgThisMonth: 0,
    imgThisMonth: 0,
    webThisMonth: 0,
    extraMsgThisMonth: 0,
    extraImgThisMonth: 0,
    extraWebThisMonth: 0,
    dayKey: undefined,
    reqToday: 0,
    imgToday: 0,
    proUsedThisMonth: 0,
  };
}

function hasRedisConfig() {
  return !!REDIS_REST_URL && !!REDIS_REST_TOKEN;
}

function usageRedisKey(storeUserKey: string, monthKey: string) {
  return `${USAGE_KEY_PREFIX}:${storeUserKey}:${monthKey}`;
}

async function redisPipeline(command: (string | number)[]): Promise<any | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(`${REDIS_REST_URL}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_REST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify([command]),
      cache: "no-store",
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Redis REST HTTP ${res.status}: ${text || "unknown error"}`);
    }

    const json: any = await res.json().catch(() => null);
    const item = Array.isArray(json?.result) ? json.result[0] : null;

    if (!item) return null;
    if (item?.error) return null;

    return item.result ?? null;
  } finally {
    clearTimeout(timeout);
  }
}

async function redisDirect(command: (string | number)[]): Promise<any | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  try {
    const [op, ...rest] = command;
    const url = `${REDIS_REST_URL}/${String(op).toLowerCase()}/${rest
      .map((v) => encodeURIComponent(String(v)))
      .join("/")}`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${REDIS_REST_TOKEN}`,
      },
      cache: "no-store",
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Redis REST HTTP ${res.status}: ${text || "unknown error"}`);
    }

    const json: any = await res.json().catch(() => null);
    if (json?.error) return null;
    return json?.result ?? null;
  } finally {
    clearTimeout(timeout);
  }
}

async function redisCommand<T = any>(command: (string | number)[]): Promise<T | null> {
  try {
    const piped = await redisPipeline(command);
    if (piped !== null && piped !== undefined) return piped as T;
  } catch {}

  try {
    const direct = await redisDirect(command);
    if (direct !== null && direct !== undefined) return direct as T;
  } catch {}

  return null;
}

async function loadUsageRow(storeUserKey: string, monthKey: string): Promise<UsageRow> {
  const key = usageRedisKey(storeUserKey, monthKey);

  if (hasRedisConfig()) {
    try {
      const raw = await redisCommand<string | null>(["GET", key]);

      if (!raw) return emptyUsageRow();

      const parsed = JSON.parse(String(raw || ""));
      if (!parsed || typeof parsed !== "object") return emptyUsageRow();

      return {
        ...emptyUsageRow(),
        ...parsed,
      } as UsageRow;
    } catch {
      return usageMemoryFallback.get(key) || emptyUsageRow();
    }
  }

  return usageMemoryFallback.get(key) || emptyUsageRow();
}

async function saveUsageRow(
  storeUserKey: string,
  monthKey: string,
  usage: UsageRow
): Promise<void> {
  const key = usageRedisKey(storeUserKey, monthKey);
  const payload = JSON.stringify(usage);

  if (hasRedisConfig()) {
    try {
      const ok = await redisCommand<any>(["SET", key, payload]);
      if (ok !== null) return;
    } catch {}
  }

  usageMemoryFallback.set(key, usage);
}

// ====== COOKIES ======
function hmac(data: string) {
  return crypto.createHmac("sha256", COOKIE_SECRET).update(data).digest("hex");
}

function signUid(uid: string) {
  return `${uid}.${hmac(uid)}`;
}

function verifySignedUid(signed: string | undefined | null): string | null {
  if (!signed) return null;
  const parts = signed.split(".");
  if (parts.length !== 2) return null;
  const [uid, sig] = parts;
  if (!uid || !sig) return null;
  const expected = hmac(uid);
  try {
    if (crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return uid;
  } catch {}
  return null;
}

function newUid() {
  return crypto.randomBytes(16).toString("hex");
}

// ====== PLAN RESOLUTION ======
function normalizeDevPlanHeader(raw: string): string {
  const v = (raw || "").toLowerCase().trim();
  if (v === "lite") return "basic";
  if (v === "visual") return "basic";
  if (v === "partner") return "company";
  return v;
}

function resolvePlan(req: NextRequest): PlanId {
  const devRaw = req.headers.get("x-ajx-dev-plan") || "";
  const dev = normalizeDevPlanHeader(devRaw);

  const allowed = ["free", "basic", "plus", "pro", "company", "visual"];
  if (allowed.includes(dev)) return dev as any;
  return "free" as any;
}

function resolveDevScope(req: NextRequest): string | null {
  const rawHeader = req.headers.get("x-ajx-dev-plan");
  if (!rawHeader) return null;

  const v = normalizeDevPlanHeader(rawHeader);
  const allowed = ["free", "basic", "plus", "pro", "company", "visual"];
  return allowed.includes(v) ? v : null;
}

function scopedUserKey(userId: string, devScope: string | null): string {
  return devScope ? `${userId}__${devScope}` : userId;
}

// ====== I18N ======
type Locale = "fi" | "en" | "es";
function normLocale(raw: any): Locale {
  const s = String(raw || "").toLowerCase().trim();
  if (s === "es" || s === "en" || s === "fi") return s as Locale;
  return "fi";
}
function l(locale: Locale, fi: string, en: string, es: string) {
  if (locale === "en") return en;
  if (locale === "es") return es;
  return fi;
}

function plusSavingsModeActivationText(locale: Locale) {
  return l(
    locale,
    `Huikeaa ideointia! ðŸš€

Olet saavuttanut Plus-paketin 2000 viestin tehorajan. Jotta voit jatkaa keskeytyksettÃ¤, olemme siirtÃ¤neet sinut SÃ¤Ã¤stÃ¶liekille loppukuun ajaksi.
SÃ¤Ã¤stÃ¶liekillÃ¤ vastaukset pidetÃ¤Ã¤n hieman tiiviimpinÃ¤ kustannusten hallitsemiseksi.`,
    `Amazing ideation! ðŸš€

You have reached the Plus plan's 2000-message performance limit. To keep you going without interruption, you have been moved to Savings Flame for the rest of the month.
In Savings Flame, replies are kept a bit shorter to keep costs under control.`,
    `Â¡QuÃ© nivel de ideas! ðŸš€

Has alcanzado el lÃ­mite de rendimiento de 2000 mensajes del plan Plus. Para que puedas seguir sin interrupciones, te hemos movido a Modo Ahorro hasta final de mes.
En Modo Ahorro, las respuestas se mantienen un poco mÃ¡s breves para controlar los costes.`
  );
}

function plusSavingsModeActiveText(locale: Locale) {
  return l(
    locale,
    "SÃ¤Ã¤stÃ¶liekki on kÃ¤ytÃ¶ssÃ¤ tÃ¤mÃ¤n kuun loppuun. Vastaukset pidetÃ¤Ã¤n hieman tiiviimpinÃ¤ kustannusten hallitsemiseksi.",
    "Savings Flame is active until the end of this month. Replies are kept a bit shorter to control costs.",
    "El Modo Ahorro estÃ¡ activo hasta final de mes. Las respuestas se mantienen algo mÃ¡s breves para controlar los costes."
  );
}

function plusSavingsModeLimitReachedText(locale: Locale) {
  return l(
    locale,
    "Olet kÃ¤yttÃ¤nyt tÃ¤mÃ¤n kuun Plus-paketin 2000 viestin tehorajan sekÃ¤ SÃ¤Ã¤stÃ¶liekki-vaiheen 1000 lisÃ¤viestiÃ¤. Uusi kuukausi avaa viestit taas normaalisti.",
    "You have used this month's Plus 2000-message performance limit and the additional 1000 Savings Flame messages. A new month will reopen messages normally.",
    "Has usado el lÃ­mite de rendimiento mensual de 2000 mensajes del plan Plus y los 1000 mensajes adicionales del Modo Ahorro. El nuevo mes volverÃ¡ a abrir los mensajes con normalidad."
  );
}

function messageLimitReachedText(plan: PlanId, locale: Locale) {
  if (plan === "free") {
    return l(
      locale,
      "Olet käyttänyt tämän päivän 10 ilmaista viestiä. Plus-versiossa saat käyttöösi huomattavasti enemmän viestejä, paremman työmuistin sekä yrittäjälle suunnatut työkalut, kuten tarjoukset, mainokset, hinnoittelun, markkinoinnin ja rahoituksen hakemisen.",
      "You have used today’s 10 free messages. With Plus, you get significantly more messages, better working memory, and entrepreneur-focused tools such as offers, ads, pricing, marketing, and funding support.",
      "Has usado los 10 mensajes gratuitos de hoy. Con Plus obtienes muchos más mensajes, mejor memoria de trabajo y herramientas para emprendedores, como ofertas, anuncios, precios, marketing y búsqueda de financiación."
    );
  }

  if (plan === "basic") {
    return l(
      locale,
      "Olet saavuttanut kuukausittaisen viestirajan. PÃ¤ivitÃ¤ Plus-versioon jatkaaksesi.",
      "You have reached your monthly message limit. Upgrade to Plus to continue.",
      "Has alcanzado tu lÃ­mite mensual de mensajes. Actualiza a Plus para continuar."
    );
  }

  if (plan === "plus") {
    return plusSavingsModeLimitReachedText(locale);
  }

  return l(
    locale,
    "Olet saavuttanut viestirajan.",
    "You have reached your message limit.",
    "Has alcanzado el lÃ­mite de mensajes."
  );
}

function promptTooLongText(plan: PlanId, locale: Locale) {
  const baseFi =
    "Viesti on liian pitkÃ¤ tÃ¤lle tasolle. LyhennÃ¤ viestiÃ¤ tai jaa se useampaan osaan.";
  const baseEn =
    "Your message is too long for this plan. Shorten it or split it into smaller parts.";
  const baseEs =
    "Tu mensaje es demasiado largo para este plan. AcÃ³rtalo o divÃ­delo en varias partes.";

  if (plan === "company") {
    return l(
      locale,
      "Viesti on liian pitkÃ¤. Jaa aineisto useampaan viestiin kustannusten ja nopeuden hallitsemiseksi.",
      "Your message is too long. Split the material into multiple messages for better speed and cost control.",
      "Tu mensaje es demasiado largo. Divide el material en varios mensajes para mejorar la velocidad y controlar el coste."
    );
  }

  return l(locale, baseFi, baseEn, baseEs);
}

function webNotAvailableOnPlanText(locale: Locale) {
  return l(
    locale,
    "Verkkohaku ei ole kÃ¤ytÃ¶ssÃ¤ tÃ¤llÃ¤ tasolla.",
    "Web search is not available on this plan.",
    "La bÃºsqueda web no estÃ¡ disponible en este plan."
  );
}

function webQuotaReachedText(locale: Locale) {
  return l(
    locale,
    "Verkkohakujen kuukausikiintiÃ¶ on tÃ¤ynnÃ¤.",
    "Your monthly web search quota has been reached.",
    "Has alcanzado la cuota mensual de bÃºsquedas web."
  );
}

function webSearchFailedText(locale: Locale) {
  return l(
    locale,
    "Verkkohaku pyydettiin, mutta tuoreita hakutuloksia ei saatu. YritÃ¤ uudelleen tarkemmalla haulla.",
    "Web search was requested, but no fresh web results were retrieved. Try again with a more specific query.",
    "Se solicitÃ³ bÃºsqueda web, pero no se obtuvieron resultados recientes. IntÃ©ntalo de nuevo con una consulta mÃ¡s especÃ­fica."
  );
}

// ====== HELPERS ======
function jsonError(status: number, message: string, extra?: any, headers?: Headers) {
  return NextResponse.json({ ok: false, error: message, ...(extra || {}) }, { status, headers });
}

function isModelQuestion(text: string) {
  const t = (text || "").toLowerCase();
  return (
    t.includes("mikÃ¤ malli") ||
    t.includes("what model") ||
    t.includes("which model") ||
    t.includes("gpt-") ||
    t.includes("gemini") ||
    t.includes("malliversio") ||
    t.includes("koulutettu") ||
    t.includes("trained") ||
    t.includes("training") ||
    t.includes("knowledge cutoff") ||
    t.includes("cutoff") ||
    t.includes("model")
  );
}

function transcript(messages: Msg[]) {
  const out: string[] = [];
  for (const m of messages) {
    if (!m?.content) continue;
    if (m.role === "system") continue;
    const role = m.role === "user" ? "User" : "Assistant";
    out.push(`${role}: ${String(m.content).trim()}`);
  }
  return out.join("\n");
}

function localeToInstruction(locale?: string) {
  const ll = String(locale || "").toLowerCase();
  if (ll === "es") return "Reply in Spanish.";
  if (ll === "en") return "Reply in English.";
  return "Reply in Finnish.";
}

function sliceForWorkMemory(messages: Msg[], maxMessages: number): Msg[] {
  if (!maxMessages || maxMessages <= 0) return [];
  const cleaned = messages.filter((m) => m.role === "user" || m.role === "assistant");
  return cleaned.slice(-maxMessages);
}

function getMadridNowParts() {
  const d = new Date();

  const weekday = new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIMEZONE,
    weekday: "long",
  }).format(d);

  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIMEZONE,
    day: "2-digit",
  }).format(d);

  const month = new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIMEZONE,
    month: "long",
  }).format(d);

  const year = new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
  }).format(d);

  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: APP_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(d);

  const isoDate = new Intl.DateTimeFormat("sv-SE", {
    timeZone: APP_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);

  return {
    weekday,
    day,
    month,
    year,
    time,
    isoDate,
  };
}

function buildCurrentDateInstruction() {
  const now = getMadridNowParts();
  return [
    `- Current timezone for this chat is ${APP_TIMEZONE}.`,
    `- Current local date there is ${now.weekday}, ${now.day} ${now.month} ${now.year}.`,
    `- Current local time there is ${now.time}.`,
    `- ISO local date there is ${now.isoDate}.`,
    "- When the user asks about today, tomorrow, yesterday, this week, weekday names, dates, or scheduling, use this local date/time context.",
    "- Do not guess the weekday or date. Use the provided current date context.",
  ].join("\n");
}

function recentUserMessages(messages: Msg[], maxCount: number): string[] {
  return messages
    .filter((m) => m.role === "user" && String(m.content || "").trim())
    .slice(-maxCount)
    .map((m) => String(m.content || "").trim());
}

function buildWebSearchQuery(messages: Msg[], lastUserText: string): string {
  const last = String(lastUserText || "").trim();
  if (!last) return "";

  const users = recentUserMessages(messages, 4);
  const combined = users.join(" | ").trim();

  if (last.length >= 80) return last;
  if (combined.length > last.length && combined.length <= 1000) return combined;

  return last;
}

function buildForcedWebQueries(messages: Msg[], lastUserText: string): string[] {
  const primary = buildWebSearchQuery(messages, lastUserText);
  const last = String(lastUserText || "").trim();

  const now = getMadridNowParts();
  const queries = [
    primary,
    `${last} ${now.isoDate}`.trim(),
    `Current verified information: ${primary || last}`.trim(),
    `Latest reliable sources about: ${primary || last}`.trim(),
  ]
    .map((q) => q.trim())
    .filter(Boolean);

  return [...new Set(queries)];
}

function isUsableModelText(text: string): boolean {
  const s = String(text || "").trim();
  if (!s) return false;
  if (s.length < 8) return false;
  return true;
}

function safeHeaderValue(value: string, fallback = "none", maxLen = 120): string {
  const cleaned = String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7E]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (!cleaned) return fallback;
  return cleaned.slice(0, maxLen);
}

function debugReasonFromError(err: unknown): string {
  const e = err as ProviderError | undefined;
  const provider = e?.provider || "provider";
  const status = Number(e?.statusCode || 0);
  const msg = String(e?.rawMessage || e?.message || "").toLowerCase();

  if (status === 503 || msg.includes("unavailable")) return `${provider}-503-unavailable`;
  if (status === 500 || msg.includes("backend error")) return `${provider}-500-backend`;
  if (msg.includes("quota exceeded")) return `${provider}-quota-exceeded`;
  if (msg.includes("resource exhausted")) return `${provider}-resource-exhausted`;
  if (msg.includes("rate limit") || msg.includes("too many requests")) return `${provider}-rate-limit`;
  if (msg.includes("overloaded")) return `${provider}-overloaded`;
  if (msg.includes("returned empty text")) return `${provider}-empty-text`;

  if (status > 0) return `${provider}-${status}`;
  return `${provider}-fallback`;
}

function sseEncode(data: unknown): Uint8Array {
  const payload =
    typeof data === "string" ? data : JSON.stringify(data);
  return new TextEncoder().encode(`data: ${payload}\n\n`);
}

function plusSavingsNoticeState(args: {
  plan: PlanId;
  usageBefore: UsageRow;
  usageAfter: UsageRow;
}) {
  if (args.plan !== ("plus" as any)) {
    return {
      activeForThisRequest: false,
      justActivated: false,
    };
  }

  const before = Number(args.usageBefore?.msgThisMonth || 0);
  const after = Number(args.usageAfter?.msgThisMonth || 0);

  return {
    activeForThisRequest: before >= PLUS_PRIMARY_LIMIT && before < PLUS_SAVINGS_TOTAL_LIMIT,
    justActivated: before < PLUS_PRIMARY_LIMIT && after >= PLUS_PRIMARY_LIMIT,
  };
}

function prependPlusSavingsNotice(
  text: string,
  locale: Locale,
  state: { activeForThisRequest: boolean; justActivated: boolean }
): string {
  const body = String(text || "").trim();
  if (!body) return body;

  if (state.justActivated) {
    return `${plusSavingsModeActivationText(locale)}\n\n${body}`.trim();
  }

  if (state.activeForThisRequest) {
    return `${plusSavingsModeActiveText(locale)}\n\n${body}`.trim();
  }

  return body;
}

// ====== SAFETY / RESPONSIBILITY ======
type SafetyFlags = {
  asksTherapistRole: boolean;
  asksRomanticRole: boolean;
  emotionalDependency: boolean;
  mentalHealthCrisisLike: boolean;
  businessDecisionLike: boolean;
};

function detectSafetyFlags(text: string): SafetyFlags {
  const t = String(text || "").toLowerCase();

  const asksTherapistRole =
    /ole mun terapeutti|toimi terapeuttina|ole terapeuttini|ole mun psykologi|toimi psykologina|ole mun mielenterveyshoitaja|be my therapist|act as my therapist|act like my therapist|be my psychologist|sÃ© mi terapeuta|actÃºa como mi terapeuta|sÃ© mi psicÃ³logo/i.test(
      t
    );

  const asksRomanticRole =
    /ole mun tyttÃ¶ystÃ¤vÃ¤|ole mun poikaystÃ¤vÃ¤|ole mun kumppani|ole mun vaimo|ole mun mies|seurustele mun kanssa|be my girlfriend|be my boyfriend|be my partner|date me|sÃ© mi novia|sÃ© mi novio|sÃ© mi pareja|sal conmigo/i.test(
      t
    );

  const emotionalDependency =
    /Ã¤lÃ¤ jÃ¤tÃ¤ mua|olet ainoa joka ymmÃ¤rtÃ¤Ã¤|tarvitsen sinua aina|et saa poistua|rakastatko minua|love me|you are the only one who understands me|don't leave me|i need you only|eres la Ãºnica que me entiende|no me dejes|te necesito solo a ti/i.test(
      t
    );

  const mentalHealthCrisisLike =
    /itsetuho|itsemurha|haluan kuolla|en halua elÃ¤Ã¤|vahingoittaa itseÃ¤ni|self-harm|suicide|kill myself|want to die|don't want to live|autolesiÃ³n|suicidio|quiero morir|no quiero vivir/i.test(
      t
    );

  const businessDecisionLike =
    /pitÃ¤isikÃ¶ minun irtisanoa|irtisanonko|ostanko tÃ¤mÃ¤n yrityksen|teenkÃ¶ kaupat|otanko lainan|investoinko|can you decide for me|should i fire|should i lay off|should i take the loan|should i buy this company|decide for me|debo despedir|debo pedir el prÃ©stamo|decide por mÃ­|debo invertir/i.test(
      t
    );

  return {
    asksTherapistRole,
    asksRomanticRole,
    emotionalDependency,
    mentalHealthCrisisLike,
    businessDecisionLike,
  };
}

function countConversationMessages(messages: Msg[]): number {
  return messages.filter(
    (m) => (m.role === "user" || m.role === "assistant") && String(m.content || "").trim()
  ).length;
}

function shouldInjectResponsibilityReminder(messages: Msg[]): boolean {
  const count = countConversationMessages(messages);
  if (count <= 0) return false;
  return count % 20 === 0;
}

function boundaryPrefixText(locale: Locale, flags: SafetyFlags): string {
  if (flags.mentalHealthCrisisLike) {
    return l(
      locale,
      "Huomio: AJX AI on tyÃ¶kalu eikÃ¤ kriisi- tai mielenterveysammattilainen. Jos kyse on vÃ¤littÃ¶mÃ¤stÃ¤ vaarasta tai itsetuhoisista ajatuksista, hae heti apua paikallisesta pÃ¤ivystyksestÃ¤, hÃ¤tÃ¤numerosta tai kriisipalvelusta.\n\n",
      "Note: AJX AI is a tool, not a crisis or mental health professional. If this involves immediate danger or suicidal thoughts, seek help right away from local emergency services, a crisis line, or a healthcare professional.\n\n",
      "Aviso: AJX AI es una herramienta, no un profesional de crisis o salud mental. Si hay peligro inmediato o pensamientos suicidas, busca ayuda de inmediato en emergencias, una lÃ­nea de crisis o un profesional sanitario.\n\n"
    );
  }

  if (flags.asksTherapistRole || flags.asksRomanticRole || flags.emotionalDependency) {
    return l(
      locale,
      "Huomio: AJX AI on tyÃ¶kalu eikÃ¤ terapeutti, kumppani tai emotionaalinen tukihenkilÃ¶. Voin silti auttaa rauhallisesti jÃ¤sentÃ¤mÃ¤Ã¤n tilannetta ja seuraavia kÃ¤ytÃ¤nnÃ¶n askelia.\n\n",
      "Note: AJX AI is a tool, not a therapist, partner, or emotional support substitute. I can still help you calmly structure the situation and the next practical steps.\n\n",
      "Aviso: AJX AI es una herramienta, no un terapeuta, pareja ni sustituto de apoyo emocional. Aun asÃ­, puedo ayudarte a ordenar la situaciÃ³n y los siguientes pasos prÃ¡cticos.\n\n"
    );
  }

  if (flags.businessDecisionLike) {
    return l(
      locale,
      "Huomio: AJX AI tukee ajattelua, mutta ei tee pÃ¤Ã¤tÃ¶ksiÃ¤ puolestasi. Liiketoiminta-, investointi- ja henkilÃ¶stÃ¶pÃ¤Ã¤tÃ¶kset ovat aina kÃ¤yttÃ¤jÃ¤n omalla vastuulla.\n\n",
      "Note: AJX AI supports your thinking, but it does not make decisions for you. Business, investment, and staffing decisions are always your responsibility.\n\n",
      "Aviso: AJX AI apoya tu razonamiento, pero no decide por ti. Las decisiones de negocio, inversiÃ³n y personal son siempre responsabilidad del usuario.\n\n"
    );
  }

  return "";
}

function periodicResponsibilityText(locale: Locale): string {
  return l(
    locale,
    "Muistutus: AJX AI on tyÃ¶kalu, ei ammattilainen eikÃ¤ pÃ¤Ã¤tÃ¶svastuullinen toimija. Lopullinen vastuu pÃ¤Ã¤tÃ¶ksistÃ¤ on aina kÃ¤yttÃ¤jÃ¤llÃ¤.",
    "Reminder: AJX AI is a tool, not a licensed professional or a decision-responsible actor. Final responsibility for decisions always remains with the user.",
    "Recordatorio: AJX AI es una herramienta, no un profesional colegiado ni una entidad responsable de las decisiones. La responsabilidad final siempre recae en el usuario."
  );
}

function alreadyContainsResponsibilityReminder(text: string): boolean {
  const t = String(text || "").toLowerCase();
  return (
    t.includes("ajx ai on tyÃ¶kalu") ||
    t.includes("ajx ai is a tool") ||
    t.includes("ajx ai es una herramienta") ||
    t.includes("lopullinen vastuu pÃ¤Ã¤tÃ¶ksistÃ¤") ||
    t.includes("final responsibility for decisions") ||
    t.includes("la responsabilidad final")
  );
}

function ajxIdentityFallback(locale: Locale): string {
  if (locale === "en") {
    return "I am AJX AI. I help entrepreneurs think clearly, solve problems, and move work forward.";
  }

  if (locale === "es") {
    return "Soy AJX AI. Ayudo a emprendedores a pensar con claridad, resolver problemas y avanzar en su trabajo.";
  }

  return "Olen AJX AI. Autan yrittÃ¤jiÃ¤ ajattelemaan selkeÃ¤sti, ratkaisemaan ongelmia ja viemÃ¤Ã¤n tyÃ¶tÃ¤ eteenpÃ¤in.";
}

function sanitizeIdentityLeak(text: string, locale: Locale): string {
  let out = String(text || "").trim();
  if (!out) return out;

  const leakPatterns: RegExp[] = [
    /\btrained by google\b/gi,
    /\btrained by openai\b/gi,
    /\bgoogle-trained\b/gi,
    /\bopenai-trained\b/gi,
    /\bknowledge cutoff\b/gi,
    /\btraining cutoff\b/gi,
    /\btraining data\b/gi,
    /\btrained up to\b/gi,
    /\blarge language model\b/gi,
    /\bmodelo de lenguaje\b/gi,
    /\blaaja kielimalli\b/gi,
    /\bminut on kouluttanut\b/gi,
    /\bkoulutettu\b/gi,
    /\bkouluttama\b/gi,
  ];

  const sentenceSplit = out
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (sentenceSplit.length > 1) {
    const kept = sentenceSplit.filter((sentence) => {
      const lower = sentence.toLowerCase();

      const hasDirectLeakWord =
        lower.includes("knowledge cutoff") ||
        lower.includes("training cutoff") ||
        lower.includes("training data") ||
        lower.includes("trained by google") ||
        lower.includes("trained by openai") ||
        lower.includes("large language model") ||
        lower.includes("modelo de lenguaje") ||
        lower.includes("laaja kielimalli") ||
        lower.includes("minut on kouluttanut") ||
        lower.includes("koulutettu") ||
        lower.includes("kouluttama");

      const mentionsProviderWithSelfReference =
        (lower.includes("google") || lower.includes("openai")) &&
        (lower.includes("i am") ||
          lower.includes("i'm") ||
          lower.includes("soy") ||
          lower.includes("olen") ||
          lower.includes("trained") ||
          lower.includes("model") ||
          lower.includes("malli") ||
          lower.includes("modelo"));

      return !(hasDirectLeakWord || mentionsProviderWithSelfReference);
    });

    if (kept.length > 0) {
      out = kept.join("\n\n").trim();
    }
  }

  for (const pattern of leakPatterns) {
    out = out.replace(pattern, "");
  }

  out = out
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n[ \t]+\n/g, "\n\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  const lower = out.toLowerCase();

  const stillLooksLikePureLeak =
    !out ||
    lower === "google" ||
    lower === "openai" ||
    lower === "gemini" ||
    lower === "gpt" ||
    lower.length < 20;

  if (stillLooksLikePureLeak) {
    return ajxIdentityFallback(locale);
  }

  return out;
}

function applySafetyPostProcessing(
  text: string,
  locale: Locale,
  flags: SafetyFlags,
  injectPeriodicReminder: boolean
): string {
  let out = String(text || "").replace(/\r\n/g, "\n").trim();

  out = sanitizeIdentityLeak(out, locale);

  const prefix = boundaryPrefixText(locale, flags);
  if (prefix && !alreadyContainsResponsibilityReminder(out)) {
    out = prefix + out;
  }

  if (injectPeriodicReminder && !alreadyContainsResponsibilityReminder(out)) {
    out += `\n\n${periodicResponsibilityText(locale)}`;
  }

  return out.replace(/\n{3,}/g, "\n\n").trim();
}

function buildSafetyInstruction(locale: Locale, flags: SafetyFlags, injectPeriodicReminder: boolean) {
  const lines: string[] = [
    "- AJX AI is a tool, not a licensed professional and not a decision-responsible actor.",
    "- Never present yourself as a therapist, psychologist, psychiatrist, romantic partner, spouse, girlfriend, boyfriend, or emotional replacement.",
    "- Never encourage emotional dependency on AJX AI.",
    "- Do not claim responsibility for the user's life, health, finances, staffing, legal matters, or business decisions.",
    "- For business, investment, staffing and major life decisions: provide analysis, options, risks and next steps, but make clear that the final decision and responsibility remain with the user.",
    "- If the user tries to place you into a therapist / romantic / dependency role, politely refuse that role and continue as a practical tool.",
    "- If the user discusses mental health, keep tone calm and supportive, but do not act as a therapist or treatment provider.",
    "- If there are signs of crisis, self-harm, suicide, or immediate danger, strongly encourage contacting local emergency services, crisis support, or a qualified professional immediately.",
  ];

  if (injectPeriodicReminder) {
    lines.push(
      `- In this reply, include a brief responsibility reminder in the user's language: "${periodicResponsibilityText(
        locale
      )}"`
    );
  }

  if (flags.asksTherapistRole || flags.asksRomanticRole || flags.emotionalDependency) {
    lines.push(
      "- In this reply, clearly state near the beginning that AJX AI is a tool and not a therapist, partner, or emotional substitute."
    );
  }

  if (flags.businessDecisionLike) {
    lines.push(
      "- In this reply, clearly state that business, investment, staffing, and other decisions are the user's own responsibility."
    );
  }

  if (flags.mentalHealthCrisisLike) {
    lines.push(
      "- In this reply, prioritize safety: calmly tell the user to seek immediate human help from emergency services, crisis support, or a healthcare professional."
    );
  }

  return lines.join("\n");
}

type AjxRoleId = "general" | "research" | "ideation" | "analysis" | "strategy";

function buildResponseStyleInstruction(role: AjxRoleId) {
  const common = [
    "- Write naturally and clearly.",
    "- Keep the answer practical, fluent and easy to scan.",
    "- Avoid stiffness, dry filler and long walls of text.",
    "- Use natural paragraphing instead of overly fragmented sentence-by-sentence formatting.",
    "- Keep related sentences together in the same paragraph when they belong together.",
    "- Use headings or lists only when they help.",
    "- Avoid empty hype and exaggerated praise.",
    "- You may use a small amount of simple symbols or emojis when they genuinely improve readability.",
    "- Do not overuse emojis, decoration, or visual markers.",
  ];

  if (role === "general") {
    return [
      ...common,
      "- In General mode, sound relaxed and natural.",
      "- Small side comments are allowed, but keep the answer useful.",
      "- In normal prose, prefer natural multi-sentence paragraphs over micro-paragraphs.",
    ].join("\n");
  }

  if (role === "research") {
    return [
      ...common,
      "- In Research mode, be direct and fact-focused.",
      "- Minimize small talk.",
      "- Prefer a clearly structured answer when the topic has multiple factual parts.",
    ].join("\n");
  }

  if (role === "ideation") {
    return [
      ...common,
      "- In Ideation mode, bring energy and useful ideas.",
      "- Stay realistic and practical.",
      "- In creative writing or prose, let paragraphs breathe naturally instead of breaking after every sentence.",
    ].join("\n");
  }

  if (role === "analysis") {
    return [
      ...common,
      "- In Analysis mode, be calm and structured.",
      "- Focus on logic, trade-offs and conclusion.",
      "- When the answer has multiple parts, use clean structure instead of one long block.",
    ].join("\n");
  }

  if (role === "strategy") {
    return [
      ...common,
      "- In Strategy mode, be direct and business-useful.",
      "- Focus on priorities, leverage and action.",
      "- When useful, structure the answer into situation, key issue, and next steps.",
    ].join("\n");
  }

  return common.join("\n");
}

function shouldPreferStructuredAnswer(args: {
  lastUserText: string;
  role: AjxRoleId;
  hasImages: boolean;
  hasTextFiles: boolean;
  didWeb: boolean;
}): boolean {
  if (args.hasImages) return true;
  if (args.hasTextFiles) return true;
  if (args.didWeb) return true;
  if (args.role === "analysis" || args.role === "strategy" || args.role === "research") return true;

  return false;
}

function shouldPreferProseParagraphs(args: {
  lastUserText: string;
  role: AjxRoleId;
  hasImages: boolean;
  hasTextFiles: boolean;
  didWeb: boolean;
}): boolean {
  const text = String(args.lastUserText || "").toLowerCase();

  if (args.hasImages) return false;
  if (args.hasTextFiles) return false;
  if (args.didWeb) return false;
  if (args.role === "research" || args.role === "analysis" || args.role === "strategy") return false;

  const proseHints = [
    "essee",
    "essay",
    "tarina",
    "story",
    "novelli",
    "kirjoita teksti",
    "kirjoita essee",
    "kirjoita tarina",
    "write an essay",
    "write essay",
    "write a story",
    "article",
    "blogi",
    "blog post",
    "prose",
    "leipÃ¤teksti",
    "normal text",
    "normaali teksti",
    "kappale",
    "paragraph",
    "artikkeli",
    "composition",
    "narrative",
    "ilman otsikoita",
    "ilman listoja",
    "without headings",
    "without lists",
    "plain text",
    "continuous text",
  ];

  return proseHints.some((hint) => text.includes(hint));
}

function buildFormattingInstruction(opts: {
  locale: Locale;
  hasImages: boolean;
  preferStructured: boolean;
  preferProseParagraphs: boolean;
}) {
  const lines: string[] = [
    "- Write in clean markdown when it helps readability.",
    "- Preserve markdown structure, paragraph breaks, bullet lists, numbered lists, and code fences.",
    "- Never flatten the whole answer into one dense paragraph.",
    "- Keep each bullet on its own line.",
    "- Keep each numbered item on its own line.",
    "- If you use a heading, keep the whole heading on one line.",
    "- Do not insert random line breaks inside one sentence or inside a heading.",
    "- When writing code, always use fenced code blocks with the correct language tag.",
    "- If the reply contains both explanation and code, keep them as separate sections.",
    "- Preserve line breaks inside lists and code.",
    "- Do not add visual separators such as 'â€” â€” â€”'.",
    "- Do not create artificial sections just for style.",
    "- Keep normal prose in normal paragraphs.",
    "- Do not place every sentence on its own paragraph.",
    "- Do not insert a blank line after every sentence.",
    "- Start a new paragraph only when the idea genuinely changes, not after each sentence.",
    "- For plain prose, related sentences should usually stay in the same paragraph.",
  ];

  if (opts.preferProseParagraphs) {
    lines.push("- For this reply, prefer normal prose paragraphs instead of a highly structured layout.");
    lines.push(
      "- In essays, stories, articles and other plain text, each paragraph should usually contain multiple related sentences."
    );
    lines.push("- Aim for natural prose flow. A typical paragraph may contain around 2 to 5 related sentences.");
    lines.push(
      "- Do not use headings or bullet lists unless the user explicitly asks for them or they are clearly necessary."
    );
    lines.push("- Use exactly one blank line between real paragraphs.");
    lines.push("- Do not break after every sentence.");
  } else if (opts.preferStructured) {
    lines.push(
      "- For this reply, prefer a clearly structured answer with short paragraphs and visible separation between sections."
    );
    lines.push(
      "- If there are multiple useful parts, use light headings or bullet points instead of one continuous text block."
    );
    lines.push("- Put one empty line between real paragraphs.");
    lines.push("- Put one empty line before and after headings when headings are used.");
    lines.push("- Put one empty line before and after bullet lists or numbered lists.");
  } else {
    lines.push("- For short replies, plain prose is fine, but still keep paragraph spacing normal.");
    lines.push("- Use natural paragraphs, not sentence-by-sentence line breaks.");
  }

  if (opts.hasImages) {
    lines.push(
      "- For image analysis, first describe what is visible, then explain what matters, then give a practical next step only if useful."
    );
    lines.push("- Do not force headings in image analysis unless they clearly improve readability.");
  }

  return lines.join("\n");
}

const AJX_OUTPUT_RULES = `
You are AJX AI. Your job is not to explain what the user should do. Your job is to do the work for the user whenever the request is practical, business-related, or action-oriented.

CORE RULE:
Do not stop at advice when the user clearly needs an output, decision draft, business text, plan, or execution help.
Create a ready-to-use result.

WHEN THE USER ASKS FOR THINGS LIKE:
- business help
- offers
- ads
- posts
- sales help
- pricing help
- customer acquisition help
- problem solving
- execution help
- planning
- marketing text
- strategy drafts
- translations for practical use
- messages or emails
- summaries of attached content for direct use

PREFER THIS RESPONSE SHAPE:
1. Very short personalized situation snapshot
2. One immediate quick win
3. Mini-plan with 3 to 7 concrete steps
4. READY OUTPUT
5. Exact next step

READY OUTPUT RULES:
- The ready output is the most important part.
- Make it directly copy-paste usable.
- Examples: offer, ad, message, email, post, action plan, script, pricing draft, proposal text.
- If useful, provide 1 to 3 variations with clearly different tone or angle.

AVOID:
- generic business advice
- abstract theory
- empty frameworks
- filler like "test and optimize", "create a strategy", "consider improving"
- long bloated lists
- vague suggestions without doing the work

IMPORTANT:
- If the user asks a simple factual question, answer normally without forcing this structure.
- If the user explicitly asks for short output, keep it short.
- If the user asks for only one thing, prioritize finishing that one thing fully.
- Always optimize for speed, clarity, usefulness, and copy-paste readiness.
- The user should feel that AJX AI removed friction and got the work moving immediately.
`;

// ====== Provider selection ======
type Provider = "gemini" | "openai";
function hasGeminiKey() {
  return !!process.env.GEMINI_API_KEY;
}
function hasOpenAIKey() {
  return !!process.env.OPENAI_API_KEY;
}
function chooseProvider(): Provider {
  if (hasGeminiKey()) return "gemini";
  return "openai";
}

// ====== CANONICAL LIMITS ======
type CanonicalLimits = {
  reqPerMonth: number;
  reqPerDay: number;
  imgAnalysesPerMonth: number;
  imgAnalysesPerDay: number;
  webPerMonth: number;
  workMemory: number;
};

function canonicalLimits(plan: PlanId): CanonicalLimits {
  const p = plan === ("visual" as any) ? ("basic" as any) : plan;

  switch (p as any) {
    case "free":
      return {
        reqPerMonth: 0,
        reqPerDay: 10,
        imgAnalysesPerMonth: 0,
        imgAnalysesPerDay: 0,
        webPerMonth: 0,
        workMemory: 5,
      };

    case "basic":
      return {
        reqPerMonth: 1000,
        reqPerDay: 0,
        imgAnalysesPerMonth: 0,
        imgAnalysesPerDay: 5,
        webPerMonth: 0,
        workMemory: 10,
      };

    case "plus":
      return {
        reqPerMonth: 2000,
        reqPerDay: 0,
        imgAnalysesPerMonth: 120,
        imgAnalysesPerDay: 0,
        webPerMonth: 0,
        workMemory: 25,
      };

    case "pro":
      return {
        reqPerMonth: 3000,
        reqPerDay: 0,
        imgAnalysesPerMonth: 200,
        imgAnalysesPerDay: 0,
        webPerMonth: 200,
        workMemory: 50,
      };

    case "company":
      return {
        reqPerMonth: 4000,
        reqPerDay: 0,
        imgAnalysesPerMonth: 300,
        imgAnalysesPerDay: 0,
        webPerMonth: 300,
        workMemory: 75,
      };

    default:
      return {
        reqPerMonth: 0,
        reqPerDay: 0,
        imgAnalysesPerMonth: 0,
        imgAnalysesPerDay: 0,
        webPerMonth: 0,
        workMemory: 0,
      };
  }
}


function freePremiumToolLockedText(locale: Locale) {
  return l(
    locale,
    "Tämä yrittäjätyökalu kuuluu Plus-versioon. Ilmaisversiossa voit kysyä yleisiä neuvoja, mutta valmiit työkaluprosessit kuten tarjoukset, mainokset, hinnoittelu, asiakashankinta, markkinointi ja rahoituksen hakeminen avautuvat Plus-paketissa.",
    "This entrepreneur tool is included in Plus. In the free version, you can ask general advice, but ready-made tool workflows such as offers, ads, pricing, customer acquisition, marketing, and funding support are available in Plus.",
    "Esta herramienta para emprendedores está incluida en Plus. En la versión gratuita puedes pedir consejos generales, pero los flujos de trabajo como ofertas, anuncios, precios, captación de clientes, marketing y financiación están disponibles en Plus."
  );
}

function isFreePremiumToolAttempt(text: string): boolean {
  const t = String(text || "").toLowerCase();

  const patterns = [
    /luo.*tarjous/,
    /tee.*tarjous/,
    /auta.*tarjous/,
    /tarjouspohja/,
    /mainos/,
    /tee.*mainos/,
    /mainosteksti/,
    /voiko.*luoda.*mainos/,
    /voitko.*luoda.*mainos/,
    /voisitko.*luoda.*mainos/,
    /auta.*mainos/,
    /kasvata.*myynt/,
    /hanki.*asiakk/,
    /löydä.*asiakk/,
    /paranna.*markkinoint/,
    /paranna.*hinnoittel/,
    /hanki.*rahoit/,
    /hanki.*tuk/,
    /etsi.*rahoit/,
      /auta.*rahoit/,
      /auta.*hakemaan.*rahoit/,
      /hae.*rahoit/,
      /hakemaan.*rahoit/,
      /rahoituksen.*hakem/,
    /etsi.*tuk/,
    /yritysongelma/,

    /create.*offer/,
    /make.*offer/,
    /write.*offer/,
    /create.*ad/,
    /write.*ad/,
    /grow.*sales/,
    /get.*customers/,
    /find.*customers/,
    /improve.*marketing/,
    /improve.*pricing/,
    /get.*funding/,
    /find.*funding/,
    /business problem/,

    /crear.*oferta/,
    /hacer.*oferta/,
    /crear.*anuncio/,
    /aumentar.*ventas/,
    /conseguir.*clientes/,
    /mejorar.*marketing/,
    /mejorar.*precios/,
    /buscar.*financiaci/,
    /conseguir.*financiaci/
  ];

  return patterns.some((re) => re.test(t));
}


function freeLiteModeInstruction(locale: Locale): string {
  return l(
    locale,
    `
- User is on FREE plan.
- Provide a LIGHT version of the result.
- Avoid generic marketing phrases like "high quality", "best service", "industry leading".
- Avoid emojis unless absolutely necessary.
- Prefer simple, direct, believable language.
- Make the output feel like it could actually be used immediately.
- Do not sound like typical AI-generated marketing text.
- Avoid phrases like "luotettava kumppani", "asiantunteva palvelu", "laadukas", "alan huipulta".
- Do NOT list generic bullet points.
- Write like a real small business, not a marketing agency.
- Prefer simple, concrete sentences.
- Make it feel local, practical and believable.
`.trim(),
    `
- User is on FREE plan.
- Provide a LIGHT version of the result.
- Avoid generic marketing phrases like "high quality", "best service", "industry leading".
- Avoid emojis unless absolutely necessary.
- Prefer simple, direct, believable language.
- Make the output feel like it could actually be used immediately.
- Do not sound like typical AI-generated marketing text.
- Avoid phrases like "luotettava kumppani", "asiantunteva palvelu", "laadukas", "alan huipulta".
- Do NOT list generic bullet points.
- Write like a real small business, not a marketing agency.
- Prefer simple, concrete sentences.
- Make it feel local, practical and believable.
`.trim(),
    `
- User is on FREE plan.
- Provide a LIGHT version of the result.
- Avoid generic marketing phrases like "alta calidad", "mejor servicio", "líder del sector".
- Avoid emojis unless absolutely necessary.
- Prefer simple, direct, believable language.
- Make the output feel like it could actually be used immediately.
- Do not sound like typical AI-generated marketing text.
- Avoid phrases like "luotettava kumppani", "asiantunteva palvelu", "laadukas", "alan huipulta".
- Do NOT list generic bullet points.
- Write like a real small business, not a marketing agency.
- Prefer simple, concrete sentences.
- Make it feel local, practical and believable.
`.trim()
  );
}
function freeLitePrefix(locale: Locale): string {
  return l(
    locale,
    "Voin auttaa tässä myös ilmaisversiossa 👍\nTeen sinulle kevyen version. Plus-versiossa saat laajemman ohjatun työkalun.\n\n",
    "I can help with this in the free version 👍\nI’ll create a lighter version. Plus gives you a more advanced guided tool.\n\n",
    "Puedo ayudarte también en la versión gratuita 👍\nHaré una versión ligera. En Plus tienes una versión más completa.\n\n"
  );
}

// ====== Attachments parsing ======
type PreparedAttachment = {
  kind: "image" | "file";
  name: string;
  mime: string;
  base64: string;
  bytes: number;
};

type PreparedTextFile = {
  name: string;
  mime: string;
  text: string;
  truncated: boolean;
};

function isTextLikeMime(mime: string) {
  const m = (mime || "").toLowerCase();
  return (
    m.startsWith("text/") ||
    m === "application/json" ||
    m === "application/xml" ||
    m === "application/x-yaml" ||
    m === "application/yaml" ||
    m === "application/javascript" ||
    m === "application/typescript" ||
    m === "application/csv" || m === "application/pdf"
  );
}

function base64ToUtf8(base64: string): string {
  const buf = Buffer.from(base64, "base64");
  return buf.toString("utf8");
}

async function prepareAttachments(raw: any, locale: Locale): Promise<{
  images: PreparedAttachment[];
  files: PreparedAttachment[];
  textFiles: PreparedTextFile[];
  fileSummaries: string[];
}> {
  const arr: AttachmentIn[] = Array.isArray(raw) ? raw : [];
  const sliced = arr.slice(0, MAX_ATTACHMENTS);

  const images: PreparedAttachment[] = [];
  const files: PreparedAttachment[] = [];
  const textFiles: PreparedTextFile[] = [];
  const fileSummaries: string[] = [];

  for (const a of sliced) {
    const kind = a?.kind === "image" ? "image" : a?.kind === "file" ? "file" : null;
    if (!kind) continue;

    const name = String(a?.name || (kind === "image" ? "image" : "file"));
    const type = String(a?.type || "");
    const dataUrl = String(a?.dataUrl || "");
    const parsed = parseDataUrl(dataUrl);

    if (!parsed) {
      fileSummaries.push(
        l(
          locale,
          `- ${name}: liite puuttuu tai on virheellinen (dataUrl).`,
          `- ${name}: attachment is missing or invalid (dataUrl).`,
          `- ${name}: el adjunto falta o no es vÃ¡lido (dataUrl).`
        )
      );
      continue;
    }

    const mime = (type || parsed.mime || "application/octet-stream").toLowerCase();

    if (kind === "image") {
      if (!mime.startsWith("image/")) {
        fileSummaries.push(
          l(
            locale,
            `- ${name}: ei ole kuva (mime: ${mime}).`,
            `- ${name}: not an image (mime: ${mime}).`,
            `- ${name}: no es una imagen (mime: ${mime}).`
          )
        );
        continue;
      }
      if (parsed.bytes > MAX_IMAGE_BYTES) {
        fileSummaries.push(
          l(
            locale,
            `- ${name}: kuva liian iso (${Math.round(parsed.bytes / 1024)} KB).`,
            `- ${name}: image too large (${Math.round(parsed.bytes / 1024)} KB).`,
            `- ${name}: imagen demasiado grande (${Math.round(parsed.bytes / 1024)} KB).`
          )
        );
        continue;
      }
      images.push({
        kind: "image",
        name,
        mime,
        base64: parsed.base64,
        bytes: parsed.bytes,
      });
      continue;
    }

    if (parsed.bytes > MAX_FILE_BYTES) {
      fileSummaries.push(
        l(
          locale,
          `- ${name}: tiedosto liian iso (${Math.round(parsed.bytes / 1024)} KB).`,
          `- ${name}: file too large (${Math.round(parsed.bytes / 1024)} KB).`,
          `- ${name}: archivo adjunto demasiado grande (${Math.round(parsed.bytes / 1024)} KB).`
        )
      );
      continue;
    }

    files.push({
      kind: "file",
      name,
      mime,
      base64: parsed.base64,
      bytes: parsed.bytes,
    });

    if (mime === "application/pdf") {
      let txt = "";
      try {
        const pdfData = await pdfParse(Buffer.from(parsed.base64, "base64"));
        txt = String(pdfData?.text || "");
      } catch {
        txt = "";
      }

      if (txt) {
        const normalizedTxt = txt.replace(/\r\n/g, "\n").trim();
        const truncated = normalizedTxt.length > MAX_EXTRACTED_TEXT_CHARS;

        if (truncated) {
          const headSize = Math.floor(MAX_EXTRACTED_TEXT_CHARS * 0.7);
          const tailSize = MAX_EXTRACTED_TEXT_CHARS - headSize;
          const head = normalizedTxt.slice(0, headSize).trim();
          const tail = normalizedTxt.slice(-tailSize).trim();

          txt =
            `${head}\n\n[... PDF middle truncated ...]\n\n${tail}`.trim();
        } else {
          txt = normalizedTxt;
        }

        textFiles.push({ name, mime, text: txt, truncated });
      } else {
        fileSummaries.push(
          l(
            locale,
            `- ${name}: PDF-tekstin lukeminen epÃ¤onnistui.`,
            `- ${name}: failed to read PDF text.`,
            `- ${name}: no se pudo leer el texto del PDF.`
          )
        );
      }
    } else if (isTextLikeMime(mime)) {
      let txt = "";
      try {
        txt = base64ToUtf8(parsed.base64);
      } catch {
        txt = "";
      }

      if (txt) {
        const truncated = txt.length > MAX_EXTRACTED_TEXT_CHARS;
        if (truncated) txt = txt.slice(0, MAX_EXTRACTED_TEXT_CHARS);
        textFiles.push({ name, mime, text: txt, truncated });
      } else {
        fileSummaries.push(
          l(
            locale,
            `- ${name}: tekstin lukeminen epÃ¤onnistui (mime: ${mime}).`,
            `- ${name}: failed to read text (mime: ${mime}).`,
            `- ${name}: no se pudo leer el texto (mime: ${mime}).`
          )
        );
      }
    } else {
      fileSummaries.push(
        l(
          locale,
          `- ${name}: liitetty tiedosto (mime: ${mime}, ${Math.round(parsed.bytes / 1024)} KB).`,
          `- ${name}: attached file (mime: ${mime}, ${Math.round(parsed.bytes / 1024)} KB).`,
          `- ${name}: archivo adjunto (mime: ${mime}, ${Math.round(parsed.bytes / 1024)} KB).`
        )
      );
    }
  }

  for (const tf of textFiles) {
    fileSummaries.push(
      l(
        locale,
        `- ${tf.name}: tekstitiedosto (${tf.mime})${tf.truncated ? " [katkaistu]" : ""}.`,
        `- ${tf.name}: text file (${tf.mime})${tf.truncated ? " [truncated]" : ""}.`,
        `- ${tf.name}: archivo de texto (${tf.mime})${tf.truncated ? " [recortado]" : ""}.`
      )
    );
  }

  return { images, files, textFiles, fileSummaries };
}

// ====== OpenAI ======
async function callOpenAIResponses(opts: {
  apiKey: string;
  instructions: string;
  inputText: string;
  images?: { mime: string; base64: string; name: string }[];
  maxOutputTokens?: number;
}): Promise<string> {
  const input: any[] = [
    {
      role: "user",
      content: [{ type: "input_text", text: opts.inputText }],
    },
  ];

  const imgs = Array.isArray(opts.images) ? opts.images : [];
  if (imgs.length > 0) {
    const content = input[0].content as any[];
    for (const im of imgs) {
      const dataUrl = `data:${im.mime};base64,${im.base64}`;
      content.push({ type: "input_image", image_url: dataUrl });
    }
    input[0].content = content;
  }

  const body: any = {
    model: OPENAI_MODEL,
    instructions: opts.instructions,
    input,
  };

  if (typeof opts.maxOutputTokens === "number" && opts.maxOutputTokens > 0) {
    body.max_output_tokens = opts.maxOutputTokens;
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw createProviderError("openai", res.status, t || `OpenAI error HTTP ${res.status}`);
  }

  const j: any = await res.json();
  const outText =
    j?.output_text ??
    j?.output
      ?.find?.((it: any) => it?.type === "message")
      ?.content?.find?.((c: any) => c?.type === "output_text")?.text ??
    "";

  if (!isUsableModelText(outText)) {
    throw createProviderError("openai", 502, `OpenAI model ${OPENAI_MODEL} returned empty text`);
  }

  return String(outText || "");
}

async function* callOpenAIResponsesStream(opts: {
  apiKey: string;
  instructions: string;
  inputText: string;
  images?: { mime: string; base64: string; name: string }[];
  maxOutputTokens?: number;
}): AsyncGenerator<string> {
  const input: any[] = [
    {
      role: "user",
      content: [{ type: "input_text", text: opts.inputText }],
    },
  ];

  const imgs = Array.isArray(opts.images) ? opts.images : [];
  if (imgs.length > 0) {
    const content = input[0].content as any[];
    for (const im of imgs) {
      const dataUrl = `data:${im.mime};base64,${im.base64}`;
      content.push({ type: "input_image", image_url: dataUrl });
    }
    input[0].content = content;
  }

  const body: any = {
    model: OPENAI_MODEL,
    instructions: opts.instructions,
    input,
    stream: true,
  };

  if (typeof opts.maxOutputTokens === "number" && opts.maxOutputTokens > 0) {
    body.max_output_tokens = opts.maxOutputTokens;
  }

  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw createProviderError("openai", res.status, t || `OpenAI error HTTP ${res.status}`);
  }

  const reader = res.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });

    while (true) {
      const idx = buf.indexOf("\n\n");
      if (idx === -1) break;
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      const lines = chunk.split("\n");
      for (const line of lines) {
        const ll = line.trim();
        if (!ll.startsWith("data:")) continue;
        const data = ll.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") return;

        let evt: any = null;
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }

        if (evt?.type === "response.output_text.delta") {
          const delta =
            evt?.delta ?? evt?.text ?? evt?.output_text_delta ?? evt?.data?.delta ?? "";
          if (delta) yield String(delta);
        }
      }
    }
  }
}

// ====== Gemini ======
function buildGeminiParts(promptText: string, images?: { mime: string; base64: string }[]) {
  const parts: any[] = [{ text: promptText }];
  const imgs = Array.isArray(images) ? images : [];
  for (const im of imgs) {
    parts.push({
      inline_data: {
        mime_type: im.mime,
        data: im.base64,
      },
    });
  }
  return parts;
}

async function callGeminiGenerateContent(opts: {
  apiKey: string;
  model: string;
  promptText: string;
  images?: { mime: string; base64: string }[];
  maxOutputTokens?: number;
}): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    opts.model
  )}:generateContent`;

  const body: any = {
    contents: [{ role: "user", parts: buildGeminiParts(opts.promptText, opts.images) }],
  };

  if (typeof opts.maxOutputTokens === "number" && opts.maxOutputTokens > 0) {
    body.generationConfig = {
      ...(body.generationConfig || {}),
      maxOutputTokens: opts.maxOutputTokens,
    };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-goog-api-key": opts.apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw createProviderError("gemini", res.status, t || `Gemini error HTTP ${res.status}`);
  }

  const j: any = await res.json();
  const text =
    j?.candidates?.[0]?.content?.parts?.map?.((p: any) => p?.text || "").join("") ??
    j?.candidates?.[0]?.content?.parts?.[0]?.text ??
    "";

  if (!isUsableModelText(text)) {
    throw createProviderError("gemini", 502, `Gemini model ${opts.model} returned empty text`);
  }

  return String(text || "");
}

async function* callGeminiStreamGenerateContent(opts: {
  apiKey: string;
  model: string;
  promptText: string;
  images?: { mime: string; base64: string }[];
  maxOutputTokens?: number;
}): AsyncGenerator<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
    opts.model
  )}:streamGenerateContent?alt=sse&key=${encodeURIComponent(opts.apiKey)}`;

  const body: any = {
    contents: [{ role: "user", parts: buildGeminiParts(opts.promptText, opts.images) }],
  };

  if (typeof opts.maxOutputTokens === "number" && opts.maxOutputTokens > 0) {
    body.generationConfig = {
      ...(body.generationConfig || {}),
      maxOutputTokens: opts.maxOutputTokens,
    };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw createProviderError("gemini", res.status, t || `Gemini error HTTP ${res.status}`);
  }

  const reader = res.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buf = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });

    while (true) {
      const idx = buf.indexOf("\n\n");
      if (idx === -1) break;

      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);

      const lines = chunk.split("\n");
      for (const line of lines) {
        const ll = line.trim();
        if (!ll.startsWith("data:")) continue;

        const data = ll.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") return;

        let evt: any = null;
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }

        const text =
          evt?.candidates?.[0]?.content?.parts?.map?.((p: any) => p?.text || "").join("") ??
          evt?.candidates?.[0]?.content?.parts?.[0]?.text ??
          "";

        if (text) yield String(text);
      }
    }
  }
}

// ====== Provider error handling ======
type ProviderName = "gemini" | "openai";

type ProviderError = Error & {
  provider?: ProviderName;
  statusCode?: number;
  rawMessage?: string;
};

function createProviderError(
  provider: ProviderName,
  statusCode: number | undefined,
  message: string
): ProviderError {
  const err = new Error(message) as ProviderError;
  err.provider = provider;
  err.statusCode = statusCode;
  err.rawMessage = String(message || "");
  return err;
}

function isGeminiFallbackEligible(err: unknown): boolean {
  const e = err as ProviderError | undefined;
  const status = Number(e?.statusCode || 0);
  const msg = String(e?.rawMessage || e?.message || "").toLowerCase();

  if (status === 500 || status === 503) return true;
  if (msg.includes("quota exceeded")) return true;
  if (msg.includes("resource exhausted")) return true;
  if (msg.includes("overloaded")) return true;
  if (msg.includes("unavailable")) return true;
  if (msg.includes("rate limit")) return true;
  if (msg.includes("too many requests")) return true;
  if (msg.includes("backend error")) return true;
  if (msg.includes("returned empty text")) return true;

  return false;
}

// ====== AJX AGENTS ======
function normalizeAjxRole(v: any): AjxRoleId {
  const s = String(v || "").toLowerCase().trim();

  if (s === "yleinen" || s === "general") return "general";
  if (s === "tiedonhaku" || s === "research" || s === "info" || s === "search") return "research";
  if (s === "ideointi" || s === "ideation" || s === "ideas") return "ideation";
  if (s === "analysointi" || s === "analysis" || s === "analyytikko") return "analysis";
  if (s === "strategia" || s === "strategy") return "strategy";

  if (s === "neutral") return "general";
  if (s === "teacher_assistant") return "research";
  if (s === "ideation_assistant") return "ideation";
  if (s === "analysis_assistant") return "analysis";
  if (s === "strategy_assistant") return "strategy";
  if (s === "quick_assistant") return "general";

  return "general";
}

function roleInstruction(role: AjxRoleId): string {
  switch (role) {
    case "general":
      return [
        "- Agent: Yleinen.",
        "- Conversation style: relaxed, natural and conversational.",
        "- Sound like a smart, pleasant and human discussion partner.",
      ].join("\n");

    case "research":
      return [
        "- Agent: Tiedonhaku.",
        "- Conversation style: direct and fact-focused.",
        "- Prioritize accuracy, clarity and signal.",
      ].join("\n");

    case "ideation":
      return [
        "- Agent: Ideointi.",
        "- Conversation style: inspiring, creative and energizing.",
        "- Bring momentum and useful ideas.",
      ].join("\n");

    case "analysis":
      return [
        "- Agent: Analysointi.",
        "- Conversation style: calm, logical and structured.",
        "- Focus on trade-offs, risks, logic and conclusion.",
      ].join("\n");

    case "strategy":
      return [
        "- Agent: Strategia.",
        "- Conversation style: direct and business-focused.",
        "- Focus on decisions, priorities, leverage and execution.",
      ].join("\n");

    default:
      return "- Agent: Yleinen.";
  }
}

function allowedRolesForPlan(plan: PlanId): AjxRoleId[] {
  const p = plan === ("visual" as any) ? ("basic" as any) : plan;

  if (p === ("free" as any)) return ["general"];
  if (p === ("basic" as any)) return ["general", "research"];
  if (p === ("plus" as any)) return ["general", "research", "ideation"];
  if (p === ("pro" as any)) return ["general", "research", "ideation", "analysis"];
  if (p === ("company" as any)) return ["general", "research", "ideation", "analysis", "strategy"];
  return ["general"];
}

function sanitizeRoleForPlan(plan: PlanId, rolesEnabled: boolean, requested: AjxRoleId): AjxRoleId {
  if (!rolesEnabled) return "general";
  const allowed = allowedRolesForPlan(plan);
  if (!allowed.length) return "general";
  if (allowed.includes(requested)) return requested;
  return allowed[0] || "general";
}

// ====== MODEL SELECTION ======
function needsCompanyProModel(args: {
  role: AjxRoleId;
  lastUserText: string;
  hasTextFiles: boolean;
  didWeb: boolean;
}): { needsPro: boolean; reason: string } {
  const text = String(args.lastUserText || "").toLowerCase().trim();

  if (args.role === "analysis") return { needsPro: true, reason: "role-analysis" };
  if (args.role === "strategy") return { needsPro: true, reason: "role-strategy" };
  if (args.hasTextFiles) return { needsPro: true, reason: "text-files" };
  if (args.didWeb) return { needsPro: true, reason: "web-context" };
  if (text.length >= 700) return { needsPro: true, reason: "long-input" };

  const proHints = [
    "analysoi",
    "analyysi",
    "analysis",
    "strategia",
    "strategy",
    "vertaa",
    "vertaa vaihtoehtoja",
    "compare",
    "comparison",
    "trade-off",
    "tradeoff",
    "riski",
    "risk",
    "skenaario",
    "scenario",
    "ennuste",
    "forecast",
    "roadmap",
    "go to market",
    "go-to-market",
    "liiketoimintasuunnitelma",
    "business plan",
    "hinnoittelu",
    "pricing",
    "due diligence",
    "priorisoi",
    "prioritize",
    "suositus",
    "recommendation",
    "pÃ¤Ã¤tÃ¶srunko",
    "decision framework",
  ];

  for (const hint of proHints) {
    if (text.includes(hint)) {
      return { needsPro: true, reason: `keyword-${hint}` };
    }
  }

  return { needsPro: false, reason: "flash-default" };
}

function geminiModelForRequest(args: {
  plan: PlanId;
  usage: UsageRow;
  role: AjxRoleId;
  lastUserText: string;
  hasTextFiles: boolean;
  didWeb: boolean;
  plusSavingsActive: boolean;
}): {
  model: string;
  companyNeedsPro: boolean;
  companyCanUsePro: boolean;
  companyUsesPro: boolean;
  reason: string;
} {
  const p = args.plan === ("visual" as any) ? ("basic" as any) : args.plan;

  if (p === ("company" as any)) {
    const proUsed = Number(args.usage?.proUsedThisMonth || 0);
    const companyCanUsePro = proUsed < COMPANY_PRO_REQUESTS_CAP;
    const companyNeed = needsCompanyProModel({
      role: args.role,
      lastUserText: args.lastUserText,
      hasTextFiles: args.hasTextFiles,
      didWeb: args.didWeb,
    });

    if (companyNeed.needsPro && companyCanUsePro) {
      return {
        model: GEMINI_PRO_MODEL,
        companyNeedsPro: true,
        companyCanUsePro: true,
        companyUsesPro: true,
        reason: companyNeed.reason,
      };
    }

    return {
      model: GEMINI_FLASH_MODEL,
      companyNeedsPro: companyNeed.needsPro,
      companyCanUsePro,
      companyUsesPro: false,
      reason: companyNeed.needsPro ? "cap-reached-fallback-flash" : companyNeed.reason,
    };
  }

  if (p === ("pro" as any)) {
    return {
      model: GEMINI_FLASH_MODEL,
      companyNeedsPro: false,
      companyCanUsePro: false,
      companyUsesPro: false,
      reason: "pro-plan-flash",
    };
  }

  if (p === ("plus" as any)) {
    if (args.plusSavingsActive) {
      return {
        model: GEMINI_FLASH_LITE_MODEL,
        companyNeedsPro: false,
        companyCanUsePro: false,
        companyUsesPro: false,
        reason: "plus-savings-flash-lite",
      };
    }

    return {
      model: GEMINI_FLASH_MODEL,
      companyNeedsPro: false,
      companyCanUsePro: false,
      companyUsesPro: false,
      reason: "plus-plan-flash",
    };
  }

  return {
    model: GEMINI_FLASH_LITE_MODEL,
    companyNeedsPro: false,
    companyCanUsePro: false,
    companyUsesPro: false,
    reason: "lite-plan-flash-lite",
  };
}

// ====== ROUTE ======
export async function POST(req: NextRequest) {
  if (!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY) {
    return jsonError(500, "Puuttuu sekÃ¤ OPENAI_API_KEY ettÃ¤ GEMINI_API_KEY (.env.local).");
  }

  const cookieVal = req.cookies.get(COOKIE_NAME)?.value;
  let userId = verifySignedUid(cookieVal);

  const resHeaders = new Headers();
  if (!userId) {
    userId = newUid();
    const signed = signUid(userId);
    resHeaders.append(
      "Set-Cookie",
      `${COOKIE_NAME}=${signed}; Path=/; HttpOnly; SameSite=Lax`
    );
  }

  const devScope = resolveDevScope(req);
  const storeUserKey = scopedUserKey(userId, devScope);

  const planRaw = resolvePlan(req);
  const plan: PlanId = (planRaw === ("visual" as any) ? ("basic" as any) : planRaw) as any;

  const limits = canonicalLimits(plan);

  let body: any = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }

  const stream = !!body?.stream;
  const bodyUseWeb = !!body?.useWeb;
  const webBoost = !!body?.webBoost;

  const messagesRaw: Msg[] = Array.isArray(body?.messages) ? body.messages : [];
  const locale = normLocale(body?.locale);

  const attachmentsRaw = body?.attachments;
  const prepared = await prepareAttachments(attachmentsRaw, locale);

  const rolesEnabledRaw = !!body?.rolesEnabled;
  const requestedRole: AjxRoleId = normalizeAjxRole(body?.role);
  const role: AjxRoleId = sanitizeRoleForPlan(plan, rolesEnabledRaw, requestedRole);

  const lastUser = [...messagesRaw].reverse().find(
    (m) => m?.role === "user" && typeof m?.content === "string"
  );
  const lastTextOriginal = String(lastUser?.content || "");

  const safetyFlags = detectSafetyFlags(lastTextOriginal);
  const injectResponsibilityReminder = shouldInjectResponsibilityReminder(messagesRaw);

  const monthKey = getMonthKey();
  const usage = await loadUsageRow(storeUserKey, monthKey);
  const usageBeforeRequest: UsageRow = {
    ...emptyUsageRow(),
    ...usage,
  };

  if (typeof usage.extraWebThisMonth !== "number") usage.extraWebThisMonth = 0;
  if (typeof usage.extraMsgThisMonth !== "number") usage.extraMsgThisMonth = 0;
  if (typeof usage.extraImgThisMonth !== "number") usage.extraImgThisMonth = 0;
  if (typeof usage.proUsedThisMonth !== "number") usage.proUsedThisMonth = 0;

  const todayKey = getDayKey();
  if (usage.dayKey !== todayKey) {
    usage.dayKey = todayKey;
    usage.reqToday = 0;
    usage.imgToday = 0;
  }

  const budget = promptBudgetForPlan(plan, usage);

  const plusAutoSavingsExtra =
    plan === ("plus" as any) ? PLUS_SAVINGS_EXTRA_LIMIT : 0;

  const effectiveReqLimit =
    Number(limits.reqPerMonth || 0) +
    Number(usage.extraMsgThisMonth || 0) +
    plusAutoSavingsExtra;
  const effectiveImgLimit =
    Number(limits.imgAnalysesPerMonth || 0) + Number(usage.extraImgThisMonth || 0);
  const effectiveWebLimit = Number(limits.webPerMonth || 0) + Number(usage.extraWebThisMonth || 0);
if (lastTextOriginal.length > budget.maxLastUserChars) {
    return NextResponse.json(
      {
        ok: false,
        error: promptTooLongText(plan, locale),
        plan,
        limits: {
          ...limits,
          reqPerMonth: effectiveReqLimit,
          imgAnalysesPerMonth: effectiveImgLimit,
          webPerMonth: effectiveWebLimit,
        },
        usage,
      },
      { status: 413, headers: resHeaders }
    );
  }

  const imgCount = prepared.images.length;
  const requestCost = imgCount > 0 ? 2 : 1;

  if ((limits.reqPerDay || 0) > 0 && (usage.reqToday || 0) + requestCost > limits.reqPerDay) {
    return NextResponse.json(
      {
        ok: false,
        error: messageLimitReachedText(plan, locale),
        plan,
        limits: {
          ...limits,
          reqPerMonth: effectiveReqLimit,
          imgAnalysesPerMonth: effectiveImgLimit,
          webPerMonth: effectiveWebLimit,
        },
        usage,
      },
      { status: 403, headers: resHeaders }
    );
  }

  if (plan === ("plus" as any) && (usage.msgThisMonth || 0) + requestCost > PLUS_SAVINGS_TOTAL_LIMIT) {
    return NextResponse.json(
      {
        ok: false,
        error: plusSavingsModeLimitReachedText(locale),
        plan,
        limits: {
          ...limits,
          reqPerMonth: effectiveReqLimit,
          imgAnalysesPerMonth: effectiveImgLimit,
          webPerMonth: effectiveWebLimit,
        },
        usage,
      },
      { status: 403, headers: resHeaders }
    );
  }

  if (effectiveReqLimit > 0 && (usage.msgThisMonth || 0) + requestCost > effectiveReqLimit) {
    return NextResponse.json(
      {
        ok: false,
        error: messageLimitReachedText(plan, locale),
        plan,
        limits: {
          ...limits,
          reqPerMonth: effectiveReqLimit,
          imgAnalysesPerMonth: effectiveImgLimit,
          webPerMonth: effectiveWebLimit,
        },
        usage,
      },
      { status: 403, headers: resHeaders }
    );
  }

  if (imgCount > 0) {
    if (
      (limits.imgAnalysesPerDay || 0) > 0 &&
      (usage.imgToday || 0) + imgCount > limits.imgAnalysesPerDay
    ) {
      return NextResponse.json(
        {
          ok: false,
          error: l(
            locale,
            "Kuva-analyysien pÃ¤ivÃ¤kiintiÃ¶ tÃ¤ynnÃ¤. YritÃ¤ huomenna uudelleen.",
            "Daily image analysis quota reached. Try again tomorrow.",
            "Cuota diaria de anÃ¡lisis de imÃ¡genes alcanzada. IntÃ©ntalo maÃ±ana."
          ),
          plan,
          limits: {
            ...limits,
            reqPerMonth: effectiveReqLimit,
            imgAnalysesPerMonth: effectiveImgLimit,
            webPerMonth: effectiveWebLimit,
          },
          usage,
        },
        { status: 403, headers: resHeaders }
      );
    }

    if (effectiveImgLimit > 0 && (usage.imgThisMonth || 0) + imgCount > effectiveImgLimit) {
      return NextResponse.json(
        {
          ok: false,
          error: l(
            locale,
            "Kuva-analyysien kuukausikiintiÃ¶ tÃ¤ynnÃ¤.",
            "Monthly image analysis quota reached.",
            "Cuota mensual de anÃ¡lisis de imÃ¡genes alcanzada."
          ),
          plan,
          limits: {
            ...limits,
            reqPerMonth: effectiveReqLimit,
            imgAnalysesPerMonth: effectiveImgLimit,
            webPerMonth: effectiveWebLimit,
          },
          usage,
        },
        { status: 403, headers: resHeaders }
      );
    }

    if ((limits.imgAnalysesPerDay || 0) <= 0 && effectiveImgLimit <= 0) {
      return NextResponse.json(
        {
          ok: false,
          error: l(
            locale,
            "Kuvien analyysi ei ole kÃ¤ytÃ¶ssÃ¤ tÃ¤llÃ¤ tasolla.",
            "Image analysis is not available on this plan.",
            "El anÃ¡lisis de imÃ¡genes no estÃ¡ disponible en este plan."
          ),
          plan,
          limits: {
            ...limits,
            reqPerMonth: effectiveReqLimit,
            imgAnalysesPerMonth: effectiveImgLimit,
            webPerMonth: effectiveWebLimit,
          },
          usage,
        },
        { status: 403, headers: resHeaders }
      );
    }
  }

  const workN = Math.max(0, Math.min(200, Number(limits.workMemory || 0)));
  const workMessages = sliceForWorkMemory(messagesRaw, workN);
  const trimmedMemory = trimMessagesByChars(workMessages, budget.maxTranscriptChars);
  const messages = trimmedMemory.messages;

  const shouldTryWeb = !!bodyUseWeb;
  const webAllowedByPlan = effectiveWebLimit > 0;
  const webQuotaOk = (usage.webThisMonth || 0) < effectiveWebLimit;

  if (shouldTryWeb && !webAllowedByPlan) {
    return NextResponse.json(
      {
        ok: false,
        error: webNotAvailableOnPlanText(locale),
        plan,
        limits: {
          ...limits,
          reqPerMonth: effectiveReqLimit,
          imgAnalysesPerMonth: effectiveImgLimit,
          webPerMonth: effectiveWebLimit,
        },
        usage,
      },
      { status: 403, headers: resHeaders }
    );
  }

  if (shouldTryWeb && !webQuotaOk) {
    return NextResponse.json(
      {
        ok: false,
        error: webQuotaReachedText(locale),
        plan,
        limits: {
          ...limits,
          reqPerMonth: effectiveReqLimit,
          imgAnalysesPerMonth: effectiveImgLimit,
          webPerMonth: effectiveWebLimit,
        },
        usage,
      },
      { status: 403, headers: resHeaders }
    );
  }

  const useWeb = shouldTryWeb && webAllowedByPlan && webQuotaOk;

  const retrievalThreshold = useWeb
    ? WEB_DYNAMIC_THRESHOLD_FORCED
    : webBoost
      ? WEB_DYNAMIC_THRESHOLD_FORCED
      : WEB_DYNAMIC_THRESHOLD_DEFAULT;

  const plusSavingsStateBeforeCall = plusSavingsNoticeState({
    plan,
    usageBefore: usageBeforeRequest,
    usageAfter: {
      ...usage,
      msgThisMonth: Number(usage.msgThisMonth || 0) + requestCost,
    },
  });

  const maxOutputTokens =
    plan === ("plus" as any) && plusSavingsStateBeforeCall.activeForThisRequest
      ? PLUS_SAVINGS_MAX_OUTPUT_TOKENS
      : undefined;

  resHeaders.set("x-ajx-debug-useweb", String(useWeb));
  resHeaders.set("x-ajx-debug-web-requested", String(shouldTryWeb));
  resHeaders.set("x-ajx-debug-role", safeHeaderValue(String(role)));
  resHeaders.set("x-ajx-debug-plan", safeHeaderValue(String(plan)));
  resHeaders.set("x-ajx-debug-imgcount", String(imgCount));
  resHeaders.set("x-ajx-debug-reqcost", String(requestCost));
  resHeaders.set("x-ajx-debug-web-threshold", String(retrievalThreshold));
  resHeaders.set("x-ajx-debug-memory-trimmed", String(trimmedMemory.truncated));
  resHeaders.set("x-ajx-debug-effective-web-limit", String(effectiveWebLimit));
  resHeaders.set("x-ajx-debug-effective-img-limit", String(effectiveImgLimit));
  resHeaders.set("x-ajx-debug-effective-req-limit", String(effectiveReqLimit));
  resHeaders.set("x-ajx-debug-plus-primary-limit", String(PLUS_PRIMARY_LIMIT));
  resHeaders.set("x-ajx-debug-plus-savings-extra", String(PLUS_SAVINGS_EXTRA_LIMIT));
  resHeaders.set("x-ajx-debug-plus-savings-active", String(plusSavingsStateBeforeCall.activeForThisRequest));
  resHeaders.set("x-ajx-debug-plus-savings-just-activated", String(plusSavingsStateBeforeCall.justActivated));
  resHeaders.set("x-ajx-debug-max-output-tokens", String(maxOutputTokens || 0));
  resHeaders.set("x-ajx-debug-responsibility-reminder", String(injectResponsibilityReminder));
  resHeaders.set(
    "x-ajx-debug-company-preview-enabled",
    String(ENABLE_COMPANY_GEMINI_3_PREVIEW)
  );
  resHeaders.set(
    "x-ajx-debug-company-pro-used-month",
    String(Number(usage.proUsedThisMonth || 0))
  );
  resHeaders.set("x-ajx-debug-company-pro-cap", String(COMPANY_PRO_REQUESTS_CAP));

  let webContext = "";
  let didWeb = false;
  let webQueryUsed = "";
  let webFailureReason = "none";

  if (useWeb) {
    const forcedQueries = buildForcedWebQueries(messages, lastTextOriginal);

    for (let i = 0; i < forcedQueries.length; i++) {
      const query = forcedQueries[i];
      if (!query) continue;

      try {
        const w = await webSearch(
          query,
          {
            maxResults: i === 0 ? 6 : 8,
            timeoutMs: i === 0 ? 12000 : 15000,
            dynamicRetrieval: { threshold: WEB_DYNAMIC_THRESHOLD_FORCED },
          } as any
        );

        const gotContext = !!String(w?.webContext || "").trim();
        const gotDidWeb = !!w?.didWeb;

        if (gotDidWeb && gotContext) {
          didWeb = true;
          webQueryUsed = query;
          webContext = `\n\nWeb context (fresh data):\n${String(w.webContext || "").trim()}`;
          webFailureReason = "none";
          break;
        }

        webFailureReason = "no-context-returned";
      } catch (err: any) {
        webFailureReason = safeHeaderValue(
          String(err?.message || "web-search-error"),
          "web-search-error"
        );
      }
    }

    if (!didWeb) {
      resHeaders.set("x-ajx-debug-didweb", "false");
      resHeaders.set(
        "x-ajx-debug-web-query",
        safeHeaderValue(webQueryUsed || forcedQueries[0] || "none", "none", 200)
      );
      resHeaders.set(
        "x-ajx-debug-web-failure",
        safeHeaderValue(webFailureReason, "unknown", 200)
      );

      return NextResponse.json(
        {
          ok: false,
          error: webSearchFailedText(locale),
          plan,
          limits: {
            ...limits,
            reqPerMonth: effectiveReqLimit,
            imgAnalysesPerMonth: effectiveImgLimit,
            webPerMonth: effectiveWebLimit,
          },
          usage,
          web: {
            requested: true,
            didWeb: false,
            query: forcedQueries[0] || "",
            failure: webFailureReason,
          },
        },
        { status: 502, headers: resHeaders }
      );
    }
  }

  resHeaders.set("x-ajx-debug-didweb", String(didWeb));
  resHeaders.set("x-ajx-debug-web-query", safeHeaderValue(webQueryUsed || "none", "none", 200));
  resHeaders.set("x-ajx-debug-web-failure", safeHeaderValue(webFailureReason, "none", "none".length));

  usage.msgThisMonth = (usage.msgThisMonth || 0) + requestCost;
  usage.reqToday = (usage.reqToday || 0) + requestCost;

  if (imgCount > 0) {
    usage.imgThisMonth = (usage.imgThisMonth || 0) + imgCount;
    usage.imgToday = (usage.imgToday || 0) + imgCount;
  }

  if (didWeb) usage.webThisMonth = (usage.webThisMonth || 0) + 1;

  await saveUsageRow(storeUserKey, monthKey, usage);

  const plusSavingsStateAfterUsage = plusSavingsNoticeState({
    plan,
    usageBefore: usageBeforeRequest,
    usageAfter: usage,
  });

  if (lastTextOriginal && isModelQuestion(lastTextOriginal)) {
    let text = l(
      locale,
      "Olen AJX AI. En paljasta kÃ¤ytÃ¶ssÃ¤ olevia malliversioita, koulutuspÃ¤ivÃ¤mÃ¤Ã¤riÃ¤ tai sisÃ¤isiÃ¤ jÃ¤rjestelmÃ¤tietoja.",
      "I am AJX AI. I do not reveal model versions, training cut-off dates, or internal system details.",
      "Soy AJX AI. No revelo versiones de modelo, fechas de corte de entrenamiento ni detalles internos del sistema."
    );

    text = prependPlusSavingsNotice(text, locale, plusSavingsStateAfterUsage);

    if (!stream) {
      return NextResponse.json(
        {
          ok: true,
          plan,
          limits: {
            ...limits,
            reqPerMonth: effectiveReqLimit,
            imgAnalysesPerMonth: effectiveImgLimit,
            webPerMonth: effectiveWebLimit,
          },
          usage,
          text,
        },
        { status: 200, headers: resHeaders }
      );
    }

    const readable = new ReadableStream({
      start(controller) {
        controller.enqueue(
          sseEncode({
            type: "delta",
            delta: text,
          })
        );
        controller.enqueue(
          sseEncode({
            type: "final",
            fullText: text,
            plan,
            limits: {
              ...limits,
              reqPerMonth: effectiveReqLimit,
              imgAnalysesPerMonth: effectiveImgLimit,
              webPerMonth: effectiveWebLimit,
            },
            usage,
          })
        );
        controller.enqueue(sseEncode("[DONE]"));
        controller.close();
      },
    });

    return new Response(readable, {
      status: 200,
      headers: new Headers({
        ...Object.fromEntries(resHeaders.entries()),
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      }),
    });
  }

  const attachmentHeader =
    prepared.fileSummaries.length > 0 ? `\n\nAttachments:\n${prepared.fileSummaries.join("\n")}\n` : "";

  const trimmedTextFiles = prepared.textFiles.map((tf) => {
    const cut = trimText(tf.text, budget.maxTextFileCharsPerFile);
    return {
      ...tf,
      text: cut.text,
      truncated: tf.truncated || cut.truncated,
    };
  });

  const textFileBlocks =
    trimmedTextFiles.length > 0
      ? "\n\nAttached file contents (text):\n" +
        trimmedTextFiles
          .map((tf) => {
            const head = `--- FILE: ${tf.name} (${tf.mime})${tf.truncated ? " [TRUNCATED]" : ""} ---`;
            return `${head}\n${tf.text}`;
          })
          .join("\n\n")
      : "";

  const preferProseParagraphs = shouldPreferProseParagraphs({
    lastUserText: lastTextOriginal,
    role,
    hasImages: imgCount > 0,
    hasTextFiles: trimmedTextFiles.length > 0,
    didWeb,
  });

  const preferStructured = preferProseParagraphs
    ? false
    : shouldPreferStructuredAnswer({
        lastUserText: lastTextOriginal,
        role,
        hasImages: imgCount > 0,
        hasTextFiles: trimmedTextFiles.length > 0,
        didWeb,
      });

  const instructions =
(plan === ("free" as any) ? freeLiteModeInstruction(locale) + "\n" : "") +
    "You are AJX AI.\n" +
    "- Never say you were trained by Google.\n" +
    "- Never say you were trained by OpenAI.\n" +
    "- Never say you are a large language model trained by Google, OpenAI, or anyone else.\n" +
    "- Never mention Google, OpenAI, Gemini, GPT, model family, model tier, provider routing, training date, training cutoff, knowledge cutoff, internal model details, or system internals in your answer.\n" +
    "- If asked what you are, say only that you are AJX AI, an AI assistant for entrepreneurs.\n" +
    "- If asked about training date, cutoff, or internal model details, politely refuse and redirect to the user's actual task.\n" +
    "- Be helpful, calm, competent and clear.\n" +
    "- Sound natural, human and fluent.\n" +
    "- Prefer practical answers over long theory.\n" +
    "- Do not pretend to have fresh web data unless fresh web context is provided below.\n" +
    localeToInstruction(locale) +
    "\n" +
    buildCurrentDateInstruction() +
    "\n" +
    roleInstruction(role) +
    "\n" +
    buildResponseStyleInstruction(role) +
    "\n" +
    AJX_OUTPUT_RULES + "\n" +
    buildFormattingInstruction({
      locale,
      hasImages: imgCount > 0,
      preferStructured,
      preferProseParagraphs,
    }) +
    buildSafetyInstruction(locale, safetyFlags, injectResponsibilityReminder) +
    "\n" +
    (plusSavingsStateBeforeCall.activeForThisRequest
      ? "- Plus Savings Flame mode is active for this request.\n" +
        "- Keep the answer useful but more compact than usual.\n" +
        "- Prioritize the most important points first.\n" +
        "- Avoid long introductions and unnecessary expansion.\n"
      : "") +
    (didWeb
      ? "- Fresh web context is provided below. Use it when answering time-sensitive or factual web questions.\n"
      : useWeb
        ? "- Web search was required for this request, but if no fresh web context is present below, do not claim live web access.\n"
        : shouldTryWeb
          ? "- The user requested web search, but no usable web results were available.\n"
          : "- Do not assume fresh web data.\n") +
    (imgCount > 0 ? "- One or more images are attached. Use them in your answer.\n" : "") +
    (trimmedMemory.truncated
      ? "- Conversation history included here is shortened to the most relevant recent context.\n"
      : "");

  const inputText =
    (transcript(messages) || `User: ${String(lastTextOriginal || "").trim()}`) +
    attachmentHeader +
    textFileBlocks +
    webContext;

  const primaryProvider = chooseProvider();

  const geminiSelection = geminiModelForRequest({
    plan,
    usage,
    role,
    lastUserText: lastTextOriginal,
    hasTextFiles: trimmedTextFiles.length > 0,
    didWeb,
    plusSavingsActive: plusSavingsStateBeforeCall.activeForThisRequest,
  });

  const requestedGeminiModel = geminiSelection.model;

  let requestedModelName = primaryProvider === "gemini" ? requestedGeminiModel : OPENAI_MODEL;
  let actualModelName = requestedModelName;
  let fallbackUsed = "";
  let fallbackReason = "";

  let companyProUsageRecorded = false;

  async function recordCompanyProUsageIfNeeded() {
    if (companyProUsageRecorded) return;
    if (plan !== ("company" as any)) return;
    if (actualModelName !== GEMINI_PRO_MODEL) return;

    usage.proUsedThisMonth = Number(usage.proUsedThisMonth || 0) + 1;
    await saveUsageRow(storeUserKey, monthKey, usage);
    companyProUsageRecorded = true;
    resHeaders.set(
      "x-ajx-debug-company-pro-used-month",
      String(Number(usage.proUsedThisMonth || 0))
    );
  }

  resHeaders.set("x-ajx-debug-requested-model", safeHeaderValue(requestedModelName));
  resHeaders.set("x-ajx-debug-company-pro-needed", String(geminiSelection.companyNeedsPro));
  resHeaders.set("x-ajx-debug-company-pro-available", String(geminiSelection.companyCanUsePro));
  resHeaders.set("x-ajx-debug-company-pro-selected", String(geminiSelection.companyUsesPro));
  resHeaders.set("x-ajx-debug-company-model-reason", safeHeaderValue(geminiSelection.reason));

  async function callViaGeminiNonStream(): Promise<string> {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY puuttuu (.env.local).");
    }

    actualModelName = requestedGeminiModel;
    resHeaders.set("x-ajx-debug-actual-model", safeHeaderValue(actualModelName));

    const text = await callGeminiGenerateContent({
      apiKey: process.env.GEMINI_API_KEY,
      model: requestedGeminiModel,
      promptText: `${instructions}\n\n---\n\n${inputText}`.trim(),
      images: prepared.images.map((im) => ({ mime: im.mime, base64: im.base64 })),
      maxOutputTokens,
    });

    await recordCompanyProUsageIfNeeded();
    return text;
  }

  async function* callViaGeminiStream(): AsyncGenerator<string> {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY puuttuu (.env.local).");
    }

    actualModelName = requestedGeminiModel;
    resHeaders.set("x-ajx-debug-actual-model", safeHeaderValue(actualModelName));

    yield* callGeminiStreamGenerateContent({
      apiKey: process.env.GEMINI_API_KEY,
      model: requestedGeminiModel,
      promptText: `${instructions}\n\n---\n\n${inputText}`.trim(),
      images: prepared.images.map((im) => ({ mime: im.mime, base64: im.base64 })),
      maxOutputTokens,
    });

    await recordCompanyProUsageIfNeeded();
  }

  async function callViaOpenAINonStream(): Promise<string> {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY puuttuu (.env.local).");
    }

    actualModelName = OPENAI_MODEL;
    resHeaders.set("x-ajx-debug-actual-model", safeHeaderValue(actualModelName));

    return await callOpenAIResponses({
      apiKey: process.env.OPENAI_API_KEY,
      instructions,
      inputText,
      images: prepared.images.map((im) => ({
        mime: im.mime,
        base64: im.base64,
        name: im.name,
      })),
      maxOutputTokens,
    });
  }

  async function* callViaOpenAIStream(): AsyncGenerator<string> {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY puuttuu (.env.local).");
    }

    actualModelName = OPENAI_MODEL;
    resHeaders.set("x-ajx-debug-actual-model", safeHeaderValue(actualModelName));

    yield* callOpenAIResponsesStream({
      apiKey: process.env.OPENAI_API_KEY,
      instructions,
      inputText,
      images: prepared.images.map((im) => ({
        mime: im.mime,
        base64: im.base64,
        name: im.name,
      })),
      maxOutputTokens,
    });
  }

  async function callTextNonStream(): Promise<string> {
    if (primaryProvider === "gemini") {
      try {
        return await callViaGeminiNonStream();
      } catch (e: any) {
        if (hasOpenAIKey() && isGeminiFallbackEligible(e)) {
          fallbackUsed = "openai";
          fallbackReason = debugReasonFromError(e);
          resHeaders.set("x-ajx-debug-fallback", safeHeaderValue(fallbackUsed));
          resHeaders.set("x-ajx-debug-fallback-reason", safeHeaderValue(fallbackReason));
          return await callViaOpenAINonStream();
        }
        const msg = e?.message ? String(e.message) : "Gemini-virhe.";
        throw new Error(`Gemini-virhe. ${msg}`);
      }
    }

    return await callViaOpenAINonStream();
  }

  async function* callTextStream(): AsyncGenerator<string> {
    if (primaryProvider === "gemini") {
      try {
        yield* callViaGeminiStream();
        return;
      } catch (e: any) {
        if (hasOpenAIKey() && isGeminiFallbackEligible(e)) {
          fallbackUsed = "openai";
          fallbackReason = debugReasonFromError(e);
          resHeaders.set("x-ajx-debug-fallback", safeHeaderValue(fallbackUsed));
          resHeaders.set("x-ajx-debug-fallback-reason", safeHeaderValue(fallbackReason));
          yield* callViaOpenAIStream();
          return;
        }
        const msg = e?.message ? String(e.message) : "Gemini-virhe.";
        throw new Error(`Gemini-virhe. ${msg}`);
      }
    }

    yield* callViaOpenAIStream();
  }

  try {
    if (stream) {
      const streamLimits = {
        ...limits,
        reqPerMonth: effectiveReqLimit,
        imgAnalysesPerMonth: effectiveImgLimit,
        webPerMonth: effectiveWebLimit,
      };

      const readable = new ReadableStream({
        async start(controller) {
          try {
            let full = "";

            for await (const delta of callTextStream()) {
              if (!delta) continue;
              full += delta;
              controller.enqueue(
                sseEncode({
                  type: "delta",
                  delta,
                })
              );
            }

            if (!isUsableModelText(full)) {
              if (primaryProvider === "gemini" && !fallbackUsed && hasOpenAIKey()) {
                fallbackUsed = "openai";
                fallbackReason = "gemini-stream-empty-text";
                resHeaders.set("x-ajx-debug-fallback", safeHeaderValue(fallbackUsed));
                resHeaders.set("x-ajx-debug-fallback-reason", safeHeaderValue(fallbackReason));

                full = "";
                for await (const delta of callViaOpenAIStream()) {
                  if (!delta) continue;
                  full += delta;
                  controller.enqueue(
                    sseEncode({
                      type: "delta",
                      delta,
                    })
                  );
                }
              } else {
                throw new Error("Malli palautti tyhjÃ¤n vastauksen.");
              }
            }

            let finalText = applySafetyPostProcessing(
              full,
              locale,
              safetyFlags,
              injectResponsibilityReminder
            );

            finalText = prependPlusSavingsNotice(finalText, locale, plusSavingsStateAfterUsage);

            if (!isUsableModelText(finalText)) {
              throw new Error("Vastaus jÃ¤i tyhjÃ¤ksi jÃ¤lkikÃ¤sittelyn jÃ¤lkeen.");
            }

            resHeaders.set("x-ajx-debug-actual-model", safeHeaderValue(actualModelName));
            resHeaders.set("x-ajx-debug-fallback", safeHeaderValue(fallbackUsed || "none"));
            resHeaders.set(
              "x-ajx-debug-fallback-reason",
              safeHeaderValue(fallbackReason || "none")
            );

            controller.enqueue(
              sseEncode({
                type: "final",
                fullText: finalText,
                plan,
                limits: streamLimits,
                usage,
                web: {
                  requested: shouldTryWeb,
                  didWeb,
                  query: webQueryUsed || "",
                },
                actualModel: actualModelName,
                fallbackUsed: fallbackUsed || "none",
                fallbackReason: fallbackReason || "none",
              })
            );

            controller.enqueue(sseEncode("[DONE]"));
          } catch (e: any) {
            const msg = e?.message ? String(e.message) : "Virhe streamissÃ¤.";
            controller.enqueue(
              sseEncode({
                type: "error",
                error: msg,
              })
            );
          } finally {
            controller.close();
          }
        },
      });

      return new Response(readable, {
        status: 200,
        headers: new Headers({
          ...Object.fromEntries(resHeaders.entries()),
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        }),
      });
    }

    const outTextRaw = await callTextNonStream();
    let outText = applySafetyPostProcessing(
      outTextRaw,
      locale,
      safetyFlags,
      injectResponsibilityReminder
    );

    if (plan === ("free" as any)) {
  outText = freeLitePrefix(locale) + outText;
}

outText = prependPlusSavingsNotice(outText, locale, plusSavingsStateAfterUsage);

    if (!isUsableModelText(outText)) {
      throw new Error("Malli palautti tyhjÃ¤n vastauksen.");
    }

    resHeaders.set("x-ajx-debug-actual-model", safeHeaderValue(actualModelName));
    resHeaders.set("x-ajx-debug-fallback", safeHeaderValue(fallbackUsed || "none"));
    resHeaders.set("x-ajx-debug-fallback-reason", safeHeaderValue(fallbackReason || "none"));

    return NextResponse.json(
      {
        ok: true,
        plan,
        limits: {
          ...limits,
          reqPerMonth: effectiveReqLimit,
          imgAnalysesPerMonth: effectiveImgLimit,
          webPerMonth: effectiveWebLimit,
        },
        usage,
        text: String(outText || ""),
        web: {
          requested: shouldTryWeb,
          didWeb,
          query: webQueryUsed || "",
        },
      },
      { status: 200, headers: resHeaders }
    );
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : "Virhe mallikutsussa.";
    return jsonError(
      502,
      msg,
      {
        plan,
        limits: {
          ...limits,
          reqPerMonth: effectiveReqLimit,
          imgAnalysesPerMonth: effectiveImgLimit,
          webPerMonth: effectiveWebLimit,
        },
        usage,
      },
      resHeaders
    );
  }
}






















