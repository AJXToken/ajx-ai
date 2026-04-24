// src/app/api/stats/route.ts
import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { type PlanId } from "../../../lib/plans";

export const runtime = "nodejs";

// ====== CONFIG ======
const DATA_DIR = process.env.AJX_DATA_DIR || path.join(process.cwd(), ".ajx-data");
const USAGE_FILE = path.join(DATA_DIR, "usage.json");

const COOKIE_NAME = "ajx_uid";
const COOKIE_SECRET =
  process.env.AJX_COOKIE_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  "dev-secret-change-me";

// ====== STORAGE ======
function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function getMonthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

type UsageRow = {
  msgThisMonth: number;
  imgThisMonth: number; // chat attachments / image analysis
  webThisMonth: number;

  imgGenThisMonth?: number; // image generations

  extraMsgThisMonth?: number;
  extraImgThisMonth?: number;
  extraGenThisMonth?: number;
  extraWebThisMonth?: number;

  dayKey?: string;
  reqToday?: number;
  imgToday?: number;
};

type UsageDb = Record<string, Record<string, UsageRow>>;

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

// ====== COOKIES ======
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

function newUid() {
  return crypto.randomBytes(16).toString("hex");
}

function signUid(uid: string) {
  return `${uid}.${hmac(uid)}`;
}

// ====== PLAN RESOLUTION (header OR query) ======
// Canonical: free, basic, plus, pro, company
// Legacy: lite/visual -> basic, partner -> company
function normalizeDevPlan(raw: string): string {
  const v = (raw || "").toLowerCase().trim();
  if (v === "lite") return "basic";
  if (v === "visual") return "basic";
  if (v === "partner") return "company";
  return v;
}

function readPlan(req: NextRequest): PlanId {
  const hdr = normalizeDevPlan(req.headers.get("x-ajx-dev-plan") || "");
  const q = normalizeDevPlan(req.nextUrl.searchParams.get("devPlan") || "");

  const cand = hdr || q;
  const allowed = ["free", "basic", "plus", "pro", "company"];
  if (allowed.includes(cand)) return cand as PlanId;

  return "free" as PlanId;
}

function resolveDevScope(req: NextRequest): string | null {
  const hdr = normalizeDevPlan(req.headers.get("x-ajx-dev-plan") || "");
  const q = normalizeDevPlan(req.nextUrl.searchParams.get("devPlan") || "");

  const cand = hdr || q;
  const allowed = ["free", "basic", "plus", "pro", "company"];
  return allowed.includes(cand) ? cand : null;
}

function scopedUserKey(userId: string, devScope: string | null): string {
  return devScope ? `${userId}__${devScope}` : userId;
}

// ====== CANONICAL LIMITS ======
type Limits = {
  msgPerMonth: number;
  imgPerMonth: number;
  genPerMonth: number;
  webPerMonth: number;
};

// HUOM:
// Free:n oikea viestiraja tehdään chat-routessa päiväkohtaisesti (20 / vrk),
// mutta UI:lle palautetaan 20, jotta laskuri pysyy selkeänä.
function canonicalLimits(plan: PlanId): Limits {
  switch (plan) {
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

    case "free":
    default:
      return {
        msgPerMonth: 10,
        imgPerMonth: 0,
        genPerMonth: 0,
        webPerMonth: 0,
      };
  }
}

export async function GET(req: NextRequest) {
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

  const plan = readPlan(req);
  const baseLimits = canonicalLimits(plan);

  const devScope = resolveDevScope(req);
  const storeUserKey = scopedUserKey(userId, devScope);

  const usageDb = loadUsage();
  const monthKey = getMonthKey();

  const rawUsage =
    usageDb?.[storeUserKey]?.[monthKey] || {
      msgThisMonth: 0,
      imgThisMonth: 0,
      webThisMonth: 0,
      imgGenThisMonth: 0,
      extraMsgThisMonth: 0,
      extraImgThisMonth: 0,
      extraGenThisMonth: 0,
      extraWebThisMonth: 0,
      dayKey: "",
      reqToday: 0,
      imgToday: 0,
    };

  const usage: UsageRow = {
    msgThisMonth: Number(rawUsage.msgThisMonth || 0),
    imgThisMonth: Number(rawUsage.imgThisMonth || 0),
    webThisMonth: Number(rawUsage.webThisMonth || 0),
    imgGenThisMonth: Number(rawUsage.imgGenThisMonth || 0),
    extraMsgThisMonth: Number(rawUsage.extraMsgThisMonth || 0),
    extraImgThisMonth: Number(rawUsage.extraImgThisMonth || 0),
    extraGenThisMonth: Number(rawUsage.extraGenThisMonth || 0),
    extraWebThisMonth: Number(rawUsage.extraWebThisMonth || 0),
    dayKey: String(rawUsage.dayKey || ""),
    reqToday: Number(rawUsage.reqToday || 0),
    imgToday: Number(rawUsage.imgToday || 0),
  };

  const limits: Limits = {
    msgPerMonth: Number(baseLimits.msgPerMonth || 0) + Number(usage.extraMsgThisMonth || 0),
    imgPerMonth: Number(baseLimits.imgPerMonth || 0) + Number(usage.extraImgThisMonth || 0),
    genPerMonth: Number(baseLimits.genPerMonth || 0) + Number(usage.extraGenThisMonth || 0),
    webPerMonth: Number(baseLimits.webPerMonth || 0) + Number(usage.extraWebThisMonth || 0),
  };

  return NextResponse.json(
    {
      ok: true,
      plan,
      limits,
      usage,
    },
    { status: 200, headers: resHeaders }
  );
}