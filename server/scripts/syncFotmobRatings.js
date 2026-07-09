/*
  Bygger data/fotmob_ratings.json: FotMobs spelarbetyg (0–10) per spelare och
  match för färdigspelade VM-matcher, hämtade från FotMobs öppna webb-API
  (ingen nyckel) – samt xG (förväntade mål) per lag och spelare.

  Varför? Det egna VM-betyget (assets/playerstats.js) räknas ur ESPN:s
  gratisdata, som SAKNAR defensiva aktioner (tacklingar, brytningar, passningar,
  dueller) per spelare. Därför får en bollstädande mittback/sexa som inte gör
  mål ett tunt betyg. FotMobs betyg bygger på Opta-liknande händelsedata och
  fångar även försvarsspel – det visas i statistiken bredvid det egna betyget.
  xG-datan (samma Opta-underlag) driver xG-form i matchmodalens "Fakta & odds"
  och effektivitetsmåtten (mål − xG) i statistikens spelar-/lagtabeller.

  Källa: https://www.fotmob.com/api/data/matches?date=YYYYMMDD ger dagens
  matcher grupperade per liga; VM 2026 känns igen på parentLeagueId === 77.
  https://www.fotmob.com/api/data/matchDetails?matchId=<id> ger laguppställning
  med content.lineup.{homeTeam,awayTeam}.{starters,subs}[].performance.rating,
  lag-xG i content.stats (key "expected_goals"/"expected_goals_on_target") och
  skott-för-skott-xG i content.shotmap.shots (expectedGoals per skott, med
  playerName/teamId). Spelar-xG = summan av spelarens skott-xG i matchen
  (straffläggning efter förlängning och självmål räknas inte; straffar under
  matchen ingår, precis som i lag-xG:t).

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
  sedan (betygen är slutgiltiga), så bara nytillkomna matcher hämtas. Matcher
  sparade före xG-stödet (utan xg-fält) hämtas om en gång så xG:t backfillas.
  Ändras ingenting skrivs filen inte om, så workflowen committar bara vid
  faktisk förändring.

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

/** FotMob-sida (homeTeam/awayTeam) → [{ name, norm, val: betyg }] för spelade. */
function fmSideRatings(team) {
  const list = [];
  if (!team) return list;
  for (const p of [...(team.starters || []), ...(team.subs || [])]) {
    const r = p && p.performance && p.performance.rating;
    if (r == null) continue; // spelare utan speltid saknar betyg
    const rating = Math.round(Number(r) * 10) / 10;
    if (!Number.isFinite(rating)) continue;
    const nn = norm(p.name);
    if (nn) list.push({ name: p.name, norm: nn, val: rating });
  }
  return list;
}

/**
 * Koppla FotMob-värden (fmList: [{ norm, val }]) till ESPN-namnen (espnNorms)
 * greedy: exakt → sorterad token-mängd → token-subset. Returnerar
 * { espnNorm: val }. Claimade FotMob-poster tas bort mellan stegen så en post
 * bara används en gång. Används för både betyg (val = tal) och xG (val = objekt).
 */
function joinToEspn(espnNorms, fmList) {
  const out = {};
  const pool = fmList.map((e) => ({ ...e, sort: sortKey(e.norm), toks: tokSet(e.norm), used: false }));
  const targets = espnNorms.map((n) => ({ norm: n, sort: sortKey(n), toks: tokSet(n) }));

  const claim = (t, matcher) => {
    for (const e of pool) {
      if (e.used) continue;
      if (matcher(t, e)) {
        out[t.norm] = e.val;
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
      out[t.norm] = cand[0].val;
      cand[0].used = true;
    }
  }
  return out;
}

/* ---------- xG ur FotMob-datan ---------- */

const r2dec = (v) => Math.round(v * 100) / 100;

/** Lagstatistik { h, a } (FotMobs hemma/borta-ordning) för given stat-key. */
function fmTeamStat(detail, key) {
  const all = detail.content && detail.content.stats && detail.content.stats.Periods
    && detail.content.stats.Periods.All;
  for (const grp of (all && all.stats) || []) {
    for (const s of grp.stats || []) {
      if (s.key !== key || !Array.isArray(s.stats)) continue;
      const h = Number(s.stats[0]);
      const a = Number(s.stats[1]);
      if (Number.isFinite(h) && Number.isFinite(a)) return { h, a };
    }
  }
  return null;
}

/**
 * Spelar-xG ur shotmap, per FotMob-sida (h = FotMobs hemmalag). Straffläggning
 * efter förlängning (period "PenaltyShootout") och självmål räknas inte;
 * straffar under matchen ingår (som i lag-xG:t). Returnerar även lagsummor
 * som reserv om lagstatistiken saknas.
 */
function fmShotXg(detail, fmHomeId) {
  const shots = detail.content && detail.content.shotmap && detail.content.shotmap.shots;
  const players = { h: new Map(), a: new Map() };
  const totals = { h: { xg: 0, xgot: 0 }, a: { xg: 0, xgot: 0 } };
  let any = false;
  for (const s of Array.isArray(shots) ? shots : []) {
    if (!s || s.period === "PenaltyShootout" || s.isOwnGoal) continue;
    const side = s.teamId === fmHomeId ? "h" : "a";
    const xg = Number(s.expectedGoals) || 0;
    const xgot = Number(s.expectedGoalsOnTarget) || 0;
    totals[side].xg += xg;
    totals[side].xgot += xgot;
    any = true;
    const name = s.fullName || s.playerName;
    const nn = norm(name);
    if (!nn) continue;
    const cur = players[side].get(nn) || { name, norm: nn, xg: 0, xgot: 0, shots: 0, goals: 0 };
    cur.xg += xg;
    cur.xgot += xgot;
    cur.shots += 1;
    if (s.eventType === "Goal") cur.goals += 1;
    players[side].set(nn, cur);
  }
  const toList = (m) => [...m.values()].map((p) => ({
    name: p.name, norm: p.norm,
    val: { xg: r2dec(p.xg), xgot: r2dec(p.xgot), shots: p.shots, goals: p.goals },
  }));
  return {
    any,
    players: { h: toList(players.h), a: toList(players.a) },
    totals: { h: { xg: r2dec(totals.h.xg), xgot: r2dec(totals.h.xgot) },
              a: { xg: r2dec(totals.a.xg), xgot: r2dec(totals.a.xgot) } },
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

    // Redan betygsatt → behåll (färdiga matchers betyg ändras inte). Poster
    // sparade före xG-stödet (xg-fältet saknas helt) hämtas om en gång så
    // xG:t backfillas; xg: null betyder "kollat, FotMob har inget".
    if (prevMatches[key] && prevMatches[key].players && prevMatches[key].xg !== undefined) {
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
      const h = espnH.length ? joinToEspn(espnH, fmH) : Object.fromEntries(fmH.map((e) => [e.norm, e.val]));
      const a = espnA.length ? joinToEspn(espnA, fmA) : Object.fromEntries(fmA.map((e) => [e.norm, e.val]));
      const nJoined = Object.keys(h).length + Object.keys(a).length;
      if (!nJoined) {
        console.log(`[fotmob] ${key} ${label}: inga betyg satta ännu.`);
        continue;
      }
      const nFm = fmH.length + fmA.length;
      const miss = espnH.length ? nFm - nJoined : 0;
      joined += nJoined;
      unmatched += Math.max(0, miss);

      /* xG: lagsiffror ur matchstatistiken (Opta), spelarsiffror ur shotmap.
         FotMobs hemma/borta reorienteras till appens fasta ordning som ovan. */
      const fmHomeId =
        (detail.header && detail.header.teams && detail.header.teams[0] && detail.header.teams[0].id) ??
        (game.home && game.home.id);
      const swap = (o) => (homeIsHome ? o : { h: o.a, a: o.h });
      const statXg = fmTeamStat(detail, "expected_goals");
      const statXgot = fmTeamStat(detail, "expected_goals_on_target");
      const shot = fmShotXg(detail, fmHomeId);
      const shotOur = { players: swap(shot.players), totals: swap(shot.totals) };
      // Lagstatistiken är facit; skottsummorna är reserv om den saknas.
      const xg = statXg ? swap(statXg)
        : shot.any ? { h: shotOur.totals.h.xg, a: shotOur.totals.a.xg } : null;
      const xgot = statXgot ? swap(statXgot)
        : shot.any ? { h: shotOur.totals.h.xgot, a: shotOur.totals.a.xgot } : null;
      const pxH = espnH.length ? joinToEspn(espnH, shotOur.players.h)
        : Object.fromEntries(shotOur.players.h.map((e) => [e.norm, e.val]));
      const pxA = espnA.length ? joinToEspn(espnA, shotOur.players.a)
        : Object.fromEntries(shotOur.players.a.map((e) => [e.norm, e.val]));
      const playerXg = shot.any ? { h: pxH, a: pxA } : null;

      out[key] = {
        fotmobId: game.id,
        teamRating: {
          h: ourHome.rating != null ? Number(ourHome.rating) : null,
          a: ourAway.rating != null ? Number(ourAway.rating) : null,
        },
        xg,
        xgot,
        players: { h, a },
        playerXg,
        updatedAt: new Date().toISOString(),
      };
      fetched++;
      console.log(
        `[fotmob] ${key} ${label}: ${nJoined} kopplade betyg (FotMob #${game.id}` +
          `${miss > 0 ? `, ${miss} omatchade` : ""}` +
          `${xg ? `, xG ${xg.h.toFixed(2)}–${xg.a.toFixed(2)}` : ", xG saknas"}).`
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
