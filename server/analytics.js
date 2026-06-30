import fs from "node:fs";
import { DATA_DIR } from "./config.js";

/*
  Integritetsvänlig besöksmätning (ingen tredjepart, inga cookies).
  Frontenden skickar beacons till /api/track vid vy-byte och utvalda händelser.
  Lagras i Neon Postgres om DATABASE_URL är satt, annars i en lokal JSONL-fil.
*/

const FILE = DATA_DIR + "/pageviews.jsonl";
const TZ = "Europe/Stockholm";

const VALID_VIEWS = new Set([
  "home", "groups", "bracket", "r32", "legacy-r32", "players", "calendar",
]);

const VALID_KINDS = new Set(["view", "match", "search", "team"]);

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
        kind TEXT NOT NULL DEFAULT 'view',
        view TEXT,
        detail TEXT,
        visitor TEXT,
        session TEXT,
        referrer TEXT,
        device TEXT,
        browser TEXT,
        duration_sec INT
      )
    `;
    await sql`CREATE INDEX IF NOT EXISTS vm_pageviews_ts_idx ON vm_pageviews (ts)`;
    await sql`CREATE INDEX IF NOT EXISTS vm_pageviews_kind_idx ON vm_pageviews (kind)`;
    await sql`ALTER TABLE vm_pageviews ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'view'`;
    await sql`ALTER TABLE vm_pageviews ADD COLUMN IF NOT EXISTS detail TEXT`;
    await sql`ALTER TABLE vm_pageviews ADD COLUMN IF NOT EXISTS session TEXT`;
    await sql`ALTER TABLE vm_pageviews ADD COLUMN IF NOT EXISTS browser TEXT`;
    await sql`ALTER TABLE vm_pageviews ADD COLUMN IF NOT EXISTS duration_sec INT`;
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

function browserFromUA(ua) {
  if (!ua) return "okänd";
  if (/Edg\//i.test(ua)) return "Edge";
  if (/OPR\//i.test(ua) || /Opera/i.test(ua)) return "Opera";
  if (/SamsungBrowser/i.test(ua)) return "Samsung";
  if (/Firefox\//i.test(ua)) return "Firefox";
  if (/CriOS/i.test(ua)) return "Chrome (iOS)";
  if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) return "Chrome";
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return "Safari";
  return "övrigt";
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

function cleanDuration(n) {
  const v = parseInt(n, 10);
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.min(v, 86400);
}

/** Lagra en händelse. Kastar aldrig – mätning får aldrig störa sidan. */
export async function record({
  view, visitor, referrer, ua, session, duration, kind, detail,
} = {}) {
  try {
    const k = VALID_KINDS.has(kind) ? kind : "view";
    const v = k === "view" && VALID_VIEWS.has(view) ? view : (view || null);
    const vid = (visitor || "").slice(0, 40) || null;
    const sid = (session || "").slice(0, 40) || null;
    const det = detail ? String(detail).slice(0, 120) : null;
    const device = deviceFromUA(ua);
    const browser = browserFromUA(ua);
    const ref = cleanRef(referrer);
    const dur = cleanDuration(duration);
    const row = {
      ts: new Date().toISOString(),
      kind: k, view: v, detail: det, visitor: vid, session: sid,
      referrer: ref, device, browser, duration_sec: dur,
    };
    const sql = await getDb();
    if (sql) {
      await sql`
        INSERT INTO vm_pageviews (kind, view, detail, visitor, session, referrer, device, browser, duration_sec)
        VALUES (${k}, ${v}, ${det}, ${vid}, ${sid}, ${ref}, ${device}, ${browser}, ${dur})
      `;
      return;
    }
    fs.appendFileSync(FILE, JSON.stringify(row) + "\n");
  } catch (e) {
    console.warn("[analytics] kunde inte spara händelse:", e.message);
  }
}

function fmtDay(d) {
  return String(d).slice(0, 10);
}

/** Aggregerad statistik för admin-panelen. */
export async function stats() {
  const sql = await getDb();
  if (sql) return statsFromPostgres(sql);
  return statsFromFile();
}

async function statsFromPostgres(sql) {
  const [totals] = await sql`
    SELECT COUNT(*)::int AS events,
           COUNT(*) FILTER (WHERE kind = 'view')::int AS views,
           COUNT(DISTINCT visitor)::int AS visitors,
           COUNT(DISTINCT session)::int AS sessions
    FROM vm_pageviews
  `;
  const [today] = await sql`
    SELECT COUNT(*)::int AS events,
           COUNT(*) FILTER (WHERE kind = 'view')::int AS views,
           COUNT(DISTINCT visitor)::int AS visitors,
           COUNT(DISTINCT session)::int AS sessions
    FROM vm_pageviews
    WHERE (ts AT TIME ZONE ${TZ})::date = (NOW() AT TIME ZONE ${TZ})::date
  `;
  const byDay = await sql`
    SELECT (ts AT TIME ZONE ${TZ})::date AS day,
           COUNT(*) FILTER (WHERE kind = 'view')::int AS views,
           COUNT(DISTINCT visitor)::int AS visitors
    FROM vm_pageviews
    WHERE ts >= NOW() - INTERVAL '30 days'
    GROUP BY day ORDER BY day
  `;
  const byHour = await sql`
    SELECT EXTRACT(HOUR FROM (ts AT TIME ZONE ${TZ}))::int AS hour,
           COUNT(*) FILTER (WHERE kind = 'view')::int AS views,
           COUNT(DISTINCT visitor)::int AS visitors
    FROM vm_pageviews
    WHERE (ts AT TIME ZONE ${TZ})::date = (NOW() AT TIME ZONE ${TZ})::date
    GROUP BY hour ORDER BY hour
  `;
  const byView = await sql`
    SELECT view, COUNT(*)::int AS views
    FROM vm_pageviews WHERE kind = 'view' AND view IS NOT NULL
    GROUP BY view ORDER BY views DESC
  `;
  const byReferrer = await sql`
    SELECT referrer, COUNT(*)::int AS views
    FROM vm_pageviews WHERE kind = 'view'
    GROUP BY referrer ORDER BY views DESC LIMIT 12
  `;
  const byDevice = await sql`
    SELECT device, COUNT(*)::int AS views
    FROM vm_pageviews WHERE kind = 'view'
    GROUP BY device ORDER BY views DESC
  `;
  const byBrowser = await sql`
    SELECT browser, COUNT(*)::int AS views
    FROM vm_pageviews WHERE kind = 'view'
    GROUP BY browser ORDER BY views DESC
  `;
  const avgDuration = await sql`
    SELECT view, ROUND(AVG(duration_sec))::int AS avg_sec, COUNT(*)::int AS samples
    FROM vm_pageviews
    WHERE kind = 'view' AND duration_sec IS NOT NULL AND duration_sec > 0
    GROUP BY view ORDER BY avg_sec DESC
  `;
  const topMatches = await sql`
    SELECT detail, COUNT(*)::int AS clicks
    FROM vm_pageviews WHERE kind = 'match' AND detail IS NOT NULL
    GROUP BY detail ORDER BY clicks DESC LIMIT 15
  `;
  const topTeams = await sql`
    SELECT detail, COUNT(*)::int AS clicks
    FROM vm_pageviews WHERE kind = 'team' AND detail IS NOT NULL
    GROUP BY detail ORDER BY clicks DESC LIMIT 12
  `;
  const topSearches = await sql`
    SELECT detail, COUNT(*)::int AS clicks
    FROM vm_pageviews WHERE kind = 'search' AND detail IS NOT NULL
    GROUP BY detail ORDER BY clicks DESC LIMIT 12
  `;
  const [visitorSplit] = await sql`
    WITH first_seen AS (
      SELECT visitor, MIN((ts AT TIME ZONE ${TZ})::date) AS first_day
      FROM vm_pageviews WHERE visitor IS NOT NULL GROUP BY visitor
    ),
    today_vis AS (
      SELECT DISTINCT visitor FROM vm_pageviews
      WHERE (ts AT TIME ZONE ${TZ})::date = (NOW() AT TIME ZONE ${TZ})::date
        AND visitor IS NOT NULL
    )
    SELECT
      COUNT(*) FILTER (WHERE f.first_day = (NOW() AT TIME ZONE ${TZ})::date)::int AS new_today,
      COUNT(*) FILTER (WHERE f.first_day < (NOW() AT TIME ZONE ${TZ})::date)::int AS returning_today
    FROM today_vis t JOIN first_seen f ON f.visitor = t.visitor
  `;
  const [engagement] = await sql`
    SELECT ROUND(AVG(cnt), 1)::float AS avg_views_per_visitor
    FROM (
      SELECT visitor, COUNT(*)::float AS cnt
      FROM vm_pageviews
      WHERE kind = 'view' AND visitor IS NOT NULL
      GROUP BY visitor
    ) sub
  `;
  const byKind = await sql`
    SELECT kind, COUNT(*)::int AS count
    FROM vm_pageviews GROUP BY kind ORDER BY count DESC
  `;

  return {
    source: "postgres",
    totals,
    today,
    visitorSplit: visitorSplit || { new_today: 0, returning_today: 0 },
    engagement: engagement || { avg_views_per_visitor: 0 },
    byDay: byDay.map((r) => ({ day: fmtDay(r.day), views: r.views, visitors: r.visitors })),
    byHour: byHour.map((r) => ({ hour: r.hour, views: r.views, visitors: r.visitors })),
    byView,
    byReferrer,
    byDevice,
    byBrowser,
    avgDuration,
    topMatches,
    topTeams,
    topSearches,
    byKind,
  };
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
  const hourKey = (iso) => {
    const h = new Date(iso).toLocaleString("sv-SE", { timeZone: TZ, hour: "numeric", hour12: false });
    return parseInt(h, 10);
  };
  const uniq = (arr) => new Set(arr.filter(Boolean)).size;
  const viewRows = rows.filter((r) => (r.kind || "view") === "view");

  const tallySimple = (subset, keyFn, outKey, countKey) => {
    const m = new Map();
    for (const r of subset) {
      const k = keyFn(r);
      if (!k) continue;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1])
      .map(([k, n]) => ({ [outKey]: k, [countKey]: n }));
  };

  const days = new Map();
  for (const r of viewRows) {
    const k = dayKey(r.ts);
    if (!days.has(k)) days.set(k, { views: 0, visitors: new Set() });
    const d = days.get(k);
    d.views++;
    if (r.visitor) d.visitors.add(r.visitor);
  }
  const byDay = [...days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-30)
    .map(([day, d]) => ({ day, views: d.views, visitors: d.visitors.size }));

  const hours = new Map();
  for (const r of viewRows.filter((r) => dayKey(r.ts) === todayKey)) {
    const h = hourKey(r.ts);
    if (!hours.has(h)) hours.set(h, { views: 0, visitors: new Set() });
    hours.get(h).views++;
    if (r.visitor) hours.get(h).visitors.add(r.visitor);
  }
  const byHour = [...hours.entries()].sort((a, b) => a[0] - b[0])
    .map(([hour, d]) => ({ hour, views: d.views, visitors: d.visitors.size }));

  const firstSeen = new Map();
  for (const r of rows) {
    if (!r.visitor) continue;
    const d = dayKey(r.ts);
    if (!firstSeen.has(r.visitor) || d < firstSeen.get(r.visitor)) firstSeen.set(r.visitor, d);
  }
  const todayVisitors = new Set(viewRows.filter((r) => dayKey(r.ts) === todayKey).map((r) => r.visitor));
  let newToday = 0;
  let returningToday = 0;
  for (const vid of todayVisitors) {
    if (!vid) continue;
    if (firstSeen.get(vid) === todayKey) newToday++;
    else returningToday++;
  }

  const viewsPerVisitor = new Map();
  for (const r of viewRows) {
    if (!r.visitor) continue;
    viewsPerVisitor.set(r.visitor, (viewsPerVisitor.get(r.visitor) || 0) + 1);
  }
  const avgViews = viewsPerVisitor.size
    ? Math.round([...viewsPerVisitor.values()].reduce((a, b) => a + b, 0) / viewsPerVisitor.size * 10) / 10
    : 0;

  const durMap = new Map();
  const durCount = new Map();
  for (const r of viewRows) {
    if (!r.view || !r.duration_sec || r.duration_sec <= 0) continue;
    durMap.set(r.view, (durMap.get(r.view) || 0) + r.duration_sec);
    durCount.set(r.view, (durCount.get(r.view) || 0) + 1);
  }
  const avgDuration = [...durMap.entries()].map(([view, sum]) => ({
    view,
    avg_sec: Math.round(sum / durCount.get(view)),
    samples: durCount.get(view),
  })).sort((a, b) => b.avg_sec - a.avg_sec);

  const todayViewRows = viewRows.filter((r) => dayKey(r.ts) === todayKey);
  const sessionsToday = uniq(todayViewRows.map((r) => r.session));

  return {
    source: "fil",
    totals: {
      events: rows.length,
      views: viewRows.length,
      visitors: uniq(rows.map((r) => r.visitor)),
      sessions: uniq(rows.map((r) => r.session)),
    },
    today: {
      events: rows.filter((r) => dayKey(r.ts) === todayKey).length,
      views: todayViewRows.length,
      visitors: uniq(todayViewRows.map((r) => r.visitor)),
      sessions: sessionsToday,
    },
    visitorSplit: { new_today: newToday, returning_today: returningToday },
    engagement: { avg_views_per_visitor: avgViews },
    byDay,
    byHour,
    byView: tallySimple(viewRows, (r) => r.view, "view", "views"),
    byReferrer: tallySimple(viewRows, (r) => r.referrer, "referrer", "views").slice(0, 12),
    byDevice: tallySimple(viewRows, (r) => r.device, "device", "views"),
    byBrowser: tallySimple(viewRows, (r) => r.browser || browserFromUA(""), "browser", "views"),
    avgDuration,
    topMatches: tallySimple(rows.filter((r) => r.kind === "match"), (r) => r.detail, "detail", "clicks").slice(0, 15),
    topTeams: tallySimple(rows.filter((r) => r.kind === "team"), (r) => r.detail, "detail", "clicks").slice(0, 12),
    topSearches: tallySimple(rows.filter((r) => r.kind === "search"), (r) => r.detail, "detail", "clicks").slice(0, 12),
    byKind: tallySimple(rows, (r) => r.kind || "view", "kind", "count"),
  };
}
