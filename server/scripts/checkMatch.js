import { getMatches } from "../footballData.js";
import { utcToSwedish, findAppTeamIndex } from "../mapResults.js";
import { groupPairToKey, canonicalTeam } from "../wcFixtures.js";

const data = await getMatches();
const matches = data.matches || [];

const hits = matches.filter((m) => {
  const h = (m.homeTeam?.name || "").toLowerCase();
  const a = (m.awayTeam?.name || "").toLowerCase();
  return (
    (h.includes("egypt") && a.includes("zealand")) ||
    (a.includes("egypt") && h.includes("zealand"))
  );
});

const pairMap = groupPairToKey();

for (const m of hits) {
  const sw = utcToSwedish(m.utcDate);
  const home = m.homeTeam?.name;
  const away = m.awayTeam?.name;
  const key =
    pairMap.get(`${canonicalTeam(home)}|${canonicalTeam(away)}`) ||
    pairMap.get(`${canonicalTeam(away)}|${canonicalTeam(home)}`);
  console.log("--- API-match ---");
  console.log("id:", m.id);
  console.log("stage:", m.stage, "group:", m.group);
  console.log("home:", home, "away:", away);
  console.log("utcDate:", m.utcDate);
  console.log("svensk tid:", sw.date, sw.time);
  console.log("status:", m.status);
  console.log("app-nyckel:", key);
  console.log("homeRef:", findAppTeamIndex(home));
  console.log("awayRef:", findAppTeamIndex(away));
}
