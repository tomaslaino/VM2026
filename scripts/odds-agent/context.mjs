import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RESULTS = path.join(ROOT, "data", "results.json");

const FINISHED = new Set(["FINISHED", "FULL_TIME", "FT"]);
const LIVE = new Set(["IN_PLAY", "LIVE", "PAUSED", "1ST_HALF", "2ND_HALF", "HALFTIME", "HT"]);

/**
 * @param {string} key  t.ex. g:B:4
 * @param {object} [data]  results.json (cachas om utelämnad)
 */
export function oddsContextForKey(key, data) {
  if (!data) data = JSON.parse(fs.readFileSync(RESULTS, "utf8"));
  const r = data.results?.[key] || {};
  const fx = data.fixtures?.[key] || {};
  const liveRow = (data.live || []).find((row) => row.key === key);
  const st = String(r.status || fx.status || liveRow?.status || "").toUpperCase();

  if (FINISHED.has(st)) {
    return { oddsContext: "prematch", matchMinute: null };
  }
  if (LIVE.has(st) || liveRow) {
    const min =
      typeof liveRow?.minute === "number"
        ? liveRow.minute
        : typeof r.minute === "number"
          ? r.minute
          : null;
    return { oddsContext: "inplay", matchMinute: min };
  }
  return { oddsContext: "prematch", matchMinute: null };
}
