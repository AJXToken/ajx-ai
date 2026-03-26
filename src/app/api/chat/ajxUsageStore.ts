import fs from "fs/promises";
import path from "path";

export type AjxUsage = {
  // Viestit / kk
  msgMonth: string; // esim "2026-01"
  msgCount: number;

  // Kuvat / kk
  imgMonth: string;
  imgCount: number;

  // Web-haut / kk
  webMonth: string;
  webCount: number;

  updatedAt: number; // unix ms
};

type StoreShape = {
  version: 1;
  users: Record<string, AjxUsage>;
};

const IS_VERCEL =
  process.env.VERCEL === "1" ||
  !!process.env.VERCEL_ENV ||
  !!process.env.AWS_REGION ||
  process.cwd().startsWith("/var/task");

const DATA_DIR = process.env.AJX_DATA_DIR || path.join(process.cwd(), ".ajx-data");
const STORE_FILE = path.join(DATA_DIR, "usage.json");

const memoryStore: StoreShape = {
  version: 1,
  users: {},
};

// Kevyt prosessilukko (riittää MVP/dev)
let mutex = Promise.resolve();

async function withLock<T>(fn: () => Promise<T>): Promise<T> {
  const prev = mutex;
  let release: () => void = () => {};
  mutex = new Promise<void>((res) => (release = res));
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

function monthKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function cloneStore(store: StoreShape): StoreShape {
  return {
    version: 1,
    users: { ...store.users },
  };
}

function canUseFilesystem() {
  return !IS_VERCEL;
}

async function ensureStore(): Promise<StoreShape> {
  if (!canUseFilesystem()) {
    return cloneStore(memoryStore);
  }

  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const raw = await fs.readFile(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw) as StoreShape;

    if (!parsed || parsed.version !== 1 || typeof parsed.users !== "object") {
      return { version: 1, users: {} };
    }

    return parsed;
  } catch {
    return { version: 1, users: {} };
  }
}

async function writeStore(store: StoreShape) {
  if (!canUseFilesystem()) {
    memoryStore.version = 1;
    memoryStore.users = { ...store.users };
    return;
  }

  await fs.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, STORE_FILE);
}

export async function getUsage(uid: string): Promise<AjxUsage> {
  return withLock(async () => {
    const store = await ensureStore();
    const mk = monthKey();

    const existing = store.users[uid];
    if (!existing) {
      const fresh: AjxUsage = {
        msgMonth: mk,
        msgCount: 0,
        imgMonth: mk,
        imgCount: 0,
        webMonth: mk,
        webCount: 0,
        updatedAt: Date.now(),
      };
      store.users[uid] = fresh;
      await writeStore(store);
      return fresh;
    }

    if (existing.msgMonth !== mk) {
      existing.msgMonth = mk;
      existing.msgCount = 0;
    }
    if (existing.imgMonth !== mk) {
      existing.imgMonth = mk;
      existing.imgCount = 0;
    }
    if (existing.webMonth !== mk) {
      existing.webMonth = mk;
      existing.webCount = 0;
    }

    existing.updatedAt = Date.now();
    store.users[uid] = existing;
    await writeStore(store);
    return existing;
  });
}

export async function incrementUsage(
  uid: string,
  what: "msg" | "img" | "web",
  amount = 1
): Promise<AjxUsage> {
  return withLock(async () => {
    const store = await ensureStore();
    const mk = monthKey();

    const existing: AjxUsage = store.users[uid] ?? {
      msgMonth: mk,
      msgCount: 0,
      imgMonth: mk,
      imgCount: 0,
      webMonth: mk,
      webCount: 0,
      updatedAt: Date.now(),
    };

    if (existing.msgMonth !== mk) {
      existing.msgMonth = mk;
      existing.msgCount = 0;
    }
    if (existing.imgMonth !== mk) {
      existing.imgMonth = mk;
      existing.imgCount = 0;
    }
    if (existing.webMonth !== mk) {
      existing.webMonth = mk;
      existing.webCount = 0;
    }

    if (what === "msg") existing.msgCount += amount;
    if (what === "img") existing.imgCount += amount;
    if (what === "web") existing.webCount += amount;

    existing.updatedAt = Date.now();
    store.users[uid] = existing;
    await writeStore(store);
    return existing;
  });
}