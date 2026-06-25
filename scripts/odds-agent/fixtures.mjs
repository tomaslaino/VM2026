import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RESULTS = path.join(ROOT, "data", "results.json");
const TEAMS = path.join(ROOT, "scripts", "prob", "teams.json");

const FINISHED = new Set(["FINISHED", "FULL_TIME", "FT"]);

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
      key,
      group: homeRef.group || key.split(":")[1],
      home: homeTeam.name,
      away: awayTeam.name,
      home_idx: homeRef.idx,
      away_idx: awayRef.idx,
      date: fx.date,
      utcDate: fx.utcDate,
    });
  }

  out.sort((a, b) => {
    const da = a.utcDate || a.date || "";
    const db = b.utcDate || b.date || "";
    return da.localeCompare(db) || a.group.localeCompare(b.group);
  });
  return out;
}
