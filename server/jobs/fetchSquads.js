import { getTeams, getSquad, getCallCount } from "../apiFootball.js";
import * as store from "../store.js";
import { WC_GROUPS, NAME_ALIASES } from "../wcTeams.js";
import { config } from "../config.js";

/*
  FAS 1 – Grunddata (körs en gång per natt).
  Hämtar alla lag i turneringen och varje lags trupp, mappar dem till rätt
  grupp och sparar i det lokala registret. Då är allt redo när matcherna börjar.
*/

function canonicalName(apiName) {
  const key = String(apiName || "").toLowerCase().trim();
  return NAME_ALIASES[key] || apiName;
}

function groupForName(name) {
  const canon = canonicalName(name);
  for (const [group, names] of Object.entries(WC_GROUPS)) {
    if (names.includes(canon)) return { group, canon };
  }
  return { group: null, canon };
}

export async function fetchSquads({ log = console.log } = {}) {
  if (config.offline) {
    log("[fas1] OFFLINE_MODE – hoppar över trupphämtning (ingen API-nyckel).");
    return { teams: 0, players: 0, skipped: true };
  }

  store.load();
  log("[fas1] Hämtar lag …");
  const teams = await getTeams();
  log(`[fas1] ${teams.length} lag från API:t.`);

  let teamCount = 0;
  let playerCount = 0;

  for (const entry of teams) {
    const t = entry.team || entry;
    const { group, canon } = groupForName(t.name);
    if (!group) {
      // Lag som inte ingår i vår gruppindelning hoppas över (t.ex. om API:t
      // listar fler lag än de 48 i slutturneringen).
      continue;
    }

    store.upsertTeam({
      id: t.id,
      name: canon,
      apiName: t.name,
      code: t.code ?? null,
      logo: t.logo ?? null,
      group,
    });
    teamCount++;

    try {
      const squad = await getSquad(t.id);
      const players = (squad[0]?.players || []).map((p) => ({
        id: p.id,
        name: p.name,
        number: p.number ?? null,
        position: p.position ?? null,
        photo: p.photo ?? null,
        age: p.age ?? null,
      }));
      store.setSquad(t.id, players);
      playerCount += players.length;
      log(`[fas1]   ${canon} (grupp ${group}): ${players.length} spelare`);
    } catch (e) {
      log(`[fas1]   ${canon}: kunde inte hämta trupp – ${e.message}`);
    }
  }

  store.recomputeTotals();
  store.save();
  log(`[fas1] Klart. ${teamCount} lag, ${playerCount} spelare. API-anrop totalt: ${getCallCount()}`);
  return { teams: teamCount, players: playerCount };
}

// Tillåt körning fristående: `npm run squads`
if (import.meta.url === `file://${process.argv[1]}`) {
  fetchSquads().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
