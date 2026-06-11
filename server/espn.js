/*
  Klient mot ESPN:s öppna API (samma data som espn.com/football visar).
  Ingen API-nyckel behövs. Ersätter football-data.org som källa för
  resultat, livematcher, matchhändelser och statistik.

  Endpoints:
    scoreboard – alla VM-matcher med status/resultat
    summary    – detaljer för en match (händelser, statistik, domare …)
    standings  – officiella grupptabeller
*/

const SITE = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world";
const CORE = "https://site.api.espn.com/apis/v2/sports/soccer/fifa.world";

// Hela turneringen (med marginal) – ESPN stödjer datumintervall.
const DATE_RANGE = "20260610-20260721";

let callCount = 0;
export function getCallCount() {
  return callCount;
}

export class EspnError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "EspnError";
    this.status = status;
  }
}

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "application/json",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url, retries = 3) {
  let lastErr = null;
  for (let attempt = 0; attempt < retries; attempt++) {
    callCount++;
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (res.ok) return res.json();
      const body = await res.text().catch(() => "");
      lastErr = new EspnError(`ESPN ${res.status}: ${body.slice(0, 150)} (${url})`, res.status);
      // 429/5xx → vänta och försök igen, annars ge upp direkt.
      if (res.status !== 429 && res.status < 500) throw lastErr;
    } catch (e) {
      if (e instanceof EspnError && e.status !== 429 && e.status < 500) throw e;
      lastErr = e;
    }
    await sleep(1500 * (attempt + 1));
  }
  throw lastErr || new EspnError("ESPN: okänt fel", 0);
}

/** Alla VM-matcher (104 st) med status, resultat och avsparkstider. */
export async function getScoreboard() {
  const data = await getJson(`${SITE}/scoreboard?dates=${DATE_RANGE}&limit=400`);
  return data.events || [];
}

/** Detaljer för en match: händelser (mål/kort/byten), statistik, domare m.m. */
export function getSummary(eventId) {
  return getJson(`${SITE}/summary?event=${eventId}`);
}

/** Officiella grupptabeller. */
export function getStandings(season = 2026) {
  return getJson(`${CORE}/standings?season=${season}`);
}
