import fs from "fs/promises";
import path from "path";

export type AjxUserSnapshot = {
  text: string; // 300–800 merkkiä
  updatedAt: number; // unix ms
};

type StoreShape = {
  version: 1;
  users: Record<string, AjxUserSnapshot>;
};

const IS_VERCEL =
  process.env.VERCEL === "1" ||
  !!process.env.VERCEL_ENV ||
  !!process.env.AWS_REGION ||
  process.cwd().startsWith("/var/task");

const DATA_DIR = process.env.AJX_DATA_DIR || path.join(process.cwd(), ".ajx-data");
const STORE_FILE = path.join(DATA_DIR, "memory.json");

const memoryStore: StoreShape = {
  version: 1,
  users: {},
};

// Kevyt prosessin sisäinen lukko (riittää MVP/dev)
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

function canUseFilesystem() {
  return !IS_VERCEL;
}

function cloneStore(store: StoreShape): StoreShape {
  return {
    version: 1,
    users: { ...store.users },
  };
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