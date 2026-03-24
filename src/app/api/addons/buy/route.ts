// src/app/api/addons/buy/route.ts
import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";

import type { PlanId } from "../../../../lib/plans";

export const runtime = "nodejs";

const DATA_DIR = process.env.AJX_DATA_DIR || path.join(process.cwd(), ".ajx-data");
const USAGE_FILE = path.join(DATA_DIR, "usage.json");

const COOKIE_NAME = "ajx_uid";
const COOKIE_SECRET =
  process.env.AJX_COOKIE_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  "dev-secret-change-me";

type Plan = PlanId;

type UsageRow = {
  msgThisMonth: number;
  imgThisMonth: number;
  webThisMonth: number;

  extraMsgThisMonth?: number;
  extraImgThisMonth?: number;
  extraGenThisMonth?: number;
  extraWebThisMonth?: number;

  dayKey?: string;
  reqToday?: number;
  imgToday?: number;
};

type UsageDb = Record<string, Record<string, UsageRow>>;

type AddonDef = {
  sku: string;
  plan: Plan;
  priceEur: number;
  addMessages?: number;
  addImageAnalyses?: number;
  addImageGenerations?: number;
  addWebSearches?: number;
  labelFi: string;
};

const ADDONS: AddonDef[] = [
  {
    sku: "bundle_basic_1000_120",
    plan: "basic",
    priceEur: 3.99,
    addMessages: 1000,
    addImageAnalyses: 120,
    labelFi: "Basic-lisäpaketti: +1000 viestiä +120 kuvan analyysiä",
  },
  {
    sku: "bundle_plus_1000_120_30",
    plan: "plus",
    priceEur: 9.99,
    addMessages: 1000,
    addImageAnalyses: 120,
    addImageGenerations: 30,
    labelFi: "Plus-lisäpaketti: +1000 viestiä +120 analyysiä +30 generointia",
  },
  {
    sku: "bundle_pro_3000_200_100",
    plan: "pro",
    priceEur: 19.99,
    addMessages: 3000,
    addImageAnalyses: 200,
    addImageGenerations: 100,
    labelFi: "Pro-lisäpaketti: +3000 viestiä +200 analyysiä +100 generointia",
  },
  {
    sku: "bundle_company_4000_300_200",
    plan: "company",
    priceEur: 29.99,
    addMessages: 4000,
    addImageAnalyses: 300,
    addImageGenerations: 200,
    labelFi: "Company-lisäpaketti: +4000 viestiä +300 analyysiä +200 generointia",
  },
  {
    sku: "web_plus_200",
    plan: "pro",
    priceEur: 4.9,
    addWebSearches: 200,
    labelFi: "Pro web-lisäpaketti: +200 web-hakua",
  },
  {
    sku: "web_plus_200",
    plan: "company",
    priceEur: 4.9,
    addWebSearches: 200,
    labelFi: "Company web-lisäpaketti: +200 web-hakua",
  },
];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getMonthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

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
  fs.writeFileSync(USAGE_FILE, JSON.stringify(db, null, 2), "utf8");
}

function hmac(data: string) {
  return crypto.createHmac("sha256", COOKIE_SECRET).update(data).digest("hex");
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

/**
 * Normalisoi legacy-dev-planit nykyisiin:
 * - lite -> basic
 * - visual -> basic
 * - partner -> company
 */
function normalizeDevPlan(v: string): Plan | null {
  const raw = (v || "").toLowerCase().trim();
  const norm =
    raw === "lite" ? "basic" :
    raw === "visual" ? "basic" :
    raw === "partner" ? "company" :
    raw;

  if (
    norm === "free" ||
    norm === "basic" ||
    norm === "plus" ||
    norm === "pro" ||
    norm === "company"
  ) {
    return norm as Plan;
  }

  return null;
}

function resolvePlan(req: NextRequest): Plan {
  const dev = req.headers.get("x-ajx-dev-plan") || "";
  return normalizeDevPlan(dev) ?? "free";
}

/**
 * DEV-SCOPE: vain jos header on mukana.
 */
function resolveDevScope(req: NextRequest): Plan | null {
  const raw = req.headers.get("x-ajx-dev-plan");
  if (!raw) return null;
  return normalizeDevPlan(raw);
}

function scopedUserKey(userId: string, devScope: Plan | null): string {
  return devScope ? `${userId}__${devScope}` : userId;
}

function jsonError(status: number, message: string, extra?: any, headers?: Headers) {
  return NextResponse.json({ ok: false, error: message, ...(extra || {}) }, { status, headers });
}

function canonicalLimits(plan: Plan) {
  switch (plan) {
    case "free":
      return {
        msgPerMonth: 0,
        imgPerMonth: 0,
        genPerMonth: 0,
        webPerMonth: 0,
      };

    case "basic":
      return {
        msgPerMonth: 1000,
        imgPerMonth: 120,
        genPerMonth: 0,
        webPerMonth: 0,
      };

    case "plus":
      return {
        msgPerMonth: 1000,
        imgPerMonth: 120,
        genPerMonth: 30,
        webPerMonth: 0,
      };

    case "pro":
      return {
        msgPerMonth: 3000,
        imgPerMonth: 200,
        genPerMonth: 100,
        webPerMonth: 200,
      };

    case "company":
      return {
        msgPerMonth: 4000,
        imgPerMonth: 300,
        genPerMonth: 200,
        webPerMonth: 300,
      };

    default:
      return {
        msgPerMonth: 0,
        imgPerMonth: 0,
        genPerMonth: 0,
        webPerMonth: 0,
      };
  }
}

function availableAddonsForPlan(plan: Plan): AddonDef[] {
  return ADDONS.filter((a) => a.plan === plan);
}

function findAddonForPlan(plan: Plan, sku: string): AddonDef | null {
  const found = ADDONS.find((a) => a.plan === plan && a.sku === sku);
  return found || null;
}

export async function POST(req: NextRequest) {
  const cookieVal = req.cookies.get(COOKIE_NAME)?.value;
  const userId = verifySignedUid(cookieVal);

  if (!userId) {
    return jsonError(401, "Sessio puuttuu. Avaa chat ja yritä uudelleen.");
  }

  const devScope = resolveDevScope(req);
  const storeUserKey = scopedUserKey(userId, devScope);
  const plan = resolvePlan(req);

  if (plan === "free") {
    return jsonError(403, "Lisäpaketteja ei ole saatavilla Free-tasolle.");
  }

  let body: any = null;
  try {
    body = await req.json();
  } catch {
    body = null;
  }

  const sku = String(body?.sku || "").trim();
  if (!sku) {
    return jsonError(400, "SKU puuttuu.");
  }

  const addon = findAddonForPlan(plan, sku);
  if (!addon) {
    return jsonError(403, "Tämä lisäpaketti ei ole saatavilla nykyiselle tasolle.", {
      plan,
      availableAddons: availableAddonsForPlan(plan).map((a) => ({
        sku: a.sku,
        priceEur: a.priceEur,
        labelFi: a.labelFi,
        addMessages: a.addMessages || 0,
        addImageAnalyses: a.addImageAnalyses || 0,
        addImageGenerations: a.addImageGenerations || 0,
        addWebSearches: a.addWebSearches || 0,
      })),
    });
  }

  const usageDb = loadUsage();
  const monthKey = getMonthKey();

  usageDb[storeUserKey] ||= {};
  usageDb[storeUserKey][monthKey] ||= {
    msgThisMonth: 0,
    imgThisMonth: 0,
    webThisMonth: 0,
    extraMsgThisMonth: 0,
    extraImgThisMonth: 0,
    extraGenThisMonth: 0,
    extraWebThisMonth: 0,
  };

  const usage = usageDb[storeUserKey][monthKey];

  if (typeof usage.extraMsgThisMonth !== "number") usage.extraMsgThisMonth = 0;
  if (typeof usage.extraImgThisMonth !== "number") usage.extraImgThisMonth = 0;
  if (typeof usage.extraGenThisMonth !== "number") usage.extraGenThisMonth = 0;
  if (typeof usage.extraWebThisMonth !== "number") usage.extraWebThisMonth = 0;

  usage.extraMsgThisMonth += Number(addon.addMessages || 0);
  usage.extraImgThisMonth += Number(addon.addImageAnalyses || 0);
  usage.extraGenThisMonth += Number(addon.addImageGenerations || 0);
  usage.extraWebThisMonth += Number(addon.addWebSearches || 0);

  saveUsage(usageDb);

  const baseLimits = canonicalLimits(plan);

  const effectiveLimits = {
    msgPerMonth: Number(baseLimits.msgPerMonth || 0) + Number(usage.extraMsgThisMonth || 0),
    imgPerMonth: Number(baseLimits.imgPerMonth || 0) + Number(usage.extraImgThisMonth || 0),
    genPerMonth: Number(baseLimits.genPerMonth || 0) + Number(usage.extraGenThisMonth || 0),
    webPerMonth: Number(baseLimits.webPerMonth || 0) + Number(usage.extraWebThisMonth || 0),
  };

  return NextResponse.json({
    ok: true,
    sku: addon.sku,
    priceEur: addon.priceEur,
    plan,
    purchased: {
      addMessages: Number(addon.addMessages || 0),
      addImageAnalyses: Number(addon.addImageAnalyses || 0),
      addImageGenerations: Number(addon.addImageGenerations || 0),
      addWebSearches: Number(addon.addWebSearches || 0),
    },
    limits: effectiveLimits,
    usage,
    availableAddons: availableAddonsForPlan(plan).map((a) => ({
      sku: a.sku,
      priceEur: a.priceEur,
      labelFi: a.labelFi,
      addMessages: a.addMessages || 0,
      addImageAnalyses: a.addImageAnalyses || 0,
      addImageGenerations: a.addImageGenerations || 0,
      addWebSearches: a.addWebSearches || 0,
    })),
  });
}