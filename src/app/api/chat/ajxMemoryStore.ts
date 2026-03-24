import fs from "fs/promises";
import path from "path";

export type AjxUserSnapshot = {
  text: string;      // 300â€“800 merkkiÃ¤
  updatedAt: number; // unix ms
};

type StoreShape = {
  version: 1;
  users: Record<string, AjxUserSnapshot>;
};

const DATA_DIR = process.env.AJX_DATA_DIR || path.join(process.cwd(), ".ajx-data");
const STORE_FILE = path.join(DATA_DIR, "memory.json");

// Kevyt prosessin sisÃ¤inen lukko (riittÃ¤Ã¤ MVP/dev)
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

async function ensureStore(): Promise<StoreShape> {
  await fs.mkdir(DATA_DIR, { recursive: true });

  try {
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
  const tmp = `${STORE_FILE}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), "utf8");
  await fs.rename(tmp, STORE_FILE);
}

export async function getUserSnapshot(uid: string): Promise<AjxUserSnapshot | null> {
  return withLock(async () => {
    const store = await ensureStore();
    return store.users[uid] ?? null;
  });
}

export async function setUserSnapshot(uid: string, snapshotText: string): Promise<AjxUserSnapshot> {
  return withLock(async () => {
    const store = await ensureStore();
    const next: AjxUserSnapshot = { text: snapshotText, updatedAt: Date.now() };
    store.users[uid] = next;
    await writeStore(store);
    return next;
  });
}
