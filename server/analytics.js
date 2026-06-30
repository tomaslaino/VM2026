import fs from "node:fs";
import { DATA_DIR } from "./config.js";

/*
  Enkel, integritetsvänlig besöksmätning (ingen tredjepart, inga cookies).
  Frontenden skickar en beacon till /api/track vid varje vy-byte; här lagras
  raden i Neon Postgres om DATABASE_URL är satt, annars i en lokal JSONL-fil.

  En "besökare" identifieras av ett slumpat id som frontenden själv lagrar i
  localStorage (förstaparts-id, ingen IP sparas). Referrer reduceras till
  värddomän så inga fullständiga URL:er lagras.
*/

const FILE = DATA_DIR + "/pageviews.jsonl";

const VALID_VIEWS = new Set([
  "home", "groups", "bracket", "r32", "legacy-r32", "players", "calendar",
]);

let db; // undefined = ej testat, null = ingen DB, annars sql-funktion

async function getDb() {
  if (db !== undefined) return db;
  const url = process.env.DATABASE_URL;
  if (!url) { db = null; return null; }
  try {
    const { neon } = await import("@neondatabase/serverless");
    const sql = neon(url);
    await sql`
      CREATE TABLE IF NOT EXISTS vm_pageviews (
        id BIGSERIAL PRIMARY KEY,
        ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        view TEXT,
        visitor TEXT,
        referrer TEXT,
        device TEXT
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS vm_pageviews_ts_idx ON vm_pageviews (ts)`;
    db = sql;
    console.log("[analytics] Neon Postgres ansluten.");
  } catch (e) {
    console.warn("[analytics] Neon misslyckades, loggar till fil:", e.message);
    db = null;
  }
  return db;
}

function deviceFromUA(ua) {
  if (!ua) return "okänd";
  if (/iPad|Tablet/i.test(ua)) return "surfplatta";
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return "mobil";
  return "dator";
}

function cleanRef(ref) {
  if (!ref) return "direkt";
  try {
    const host = new URL(ref).hostname.replace(/^www\./, "");
    return host || "direkt";
  } catch {
    return "direkt";
  }
}

/** Lagra en sidvisning. Kastar aldrig – mätning får aldrig störa sidan. */
export async function record({ view, visitor, referrer, ua } = {}) {
  try {
    const v = VALID_VIEWS.has(view) ? view : "okänd";
    const vid = (visitor || "").slice(0, 40) || null;
    const device = deviceFromUA(ua);
    const ref = cleanRef(referrer);
    const sql = await getDb();
    if (sql) {
      await sql`
        INSERT INTO vm_pageviews (view, visitor, referrer, device)
        VALUES (${v}, ${vid}, ${ref}, ${device})
      `;
      return;
    }
    fs.appendFileSync(
      FILE,
      JSON.stringify({ ts: new Date().toISOString(), view: v, visitor: vid, referrer: ref, device }) + "\n"
    );
  } catch (e) {
    console.warn("[analytics] kunde inte spara sidvisning:", e.message);
  }
}

const TZ = "Europe/Stockholm";

/** Aggregerad statistik för admin-panelen. */
export async function stats() {
  const sql = await getDb();
  if (sql) {
    const [totals] = await sql`
      SELECT COUNT(*)::int AS views, COUNT(DISTINCT visitor)::int AS visitors
      FROM vm_pageviews
    `;
    const [today] = await sql`
      SELECT COUNT(*)::int AS views, COUNT(DISTINCT visitor)::int AS visitors
      FROM vm_pageviews
      WHERE (ts AT TIME ZONE ${TZ})::date = (NOW() AT TIME ZONE ${TZ})::date
    `;
    const byDay = await sql`
      SELECT (ts AT TIME ZONE ${TZ})::date AS day,
             COUNT(*)::int AS views,
             COUNT(DISTINCT visitor)::int AS visitors
      FROM vm_pageviews
      WHERE ts >= NOW() - INTERVAL '30 days'
      GROUP BY day ORDER BY day
    `;
    const byView = await sql`
      SELECT view, COUNT(*)::int AS views
      FROM vm_pageviews GROUP BY view ORDER BY views DESC
    `;
    const byReferrer = await sql`
      SELECT referrer, COUNT(*)::int AS views
      FROM vm_pageviews GROUP BY referrer ORDER BY views DESC LIMIT 12
    `;
    const byDevice = await sql`
      SELECT device, COUNT(*)::int AS views
      FROM vm_pageviews GROUP BY device ORDER BY views DESC
    `;
    return {
      source: "postgres",
      totals,
      today,
      byDay: byDay.map((r) => ({ day: String(r.day).slice(0, 10), views: r.views, visitors: r.visitors })),
      byView,
      byReferrer,
      byDevice,
    };
  }
  return statsFromFile();
}

function statsFromFile() {
  let rows = [];
  try {
    if (fs.existsSync(FILE)) {
      rows = fs.readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    }
  } catch { /* tom */ }

  const dayKey = (iso) => new Date(iso).toLocaleDateString("sv-SE", { timeZone: TZ });
  const todayKey = new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
  const uniq = (arr) => new Set(arr.filter(Boolean)).size;

  const tally = (keyFn) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };

  const days = new Map(); // day -> { views, visitors:Set }
  for (const r of rows) {
    const k = dayKey(r.ts);
    if (!days.has(k)) days.set(k, { views: 0, visitors: new Set() });
    const d = days.get(k);
    d.views++;
    if (r.visitor) d.visitors.add(r.visitor);
  }
  const byDay = [...days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-30)
    .map(([day, d]) => ({ day, views: d.views, visitors: d.visitors.size }));

  const todayRows = rows.filter((r) => dayKey(r.ts) === todayKey);

  return {
    source: "fil",
    totals: { views: rows.length, visitors: uniq(rows.map((r) => r.visitor)) },
    today: { views: todayRows.length, visitors: uniq(todayRows.map((r) => r.visitor)) },
    byDay,
    byView: tally((r) => r.view).map(([view, views]) => ({ view, views })),
    byReferrer: tally((r) => r.referrer).slice(0, 12).map(([referrer, views]) => ({ referrer, views })),
    byDevice: tally((r) => r.device).map(([device, views]) => ({ device, views })),
  };
}
