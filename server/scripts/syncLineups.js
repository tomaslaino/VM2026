/*
  Bygger data/lineups_prelim.json: troliga startelvor för kommande VM-matcher,
  hämtade från 365Scores öppna webb-API (samma data som deras matchsidor visar,
  ingen nyckel behövs).

  365Scores publicerar en TROLIG elva (lineups.status = "NotConfirmed") ofta
  redan dagen före match, och samma fält slår om till "Confirmed" när de
  officiella laguppställningarna släpps (~1 timme före avspark). Frontenden
  (assets/matchinfo.js, fliken "Laguppställning") visar troliga elvor med en
  tydlig "preliminär"-banner tills ESPN:s officiella lineups tar över i
  data/matchdetails.json vid avspark.

  Utdataformatet på h/a är detsamma som matchdetails-lineups (formation +
  starters [{name, jersey, pos}] + bench), så frontendens befintliga
  gräsplans-rendering kan återanvändas rakt av. pos-koderna (G/RB/CB/LB/DM/
  CM/AM/ST …) väljs så att pitchBandOf()/pitchSideOf() i matchinfo.js placerar
  spelarna på rätt linje och kant utifrån 365Scores yardFormation-data.

  Ändras ingenting sedan förra körningen skrivs filen inte om (per-entry
  updatedAt bevaras), så workflowen bara committar när elvorna faktiskt ändrats.

  Körs av .github/workflows/sync-lineups.yml. Kan köras manuellt:
    node server/scripts/syncLineups.js
*/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(__dir, "../../data/lineups_prelim.json");
const RESULTS_FILE = path.join(__dir, "../../data/results.json");

const API = "https://webws.365scores.com/web";
const PARAMS = "appTypeId=5&langId=1&timezoneName=UTC&userCountryId=1";
const LOOKAHEAD_H = 48; // leta elvor så här långt före avspark
const KEEP_AFTER_H = 6; // behåll en entry så här länge efter avspark
const FETCH_TIMEOUT = 15000;
const DELAY_MS = 300; // paus mellan anropen – snällt mot 365Scores

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "application/json",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url, {
    headers: HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} (${url})`);
  return res.json();
}

/* ---------- Lagnamnsmatchning (results.json/ESPN-namn ↔ 365Scores-namn) ---------- */

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Nyckel = normaliserat ESPN-namn ur results.json, värden = 365Scores-varianter.
const ALIASES = {
  "united states": ["usa", "united states"],
  "south korea": ["south korea", "korea republic"],
  czechia: ["czechia", "czech republic"],
  "bosnia herzegovina": ["bosnia herzegovina", "bosnia and herzegovina", "bosnia"],
  "ivory coast": ["ivory coast", "cote d ivoire"],
  turkiye: ["turkiye", "turkey"],
  "congo dr": ["congo dr", "dr congo", "congo democratic republic"],
  "cape verde": ["cape verde", "cabo verde"],
  iran: ["iran", "ir iran"],
};

function nameMatches(fixName, scoresName) {
  const a = norm(fixName);
  const b = norm(scoresName);
  if (!a || !b) return false;
  if (a === b) return true;
  return (ALIASES[a] || []).includes(b);
}

/* ---------- 365Scores-lineup → appens lineupsformat ---------- */

/* pos-koder per band (0 = målvakt … 5 = anfall) och kant (-1 vänster, 0 mitt,
   1 höger) – valda så att matchinfo.js ritar spelaren på rätt planposition. */
const POS_BY_BAND = {
  1: { "-1": "LB", 0: "CB", 1: "RB" },
  2: { "-1": "DM", 0: "DM", 1: "DM" },
  3: { "-1": "LM", 0: "CM", 1: "RM" },
  4: { "-1": "AM-L", 0: "AM", 1: "AM-R" },
  5: { "-1": "LF", 0: "ST", 1: "RF" },
};

// Antal utespelarlinjer i formationen → vilka band linjerna ritas på.
const BANDS_BY_LINE_COUNT = {
  1: [3],
  2: [1, 4],
  3: [1, 3, 5],
  4: [1, 2, 4, 5],
  5: [1, 2, 3, 4, 5],
};

function lineOf(m) {
  const l = m?.yardFormation?.line;
  return Number.isFinite(l) ? l : null;
}

function fieldSideOf(m) {
  const s = m?.yardFormation?.fieldSide;
  return Number.isFinite(s) ? s : 50;
}

function edgeOf(fieldSide) {
  if (fieldSide >= 75) return 1; // höger
  if (fieldSide <= 25) return -1; // vänster
  return 0;
}

/**
 * En 365Scores-competitor → { formation, starters, bench } eller null om
 * laget saknar (komplett) elva. membersById mappar lineup-id → namn/tröja.
 */
function mapSide(comp, membersById) {
  const lu = comp?.lineups;
  if (!lu || !Array.isArray(lu.members)) return null;

  const playerOf = (m) => membersById.get(m.id) || {};
  const starters = lu.members.filter((m) => m.statusText === "Starting");
  const bench = lu.members.filter((m) => m.statusText === "Substitute");
  if (starters.length < 11) return null;

  // Målvakt först, sedan linje för linje bakifrån, vänster → höger.
  starters.sort((x, y) => (lineOf(x) ?? 9) - (lineOf(y) ?? 9) || fieldSideOf(x) - fieldSideOf(y));

  const outfieldLines = [...new Set(starters.map(lineOf).filter((l) => l != null && l > 1))].sort(
    (a, b) => a - b
  );
  const bands = BANDS_BY_LINE_COUNT[outfieldLines.length] || [1, 2, 3, 4, 5];
  const bandOfLine = (l) => {
    if (l == null || l <= 1) return 0;
    const i = outfieldLines.indexOf(l);
    return bands[Math.min(i < 0 ? bands.length - 1 : i, bands.length - 1)];
  };

  const rows = [];
  for (const m of starters) {
    const p = playerOf(m);
    if (!p.name) continue;
    const band = bandOfLine(lineOf(m));
    const pos = band === 0 ? "G" : POS_BY_BAND[band][edgeOf(fieldSideOf(m))];
    rows.push({
      name: p.name,
      jersey: p.jerseyNumber != null ? String(p.jerseyNumber) : null,
      pos,
    });
  }
  if (rows.length < 11) return null;

  const benchRows = bench
    .map((m) => playerOf(m))
    .filter((p) => p.name)
    .map((p) => ({ name: p.name, jersey: p.jerseyNumber != null ? String(p.jerseyNumber) : null }));

  const st = String(lu.status || "");
  return {
    confirmed: /confirmed/i.test(st) && !/not/i.test(st),
    side: { formation: lu.formation || null, starters: rows, bench: benchRows },
  };
}

/* ---------- Huvudflöde ---------- */

function readJsonIfExists(file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    /* trasig fil → börja om */
  }
  return null;
}

function ddmmyyyy(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
}

/** Kommande (ej färdigspelade) matcher med klara lag inom tidsfönstret. */
function pickTargets(fixtures) {
  const now = Date.now();
  const targets = [];
  for (const [key, fx] of Object.entries(fixtures || {})) {
    if (!fx || fx.status === "FINISHED" || !fx.utcDate || !fx.home || !fx.away) continue;
    if (/winner|loser|round of|group|match/i.test(fx.home + " " + fx.away)) continue; // platshållare
    const t = Date.parse(fx.utcDate);
    if (!Number.isFinite(t)) continue;
    if (t < now - KEEP_AFTER_H * 3600e3 || t > now + LOOKAHEAD_H * 3600e3) continue;
    targets.push({ key, fx, kickoff: t });
  }
  targets.sort((a, b) => a.kickoff - b.kickoff);
  return targets;
}

/** Hämta dagens VM-matcher hos 365Scores (en gång per datum). */
async function fetchWcGamesForDate(dateStr, cache) {
  if (cache.has(dateStr)) return cache.get(dateStr);
  const url =
    `${API}/games/allscores/?${PARAMS}&sports=1&onlyMajorGames=true` +
    `&startDate=${encodeURIComponent(dateStr)}&endDate=${encodeURIComponent(dateStr)}`;
  const data = await getJson(url);
  const games = (data.games || []).filter((g) =>
    /fifa world cup/i.test(g.competitionDisplayName || "")
  );
  cache.set(dateStr, games);
  return games;
}

async function syncLineups() {
  const results = readJsonIfExists(RESULTS_FILE);
  if (!results || !results.fixtures) {
    console.error("[lineups] Hittar inga fixtures i data/results.json – avbryter.");
    process.exit(1);
  }

  const targets = pickTargets(results.fixtures);
  console.log(`[lineups] ${targets.length} matcher inom fönstret (${LOOKAHEAD_H}h framåt).`);

  const prev = readJsonIfExists(OUT_FILE);
  const prevEntries = (prev && prev.lineups) || {};
  const out = {};
  const dateCache = new Map();

  for (const { key, fx, kickoff } of targets) {
    const label = `${fx.home}–${fx.away}`;
    try {
      const games = await fetchWcGamesForDate(ddmmyyyy(fx.utcDate), dateCache);
      const game = games.find(
        (g) =>
          (nameMatches(fx.home, g.homeCompetitor?.name) &&
            nameMatches(fx.away, g.awayCompetitor?.name)) ||
          (nameMatches(fx.home, g.awayCompetitor?.name) &&
            nameMatches(fx.away, g.homeCompetitor?.name))
      );
      if (!game) {
        console.log(`[lineups] ${key} ${label}: ingen 365Scores-match hittad.`);
        if (prevEntries[key]) out[key] = prevEntries[key];
        continue;
      }

      await sleep(DELAY_MS);
      const detail = await getJson(`${API}/game/?${PARAMS}&gameId=${game.id}`);
      const g = detail.game || {};
      const membersById = new Map((g.members || []).map((m) => [m.id, m]));

      // Vänd sidorna efter namn – 365Scores hemma/borta kan vara spegelvänt.
      const homeIsHome = nameMatches(fx.home, g.homeCompetitor?.name);
      const hSide = mapSide(homeIsHome ? g.homeCompetitor : g.awayCompetitor, membersById);
      const aSide = mapSide(homeIsHome ? g.awayCompetitor : g.homeCompetitor, membersById);
      if (!hSide || !aSide) {
        console.log(`[lineups] ${key} ${label}: ingen (komplett) trolig elva ännu.`);
        if (prevEntries[key]) out[key] = prevEntries[key];
        continue;
      }

      const entry = {
        status: hSide.confirmed && aSide.confirmed ? "confirmed" : "probable",
        gameId: game.id,
        kickoff: fx.utcDate,
        h: hSide.side,
        a: aSide.side,
      };

      // Bevara updatedAt om ingenting ändrats – annars stämpla nu.
      const old = prevEntries[key];
      const same =
        old &&
        JSON.stringify({ ...old, updatedAt: 0 }) === JSON.stringify({ ...entry, updatedAt: 0 });
      entry.updatedAt = same ? old.updatedAt : new Date().toISOString();
      out[key] = entry;
      console.log(
        `[lineups] ${key} ${label}: ${entry.status}` +
          ` (${entry.h.formation || "?"} / ${entry.a.formation || "?"})${same ? " – oförändrad" : ""}`
      );
      await sleep(DELAY_MS);
    } catch (e) {
      console.log(`[lineups] ${key} ${label}: fel – ${e.message}`);
      if (prevEntries[key]) out[key] = prevEntries[key]; // behåll gamla vid nätverksfel
    }
  }

  const changed =
    JSON.stringify((prev && prev.lineups) || null) !== JSON.stringify(out) || !prev;
  if (!changed) {
    console.log("[lineups] Inga förändringar – skriver inte om filen.");
    return;
  }

  const payload = {
    meta: {
      updatedAt: new Date().toISOString(),
      source: "365scores",
      matchCount: Object.keys(out).length,
    },
    lineups: out,
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2) + "\n");
  console.log(`[lineups] Skrev ${Object.keys(out).length} matcher → ${path.relative(process.cwd(), OUT_FILE)}`);
}

syncLineups().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
