import { pathToFileURL } from "node:url";
import { getFixtures, getFixturePlayers, getCallCount } from "../apiFootball.js";
import * as store from "../store.js";
import { broadcast } from "../bus.js";
import { config } from "../config.js";

/*
  FAS 3 – Kvalitetssäkring (körs efter slutsignal).
  Live-data kan korrigeras i efterhand (VAR, ändrade assist). När en match
  har status FT/AET/PEN och tillräckligt lång tid passerat hämtar vi den
  officiella matchrapporten (/fixtures/players) och uppdaterar de permanenta
  totalsiffrorna i registret. Idempotent: bidrag per match skrivs över, och
  totalerna räknas alltid om från grunden.
*/

const FINISHED = new Set(["FT", "AET", "PEN"]);

function buildContributions(fixturePlayers) {
  // Returnerar { playerId -> {goals,assists,yellow,red,minutes} }
  const out = {};
  for (const team of fixturePlayers) {
    for (const entry of team.players || []) {
      const pid = entry.player?.id;
      const s = entry.statistics?.[0];
      if (!pid || !s) continue;
      out[String(pid)] = {
        goals: s.goals?.total || 0,
        assists: s.goals?.assists || 0,
        yellow: s.cards?.yellow || 0,
        red: s.cards?.red || 0,
        minutes: s.games?.minutes || 0,
      };
    }
  }
  return out;
}

export async function finalize({ log = () => {}, fixtures = null } = {}) {
  if (config.offline) {
    log("[fas3] OFFLINE_MODE – ingen slutkontroll.");
    return { finalized: 0 };
  }

  store.load();
  const all = fixtures || (await getFixtures());
  const now = Date.now();
  const delayMs = config.finalizeDelaySeconds * 1000;
  let count = 0;

  for (const f of all) {
    const id = f.fixture?.id;
    const short = f.fixture?.status?.short;
    const kickoffMs = (f.fixture?.timestamp || 0) * 1000;
    if (!id || !FINISHED.has(short)) continue;
    if (store.isFinalized(id)) continue;

    // Vänta tills det gått ~2h (matchlängd) + inställd fördröjning efter avspark.
    const readyAt = kickoffMs + 2 * 3600 * 1000 + delayMs;
    if (kickoffMs && now < readyAt) {
      log(`[fas3] Match ${id} (${short}) inte redo för slutkontroll än.`);
      continue;
    }

    try {
      const fp = await getFixturePlayers(id);
      const contributions = buildContributions(fp);
      store.setMatchPlayerStats(id, contributions);
      store.markFinalized(id);
      count++;
      log(`[fas3] Slutkontrollerade match ${id} (${Object.keys(contributions).length} spelare).`);
    } catch (e) {
      log(`[fas3] Misslyckades med match ${id}: ${e.message}`);
    }
  }

  if (count > 0) {
    store.recomputeTotals();
    store.save();
    broadcast("stats:updated", { finalized: count, updatedAt: new Date().toISOString() });
  }

  log(`[fas3] Klart. ${count} match(er) slutkontrollerade. API-anrop totalt: ${getCallCount()}`);
  return { finalized: count };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  finalize({ log: console.log }).catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
