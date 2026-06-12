/*
  Gemensam synklogik mot ESPN – används både av den statiska synken
  (GitHub Actions → data/results.json) och av den lokala servern.

  fetchSnapshot(): scoreboard → { results, live, fixtures, standings, matches }
  syncDetails():   summary per relevant match → data/matchdetails.json
                   (livematcher varje synk, avslutade en gång – permanent,
                    inklusive matchstatistik från ESPN:s boxscore)
*/

import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";
import { getScoreboard, getStandings, getSummary } from "./espn.js";
import { adaptEvent, mapEspnDetail, mapEspnStandings } from "./mapEspn.js";
import { buildKeyMap, mapMatchesToFixtures, mapMatchesToResults } from "./mapResults.js";
import { flipDetail, pickDetailTargets } from "./matchDetails.js";

export const DETAILS_FILE = path.join(ROOT, "data", "matchdetails.json");
export const RESULTS_FILE = path.join(ROOT, "data", "results.json");

/** Hämta scoreboard + tabeller och mappa till appens format. */
export async function fetchSnapshot({ log = console.log } = {}) {
  const events = await getScoreboard();
  const matches = events.map(adaptEvent);

  const { results, live, mapped, skipped } = mapMatchesToResults(matches);
  const fixtures = mapMatchesToFixtures(matches);

  let standings = {};
  try {
    standings = mapEspnStandings(await getStandings());
  } catch (e) {
    log(`[espn] Kunde inte hämta tabeller: ${e.message}`);
  }

  return { matches, results, live, fixtures, standings, mapped, skipped };
}

/**
 * Skriv den statiska results.json som frontend läser (både på GitHub Pages
 * och lokalt – sidan pollar filen direkt när ingen backend är konfigurerad).
 */
export function writeResultsFile({ results, live, fixtures, standings, mapped }, apiCalls = 0) {
  const payload = {
    meta: {
      updatedAt: new Date().toISOString(),
      source: "espn",
      matchCount: mapped,
      liveCount: live.length,
      apiCalls,
    },
    results,
    live,
    fixtures,
    standings,
  };
  fs.mkdirSync(path.dirname(RESULTS_FILE), { recursive: true });
  fs.writeFileSync(RESULTS_FILE, JSON.stringify(payload, null, 2) + "\n");
  return payload;
}

export function readStoredDetails() {
  try {
    if (fs.existsSync(DETAILS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DETAILS_FILE, "utf8"));
      if (parsed && typeof parsed.details === "object") return parsed.details;
    }
  } catch {
    /* ignorera trasig fil */
  }
  return {};
}

/**
 * Hämta matchdetaljer (händelser + statistik) för pågående och nyligen
 * avslutade matcher och spara dem permanent i data/matchdetails.json.
 */
export async function syncDetails(matches, { log = console.log } = {}) {
  const keyMap = buildKeyMap(matches);
  const details = readStoredDetails();
  const targets = pickDetailTargets(matches, keyMap, details);

  if (!targets.length) {
    log("[espn] Inga matchdetaljer att hämta.");
  }

  let fetched = 0;
  for (const t of targets) {
    try {
      const summary = await getSummary(t.id);
      const det = mapEspnDetail(summary);
      // Spegla h/a om API:ets hemma/borta är omvänd mot appens ordning,
      // så att händelser och statistik hamnar på rätt lag.
      details[t.key] = t.reversed ? flipDetail(det) : det;
      fetched++;
      log(`[espn] Detaljer hämtade för ${t.key} (event ${t.id}, ${details[t.key].status}).`);
    } catch (e) {
      log(`[espn] Kunde inte hämta detaljer för ${t.key}: ${e.message}`);
    }
  }

  const payload = {
    meta: { updatedAt: new Date().toISOString(), source: "espn" },
    details,
  };
  fs.mkdirSync(path.dirname(DETAILS_FILE), { recursive: true });
  fs.writeFileSync(DETAILS_FILE, JSON.stringify(payload, null, 2) + "\n");
  return fetched;
}
