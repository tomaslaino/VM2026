import { pathToFileURL } from "node:url";
import { getCallCount } from "../espn.js";
import { fetchSnapshot, syncDetails } from "../espnSync.js";
import * as resultsStore from "../resultsStore.js";
import { broadcast } from "../bus.js";

/*
  Hämtar alla VM-matcher från ESPN (ingen API-nyckel behövs) och mappar
  till appens resultatnycklar. Körs regelbundet av schemaläggaren när
  den lokala servern är igång. Skriver även matchdetaljer + statistik
  till data/matchdetails.json så att matchmodalen fungerar live.
*/

export async function syncResults({ log = console.log } = {}) {
  await resultsStore.load();
  log("[espn] Hämtar matcher …");

  const { matches, results, live, fixtures, standings, mapped, skipped } =
    await fetchSnapshot({ log });

  await resultsStore.save({ results, live, fixtures, standings, mapped, apiCalls: getCallCount() });

  let detailCount = 0;
  try {
    detailCount = await syncDetails(matches, { log });
  } catch (e) {
    log(`[espn] Kunde inte synka matchdetaljer: ${e.message}`);
  }

  broadcast("results:updated", {
    results,
    live,
    fixtures,
    standings,
    meta: resultsStore.getSnapshot().meta,
  });

  log(
    `[espn] Klart. ${matches.length} matcher från API, ${mapped} resultat mappade, ` +
      `${skipped} utan nyckel, ${live.length} live, ${detailCount} detaljer, ` +
      `${Object.keys(standings).length} tabeller.`
  );
  return { total: matches.length, mapped, live: live.length, standings: Object.keys(standings).length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncResults().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
