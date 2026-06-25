import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RESULTS = path.join(ROOT, "data", "results.json");
const TEAMS = path.join(ROOT, "scripts", "prob", "teams.json");

const FINISHED = new Set(["FINISHED", "FULL_TIME", "FT"]);
const PLACEHOLDER = /group|third place|winner|loser|\bplace\b/i;

/** @param {string} name */
export function isKnownTeam(name) {
  return !!name && !PLACEHOLDER.test(name);
}

/** @returns {Map<string, {name:string, group:string, idx:number}>} */
function teamIndex() {
  const data = JSON.parse(fs.readFileSync(TEAMS, "utf8"));
  const map = new Map();
  for (const t of data.teams) {
    map.set(`${t.group}:${t.idx}`, { name: t.name, group: t.group, idx: t.idx });
  }
  return map;
}

function isFinished(key, results, fixture) {
  const r = results[key];
  const st = (r && r.status) || fixture.status || "";
  return FINISHED.has(String(st).toUpperCase());
}

function fixtureBase(key, fx, home, away, phase) {
  return {
    key,
    phase,
    home: home.name || home,
    away: away.name || away,
    date: fx.date,
    utcDate: fx.utcDate,
    slot: fx.utcDate || `${fx.date || ""}T${fx.time || "00:00"}`,
  };
}

/**
 * Ospelade gruppmatcher som behöver correct-score-odds.
 * @returns {Array<object>}
 */
export function loadOpenGroupFixtures() {
  const data = JSON.parse(fs.readFileSync(RESULTS, "utf8"));
  const teams = teamIndex();
  const out = [];

  for (const [key, fx] of Object.entries(data.fixtures || {})) {
    if (!key.startsWith("g:")) continue;
    if (isFinished(key, data.results || {}, fx)) continue;

    const homeRef = fx.homeRef || {};
    const awayRef = fx.awayRef || {};
    const homeTeam = teams.get(`${homeRef.group}:${homeRef.idx}`);
    const awayTeam = teams.get(`${awayRef.group}:${awayRef.idx}`);
    if (!homeTeam || !awayTeam) continue;

    out.push({
      ...fixtureBase(key, fx, homeTeam, awayTeam, "group"),
      group: homeRef.group || key.split(":")[1],
      home_idx: homeRef.idx,
      away_idx: awayRef.idx,
    });
  }

  out.sort((a, b) => {
    const da = a.utcDate || a.date || "";
    const db = b.utcDate || b.date || "";
    return da.localeCompare(db) || String(a.group).localeCompare(String(b.group));
  });
  return out;
}

/**
 * Ospelade slutspelsmatcher med båda lag kända (1X2).
 * @returns {Array<object>}
 */
export function loadOpenKnockoutFixtures() {
  const data = JSON.parse(fs.readFileSync(RESULTS, "utf8"));
  const out = [];

  for (const [key, fx] of Object.entries(data.fixtures || {})) {
    if (!key.startsWith("k:")) continue;
    if (isFinished(key, data.results || {}, fx)) continue;
    const home = fx.home || "";
    const away = fx.away || "";
    if (!isKnownTeam(home) || !isKnownTeam(away)) continue;

    out.push({
      ...fixtureBase(key, fx, home, away, "knockout"),
      matchNo: parseInt(key.split(":")[1], 10),
    });
  }

  out.sort((a, b) => (a.utcDate || "").localeCompare(b.utcDate || "") || a.matchNo - b.matchNo);
  return out;
}

/** @returns {Array<object>} */
export function loadAllOpenFixtures() {
  return [...loadOpenGroupFixtures(), ...loadOpenKnockoutFixtures()];
}

/**
 * @param {string[]} keys
 * @returns {Array<object>}
 */
export function loadFixturesByKeys(keys) {
  const want = new Set(keys);
  return loadAllOpenFixtures().filter((f) => want.has(f.key));
}

/**
 * Alla gruppfFixturer (även avslutade) – för tidslots-kontroll.
 */
export function loadAllGroupFixtures() {
  const data = JSON.parse(fs.readFileSync(RESULTS, "utf8"));
  const teams = teamIndex();
  const out = [];

  for (const [key, fx] of Object.entries(data.fixtures || {})) {
    if (!key.startsWith("g:")) continue;
    const homeRef = fx.homeRef || {};
    const awayRef = fx.awayRef || {};
    const homeTeam = teams.get(`${homeRef.group}:${homeRef.idx}`);
    const awayTeam = teams.get(`${awayRef.group}:${awayRef.idx}`);
    if (!homeTeam || !awayTeam) continue;
    out.push({
      ...fixtureBase(key, fx, homeTeam, awayTeam, "group"),
      group: homeRef.group || key.split(":")[1],
      home_idx: homeRef.idx,
      away_idx: awayRef.idx,
    });
  }
  return out;
}

/** Alla slutspelsfixturer (även avslutade). */
export function loadAllKnockoutFixtures() {
  const data = JSON.parse(fs.readFileSync(RESULTS, "utf8"));
  const out = [];
  for (const [key, fx] of Object.entries(data.fixtures || {})) {
    if (!key.startsWith("k:")) continue;
    out.push({
      ...fixtureBase(key, fx, fx.home || "?", fx.away || "?", "knockout"),
      matchNo: parseInt(key.split(":")[1], 10),
    });
  }
  return out;
}
