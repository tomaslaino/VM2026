/*
  Hämtar repris + sammandrag från SVT Play via deras öppna GraphQL
  (contento.svt.se). Ingen API-nyckel eller inloggning behövs.

  Per spelad match görs en sökning på lagnamnen. Träffarna klassas till
  full/long/short och knyts till matchen bara om exakt rätt lagpar nämns
  (sökningen returnerar även närliggande matcher och nyhetsklipp).
*/
import { classifySvt, cleanTitle } from "./classify.js";
import { extractTeamIds, swedishNameFor } from "./match.js";

const SVT_GQL = "https://contento.svt.se/graphql";
const SVT_BASE = "https://www.svtplay.se";

const SEARCH_QUERY = `query($q:String!){
  searchPage(query:$q){
    flat {
      hits {
        teaser {
          heading
          subHeading
          item {
            __typename
            ... on Listable { name urls { svtplay } }
            ... on Clip { duration validTo }
            ... on Episode { duration validTo }
            ... on Single { duration validTo }
          }
        }
      }
    }
  }
}`;

async function searchSvt(query) {
  const res = await fetch(SVT_GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ query: SEARCH_QUERY, variables: { q: query } }),
  });
  if (!res.ok) throw new Error(`SVT HTTP ${res.status}`);
  const json = await res.json();
  return json?.data?.searchPage?.flat?.hits || [];
}

function sameId2(ids, idH, idA) {
  if (ids.length !== 2) return false;
  return (ids[0] === idH && ids[1] === idA) || (ids[0] === idA && ids[1] === idH);
}

/** Höjdpunkter/repris för en enskild match, eller null om inget hittas. */
async function fetchForFixture(fx) {
  const q = `${swedishNameFor(fx.home)} ${swedishNameFor(fx.away)}`;
  const hits = await searchSvt(q);
  const now = Date.now();
  const byType = {};
  for (const hit of hits) {
    const teaser = hit?.teaser;
    const item = teaser?.item;
    if (!teaser || !item) continue;

    const urlPath = item.urls?.svtplay || "";
    const heading = teaser.heading || "";
    const name = item.name || "";
    const type = classifySvt({ typename: item.__typename, urlPath, heading, name });
    if (!type) continue;

    // Säkerställ att träffen faktiskt gäller den här matchen (rensa <em>-taggar
    // som SVT lägger runt sökorden innan lagnamnen plockas ut).
    const ids = extractTeamIds(cleanTitle(`${heading} ${teaser.subHeading || ""} ${name}`));
    if (!sameId2(ids, fx.idH, fx.idA)) continue;

    if (item.validTo && new Date(item.validTo).getTime() <= now) continue;
    if (byType[type]) continue; // första (mest relevanta) träffen per typ vinner
    if (!urlPath) continue;

    byType[type] = {
      url: urlPath.startsWith("http") ? urlPath : SVT_BASE + urlPath,
      title: cleanTitle(heading) || cleanTitle(name),
      until: item.validTo || null,
    };
  }
  return Object.keys(byType).length ? byType : null;
}

async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let next = 0;
  async function loop() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await worker(items[i]);
      } catch {
        results[i] = null;
      }
    }
  }
  const runners = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) runners.push(loop());
  await Promise.all(runners);
  return results;
}

/**
 * @param {Array} fixtures spelade matcher från match.loadPlayedFixtures()
 * @returns {Object} { matchKey: { full?, long?, short? } }
 */
export async function fetchSvtHighlights(fixtures, { log = () => {} } = {}) {
  const out = {};
  const perFixture = await runPool(fixtures, fetchForFixture, 5);
  fixtures.forEach((fx, i) => {
    if (perFixture[i]) out[fx.key] = perFixture[i];
  });
  log(`[svt] hittade höjdpunkter för ${Object.keys(out).length}/${fixtures.length} matcher`);
  return out;
}
