/*
  Hämtar repris + sammandrag från SVT Play via deras öppna GraphQL
  (contento.svt.se). Ingen API-nyckel eller inloggning behövs.

  Per spelad match görs en sökning på lagnamnen. Träffarna klassas till
  full/long/short och knyts till matchen bara om exakt rätt lagpar nämns
  (sökningen returnerar även närliggande matcher och nyhetsklipp).
*/
import { classifySvt, cleanTitle } from "./classify.js";
import { extractTeamIds, swedishNamesFor } from "./match.js";

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

/* SVT:s öppna GraphQL svarar på vanliga GET-anrop (query + variables i URL:en).
   Vi använder GET i stället för POST eftersom POST utan webbläsarlika headers kan
   blockeras i datacenter-/CI-miljöer (t.ex. GitHub Actions) – då tappas alla
   SVT-träffar tyst och bara TV4 blir kvar. En webbläsarlik User-Agent läggs till
   av samma skäl. */
const SVT_HEADERS = {
  Accept: "application/json",
  "Accept-Language": "sv-SE,sv;q=0.9,en;q=0.8",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

async function searchSvt(query) {
  const url =
    `${SVT_GQL}?query=${encodeURIComponent(SEARCH_QUERY)}` +
    `&variables=${encodeURIComponent(JSON.stringify({ q: query }))}`;
  const res = await fetch(url, { headers: SVT_HEADERS });
  if (!res.ok) throw new Error(`SVT HTTP ${res.status}`);
  const json = await res.json();
  if (json?.errors?.length) {
    throw new Error(`SVT GraphQL: ${json.errors[0]?.message || "okänt fel"}`);
  }
  return json?.data?.searchPage?.flat?.hits || [];
}

function sameId2(ids, idH, idA) {
  if (ids.length !== 2) return false;
  return (ids[0] === idH && ids[1] === idA) || (ids[0] === idA && ids[1] === idH);
}

/** Höjdpunkter/repris för en enskild match, eller null om inget hittas. */
async function fetchForFixture(fx, { live = false } = {}) {
  // Prova alla kända svenska stavningskombinationer (t.ex. "Kongo-Kinshasa" och
  // "DR Kongo") och slå ihop träffarna – SVT använder olika stavningar för
  // klipp respektive sändningssidor, och en enda sökning kan missa matchen.
  const queries = new Set();
  for (const h of swedishNamesFor(fx.home)) {
    for (const a of swedishNamesFor(fx.away)) queries.add(`${h} ${a}`);
  }
  const seen = new Set();
  const hits = [];
  for (const q of queries) {
    for (const hit of await searchSvt(q)) {
      const url = hit?.teaser?.item?.urls?.svtplay;
      const dedupeKey = url || JSON.stringify(hit);
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      hits.push(hit);
    }
  }
  const now = Date.now();
  const byType = {};
  for (const hit of hits) {
    const teaser = hit?.teaser;
    const item = teaser?.item;
    if (!teaser || !item) continue;

    const urlPath = item.urls?.svtplay || "";
    const heading = teaser.heading || "";
    const name = item.name || "";

    // Livesändningen ligger som hel sändning (Episode/Single) under programmet
    // "FIFA Fotbolls-VM 2026". Före/under matchen finns inga sammandrag ännu, så
    // i live-läget letar vi bara efter själva sändningssidan.
    let type;
    if (live) {
      const isBroadcast =
        (item.__typename === "Episode" || item.__typename === "Single") && /fotbolls-vm/i.test(urlPath);
      type = isBroadcast ? "live" : null;
    } else {
      type = classifySvt({ typename: item.__typename, urlPath, heading, name });
    }
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

async function runPool(items, worker, concurrency, onError) {
  const results = new Array(items.length);
  let next = 0;
  async function loop() {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await worker(items[i]);
      } catch (e) {
        results[i] = null;
        if (onError) onError(e);
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
  let firstError = null;
  const perFixture = await runPool(fixtures, fetchForFixture, 5, (e) => {
    if (!firstError) firstError = e;
  });
  fixtures.forEach((fx, i) => {
    if (perFixture[i]) out[fx.key] = perFixture[i];
  });
  const found = Object.keys(out).length;
  // Syns inga träffar men alla anrop fallerade? Logga orsaken så att ett blockerat
  // SVT-anrop inte ser ut som "inga klipp publicerade ännu".
  if (found === 0 && firstError) {
    log(`[svt] inga träffar – senaste fel: ${firstError.message || firstError}`);
  }
  log(`[svt] hittade höjdpunkter för ${found}/${fixtures.length} matcher`);
  return out;
}

/**
 * Livesändning/försnack för pågående eller strax kommande matcher.
 * @param {Array} fixtures matcher från match.loadLiveFixtures()
 * @returns {Object} { matchKey: { live: {url,title,until} } }
 */
export async function fetchSvtLive(fixtures, { log = () => {} } = {}) {
  if (!fixtures.length) return {};
  const out = {};
  const perFixture = await runPool(fixtures, (fx) => fetchForFixture(fx, { live: true }), 5, () => {});
  fixtures.forEach((fx, i) => {
    if (perFixture[i]) out[fx.key] = perFixture[i];
  });
  log(`[svt] hittade livesändning för ${Object.keys(out).length}/${fixtures.length} pågående/kommande matcher`);
  return out;
}
