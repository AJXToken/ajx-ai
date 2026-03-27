// src/app/api/image/route.ts
import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { type PlanId } from "../../../lib/plans";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

// ====== CONFIG ======
function resolveDataDir() {
  const env = process.env.AJX_DATA_DIR;
  if (env && String(env).trim()) return String(env).trim();

  // Vercel/serverless-safe default:
  // local project dir is often not writable in production/serverless.
  if (process.env.VERCEL || process.env.VERCEL_ENV) {
    return "/tmp/ajx-data";
  }

  return path.join(process.cwd(), ".ajx-data");
}

const DATA_DIR = resolveDataDir();
const USAGE_FILE = path.join(DATA_DIR, "usage.json");
const IMAGES_DIR = path.join(DATA_DIR, "images");

const COOKIE_NAME = "ajx_uid";
const COOKIE_SECRET =
  process.env.AJX_COOKIE_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  "dev-secret-change-me";

// Halvempi ja vakaampi native image generation -malli
const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";
const GEMINI_IMAGE_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
  GEMINI_IMAGE_MODEL
)}:generateContent`;

const DEFAULT_IMAGE_SIZE = "768x768";

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : "Unknown filesystem error";
    throw new Error(`Failed to initialize image storage at "${DATA_DIR}": ${msg}`);
  }
}

function getMonthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function getDayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

type UsageRow = {
  msgThisMonth: number;
  imgThisMonth: number;
  webThisMonth: number;

  imgGenThisMonth?: number;
  imgGenDayKey?: string;
  imgGenToday?: number;

  extraMsgThisMonth?: number;
  extraImgThisMonth?: number;
  extraGenThisMonth?: number;
  extraWebThisMonth?: number;
};

type UsageDb = Record<string, Record<string, UsageRow>>;

type Limits = {
  imgGenPerMonth: number;
  imgGenPerDay: number;
};

type SourceImageInput = {
  name?: string;
  type?: string;
  dataUrl?: string;
};

function loadUsage(): UsageDb {
  ensureDataDir();
  if (!fs.existsSync(USAGE_FILE)) return {};
  try {
    const raw = fs.readFileSync(USAGE_FILE, "utf8");
    const j = JSON.parse(raw);
    if (j && typeof j === "object") return j as UsageDb;
    return {};
  } catch {
    return {};
  }
}

function saveUsage(db: UsageDb) {
  ensureDataDir();
  const tmpFile = `${USAGE_FILE}.tmp`;
  fs.writeFileSync(tmpFile, JSON.stringify(db, null, 2), "utf8");
  fs.renameSync(tmpFile, USAGE_FILE);
}

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

function normalizeDevPlan(raw: string): string {
  const v = (raw || "").toLowerCase().trim();
  if (v === "lite") return "basic";
  if (v === "visual") return "basic";
  if (v === "partner") return "company";
  return v;
}

function readPlanFromRequest(req: NextRequest, body: any): PlanId {
  const hdr = req.headers.get("x-ajx-dev-plan");
  const h = hdr ? normalizeDevPlan(hdr) : "";
  const q = normalizeDevPlan(req.nextUrl.searchParams.get("devPlan") || "");
  const b = normalizeDevPlan(String(body?.devPlan || ""));
  const cand = h || q || b;

  const allowed = ["free", "basic", "plus", "pro", "company", "visual"];
  if (allowed.includes(cand)) return cand as any;
  return "free" as any;
}

function resolveDevScope(req: NextRequest, body: any): string | null {
  const hdr = req.headers.get("x-ajx-dev-plan");
  const h = hdr ? normalizeDevPlan(hdr) : "";
  const q = normalizeDevPlan(req.nextUrl.searchParams.get("devPlan") || "");
  const b = normalizeDevPlan(String(body?.devPlan || ""));
  const cand = h || q || b;

  const allowed = ["free", "basic", "plus", "pro", "company", "visual"];
  return allowed.includes(cand) ? cand : null;
}

function scopedUserKey(userId: string, devScope: string | null): string {
  return devScope ? `${userId}__${devScope}` : userId;
}

function canonicalImageGenLimits(plan: PlanId): Limits {
  const p = plan === ("visual" as any) ? ("basic" as any) : plan;

  switch (p as any) {
    case "basic":
      return { imgGenPerMonth: 0, imgGenPerDay: 1 };
    case "plus":
      return { imgGenPerMonth: 0, imgGenPerDay: 2 };
    case "pro":
      return { imgGenPerMonth: 100, imgGenPerDay: 0 };
    case "company":
      return { imgGenPerMonth: 150, imgGenPerDay: 0 };
    case "free":
    default:
      return { imgGenPerMonth: 0, imgGenPerDay: 0 };
  }
}

function jsonError(status: number, message: string, extra?: any, headers?: Headers) {
  return NextResponse.json({ ok: false, error: message, ...(extra || {}) }, { status, headers });
}

function makeImageId() {
  return crypto.randomBytes(12).toString("hex");
}

async function readErrorTextSafe(r: Response) {
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = await r.json().catch(() => null);
    const msg =
      (j as any)?.error?.message ||
      (j as any)?.message ||
      JSON.stringify(j || {}).slice(0, 4000);
    return msg || `HTTP ${r.status}`;
  }
  const t = await r.text().catch(() => "");
  return t || `HTTP ${r.status}`;
}

function parseDataUrl(dataUrl: string): { mimeType: string; base64: string } | null {
  const s = String(dataUrl || "").trim();
  if (!s) return null;

  const m = s.match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;

  const mimeType = String(m[1] || "").trim().toLowerCase();
  const base64 = String(m[2] || "").replace(/\s+/g, "").trim();

  if (!mimeType || !base64) return null;
  return { mimeType, base64 };
}

function normalizeMimeType(mimeType: string): string {
  const m = String(mimeType || "").toLowerCase().trim();
  if (m === "image/jpg") return "image/jpeg";
  if (
    m === "image/png" ||
    m === "image/jpeg" ||
    m === "image/webp" ||
    m === "image/heic" ||
    m === "image/heif"
  ) {
    return m;
  }
  return "image/png";
}

function sizeToAspectRatio(size: string): string {
  const s = String(size || "").trim().toLowerCase();
  if (s === "1024x1024") return "1:1";
  if (s === "768x768") return "1:1";
  if (s === "1024x1536") return "2:3";
  if (s === "1536x1024") return "3:2";
  if (s === "768x1408") return "9:16";
  if (s === "1408x768") return "16:9";
  return "1:1";
}

function normalizeRequestedSize(
  rawSize: string,
  costTierRaw: string,
  qualityRaw: string
): string {
  const size = String(rawSize || "").trim().toLowerCase();
  const costTier = String(costTierRaw || "").trim().toLowerCase();
  const quality = String(qualityRaw || "").trim().toLowerCase();

  const allowed = new Set([
    "768x768",
    "1024x1024",
    "1024x1536",
    "1536x1024",
    "768x1408",
    "1408x768",
  ]);

  let normalized = allowed.has(size) ? size : DEFAULT_IMAGE_SIZE;

  // Halpa profiili: pakotetaan pienempi oletus.
  if (costTier === "low" || quality === "standard" || quality === "fast") {
    if (normalized === "1024x1024") normalized = "768x768";
    if (normalized === "1024x1536") normalized = "768x1408";
    if (normalized === "1536x1024") normalized = "1408x768";
  }

  return normalized;
}

function extractImageBase64FromGeminiResponse(j: any): string {
  const parts = j?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";

  for (const part of parts) {
    const inline = part?.inlineData || part?.inline_data;
    const data = inline?.data;
    if (typeof data === "string" && data.trim().length > 100) {
      return data.trim();
    }
  }

  return "";
}

function extractTextFromGeminiResponse(j: any): string {
  const parts = j?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return "";

  const texts: string[] = [];
  for (const part of parts) {
    if (typeof part?.text === "string" && part.text.trim()) {
      texts.push(part.text.trim());
    }
  }

  return texts.join("\n\n").trim();
}

function buildGeminiContents(prompt: string, sourceImage: SourceImageInput | null) {
  const parts: any[] = [{ text: prompt }];

  if (sourceImage?.dataUrl) {
    const parsed = parseDataUrl(sourceImage.dataUrl);
    if (parsed) {
      parts.push({
        inline_data: {
          mime_type: normalizeMimeType(sourceImage.type || parsed.mimeType),
          data: parsed.base64,
        },
      });
    }
  }

  return [{ parts }];
}

export async function POST(req: NextRequest) {
  if (!process.env.GEMINI_API_KEY) {
    return jsonError(500, "Puuttuu GEMINI_API_KEY (.env.local).");
  }

  let body: any = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }

  const cookieVal = req.cookies.get(COOKIE_NAME)?.value;
  let userId = verifySignedUid(cookieVal);

  const resHeaders = new Headers();
  if (!userId) {
    userId = newUid();
    const signed = signUid(userId);
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    resHeaders.append(
      "Set-Cookie",
      `${COOKIE_NAME}=${signed}; Path=/; HttpOnly; SameSite=Lax${secure}`
    );
  }

  const devScope = resolveDevScope(req, body);
  const storeUserKey = scopedUserKey(userId, devScope);

  const planRaw = readPlanFromRequest(req, body);
  const plan: PlanId = (planRaw === ("visual" as any) ? ("basic" as any) : planRaw) as any;

  const baseLimits = canonicalImageGenLimits(plan);

  const prompt = String(body?.prompt || "").trim();
  const requestedSizeRaw = String(body?.size || DEFAULT_IMAGE_SIZE).trim();
  const requestedCostTier = String(body?.costTier || "").trim().toLowerCase();
  const requestedQuality = String(body?.quality || "").trim().toLowerCase();
  const effectiveSize = normalizeRequestedSize(
    requestedSizeRaw,
    requestedCostTier,
    requestedQuality
  );

  const editing = body?.editing === true;
  const rawSourceImage: SourceImageInput | null =
    body?.sourceImage && typeof body.sourceImage === "object" ? body.sourceImage : null;

  // Käytetään lähdekuvaa vain oikeassa editointitilanteessa.
  const sourceImage: SourceImageInput | null = editing ? rawSourceImage : null;

  resHeaders.set("x-ajx-debug-plan", String(plan));
  resHeaders.set("x-ajx-debug-image-model", GEMINI_IMAGE_MODEL);
  resHeaders.set("x-ajx-debug-image-data-dir", DATA_DIR);
  resHeaders.set("x-ajx-debug-imggen-month-limit-base", String(baseLimits.imgGenPerMonth));
  resHeaders.set("x-ajx-debug-imggen-day-limit", String(baseLimits.imgGenPerDay));
  resHeaders.set("x-ajx-debug-requested-size", requestedSizeRaw);
  resHeaders.set("x-ajx-debug-effective-size", effectiveSize);
  resHeaders.set("x-ajx-debug-editing", editing ? "1" : "0");

  if (!prompt) {
    return jsonError(400, "Prompt puuttuu.", { plan, limits: baseLimits }, resHeaders);
  }

  if (sourceImage?.dataUrl) {
    const parsed = parseDataUrl(sourceImage.dataUrl);
    if (!parsed) {
      return jsonError(
        400,
        "Lähdekuva on virheellisessä muodossa. Odotettiin dataURL-kuvaa.",
        { plan, limits: baseLimits },
        resHeaders
      );
    }
  }

  let usageDb: UsageDb;
  let usage: UsageRow;
  const monthKey = getMonthKey();
  const dayKey = getDayKey();

  try {
    usageDb = loadUsage();
    usageDb[storeUserKey] ||= {};
    usageDb[storeUserKey][monthKey] ||= {
      msgThisMonth: 0,
      imgThisMonth: 0,
      webThisMonth: 0,
      imgGenThisMonth: 0,
      imgGenDayKey: dayKey,
      imgGenToday: 0,
      extraMsgThisMonth: 0,
      extraImgThisMonth: 0,
      extraGenThisMonth: 0,
      extraWebThisMonth: 0,
    };

    usage = usageDb[storeUserKey][monthKey];

    if (typeof usage.imgGenThisMonth !== "number") usage.imgGenThisMonth = 0;
    if (typeof usage.imgGenToday !== "number") usage.imgGenToday = 0;
    if (typeof usage.extraGenThisMonth !== "number") usage.extraGenThisMonth = 0;
    if (typeof usage.extraWebThisMonth !== "number") usage.extraWebThisMonth = 0;
    if (typeof usage.extraMsgThisMonth !== "number") usage.extraMsgThisMonth = 0;
    if (typeof usage.extraImgThisMonth !== "number") usage.extraImgThisMonth = 0;

    if (usage.imgGenDayKey !== dayKey) {
      usage.imgGenDayKey = dayKey;
      usage.imgGenToday = 0;
    }
  } catch (e: any) {
    const msg = e?.message ? String(e.message) : "Usage storage init failed";
    return jsonError(500, msg, { plan, dataDir: DATA_DIR }, resHeaders);
  }

  const genUsedMonth = Number(usage.imgGenThisMonth || 0);
  const genUsedToday = Number(usage.imgGenToday || 0);
  const extraGen = Number(usage.extraGenThisMonth || 0);

  const limits: Limits = {
    imgGenPerMonth:
      baseLimits.imgGenPerMonth > 0
        ? Number(baseLimits.imgGenPerMonth || 0) + extraGen
        : 0,
    imgGenPerDay: Number(baseLimits.imgGenPerDay || 0),
  };

  resHeaders.set("x-ajx-debug-imggen-used-month", String(genUsedMonth));
  resHeaders.set("x-ajx-debug-imggen-used-today", String(genUsedToday));
  resHeaders.set("x-ajx-debug-imggen-extra-month", String(extraGen));
  resHeaders.set("x-ajx-debug-imggen-month-limit-effective", String(limits.imgGenPerMonth));

  // ====== Quota check ======
  const allowAnyGen = limits.imgGenPerMonth > 0 || limits.imgGenPerDay > 0;
  if (!allowAnyGen) {
    return jsonError(
      403,
      "Kuvien luonti ei ole käytössä tällä tasolla.",
      { plan, limits, usage },
      resHeaders
    );
  }

  if (limits.imgGenPerDay > 0) {
    if (genUsedToday + 1 > limits.imgGenPerDay) {
      return jsonError(
        403,
        "Kuvaluontikiintiö on täynnä tältä päivältä.",
        { plan, limits, usage },
        resHeaders
      );
    }
  } else {
    if (limits.imgGenPerMonth <= 0 || genUsedMonth + 1 > limits.imgGenPerMonth) {
      return jsonError(
        403,
        "Kuvaluontikiintiö on täynnä tältä kuulta.",
        { plan, limits, usage },
        resHeaders
      );
    }
  }

  // ====== Gemini image generation / editing ======
  try {
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 120_000);

    const payload = {
      contents: buildGeminiContents(prompt, sourceImage),
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: {
          aspectRatio: sizeToAspectRatio(effectiveSize),
        },
      },
    };

    const r = await fetch(GEMINI_IMAGE_ENDPOINT, {
      method: "POST",
      signal: ac.signal,
      headers: {
        "x-goog-api-key": process.env.GEMINI_API_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    }).finally(() => clearTimeout(to));

    if (!r.ok) {
      const tt = await readErrorTextSafe(r);
      return jsonError(
        502,
        tt || `Gemini image error HTTP ${r.status}`,
        {
          plan,
          limits,
          usage,
          model: GEMINI_IMAGE_MODEL,
          effectiveSize,
        },
        resHeaders
      );
    }

    const j: any = await r.json();
    const b64 = extractImageBase64FromGeminiResponse(j);
    const textOut = extractTextFromGeminiResponse(j);

    if (!b64) {
      return jsonError(
        502,
        textOut || "Kuvan luonti onnistui, mutta kuva-data puuttuu vastauksesta.",
        {
          plan,
          limits,
          usage,
          model: GEMINI_IMAGE_MODEL,
          effectiveSize,
        },
        resHeaders
      );
    }

    try {
      ensureDataDir();
      const id = makeImageId();
      const outFile = path.join(IMAGES_DIR, `${id}.png`);
      fs.writeFileSync(outFile, Buffer.from(b64, "base64"));

      usage.imgGenThisMonth = genUsedMonth + 1;
      if (limits.imgGenPerDay > 0) {
        usage.imgGenToday = genUsedToday + 1;
        usage.imgGenDayKey = dayKey;
      }

      saveUsage(usageDb);

      const imageUrl = `/api/image/file/${id}?v=${Date.now()}`;

      return NextResponse.json(
        {
          ok: true,
          source: "gemini-image",
          model: GEMINI_IMAGE_MODEL,
          edited: !!sourceImage?.dataUrl,
          plan,
          limits,
          usage,
          imageId: id,
          imageUrl,
          requestedSize: requestedSizeRaw,
          effectiveSize,
          text: textOut || "",
          markdown: `![AJX Image](${imageUrl})`,
        },
        { status: 200, headers: resHeaders }
      );
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : "Failed to save generated image";
      return jsonError(
        500,
        msg,
        {
          plan,
          limits,
          usage,
          model: GEMINI_IMAGE_MODEL,
          dataDir: DATA_DIR,
          imagesDir: IMAGES_DIR,
          effectiveSize,
        },
        resHeaders
      );
    }
  } catch (e: any) {
    const msg =
      e?.name === "AbortError"
        ? "Kuvagenerointi aikakatkaistiin (120s)."
        : e?.message
          ? String(e.message)
          : "Virhe kuvan luonnissa.";

    return jsonError(
      502,
      msg,
      {
        plan,
        limits,
        dataDir: DATA_DIR,
        model: GEMINI_IMAGE_MODEL,
        effectiveSize,
      },
      resHeaders
    );
  }
}