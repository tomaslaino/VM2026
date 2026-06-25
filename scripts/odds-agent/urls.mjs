import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SLUGS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "slugs.json");

/** @type {Record<string, string[]>} */
const SLUGS = JSON.parse(fs.readFileSync(SLUGS_FILE, "utf8"));

const BASES = [
  "https://www.oddschecker.com/football/world-cup",
  "https://www.oddschecker.com/world-cup",
];

const MARKETS = ["winner", "correct-score"];

function slugVariants(team) {
  const v = SLUGS[team];
  if (Array.isArray(v) && v.length) return v;
  return [
    String(team)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, ""),
  ];
}

/**
 * Möjliga URL:er – oddschecker använder /football/world-cup/{lag}-v-{lag}/{marknad}.
 * @param {{home:string, away:string}} fx
 */
export function buildUrls(fx) {
  return buildUrlsForMarkets(fx, MARKETS);
}

/** Endast /winner (1X2) – slutspel. */
export function buildH2hUrls(fx) {
  return buildUrlsForMarkets(fx, ["winner"]);
}

function buildUrlsForMarkets(fx, markets) {
  const homeSlugs = slugVariants(fx.home);
  const awaySlugs = slugVariants(fx.away);
  const urls = [];
  const seen = new Set();

  for (const base of BASES) {
    for (const h of homeSlugs) {
      for (const a of awaySlugs) {
        for (const market of markets) {
          for (const slug of [`${h}-v-${a}`, `${a}-v-${h}`]) {
            const u = `${base}/${slug}/${market}`;
            if (!seen.has(u)) {
              seen.add(u);
              urls.push(u);
            }
          }
        }
      }
    }
  }
  return urls;
}
