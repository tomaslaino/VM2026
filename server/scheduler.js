import { config } from "./config.js";
import { syncFootballData } from "./jobs/syncFootballData.js";
import { fetchSquads } from "./jobs/fetchSquads.js";
import { livePollOnce } from "./jobs/livePoll.js";
import { finalize } from "./jobs/finalize.js";
import * as resultsStore from "./resultsStore.js";

/*
  Schemaläggare:
    Primärt: football-data-synk (resultat → grupper/slutspel uppdateras på sidan).
    Sekundärt: API-Football (spelarstatistik) om nyckel finns.
*/

const log = (...a) => console.log(...a);

function msUntilNextHour(hour) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next - now;
}

function scheduleNightlySquads() {
  if (config.apiFootballOffline) return;
  const wait = msUntilNextHour(config.nightlyHour);
  log(`[schema] Nästa trupphämtning (API-Football) om ${Math.round(wait / 3600000)} h.`);
  setTimeout(async () => {
    try {
      await fetchSquads({ log });
    } catch (e) {
      log("[schema] Trupphämtning misslyckades:", e.message);
    }
    scheduleNightlySquads();
  }, wait);
}

function nextFdDelay(snapshot) {
  const live = snapshot?.live?.length || 0;
  if (live > 0) return config.fdPollLiveSeconds;

  const results = snapshot?.results || {};
  const anyInPlay = Object.values(results).some(
    (r) => r.status === "IN_PLAY" || r.status === "PAUSED" || r.status === "LIVE"
  );
  if (anyInPlay) return config.fdPollLiveSeconds;

  const now = new Date();
  const start = new Date("2026-06-11T00:00:00Z");
  const end = new Date("2026-07-20T00:00:00Z");
  if (now >= start && now <= end) return config.fdPollMatchDaySeconds;

  return config.fdPollIdleSeconds;
}

async function fdLoop() {
  let delay = config.fdPollIdleSeconds;
  try {
    await syncFootballData({ log });
    delay = nextFdDelay(resultsStore.getSnapshot());
  } catch (e) {
    log("[schema] football-data-synk misslyckades:", e.message);
    delay = config.fdPollMatchDaySeconds;
  }
  setTimeout(fdLoop, delay * 1000);
}

async function apiFootballLoop() {
  if (config.apiFootballOffline) return;
  try {
    await livePollOnce({ log });
    finalize({ log }).catch((e) => log("[schema] Slutkontroll fel:", e.message));
  } catch (e) {
    log("[schema] API-Football live fel:", e.message);
  }
  setTimeout(apiFootballLoop, config.livePollSeconds * 1000);
}

export async function startScheduler() {
  await resultsStore.load();

  if (config.fdOffline) {
    log("[schema] FOOTBALL_DATA_TOKEN saknas – ingen automatisk resultatsynk.");
  } else {
    log("[schema] Startar football-data-synk (resultat & tabeller).");
    fdLoop();
  }

  if (!config.apiFootballOffline) {
    log("[schema] Startar API-Football-bakgrundsjobb (spelarstatistik).");
    scheduleNightlySquads();
    apiFootballLoop();
  }
}
