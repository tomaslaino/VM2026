import { getMatches } from "../footballData.js";
import { KNOCKOUT } from "../wcFixtures.js";
import { utcToSwedish, buildKoSlotMap } from "../mapResults.js";

const KO_BY_M = Object.fromEntries(KNOCKOUT.map((k) => [k.m, k]));

const { matches } = await getMatches();
const koMap = buildKoSlotMap(matches);

const byStage = {};
for (const m of matches.filter((x) => x.stage !== "GROUP_STAGE")) {
  if (!byStage[m.stage]) byStage[m.stage] = [];
  byStage[m.stage].push(m);
}

for (const stage of Object.keys(byStage)) {
  const theirs = byStage[stage].sort((a, b) => String(a.utcDate).localeCompare(String(b.utcDate)));
  console.log(`\n=== ${stage} (${theirs.length} matcher) ===`);
  for (const t of theirs) {
    const sw = utcToSwedish(t.utcDate);
    const key = koMap.get(t.id);
    const m = key ? Number(key.split(":")[1]) : null;
    const slot = m ? KO_BY_M[m] : null;
    console.log(
      `API ${sw.date} ${sw.time}  →  ${key || "(omappad)"} (data.js ${slot?.date})  id=${t.id}`
    );
  }
}
