import fs from "node:fs";
import { DATA_DIR, STORE_FILE } from "./config.js";

/*
  Lokalt datalager (JSON-fil). Håller all turneringsdata som hämtats från
  API:t så att frontend kan läsa obegränsat utan att förbruka API-kvot.

  Statistik räknas alltid om från grunden utifrån per-match-bidrag
  (matchPlayerStats). Det gör slutkontrollen idempotent: om samma match
  hämtas/finalizeras flera gånger blir totalsiffrorna ändå korrekta.
*/

const EMPTY = () => ({
  meta: { updatedAt: null, squadsUpdatedAt: null, league: null, season: null },
  teams: {}, // apiTeamId -> { id, name, code, logo, group, players: [...] }
  teamByName: {}, // normaliserat namn -> apiTeamId
  fixtures: {}, // fixtureId -> fixture
  live: { fixtures: [], updatedAt: null }, // senaste live-snapshot
  matchPlayerStats: {}, // fixtureId -> { playerId -> {goals,assists,yellow,red,minutes} }
  finalizedFixtures: [], // lista över fixtureId som slutkontrollerats
});

let data = EMPTY();
let saveTimer = null;

export function load() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(STORE_FILE, "utf8")) };
    }
  } catch (e) {
    console.error("[store] Kunde inte läsa store.json, börjar tomt:", e.message);
    data = EMPTY();
  }
  return data;
}

export function getData() {
  return data;
}

export function save() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  data.meta.updatedAt = new Date().toISOString();
  fs.writeFileSync(STORE_FILE, JSON.stringify(data, null, 2));
}

/** Skjuter upp skrivning något så att många snabba uppdateringar slås ihop. */
export function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}

/* ---------- Hjälpare ---------- */

export function normName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // ta bort diakritiska tecken
    .replace(/[^a-z0-9]/g, "");
}

const emptyContribution = () => ({ goals: 0, assists: 0, yellow: 0, red: 0, minutes: 0 });

/* ---------- Lag & trupper ---------- */

export function upsertTeam(team) {
  const id = String(team.id);
  const existing = data.teams[id] || { players: [] };
  data.teams[id] = { ...existing, ...team, id, players: existing.players || [] };
  if (team.name) data.teamByName[normName(team.name)] = id;
  return data.teams[id];
}

export function setSquad(teamId, players) {
  const id = String(teamId);
  if (!data.teams[id]) data.teams[id] = { id, name: null, players: [] };
  data.teams[id].players = players.map((p) => ({
    id: p.id,
    name: p.name,
    number: p.number ?? null,
    position: p.position ?? null,
    photo: p.photo ?? null,
    age: p.age ?? null,
    stats: { goals: 0, assists: 0, yellow: 0, red: 0, minutes: 0, appearances: 0 },
  }));
  data.meta.squadsUpdatedAt = new Date().toISOString();
}

/** Slå upp ett apiTeamId från ett lagnamn (engelskt namn från data.js). */
export function teamIdByName(name) {
  return data.teamByName[normName(name)] || null;
}

function findPlayer(playerId) {
  const pid = String(playerId);
  for (const team of Object.values(data.teams)) {
    const p = (team.players || []).find((x) => String(x.id) === pid);
    if (p) return p;
  }
  return null;
}

/* ---------- Statistik ---------- */

/**
 * Lagrar en spelares statistikbidrag från EN specifik match.
 * Skriver över ev. tidigare bidrag från samma match (idempotent).
 */
export function setMatchPlayerStats(fixtureId, perPlayer) {
  data.matchPlayerStats[String(fixtureId)] = perPlayer;
}

export function markFinalized(fixtureId) {
  const id = String(fixtureId);
  if (!data.finalizedFixtures.includes(id)) data.finalizedFixtures.push(id);
}

export function isFinalized(fixtureId) {
  return data.finalizedFixtures.includes(String(fixtureId));
}

/**
 * Räknar om varje spelares totalstatistik som summan av alla matchbidrag.
 * Körs efter varje slutkontroll. Helt deterministiskt.
 */
export function recomputeTotals() {
  for (const team of Object.values(data.teams)) {
    for (const p of team.players || []) {
      p.stats = { goals: 0, assists: 0, yellow: 0, red: 0, minutes: 0, appearances: 0 };
    }
  }
  for (const perPlayer of Object.values(data.matchPlayerStats)) {
    for (const [playerId, c] of Object.entries(perPlayer)) {
      const p = findPlayer(playerId);
      if (!p) continue;
      p.stats.goals += c.goals || 0;
      p.stats.assists += c.assists || 0;
      p.stats.yellow += c.yellow || 0;
      p.stats.red += c.red || 0;
      p.stats.minutes += c.minutes || 0;
      if ((c.minutes || 0) > 0) p.stats.appearances += 1;
    }
  }
}

export { emptyContribution };
