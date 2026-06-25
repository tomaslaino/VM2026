import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadOpenGroupFixtures, loadOpenKnockoutFixtures } from "./fixtures.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_OUT = path.join(ROOT, "data", "odds.json");

/** @param {object} m */
export function matchId(m) {
  if (m.key && m.key.startsWith("k:")) return m.key;
  return `${m.group}-${m.home_idx}-${m.away_idx}`;
}

/**
 * @param {object[]} groupMatches
 * @param {object[]} knockoutMatches
 * @param {string} [outPath]
 */
export function mergeOddsFile(groupMatches = [], knockoutMatches = [], outPath = DEFAULT_OUT) {
  /** @type {{ updated?: string, matches: object[], knockout?: object[] }} */
  let existing = { matches: [], knockout: [] };
  if (fs.existsSync(outPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(outPath, "utf8"));
    } catch {
      existing = { matches: [], knockout: [] };
    }
  }

  const openGroup = new Set(loadOpenGroupFixtures().map((f) => f.key));
  const openKo = new Set(loadOpenKnockoutFixtures().map((f) => f.key));

  const byGroup = new Map();
  for (const m of existing.matches || []) {
    const key = m.key || fixtureKeyFromGroupMatch(m);
    if (key && !openGroup.has(key)) continue;
    byGroup.set(matchId(m), m);
  }
  for (const m of groupMatches) byGroup.set(matchId(m), m);

  const byKo = new Map();
  for (const m of existing.knockout || []) {
    if (m.key && !openKo.has(m.key)) continue;
    byKo.set(m.key, m);
  }
  for (const m of knockoutMatches) byKo.set(m.key, m);

  const matches = [...byGroup.values()].filter((m) => {
    const key = m.key || fixtureKeyFromGroupMatch(m);
    return key && openGroup.has(key);
  });
  matches.sort((a, b) => {
    const da = a.utcDate || a.date || "";
    const db = b.utcDate || b.date || "";
    return da.localeCompare(db) || String(a.group).localeCompare(String(b.group));
  });

  const knockout = [...byKo.values()].filter((m) => m.key && openKo.has(m.key));
  knockout.sort((a, b) => (a.utcDate || "").localeCompare(b.utcDate || "") || (a.matchNo || 0) - (b.matchNo || 0));

  return {
    updated: new Date().toISOString(),
    source: "oddschecker.com",
    market: "correct-score + knockout-h2h",
    agent: "scripts/odds-agent",
    matches,
    knockout,
  };
}

/** @param {object} m */
function fixtureKeyFromGroupMatch(m) {
  if (m.key) return m.key;
  if (m.group == null || m.home_idx == null || m.away_idx == null) return null;
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "results.json"), "utf8"));
  for (const [key, fx] of Object.entries(data.fixtures || {})) {
    if (!key.startsWith("g:")) continue;
    const hr = fx.homeRef || {};
    const ar = fx.awayRef || {};
    if (hr.group === m.group && hr.idx === m.home_idx && ar.idx === m.away_idx) return key;
    if (ar.group === m.group && ar.idx === m.home_idx && hr.idx === m.away_idx) return key;
  }
  return null;
}

/** @param {object} scraped  output från scrapeAll */
export function mergeScrapeResult(scraped, outPath = DEFAULT_OUT) {
  const group = (scraped.matches || []).filter((m) => m.group || (m.key && m.key.startsWith("g:")));
  const ko = (scraped.knockout || scraped.matches || []).filter((m) => m.key && m.key.startsWith("k:"));
  return mergeOddsFile(group, ko, outPath);
}
