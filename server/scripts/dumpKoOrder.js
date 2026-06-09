import { getMatches } from "../footballData.js";
import { KNOCKOUT } from "../wcFixtures.js";
import { utcToSwedish } from "../mapResults.js";

const { matches } = await getMatches();
const byStage = {};
for (const m of matches.filter((x) => x.stage !== "GROUP_STAGE")) {
  if (!byStage[m.stage]) byStage[m.stage] = [];
  byStage[m.stage].push(m);
}

for (const stage of Object.keys(byStage)) {
  const ours = KNOCKOUT.filter((k) => k.stage === stage).sort((a, b) => a.m - b.m);
  const theirs = byStage[stage].sort((a, b) => String(a.utcDate).localeCompare(String(b.utcDate)));
  console.log(`\n=== ${stage} (${theirs.length} matcher) ===`);
  for (let i = 0; i < theirs.length; i++) {
    const sw = utcToSwedish(theirs[i].utcDate);
    const slot = ours[i];
    console.log(
      `API#${i + 1} ${sw.date} ${sw.time}  →  M${slot?.m} (data.js ${slot?.date})  id=${theirs[i].id}`
    );
  }
}
