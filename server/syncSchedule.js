/*
  Avgör hur ofta resultat bör hämtas utifrån matcher som pågår,
  snart startar eller nyligen avslutats.
*/

const LIVE = new Set(["IN_PLAY", "PAUSED", "LIVE", "HALFTIME"]);
const FINISHED = new Set(["FINISHED", "AWARDED"]);
const SCHEDULED = new Set(["TIMED", "SCHEDULED", null, undefined, ""]);

const TOURNAMENT_START = Date.parse("2026-06-11T00:00:00Z");
const TOURNAMENT_END = Date.parse("2026-07-20T00:00:00Z");

function swedishToday(now = new Date()) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function fixtureKickoffMs(fx) {
  if (!fx) return NaN;
  if (fx.utcDate) return Date.parse(fx.utcDate);
  if (fx.date && fx.time) {
    const [y, m, d] = fx.date.split("-").map(Number);
    const [hh, mm] = fx.time.split(":").map(Number);
    // Tider i results.json är svensk sommartid (CEST, UTC+2).
    return Date.UTC(y, m - 1, d, hh - 2, mm);
  }
  return NaN;
}

export function getSyncUrgency(snapshot, now = new Date()) {
  const ms = now.getTime();

  if (ms < TOURNAMENT_START || ms > TOURNAMENT_END) {
    return { level: "offseason", pollSec: 1800, minSyncGapSec: 21600 };
  }

  const fixtures = Object.values(snapshot?.fixtures || {});
  const results = Object.values(snapshot?.results || {});

  for (const fx of fixtures) {
    if (LIVE.has(fx.status)) {
      return { level: "live", pollSec: 30, minSyncGapSec: 0 };
    }
  }
  for (const r of results) {
    if (LIVE.has(r.status)) {
      return { level: "live", pollSec: 30, minSyncGapSec: 0 };
    }
  }
  if ((snapshot?.live || []).length > 0) {
    return { level: "live", pollSec: 30, minSyncGapSec: 0 };
  }

  const soonMs = 90 * 60 * 1000;
  const recentAfterMs = 45 * 60 * 1000;
  const matchWindowMs = 110 * 60 * 1000;

  for (const fx of fixtures) {
    const kick = fixtureKickoffMs(fx);
    if (!Number.isFinite(kick)) continue;

    if (SCHEDULED.has(fx.status)) {
      const until = kick - ms;
      if (until > 0 && until <= soonMs) {
        return { level: "soon", pollSec: 60, minSyncGapSec: 0 };
      }
    }

    if (FINISHED.has(fx.status) && ms >= kick && ms <= kick + matchWindowMs + recentAfterMs) {
      return { level: "recent", pollSec: 90, minSyncGapSec: 0 };
    }
  }

  const today = swedishToday(now);
  const hasMatchToday = fixtures.some((fx) => fx.date === today);
  if (hasMatchToday) {
    return { level: "matchday", pollSec: 180, minSyncGapSec: 300 };
  }

  return { level: "idle", pollSec: 600, minSyncGapSec: 1800 };
}

export function shouldSyncNow(snapshot, now = new Date()) {
  const urgency = getSyncUrgency(snapshot, now);
  if (urgency.minSyncGapSec === 0) {
    return { sync: true, ...urgency };
  }

  const updatedAt = snapshot?.meta?.updatedAt;
  if (!updatedAt) {
    return { sync: true, ...urgency };
  }

  const ageSec = (now.getTime() - Date.parse(updatedAt)) / 1000;
  return {
    sync: ageSec >= urgency.minSyncGapSec,
    ageSec: Math.round(ageSec),
    ...urgency,
  };
}
