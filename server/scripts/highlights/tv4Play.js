/*
  Hämtar repris + sammandrag från TV4 Play via deras GraphQL-gateway
  (client-gateway.tv4.a2d.tv). Ingen inloggning behövs för metadata – vi sparar
  bara de publika sidlänkarna, inte videoströmmarna.

  VM-innehållet ligger samlat på en "page" (id "fifa-fotbolls-vm-2026") med
  paneler:
    - ClipsPanel "Matchsammandrag": klipp "Höjdpunkter: A - B" (short) och
      ibland "Extended: A - B" (long).
    - SportEventPanel ("Tidigare sändningar" m.fl.): hela matcher i repris.

  Gatewayen kräver en giltig Client-Version-header. Den kan bli inaktuell när
  TV4 uppdaterar sin webb, så versionen kan sättas via env (TV4_CLIENT_VERSION)
  och upptäcks annars automatiskt från tv4play.se.
*/
import { classifyTv4Clip, cleanTitle } from "./classify.js";
import { extractTeamIds } from "./match.js";

const TV4_GQL = "https://client-gateway.tv4.a2d.tv/graphql";
const TV4_BASE = "https://www.tv4play.se";
const DEFAULT_VERSION = process.env.TV4_CLIENT_VERSION || "5.5.0";
const PAGE_ID = process.env.TV4_WC_PAGE_ID || "fifa-fotbolls-vm-2026";

const PAGE_QUERY = `query($id:ID!){
  page(id:$id){
    content(input:{limit:40,offset:0}){
      items {
        __typename
        ... on ClipsPanel {
          title
          content(input:{limit:200,offset:0}){
            items { clip { id title slug duration { seconds } playableUntil { isoString } } }
          }
        }
        ... on SportEventPanel {
          title
          content(input:{limit:200,offset:0}){
            items { sportEvent { id title slug playableFrom { isoString } playableUntil { isoString } } }
          }
        }
      }
    }
  }
}`;

function headers(version) {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "Client-Name": "tv4-web",
    "Client-Version": version,
  };
}

async function gql(body, version) {
  const res = await fetch(TV4_GQL, { method: "POST", headers: headers(version), body: JSON.stringify(body) });
  const json = await res.json().catch(() => null);
  return json;
}

function isDeprecated(json) {
  return !!json?.errors?.some((e) => e?.extensions?.code === "CLIENT_IS_DEPRECATED");
}

/* Plocka fram en giltig Client-Version från tv4play.se om den inbyggda blivit
   inaktuell: skanna sajtens JS-buntar efter semver-strängar och testa dem. */
async function discoverVersion() {
  try {
    const html = await (await fetch(TV4_BASE + "/")).text();
    const chunks = [...html.matchAll(/\/_next\/static\/chunks\/[A-Za-z0-9_\-/.]+\.js/g)].map((m) => m[0]);
    const versions = new Set();
    for (const path of [...new Set(chunks)].slice(0, 25)) {
      try {
        const js = await (await fetch(TV4_BASE + path)).text();
        for (const m of js.matchAll(/version:"(\d+\.\d+\.\d+)"/g)) versions.add(m[1]);
      } catch { /* hoppa över trasig chunk */ }
    }
    for (const v of versions) {
      const probe = await gql({ query: "{ __typename }" }, v);
      if (probe && !isDeprecated(probe)) return v;
    }
  } catch { /* faller tillbaka nedan */ }
  return null;
}

async function fetchPage() {
  let version = DEFAULT_VERSION;
  let json = await gql({ query: PAGE_QUERY, variables: { id: PAGE_ID } }, version);
  if (isDeprecated(json)) {
    const found = await discoverVersion();
    if (found) {
      version = found;
      json = await gql({ query: PAGE_QUERY, variables: { id: PAGE_ID } }, version);
    }
  }
  if (json?.errors) throw new Error("TV4: " + JSON.stringify(json.errors[0]?.message || json.errors[0]));
  return json?.data?.page?.content?.items || [];
}

function tv4Url(kind, id, slug) {
  const seg = kind === "clip" ? "klipp" : "video";
  return `${TV4_BASE}/${seg}/${id}${slug ? "/" + slug : ""}`;
}

/**
 * @param {(ids:string[])=>string|null} matchKeyForTitle löser lagpar → matchnyckel.
 * @param {Set<string>} liveKeys nycklar för pågående/kommande matcher. För dessa
 *   blir matchsändningen en "live"-länk (även innan avspark/försnack), i stället
 *   för en "full"-repris.
 * @returns {Object} { matchKey: { full?, long?, short?, live? } }
 */
export async function fetchTv4Highlights(matchKeyForTitle, liveKeys = new Set(), { log = () => {} } = {}) {
  const panels = await fetchPage();
  const now = Date.now();
  const out = {};

  function put(key, type, entry) {
    if (!key) return;
    if (!out[key]) out[key] = {};
    if (!out[key][type]) out[key][type] = entry;
  }

  for (const panel of panels) {
    if (panel.__typename === "ClipsPanel") {
      for (const item of panel.content?.items || []) {
        const clip = item?.clip;
        if (!clip) continue;
        const type = classifyTv4Clip(clip.title);
        if (!type) continue;
        const ids = extractTeamIds(clip.title);
        if (ids.length !== 2) continue;
        const until = clip.playableUntil?.isoString || null;
        if (until && new Date(until).getTime() <= now) continue;
        const key = matchKeyForTitle(ids);
        put(key, type, { url: tv4Url("clip", clip.id, clip.slug), title: cleanTitle(clip.title), until });
      }
    } else if (panel.__typename === "SportEventPanel") {
      for (const item of panel.content?.items || []) {
        const ev = item?.sportEvent;
        if (!ev) continue;
        const ids = extractTeamIds(ev.title);
        if (ids.length !== 2) continue;
        const from = ev.playableFrom?.isoString ? new Date(ev.playableFrom.isoString).getTime() : 0;
        const until = ev.playableUntil?.isoString || null;
        if (until && new Date(until).getTime() <= now) continue;
        const key = matchKeyForTitle(ids);
        if (!key) continue;
        const entry = { url: tv4Url("event", ev.id, ev.slug), title: cleanTitle(ev.title), until };
        if (liveKeys.has(key)) {
          // Pågående/kommande match: själva matchsändningen (live + försnack).
          if (ev.playableFrom?.isoString) entry.from = ev.playableFrom.isoString;
          put(key, "live", entry);
        } else if (from <= now) {
          // Spelad match: repris som går att spela nu (inte kommande sändningar).
          put(key, "full", entry);
        }
      }
    }
  }

  log(`[tv4] hittade höjdpunkter/repriser för ${Object.keys(out).length} matcher`);
  return out;
}
