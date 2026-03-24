// src/app/api/chat/stats/route.ts
import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { type PlanId } from "../../../../lib/plans";

export const runtime = "nodejs";

type Plan = PlanId;

type Limits = {
  msgPerMonth: number;
  imgPerMonth: number;
  genPerMonth: number;
  webPerMonth: number;
};

type Usage = {
  msgThisMonth: number;
  imgThisMonth: number;
  webThisMonth: number;

  imgGenThisMonth?: number;

  extraMsgThisMonth?: number;
  extraImgThisMonth?: number;
  extraGenThisMonth?: number;
  extraWebThisMonth?: number;

  dayKey?: string;
  reqToday?: number;
  imgToday?: number;
  imgGenDayKey?: string;
  imgGenToday?: number;
};

type UsageFile = Record<string, Record<string, Usage>>;

const DATA_DIR = process.env.AJX_DATA_DIR || path.join(process.cwd(), ".ajx-data");
const USAGE_PATH = path.join(DATA_DIR, "usage.json");

const COOKIE_NAME = "ajx_uid";
const COOKIE_SECRET =
  process.env.AJX_COOKIE_SECRET ||
  process.env.NEXTAUTH_SECRET ||
  "dev-secret-change-me";

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function getYm(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
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

// legacy: lite/visual -> basic, partner -> company
function normalizeDevPlan(raw: string): string {
  const v = (raw || "").toLowerCase().trim();
  if (v === "lite") return "basic";
  if (v === "visual") return "basic";
  if (v === "partner") return "company";
  return v;
}

function resolvePlan(req: NextRequest): Plan {
  const v = normalizeDevPlan(req.headers.get("x-ajx-dev-plan") || "");
  const allowed = ["free", "basic", "plus", "pro", "company"];
  return allowed.includes(v) ? (v as Plan) : ("free" as Plan);
}

function resolveDevScope(req: NextRequest): Plan | null {
  const raw = req.headers.get("x-ajx-dev-plan");
  if (!raw) return null;

  const v = normalizeDevPlan(raw);
  const allowed = ["free", "basic", "plus", "pro", "company"];
  return allowed.includes(v) ? (v as Plan) : null;
}

function scopedUserKey(userId: string, devScope: Plan | null): string {
  return devScope ? `${userId}__${devScope}` : userId;
}

function getUsage(userKey: string, ym: string): Usage {
  ensureDir(DATA_DIR);
  const file = readJson<UsageFile>(USAGE_PATH, {});

  const raw = file[userKey]?.[ym] ?? {
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
    imgGenDayKey: "",
    imgGenToday: 0,
  };

  return {
    msgThisMonth: Number(raw.msgThisMonth || 0),
    imgThisMonth: Number(raw.imgThisMonth || 0),
    webThisMonth: Number(raw.webThisMonth || 0),

    imgGenThisMonth: Number(raw.imgGenThisMonth || 0),

    extraMsgThisMonth: Number(raw.extraMsgThisMonth || 0),
    extraImgThisMonth: Number(raw.extraImgThisMonth || 0),
    extraGenThisMonth: Number(raw.extraGenThisMonth || 0),
    extraWebThisMonth: Number(raw.extraWebThisMonth || 0),

    dayKey: String(raw.dayKey || ""),
    reqToday: Number(raw.reqToday || 0),
    imgToday: Number(raw.imgToday || 0),
    imgGenDayKey: String(raw.imgGenDayKey || ""),
    imgGenToday: Number(raw.imgGenToday || 0),
  };
}

function canonicalLimits(plan: Plan): Limits {
  switch (plan) {
    case "free":
      return {
        msgPerMonth: 20, // UI-laskuria varten; varsinainen esto chat-routessa päiväkohtainen
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
        msgPerMonth: 20,
        imgPerMonth: 0,
        genPerMonth: 0,
        webPerMonth: 0,
      };
  }
}

function computeLimits(plan: Plan, usage: Usage): Limits {
  const base = canonicalLimits(plan);

  return {
    msgPerMonth: Number(base.msgPerMonth || 0) + Number(usage.extraMsgThisMonth || 0),
    imgPerMonth: Number(base.imgPerMonth || 0) + Number(usage.extraImgThisMonth || 0),
    genPerMonth: Number(base.genPerMonth || 0) + Number(usage.extraGenThisMonth || 0),
    webPerMonth: Number(base.webPerMonth || 0) + Number(usage.extraWebThisMonth || 0),
  };
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

  const devScope = resolveDevScope(req);
  const userKey = scopedUserKey(userId, devScope);

  const plan = resolvePlan(req);
  const usage = getUsage(userKey, getYm());
  const limits = computeLimits(plan, usage);

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