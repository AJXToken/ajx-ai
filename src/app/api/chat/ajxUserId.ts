import crypto from "crypto";

const COOKIE_NAME = "ajx_uid";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365; // 1 vuosi

function base64url(input: Buffer | string) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function hmac(secret: string, data: string) {
  return base64url(crypto.createHmac("sha256", secret).update(data).digest());
}

export function getCookieName() {
  return COOKIE_NAME;
}

export function createSignedUserId(secret: string) {
  const uid = crypto.randomUUID();
  const sig = hmac(secret, uid);
  return { uid, value: `${uid}.${sig}` };
}

export function verifySignedUserId(secret: string, cookieValue: string | undefined | null) {
  if (!cookieValue) return { ok: false, uid: "" };

  const parts = cookieValue.split(".");
  if (parts.length !== 2) return { ok: false, uid: "" };

  const [uid, sig] = parts;
  if (!uid || !sig) return { ok: false, uid: "" };

  const expected = hmac(secret, uid);

  // timingSafeEqual vaatii saman pituiset bufferit
  if (sig.length !== expected.length) return { ok: false, uid: "" };

  const ok = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  return { ok, uid: ok ? uid : "" };
}

export function buildSetCookieHeader(cookieValue: string) {
  return `${COOKIE_NAME}=${cookieValue}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE_SECONDS}`;
}
