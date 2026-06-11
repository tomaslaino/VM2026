import fs from "node:fs";
import { DATA_DIR } from "./config.js";

/*
  Lagrar synkade matchresultat.
  Använder JSON-fil lokalt. Om DATABASE_URL (Neon) är satt används Postgres i stället.
*/

const RESULTS_FILE = DATA_DIR + "/results.json";

const EMPTY = () => ({
  meta: {
    updatedAt: null,
    source: "espn",
    matchCount: 0,
    liveCount: 0,
    apiCalls: 0,
  },
  results: {},
  live: [],
  fixtures: {},
  standings: {},
});

let cache = EMPTY();
let db = null;

async function getDb() {
  if (db !== undefined) return db;
  const url = process.env.DATABASE_URL;
  if (!url) {
    db = null;
    return null;
  }
  try {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(url);
    await sql`
      CREATE TABLE IF NOT EXISTS vm_results (
        key TEXT PRIMARY KEY,
        h INT NOT NULL,
        a INT NOT NULL,
        pw TEXT,
        status TEXT,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `;
    await sql`
      CREATE TABLE IF NOT EXISTS vm_sync_meta (
        id INT PRIMARY KEY DEFAULT 1,
        updated_at TIMESTAMPTZ,
        match_count INT DEFAULT 0,
        live_count INT DEFAULT 0,
        fd_calls INT DEFAULT 0,
        CONSTRAINT one_row CHECK (id = 1)
      )
    `;
    db = sql;
    console.log("[results] Neon Postgres ansluten.");
  } catch (e) {
    console.warn("[results] Neon misslyckades, faller tillbaka till JSON:", e.message);
    db = null;
  }
  return db;
}

export async function load() {
  const sql = await getDb();
  if (sql) {
    const rows = await sql`SELECT key, h, a, pw, status FROM vm_results`;
    const results = {};
    for (const row of rows) {
      results[row.key] = { h: row.h, a: row.a, pw: row.pw || undefined, status: row.status || undefined };
    }
    const metaRows = await sql`SELECT * FROM vm_sync_meta WHERE id = 1`;
      cache = {
      meta: metaRows[0]
        ? {
            updatedAt: metaRows[0].updated_at,
            source: "espn",
            matchCount: metaRows[0].match_count,
            liveCount: metaRows[0].live_count,
            apiCalls: metaRows[0].fd_calls,
          }
        : EMPTY().meta,
      results,
      live: [],
      fixtures: cache.fixtures || {},
      standings: cache.standings || {},
    };
    return cache;
  }

  try {
    if (fs.existsSync(RESULTS_FILE)) {
      cache = { ...EMPTY(), ...JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8")) };
    }
  } catch (e) {
    console.warn("[results] Kunde inte läsa results.json:", e.message);
    cache = EMPTY();
  }
  return cache;
}

export function getSnapshot() {
  return cache;
}

export async function save({ results, live, fixtures, standings, mapped, apiCalls }) {
  cache.results = results;
  cache.live = live || [];
  if (fixtures) cache.fixtures = fixtures;
  if (standings) cache.standings = standings;
  cache.meta = {
    ...cache.meta,
    updatedAt: new Date().toISOString(),
    source: "espn",
    matchCount: mapped,
    liveCount: (live || []).length,
    apiCalls,
  };

  const sql = await getDb();
  if (sql) {
    const keys = Object.keys(results);
    if (keys.length) {
      for (const key of keys) {
        const r = results[key];
        await sql`
          INSERT INTO vm_results (key, h, a, pw, status, updated_at)
          VALUES (${key}, ${r.h}, ${r.a}, ${r.pw || null}, ${r.status || null}, NOW())
          ON CONFLICT (key) DO UPDATE SET
            h = EXCLUDED.h, a = EXCLUDED.a, pw = EXCLUDED.pw,
            status = EXCLUDED.status, updated_at = NOW()
        `;
      }
    }
    await sql`
      INSERT INTO vm_sync_meta (id, updated_at, match_count, live_count, fd_calls)
      VALUES (1, NOW(), ${mapped}, ${(live || []).length}, ${apiCalls ?? 0})
      ON CONFLICT (id) DO UPDATE SET
        updated_at = NOW(), match_count = EXCLUDED.match_count,
        live_count = EXCLUDED.live_count, fd_calls = EXCLUDED.fd_calls
    `;
    return cache;
  }

  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(cache, null, 2));
  return cache;
}
