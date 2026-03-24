// src/app/api/image/file/[id]/route.ts
import { NextRequest, NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function resolveDataDir() {
  const env = process.env.AJX_DATA_DIR;
  if (env && String(env).trim()) return String(env).trim();
  return path.join(process.cwd(), ".ajx-data");
}

const DATA_DIR = resolveDataDir();
const IMAGES_DIR = path.join(DATA_DIR, "images");

function normalizeId(raw: unknown) {
  const id = String(raw || "").trim().toLowerCase();

  // hyväksy 24-hex (uusi) tai 32-hex (vanha)
  if (/^[a-f0-9]{24}$/.test(id)) return id;
  if (/^[a-f0-9]{32}$/.test(id)) return id;

  return null;
}

export async function GET(
  _req: NextRequest,
  context: { params: Promise<{ id: string }> | { id: string } }
) {
  const paramsAny: any = (context as any)?.params;
  const params = typeof paramsAny?.then === "function" ? await paramsAny : paramsAny;

  const id = normalizeId(params?.id);
  if (!id) {
    return NextResponse.json(
      { ok: false, error: "Virheellinen image id.", got: params?.id ?? null },
      {
        status: 400,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }

  const filePath = path.join(IMAGES_DIR, `${id}.png`);

  try {
    if (!fs.existsSync(filePath)) {
      return NextResponse.json(
        {
          ok: false,
          error: "Kuvaa ei löytynyt.",
          filePath,
        },
        {
          status: 404,
          headers: { "Cache-Control": "no-store" },
        }
      );
    }

    const buf = fs.readFileSync(filePath);

    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(buf.length),
        "Content-Disposition": `inline; filename="${id}.png"`,
        "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      {
        ok: false,
        error: e?.message ? String(e.message) : "Kuvan lukeminen epäonnistui.",
        filePath,
      },
      {
        status: 500,
        headers: { "Cache-Control": "no-store" },
      }
    );
  }
}