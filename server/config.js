import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function int(name, def) {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) ? v : def;
}

export const ROOT = path.resolve(__dirname, "..");
export const DATA_DIR = path.join(__dirname, "data");
export const STORE_FILE = path.join(DATA_DIR, "store.json");

export const config = {
  port: int("PORT", 3000),

  // --- football-data.org (primär datakälla för resultat/tabeller) ---
  footballDataToken: process.env.FOOTBALL_DATA_TOKEN || "",
  fdCompetition: process.env.FD_COMPETITION || "WC",
  fdSeason: int("FD_SEASON", 2026),
  fdPollIdleSeconds: int("FD_POLL_IDLE_SECONDS", 900),
  fdPollMatchDaySeconds: int("FD_POLL_MATCHDAY_SECONDS", 300),
  fdPollLiveSeconds: int("FD_POLL_LIVE_SECONDS", 120),
  fdOffline: process.env.OFFLINE_MODE === "1" || !process.env.FOOTBALL_DATA_TOKEN,

  // --- API-Football (valfritt – spelarstatistik) ---
  apiKey: process.env.API_FOOTBALL_KEY || "",
  provider: (process.env.API_FOOTBALL_PROVIDER || "direct").toLowerCase(),
  leagueId: int("WC_LEAGUE_ID", 1),
  season: int("WC_SEASON", 2026),
  livePollSeconds: int("LIVE_POLL_SECONDS", 180),
  finalizeDelaySeconds: int("FINALIZE_DELAY_SECONDS", 1800),
  nightlyHour: int("NIGHTLY_HOUR", 4),
  apiFootballOffline: process.env.OFFLINE_MODE === "1" || !process.env.API_FOOTBALL_KEY,
};

export function apiBaseAndHeaders() {
  if (config.provider === "rapidapi") {
    return {
      base: "https://api-football-v1.p.rapidapi.com/v3",
      headers: {
        "x-rapidapi-key": config.apiKey,
        "x-rapidapi-host": "api-football-v1.p.rapidapi.com",
      },
    };
  }
  return {
    base: "https://v3.football.api-sports.io",
    headers: { "x-apisports-key": config.apiKey },
  };
}
