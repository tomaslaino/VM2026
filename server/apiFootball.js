import { config, apiBaseAndHeaders } from "./config.js";

/*
  Tunn klient mot API-Football (api-sports.io v3).
  All kommunikation med det externa API:t går genom den här filen så att
  resten av servern aldrig pratar direkt med leverantören.

  Vi räknar och loggar antal anrop så att du kan hålla koll på din kvot.
*/

let callCount = 0;
export function getCallCount() {
  return callCount;
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

/**
 * Lågnivå-GET mot API-Football. Returnerar fältet `response` (en array).
 * @param {string} endpoint t.ex. "/teams"
 * @param {Record<string,string|number>} params querystring-parametrar
 */
export async function apiGet(endpoint, params = {}) {
  if (config.offline) {
    throw new ApiError("OFFLINE_MODE är på (ingen API-nyckel). Hoppar över anrop.", 0);
  }

  const { base, headers } = apiBaseAndHeaders();
  const url = new URL(base + endpoint);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }

  callCount++;
  const res = await fetch(url, { headers });

  if (!res.ok) {
    throw new ApiError(`API ${endpoint} svarade ${res.status}`, res.status);
  }

  const json = await res.json();

  // API-Football lägger fel i `errors` även vid HTTP 200.
  if (json.errors && Object.keys(json.errors).length > 0) {
    const msg = Object.values(json.errors).join("; ");
    throw new ApiError(`API ${endpoint}: ${msg}`, 200);
  }

  return Array.isArray(json.response) ? json.response : [];
}

/* ---------- Konkreta endpoints ---------- */

/** Alla lag i en liga/säsong. */
export function getTeams() {
  return apiGet("/teams", { league: config.leagueId, season: config.season });
}

/** Trupp (spelarlista) för ett lag. */
export function getSquad(teamId) {
  return apiGet("/players/squads", { team: teamId });
}

/** Alla fixtures i turneringen (schema). */
export function getFixtures() {
  return apiGet("/fixtures", { league: config.leagueId, season: config.season });
}

/** Alla matcher som pågår just nu (ett enda anrop för hela VM). */
export function getLiveFixtures() {
  return apiGet("/fixtures", { live: "all" });
}

/** En specifik fixture (för slutkontroll). */
export function getFixtureById(fixtureId) {
  return apiGet("/fixtures", { id: fixtureId });
}

/** Händelser (mål, kort, byten) för en fixture. */
export function getFixtureEvents(fixtureId) {
  return apiGet("/fixtures/events", { fixture: fixtureId });
}

/** Spelarstatistik per spelare för en specifik fixture (matchrapport). */
export function getFixturePlayers(fixtureId) {
  return apiGet("/fixtures/players", { fixture: fixtureId });
}

/** Skador/avstängningar (injuries) för hela turneringen (liga + säsong). */
export function getInjuries() {
  return apiGet("/injuries", { league: config.leagueId, season: config.season });
}
