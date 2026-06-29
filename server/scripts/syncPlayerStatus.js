import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT, config } from "../config.js";
import { getInjuries, getCallCount } from "../apiFootball.js";

/*
  Hämtar spelartillgänglighet (skador, avstängningar, osäkra) från API-Football
  (/injuries för VM-ligan + säsongen) och skriver data/wc2026_player_status.json
  som frontend (GitHub Pages) läser direkt via window.VMPlayers.

  - Kräver API_FOOTBALL_KEY. Utan nyckel (offline-läge) görs INGET API-anrop och
    den befintliga statusfilen lämnas orörd, så workflowen aldrig kraschar.
  - Spelare matchas mot data/wc2026_players.json via diakritik-tolerant
    namnjämförelse inom rätt landslag, så att samma spelar-id återanvänds.
  - Filen kan även redigeras för hand; detta skript skriver bara om hela
    statuses-objektet när nyckel finns.

  Körs av .github/workflows/sync-player-status.yml.
*/

const PLAYERS_FILE = path.join(ROOT, "data", "wc2026_players.json");
const OUT_FILE = path.join(ROOT, "data", "wc2026_player_status.json");

/* Normalisera namn: gemener, ta bort diakritik och skiljetecken. */
function norm(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* API-Footballs landsnamn som skiljer sig från Wikipedia-rubrikerna. */
const TEAM_ALIASES = {
  "korea republic": "KOR", "republic of korea": "KOR",
  "ir iran": "IRN", "iran islamic republic": "IRN",
  usa: "USA", "united states of america": "USA",
  "cote d ivoire": "CIV", "cote divoire": "CIV",
  czechia: "CZE", turkiye: "TUR",
  "congo dr": "COD", "dr congo": "COD",
  "democratic republic of the congo": "COD",
  "cabo verde": "CPV",
  "bosnia and herzegovina": "BIH", "bosnia herzegovina": "BIH",
};

/* Bygg uppslag: lagnamn -> fifa_code, och per lag namn -> spelar-id. */
function buildIndex(playersData) {
  const teamCode = {}; // normaliserat lagnamn -> fifa_code
  const squads = {};   // fifa_code -> { byFull, byLast }

  for (const team of playersData.teams || []) {
    const code = team.fifa_code;
    if (team.name) teamCode[norm(team.name)] = code;
    if (team.name_sv) teamCode[norm(team.name_sv)] = code;

    const byFull = {};
    const byLast = {};
    for (const p of team.players || []) {
      const n = norm(p.name);
      byFull[n] = p.id;
      const parts = n.split(" ");
      const last = parts[parts.length - 1];
      (byLast[last] = byLast[last] || []).push({ id: p.id, n });
    }
    squads[code] = { byFull, byLast };
  }
  for (const [alias, code] of Object.entries(TEAM_ALIASES)) {
    if (!teamCode[alias]) teamCode[alias] = code;
  }
  return { teamCode, squads };
}

/* Matcha ett API-namn mot truppen (fullt namn, annars efternamn + initial). */
function matchPlayerId(squad, apiName) {
  if (!squad) return null;
  const n = norm(apiName);
  if (squad.byFull[n]) return squad.byFull[n];
  const parts = n.split(" ");
  const last = parts[parts.length - 1];
  const cands = squad.byLast[last] || [];
  if (cands.length === 1) return cands[0].id;
  if (cands.length > 1 && parts.length > 1) {
    const ini = parts[0].charAt(0);
    const hit = cands.filter((c) => c.n.charAt(0) === ini);
    if (hit.length === 1) return hit[0].id;
  }
  return null;
}

/* API-orsak -> intern kind. */
function kindFromReason(reason) {
  const r = String(reason || "").toLowerCase();
  if (/suspend|red card|yellow card|booking/.test(r)) return "suspension";
  if (/ill|sick|virus|flu|covid|fever|infection/.test(r)) return "illness";
  return "injury";
}

/* Behåll den allvarligaste/färskaste statusen per spelare. */
function isBetter(next, prev) {
  if (!prev) return true;
  const rank = (s) => (s.availability === "out" ? 1 : 0);
  if (rank(next) !== rank(prev)) return rank(next) > rank(prev);
  return String(next.updated || "") >= String(prev.updated || "");
}

export async function syncPlayerStatus({ log = console.log } = {}) {
  if (!fs.existsSync(PLAYERS_FILE)) {
    throw new Error(`Saknar ${path.relative(ROOT, PLAYERS_FILE)} – kör truppsynken först.`);
  }
  const playersData = JSON.parse(fs.readFileSync(PLAYERS_FILE, "utf8"));

  if (config.apiFootballOffline) {
    log("[status] Ingen API_FOOTBALL_KEY – hoppar över synk, behåller befintlig fil.");
    return { skipped: true };
  }

  const { teamCode, squads } = buildIndex(playersData);

  log("[status] Hämtar skador/avstängningar från API-Football …");
  const injuries = await getInjuries();

  const statuses = {};
  let matched = 0;
  const unmatchedTeams = new Set();
  let unmatchedPlayers = 0;

  for (const row of injuries) {
    const teamName = row && row.team && row.team.name;
    const playerName = row && row.player && row.player.name;
    if (!teamName || !playerName) continue;

    const code = teamCode[norm(teamName)];
    if (!code) { unmatchedTeams.add(teamName); continue; }

    const pid = matchPlayerId(squads[code], playerName);
    if (!pid) { unmatchedPlayers++; continue; }

    const availability =
      String(row.type || "").toLowerCase() === "questionable" ? "doubtful" : "out";
    const entry = {
      availability,
      kind: kindFromReason(row.reason),
      reason: row.reason || null,
      updated: (row.fixture && row.fixture.date ? String(row.fixture.date) : "").slice(0, 10) || null,
    };
    if (isBetter(entry, statuses[pid])) {
      statuses[pid] = entry;
      matched++;
    }
  }

  const out = {
    tournament: "FIFA World Cup 2026",
    source: "API-Football (injuries)",
    updated: new Date().toISOString().slice(0, 10),
    note:
      "Spelartillgänglighet per spelar-id (samma id som data/wc2026_players.json). " +
      "availability: 'out' (missar matchen) eller 'doubtful' (osäker). " +
      "kind: 'injury' | 'suspension' | 'illness' | 'other'. " +
      "Genereras av server/scripts/syncPlayerStatus.js men kan redigeras för hand.",
    statuses,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2) + "\n", "utf8");

  log(
    `[status] Klart: ${Object.keys(statuses).length} spelare med status ` +
      `(${matched} träffar, ${unmatchedPlayers} spelare utan match, ` +
      `${unmatchedTeams.size} okända lag, ${getCallCount()} API-anrop) → ` +
      `${path.relative(ROOT, OUT_FILE)}`
  );
  if (unmatchedTeams.size) log("[status] Okända lag: " + [...unmatchedTeams].join(", "));
  return { count: Object.keys(statuses).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncPlayerStatus().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
