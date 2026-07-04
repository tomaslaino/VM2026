/*
  Bygger data/fotmob_ratings.json: FotMobs spelarbetyg (0–10) per spelare och
  match för färdigspelade VM-matcher, hämtade från FotMobs öppna webb-API
  (ingen nyckel).

  Varför? Det egna VM-betyget (assets/playerstats.js) räknas ur ESPN:s
  gratisdata, som SAKNAR defensiva aktioner (tacklingar, brytningar, passningar,
  dueller) per spelare. Därför får en bollstädande mittback/sexa som inte gör
  mål ett tunt betyg. FotMobs betyg bygger på Opta-liknande händelsedata och
  fångar även försvarsspel – det visas i statistiken bredvid det egna betyget.

  Källa: https://www.fotmob.com/api/data/matches?date=YYYYMMDD ger dagens
  matcher grupperade per liga; VM 2026 känns igen på parentLeagueId === 77.
  https://www.fotmob.com/api/data/matchDetails?matchId=<id> ger laguppställning
  med content.lineup.{homeTeam,awayTeam}.{starters,subs}[].performance.rating.

  Matchning mot appens nycklar (g:A:2, k:73 …) sker via data/results.json
  fixtures (datum + engelska lagnamn), samma round-robin-ordning som resten av
  appen. Spelare kopplas mot ESPN-laguppställningen i data/matchdetails.json
  (starters + inhopp) med en greedy namnmatchare: exakt normaliserat namn →
  ordningsoberoende (sorterad token-mängd, för koreanska/japanska rotationer
  "Kim Seung-Gyu" ↔ "Seung-Gyu Kim") → token-subset (kortnamn "Gabriel" ↔
  "Gabriel Magalhães"). Utfilen nycklas alltså på ESPN:s normaliserade namn –
  precis statBucket-nyckeln i playerstats.js – så frontenden bara slår upp
  exakt. Spelare FotMob inte betygsatt (sena inhopp) saknas; det är väntat.

  Inkrementell och resumbar: en färdig match betygsätts en gång och behålls
  sedan (betygen är slutgiltiga), så bara nytillkomna matcher hämtas. Ändras
  ingenting skrivs filen inte om, så workflowen committar bara vid faktisk
  förändring.

  Körs av .github/workflows/sync-fotmob-ratings.yml. Kan köras manuellt:
    node server/scripts/syncFotmobRatings.js
*/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const OUT_FILE = path.join(__dir, "../../data/fotmob_ratings.json");
const RESULTS_FILE = path.join(__dir, "../../data/results.json");
const DETAILS_FILE = path.join(__dir, "../../data/matchdetails.json");

const API = "https://www.fotmob.com/api/data";
const WC_PARENT_LEAGUE_ID = 77; // FIFA World Cup (INT) hos FotMob
const FETCH_TIMEOUT = 15000;
const DELAY_MS = 400; // paus mellan anropen – snällt mot FotMob

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "application/json",
  Referer: "https://www.fotmob.com/",
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

/* ---------- Namnmatchning (samma norm som playerstats.js) ---------- */

function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Nyckel = normaliserat ESPN-namn ur results.json, värden = FotMob-varianter.
const TEAM_ALIASES = {
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

function teamMatches(fixName, fotmobName) {
  const a = norm(fixName);
  const b = norm(fotmobName);
  if (!a || !b) return false;
  if (a === b) return true;
  return (TEAM_ALIASES[a] || []).includes(b) || (TEAM_ALIASES[b] || []).includes(a);
}

/* ---------- FotMob-betyg → ESPN-spelarnamn ---------- */

const sortKey = (n) => n.split(" ").filter(Boolean).sort().join(" ");
const tokSet = (n) => new Set(n.split(" ").filter(Boolean));
const subsetOf = (small, big) => {
  for (const t of small) if (!big.has(t)) return false;
  return small.size > 0;
};

/** FotMob-sida (homeTeam/awayTeam) → [{ name, norm, rating }] för spelade. */
function fmSideRatings(team) {
  const list = [];
  if (!team) return list;
  for (const p of [...(team.starters || []), ...(team.subs || [])]) {
    const r = p && p.performance && p.performance.rating;
    if (r == null) continue; // spelare utan speltid saknar betyg
    const rating = Math.round(Number(r) * 10) / 10;
    if (!Number.isFinite(rating)) continue;
    const nn = norm(p.name);
    if (nn) list.push({ name: p.name, norm: nn, rating });
  }
  return list;
}

/**
 * Koppla FotMob-betygen (fmList) till ESPN-namnen (espnNorms) greedy:
 * exakt → sorterad token-mängd → token-subset. Returnerar { espnNorm: rating }.
 * Claimade FotMob-poster tas bort mellan stegen så en post bara används en gång.
 */
function joinToEspn(espnNorms, fmList) {
  const out = {};
  const pool = fmList.map((e) => ({ ...e, sort: sortKey(e.norm), toks: tokSet(e.norm), used: false }));
  const targets = espnNorms.map((n) => ({ norm: n, sort: sortKey(n), toks: tokSet(n) }));

  const claim = (t, matcher) => {
    for (const e of pool) {
      if (e.used) continue;
      if (matcher(t, e)) {
        out[t.norm] = e.rating;
        e.used = true;
        return true;
      }
    }
    return false;
  };

  const remaining = [];
  for (const t of targets) if (!claim(t, (t, e) => t.norm === e.norm)) remaining.push(t);
  const r2 = [];
  for (const t of remaining) if (!claim(t, (t, e) => t.sort === e.sort)) r2.push(t);
  for (const t of r2) {
    // Subset åt endera hållet, men bara om exakt EN kvarvarande FotMob-post passar.
    const cand = pool.filter(
      (e) => !e.used && (subsetOf(e.toks, t.toks) || subsetOf(t.toks, e.toks))
    );
    if (cand.length === 1) {
      out[t.norm] = cand[0].rating;
      cand[0].used = true;
    }
  }
  return out;
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

function yyyymmdd(iso, offsetDays = 0) {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() + offsetDays);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`;
}

/** Färdigspelade matcher med klara lagnamn. */
function pickTargets(fixtures) {
  const targets = [];
  for (const [key, fx] of Object.entries(fixtures || {})) {
    if (!fx || fx.status !== "FINISHED" || !fx.utcDate || !fx.home || !fx.away) continue;
    if (/winner|loser|round of|group |^match/i.test(fx.home + " " + fx.away)) continue; // platshållare
    targets.push({ key, fx });
  }
  return targets;
}

/** VM-matcher hos FotMob för ett UTC-datum (cachas per datum). */
async function fetchWcGamesForDate(dateStr, cache) {
  if (cache.has(dateStr)) return cache.get(dateStr);
  const data = await getJson(`${API}/matches?date=${dateStr}`);
  const games = [];
  for (const lg of data.leagues || []) {
    if (lg.parentLeagueId !== WC_PARENT_LEAGUE_ID && lg.primaryId !== WC_PARENT_LEAGUE_ID) continue;
    for (const m of lg.matches || []) games.push(m);
  }
  cache.set(dateStr, games);
  return games;
}

async function findGame(fx, dateCache) {
  // FotMob-datumet följer UTC; avspark nära midnatt kan hamna på grannedagen.
  for (const off of [0, -1, 1]) {
    const games = await fetchWcGamesForDate(yyyymmdd(fx.utcDate, off), dateCache);
    const game = games.find(
      (g) =>
        (teamMatches(fx.home, g.home && g.home.name) && teamMatches(fx.away, g.away && g.away.name)) ||
        (teamMatches(fx.home, g.away && g.away.name) && teamMatches(fx.away, g.home && g.home.name))
    );
    if (game) return game;
  }
  return null;
}

/** ESPN-lineupens normaliserade namn per sida (starters + faktiska inhopp). */
function espnNormsOfSide(lu) {
  const names = new Set();
  if (!lu) return [];
  (lu.starters || []).forEach((s) => s && s.name && names.add(norm(s.name)));
  (lu.bench || []).forEach((s) => s && s.name && s.in && names.add(norm(s.name)));
  return [...names];
}

async function syncFotmobRatings() {
  const results = readJsonIfExists(RESULTS_FILE);
  if (!results || !results.fixtures) {
    console.error("[fotmob] Hittar inga fixtures i data/results.json – avbryter.");
    process.exit(1);
  }
  const detailsFile = readJsonIfExists(DETAILS_FILE);
  const details = (detailsFile && detailsFile.details) || {};

  const targets = pickTargets(results.fixtures);
  console.log(`[fotmob] ${targets.length} färdigspelade matcher att täcka.`);

  const prev = readJsonIfExists(OUT_FILE);
  const prevMatches = (prev && prev.matches) || {};
  const out = {};
  const dateCache = new Map();
  let fetched = 0;
  let joined = 0;
  let unmatched = 0;

  for (const { key, fx } of targets) {
    const label = `${fx.home}–${fx.away}`;

    // Redan betygsatt → behåll (färdiga matchers betyg ändras inte).
    if (prevMatches[key] && prevMatches[key].players) {
      out[key] = prevMatches[key];
      continue;
    }

    try {
      const game = await findGame(fx, dateCache);
      if (!game) {
        console.log(`[fotmob] ${key} ${label}: ingen FotMob-match hittad.`);
        continue;
      }

      await sleep(DELAY_MS);
      const detail = await getJson(`${API}/matchDetails?matchId=${game.id}`);
      const lu = detail.content && detail.content.lineup;
      if (!lu || !lu.homeTeam || !lu.awayTeam) {
        console.log(`[fotmob] ${key} ${label}: ingen laguppställning i FotMob-datan.`);
        continue;
      }

      // FotMobs hemma/borta kan vara spegelvänt mot appens fasta ordning.
      const homeIsHome = teamMatches(fx.home, lu.homeTeam.name);
      const ourHome = homeIsHome ? lu.homeTeam : lu.awayTeam;
      const ourAway = homeIsHome ? lu.awayTeam : lu.homeTeam;

      const det = details[key];
      const espnH = espnNormsOfSide(det && det.lineups && det.lineups.h);
      const espnA = espnNormsOfSide(det && det.lineups && det.lineups.a);
      const fmH = fmSideRatings(ourHome);
      const fmA = fmSideRatings(ourAway);

      // Utan ESPN-lineup (ovanligt): nyckla på FotMobs egna normaliserade namn.
      const h = espnH.length ? joinToEspn(espnH, fmH) : Object.fromEntries(fmH.map((e) => [e.norm, e.rating]));
      const a = espnA.length ? joinToEspn(espnA, fmA) : Object.fromEntries(fmA.map((e) => [e.norm, e.rating]));
      const nJoined = Object.keys(h).length + Object.keys(a).length;
      if (!nJoined) {
        console.log(`[fotmob] ${key} ${label}: inga betyg satta ännu.`);
        continue;
      }
      const nFm = fmH.length + fmA.length;
      const miss = espnH.length ? nFm - nJoined : 0;
      joined += nJoined;
      unmatched += Math.max(0, miss);

      out[key] = {
        fotmobId: game.id,
        teamRating: {
          h: ourHome.rating != null ? Number(ourHome.rating) : null,
          a: ourAway.rating != null ? Number(ourAway.rating) : null,
        },
        players: { h, a },
        updatedAt: new Date().toISOString(),
      };
      fetched++;
      console.log(
        `[fotmob] ${key} ${label}: ${nJoined} kopplade betyg (FotMob #${game.id}` +
          `${miss > 0 ? `, ${miss} omatchade` : ""}).`
      );
      await sleep(DELAY_MS);
    } catch (e) {
      console.log(`[fotmob] ${key} ${label}: fel – ${e.message}`);
    }
  }

  const changed = JSON.stringify((prev && prev.matches) || null) !== JSON.stringify(out) || !prev;
  if (!changed) {
    console.log("[fotmob] Inga förändringar – skriver inte om filen.");
    return;
  }

  const payload = {
    meta: {
      updatedAt: new Date().toISOString(),
      source: "fotmob",
      matchCount: Object.keys(out).length,
    },
    matches: out,
  };
  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2) + "\n");
  console.log(
    `[fotmob] Skrev ${Object.keys(out).length} matcher (${fetched} nya, ` +
      `${joined} kopplade betyg, ${unmatched} omatchade) → ${path.relative(process.cwd(), OUT_FILE)}`
  );
}

syncFotmobRatings().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
