import { pathToFileURL } from "node:url";
import { getLiveFixtures, getFixtureEvents, getCallCount } from "../apiFootball.js";
import * as store from "../store.js";
import { broadcast } from "../bus.js";
import { config } from "../config.js";

/*
  FAS 2 – Live-läget (Smart Polling).
  Ett enda anrop (/fixtures?live=all) ger ställning och status för ALLA
  pågående matcher samtidigt. Vi jämför med förra snapshotten och hämtar
  bara detaljerade händelser (/fixtures/events) för matcher där ställningen
  faktiskt ändrats – så håller vi nere antalet anrop.
*/

function compactFixture(f) {
  return {
    id: f.fixture.id,
    status: f.fixture.status?.short ?? null, // 1H, HT, 2H, FT ...
    elapsed: f.fixture.status?.elapsed ?? null,
    date: f.fixture.date ?? null,
    home: { id: f.teams.home.id, name: f.teams.home.name, logo: f.teams.home.logo, goals: f.goals.home ?? 0 },
    away: { id: f.teams.away.id, name: f.teams.away.name, logo: f.teams.away.logo, goals: f.goals.away ?? 0 },
  };
}

function scoreKey(c) {
  return `${c.home.goals}-${c.away.goals}`;
}

export async function livePollOnce({ log = () => {} } = {}) {
  if (config.offline) {
    log("[fas2] OFFLINE_MODE – ingen live-polling.");
    return { live: [], changed: [] };
  }

  const data = store.getData();
  const prev = {};
  for (const c of data.live.fixtures || []) prev[c.id] = scoreKey(c);

  const raw = await getLiveFixtures();
  const live = raw.map(compactFixture);

  // Hitta matcher där ställningen ändrats sedan förra anropet.
  const changed = live.filter((c) => prev[c.id] !== undefined && prev[c.id] !== scoreKey(c));
  const isNew = live.filter((c) => prev[c.id] === undefined);

  data.live = { fixtures: live, updatedAt: new Date().toISOString() };
  store.saveSoon();

  // Pusha alltid ut den aktuella ställningen så att klockor/score uppdateras.
  broadcast("live:scores", { fixtures: live });

  // Hämta målhändelser endast för matcher som faktiskt fått nytt mål.
  for (const c of changed) {
    try {
      const events = await getFixtureEvents(c.id);
      const goals = events
        .filter((e) => e.type === "Goal")
        .map((e) => ({
          minute: e.time?.elapsed ?? null,
          extra: e.time?.extra ?? null,
          teamId: e.team?.id ?? null,
          teamName: e.team?.name ?? null,
          player: e.player?.name ?? null,
          assist: e.assist?.name ?? null,
          detail: e.detail ?? null,
        }));
      broadcast("live:goal", { fixtureId: c.id, score: scoreKey(c), home: c.home, away: c.away, goals });
      log(`[fas2] Mål i match ${c.id}: ${c.home.name} ${scoreKey(c)} ${c.away.name}`);
    } catch (e) {
      log(`[fas2] Kunde inte hämta händelser för match ${c.id}: ${e.message}`);
    }
  }

  if (isNew.length) log(`[fas2] ${isNew.length} ny(a) match(er) live.`);
  log(`[fas2] ${live.length} live, ${changed.length} ändrade. API-anrop totalt: ${getCallCount()}`);

  return { live, changed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  store.load();
  livePollOnce({ log: console.log })
    .then(() => store.save())
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
