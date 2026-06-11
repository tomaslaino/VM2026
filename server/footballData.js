import { config } from "./config.js";

/*
  Klient mot football-data.org v4.
  https://www.football-data.org/documentation/quickstart
*/

let callCount = 0;
export function getCallCount() {
  return callCount;
}

export class FdError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "FdError";
    this.status = status;
  }
}

const BASE = "https://api.football-data.org/v4";

export async function fdGet(path, params = {}) {
  if (config.fdOffline) {
    throw new FdError("FOOTBALL_DATA_TOKEN saknas – offline-läge.", 0);
  }

  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  callCount++;
  const res = await fetch(url, { headers: { "X-Auth-Token": config.footballDataToken } });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new FdError(`football-data ${path} → ${res.status} ${body.slice(0, 200)}`, res.status);
  }

  return res.json();
}

export function getCompetition() {
  return fdGet(`/competitions/${config.fdCompetition}`);
}

export function getMatches(season = config.fdSeason) {
  return fdGet(`/competitions/${config.fdCompetition}/matches`, { season });
}

export function getStandings(season = config.fdSeason) {
  return fdGet(`/competitions/${config.fdCompetition}/standings`, { season });
}

export function getLiveMatches() {
  // Status-filter enligt football-data v4
  return fdGet("/matches", { competitions: config.fdCompetition, status: "LIVE" });
}

/** Detaljer för en enskild match (mål, kort, byten, domare m.m.). */
export function getMatch(id) {
  return fdGet(`/matches/${id}`);
}
