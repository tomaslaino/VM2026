/*
  Server-sidans spegling av WC.groups, gruppspelets schema och slutspel
  från assets/data.js – används för att mappa football-data-matcher till
  appens resultatnycklar (g:A:0, k:73, …).
*/
import { NAME_ALIASES, WC_GROUPS } from "./wcTeams.js";

export { WC_GROUPS, NAME_ALIASES };

const RR = [
  [[0, 1], [2, 3]],
  [[0, 2], [3, 1]],
  [[3, 0], [1, 2]],
];

export const GROUP_DATES = {
  A: ["2026-06-11", "2026-06-18", "2026-06-24"],
  B: ["2026-06-11", "2026-06-18", "2026-06-24"],
  C: ["2026-06-12", "2026-06-19", "2026-06-24"],
  D: ["2026-06-12", "2026-06-19", "2026-06-25"],
  E: ["2026-06-13", "2026-06-20", "2026-06-25"],
  F: ["2026-06-13", "2026-06-20", "2026-06-25"],
  G: ["2026-06-14", "2026-06-21", "2026-06-26"],
  H: ["2026-06-14", "2026-06-21", "2026-06-26"],
  I: ["2026-06-15", "2026-06-22", "2026-06-26"],
  J: ["2026-06-15", "2026-06-22", "2026-06-27"],
  K: ["2026-06-16", "2026-06-23", "2026-06-27"],
  L: ["2026-06-16", "2026-06-23", "2026-06-27"],
};

/*
  Slutspel – matchnummer, runda, datum + officiell avspark (UTC).
  `utc` är avsparkstiden enligt FIFA:s officiella schema (samma som data.js,
  fast i UTC). Den används för att para API-matcher mot rätt matchnummer –
  slutspelets matchnummer följer bracket-positionen, INTE kronologisk ordning,
  så en ren tidssortering räcker inte.
*/
export const KNOCKOUT = [
  { m: 73, round: "R32", date: "2026-06-28", stage: "LAST_32", utc: "2026-06-28T19:00:00Z" },
  { m: 74, round: "R32", date: "2026-06-29", stage: "LAST_32", utc: "2026-06-29T20:30:00Z" },
  { m: 75, round: "R32", date: "2026-06-30", stage: "LAST_32", utc: "2026-06-30T01:00:00Z" },
  { m: 76, round: "R32", date: "2026-06-29", stage: "LAST_32", utc: "2026-06-29T17:00:00Z" },
  { m: 77, round: "R32", date: "2026-06-30", stage: "LAST_32", utc: "2026-06-30T21:00:00Z" },
  { m: 78, round: "R32", date: "2026-06-30", stage: "LAST_32", utc: "2026-06-30T17:00:00Z" },
  { m: 79, round: "R32", date: "2026-07-01", stage: "LAST_32", utc: "2026-07-01T01:00:00Z" },
  { m: 80, round: "R32", date: "2026-07-01", stage: "LAST_32", utc: "2026-07-01T16:00:00Z" },
  { m: 81, round: "R32", date: "2026-07-02", stage: "LAST_32", utc: "2026-07-02T00:00:00Z" },
  { m: 82, round: "R32", date: "2026-07-01", stage: "LAST_32", utc: "2026-07-01T20:00:00Z" },
  { m: 83, round: "R32", date: "2026-07-03", stage: "LAST_32", utc: "2026-07-02T23:00:00Z" },
  { m: 84, round: "R32", date: "2026-07-02", stage: "LAST_32", utc: "2026-07-02T19:00:00Z" },
  { m: 85, round: "R32", date: "2026-07-03", stage: "LAST_32", utc: "2026-07-03T03:00:00Z" },
  { m: 86, round: "R32", date: "2026-07-04", stage: "LAST_32", utc: "2026-07-03T22:00:00Z" },
  { m: 87, round: "R32", date: "2026-07-04", stage: "LAST_32", utc: "2026-07-04T01:30:00Z" },
  { m: 88, round: "R32", date: "2026-07-03", stage: "LAST_32", utc: "2026-07-03T18:00:00Z" },
  { m: 89, round: "R16", date: "2026-07-04", stage: "LAST_16", utc: "2026-07-04T21:00:00Z" },
  { m: 90, round: "R16", date: "2026-07-04", stage: "LAST_16", utc: "2026-07-04T17:00:00Z" },
  { m: 91, round: "R16", date: "2026-07-05", stage: "LAST_16", utc: "2026-07-05T20:00:00Z" },
  { m: 92, round: "R16", date: "2026-07-06", stage: "LAST_16", utc: "2026-07-06T00:00:00Z" },
  { m: 93, round: "R16", date: "2026-07-06", stage: "LAST_16", utc: "2026-07-06T19:00:00Z" },
  { m: 94, round: "R16", date: "2026-07-07", stage: "LAST_16", utc: "2026-07-07T00:00:00Z" },
  { m: 95, round: "R16", date: "2026-07-07", stage: "LAST_16", utc: "2026-07-07T16:00:00Z" },
  { m: 96, round: "R16", date: "2026-07-07", stage: "LAST_16", utc: "2026-07-07T20:00:00Z" },
  { m: 97, round: "QF", date: "2026-07-09", stage: "QUARTER_FINALS", utc: "2026-07-09T20:00:00Z" },
  { m: 98, round: "QF", date: "2026-07-10", stage: "QUARTER_FINALS", utc: "2026-07-10T19:00:00Z" },
  { m: 99, round: "QF", date: "2026-07-11", stage: "QUARTER_FINALS", utc: "2026-07-11T21:00:00Z" },
  { m: 100, round: "QF", date: "2026-07-12", stage: "QUARTER_FINALS", utc: "2026-07-12T01:00:00Z" },
  { m: 101, round: "SF", date: "2026-07-14", stage: "SEMI_FINALS", utc: "2026-07-14T19:00:00Z" },
  { m: 102, round: "SF", date: "2026-07-15", stage: "SEMI_FINALS", utc: "2026-07-15T19:00:00Z" },
  { m: 103, round: "3RD", date: "2026-07-18", stage: "THIRD_PLACE", utc: "2026-07-18T21:00:00Z" },
  { m: 104, round: "FINAL", date: "2026-07-19", stage: "FINAL", utc: "2026-07-19T19:00:00Z" },
];

const STAGE_TO_ROUND = Object.fromEntries(KNOCKOUT.map((k) => [k.stage, k.round]));

export function normName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export function canonicalTeam(name) {
  const key = String(name || "").toLowerCase().trim();
  return NAME_ALIASES[key] || name;
}

/** groupLetter -> [{ key, h, a, homeName, awayName }] */
export function groupFixtureIndex() {
  const index = {};
  for (const [letter, teams] of Object.entries(WC_GROUPS)) {
    const list = [];
    let idx = 0;
    for (let md = 0; md < RR.length; md++) {
      for (const pair of RR[md]) {
        list.push({
          key: `g:${letter}:${idx}`,
          h: pair[0],
          a: pair[1],
          homeName: teams[pair[0]],
          awayName: teams[pair[1]],
        });
        idx++;
      }
    }
    index[letter] = list;
  }
  return index;
}

/*
  Bygg lookup: "homeCanon|awayCanon" -> { key, reversed } för gruppmatcher.

  Appens nycklar (g:A:0 …) har en FAST hemma/borta-ordning (round-robin i
  data.js). API:ets verkliga spelordning kan vara den omvända – då måste
  resultat, händelser och statistik speglas innan de sparas på nyckeln.
  `reversed: true` betyder att API:ets hemmalag är appens bortalag.
*/
export function groupPairLookup() {
  const map = new Map();
  const index = groupFixtureIndex();
  for (const fixtures of Object.values(index)) {
    for (const fx of fixtures) {
      const h = canonicalTeam(fx.homeName);
      const a = canonicalTeam(fx.awayName);
      map.set(`${h}|${a}`, { key: fx.key, reversed: false });
      map.set(`${a}|${h}`, { key: fx.key, reversed: true });
    }
  }
  return map;
}

/** Bygg lookup: "homeCanon|awayCanon" -> resultKey för gruppmatcher. */
export function groupPairToKey() {
  const map = new Map();
  for (const [pair, hit] of groupPairLookup()) map.set(pair, hit.key);
  return map;
}

/** Parning av knockout-matcher per fas + datum (kronologisk ordning). */
export function buildKoDateMap() {
  const byStage = {};
  for (const k of KNOCKOUT) {
    if (!byStage[k.stage]) byStage[k.stage] = [];
    byStage[k.stage].push(k.m);
  }
  return byStage;
}

export function parseGroupLetter(apiGroup) {
  if (!apiGroup) return null;
  const m = String(apiGroup).match(/GROUP_([A-L])/i);
  return m ? m[1].toUpperCase() : null;
}

export function extractResult(match) {
  const ft = match.score?.fullTime;
  if (ft?.home == null || ft?.away == null) return null;

  const r = { h: ft.home, a: ft.away, status: match.status };
  const winner = match.score?.winner;

  // Oavgjort efter full tid – vinnare via straffar
  if (ft.home === ft.away && winner === "HOME_TEAM") r.pw = "h";
  if (ft.home === ft.away && winner === "AWAY_TEAM") r.pw = "a";

  return r;
}

export function isLiveStatus(status) {
  return status === "IN_PLAY" || status === "PAUSED" || status === "LIVE";
}

export { STAGE_TO_ROUND };
