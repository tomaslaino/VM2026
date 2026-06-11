import { config } from "./config.js";
import { syncResults } from "./jobs/syncResults.js";
import { fetchSquads } from "./jobs/fetchSquads.js";
import { livePollOnce } from "./jobs/livePoll.js";
import { finalize } from "./jobs/finalize.js";
import * as resultsStore from "./resultsStore.js";

/*
  Schemaläggare:
    Primärt: ESPN-synk (resultat & matchdetaljer → grupper/slutspel uppdateras
    på sidan – ingen API-nyckel behövs).
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

function nextSyncDelay(snapshot) {
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

async function syncLoop() {
  let delay = config.fdPollIdleSeconds;
  try {
    await syncResults({ log });
    delay = nextSyncDelay(resultsStore.getSnapshot());
  } catch (e) {
    log("[schema] ESPN-synk misslyckades:", e.message);
    delay = config.fdPollMatchDaySeconds;
  }
  setTimeout(syncLoop, delay * 1000);
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

  log("[schema] Startar ESPN-synk (resultat, tabeller & matchdetaljer).");
  syncLoop();

  if (!config.apiFootballOffline) {
    log("[schema] Startar API-Football-bakgrundsjobb (spelarstatistik).");
    scheduleNightlySquads();
    apiFootballLoop();
  }
}
