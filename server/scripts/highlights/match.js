/*
  Matchning av SVT/TV4-klipp mot appens matchnycklar (g:L:idx, k:NN).

  Klippen namnges på svenska ("Höjdpunkter: Sverige - Tunisien", "Grupp F:
  Sverige – Tunisien", "Schweiz - Kanada" osv). Här mappas de svenska lagnamnen
  till samma kanoniska engelska namn som resten av appen använder, och ett
  lagpar matchas mot rätt spelad match via data/results.json (fixtures).

  Eftersom två lag möts exakt en gång (både i grupp och slutspel) räcker
  lagparet {hemma, borta} för att entydigt peka ut matchen – ordningen spelar
  ingen roll.
*/
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalTeam, normName } from "../../wcFixtures.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const RESULTS_FILE = path.join(__dir, "../../../data/results.json");

/*
  Svenskt visningsnamn -> engelskt namn (samma som WC_GROUPS i wcTeams.js).
  Täcker både SVT:s och TV4:s stavningar, inklusive kortformer som "Bosnien"
  och "DR Kongo".
*/
const SV_TO_EN = [
  ["Mexiko", "Mexico"],
  ["Sydkorea", "South Korea"],
  ["Sydafrika", "South Africa"],
  ["Tjeckien", "Czechia"],
  ["Kanada", "Canada"],
  ["Schweiz", "Switzerland"],
  ["Qatar", "Qatar"],
  ["Bosnien och Hercegovina", "Bosnia-Herzegovina"],
  ["Bosnien", "Bosnia-Herzegovina"],
  ["Brasilien", "Brazil"],
  ["Marocko", "Morocco"],
  ["Skottland", "Scotland"],
  ["Haiti", "Haiti"],
  ["USA", "USA"],
  ["Paraguay", "Paraguay"],
  ["Australien", "Australia"],
  ["Turkiet", "Türkiye"],
  ["Tyskland", "Germany"],
  ["Ecuador", "Ecuador"],
  ["Elfenbenskusten", "Ivory Coast"],
  ["Curaçao", "Curaçao"],
  ["Curacao", "Curaçao"],
  ["Nederländerna", "Netherlands"],
  ["Japan", "Japan"],
  ["Tunisien", "Tunisia"],
  ["Sverige", "Sweden"],
  ["Belgien", "Belgium"],
  ["Iran", "Iran"],
  ["Egypten", "Egypt"],
  ["Nya Zeeland", "New Zealand"],
  ["Spanien", "Spain"],
  ["Uruguay", "Uruguay"],
  ["Saudiarabien", "Saudi Arabia"],
  ["Kap Verde", "Cape Verde"],
  ["Frankrike", "France"],
  ["Senegal", "Senegal"],
  ["Norge", "Norway"],
  ["Irak", "Iraq"],
  ["Argentina", "Argentina"],
  ["Österrike", "Austria"],
  ["Algeriet", "Algeria"],
  ["Jordanien", "Jordan"],
  ["Portugal", "Portugal"],
  ["Colombia", "Colombia"],
  ["Uzbekistan", "Uzbekistan"],
  ["Kongo-Kinshasa", "DR Congo"],
  ["DR Kongo", "DR Congo"],
  ["Kongo", "DR Congo"],
  ["England", "England"],
  ["Kroatien", "Croatia"],
  ["Panama", "Panama"],
  ["Ghana", "Ghana"],
];

/** Kanoniskt lag-id (normaliserat engelskt namn) – matchningens nyckel. */
function teamId(enName) {
  return normName(canonicalTeam(enName));
}

/* Förberäknade svenska sökord, längsta först så att "Bosnien och Hercegovina"
   prövas före "Bosnien" (spelar ingen roll för resultatet men ger renare träff). */
const SV_LOOKUP = SV_TO_EN.map(([sv, en]) => ({ norm: normName(sv), id: teamId(en) }))
  .sort((a, b) => b.norm.length - a.norm.length);

/* Engelskt lag-id -> primärt svenskt visningsnamn (för SVT-sökfrågor). */
const EN_TO_SV_PRIMARY = (() => {
  const m = {};
  for (const [sv, en] of SV_TO_EN) {
    const id = teamId(en);
    if (!m[id]) m[id] = sv;
  }
  return m;
})();

/** Svenskt sökvänligt namn för ett (engelskt) lag, för SVT-sökfrågan. */
export function swedishNameFor(enName) {
  return EN_TO_SV_PRIMARY[teamId(enName)] || enName;
}

/**
 * Hitta de VM-lag som nämns i en (svensk) titel. Returnerar en lista med
 * kanoniska lag-id:n (utan dubbletter), i den ordning de hittas.
 */
export function extractTeamIds(title) {
  const hay = normName(title);
  const found = [];
  for (const t of SV_LOOKUP) {
    if (t.norm && hay.indexOf(t.norm) !== -1 && found.indexOf(t.id) === -1) {
      found.push(t.id);
    }
  }
  return found;
}

function pairKey(idA, idB) {
  return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

/**
 * Läs data/results.json och returnera spelade matcher som behöver höjdpunkter.
 * Slutspelsmatcher tas bara med när lagen är bestämda (annars står t.ex.
 * "Group A 2nd Place" som lagnamn).
 */
export function loadPlayedFixtures() {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8"));
  } catch {
    return [];
  }
  const fixtures = json.fixtures || {};
  const results = json.results || {};
  const out = [];
  for (const [key, fx] of Object.entries(fixtures)) {
    const finished =
      fx.status === "FINISHED" ||
      fx.status === "AWARDED" ||
      (results[key] && (results[key].status === "FINISHED" || results[key].h != null));
    if (!finished) continue;
    if (!fx.home || !fx.away) continue;
    const idH = teamId(fx.home);
    const idA = teamId(fx.away);
    // Slutspelsplatshållare ("Group A 2nd Place", "Winner Match 73") mappar inte
    // till något lag-id och hoppas därför över tills lagen är klara.
    if (!isKnownTeam(idH) || !isKnownTeam(idA)) continue;
    out.push({ key, home: fx.home, away: fx.away, date: fx.date, idH, idA });
  }
  return out;
}

const KNOWN_IDS = new Set(SV_LOOKUP.map((t) => t.id));
function isKnownTeam(id) {
  return KNOWN_IDS.has(id);
}

function isFinishedFixture(key, fx, results) {
  return (
    fx.status === "FINISHED" ||
    fx.status === "AWARDED" ||
    (results[key] && (results[key].status === "FINISHED" || results[key].h != null))
  );
}

function fixtureTs(fx) {
  if (fx.utcDate) {
    const t = Date.parse(fx.utcDate);
    if (!Number.isNaN(t)) return t;
  }
  if (fx.date && fx.time) {
    const t = Date.parse(`${fx.date}T${fx.time}`);
    if (!Number.isNaN(t)) return t;
  }
  return NaN;
}

/**
 * Pågående, strax kommande eller nyss avslutade matcher (med kända lag) som kan
 * ha en livesändning att länka till. Avgränsas tidsmässigt så att inte hela
 * spelschemat söks: från preHours före avspark till postHours efter.
 *
 * Nyss avslutade matcher tas medvetet med: SVT/TV4 låter ofta hela sändningen
 * ligga kvar en stund efter slutsignal (man kan spola till början), och innan
 * sammandragen publicerats är det den enda länken till matchen. När sändningen
 * tas bort eller "tillgänglig till" passerat faller länken bort av sig själv.
 */
export function loadLiveFixtures(preHours = 4, postHours = 6) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(RESULTS_FILE, "utf8"));
  } catch {
    return [];
  }
  const fixtures = json.fixtures || {};
  const results = json.results || {};
  const now = Date.now();
  const preWin = preHours * 3600 * 1000;
  const postWin = postHours * 3600 * 1000;
  const out = [];
  for (const [key, fx] of Object.entries(fixtures)) {
    if (!fx.home || !fx.away) continue;
    const idH = teamId(fx.home);
    const idA = teamId(fx.away);
    if (!isKnownTeam(idH) || !isKnownTeam(idA)) continue;
    const ts = fixtureTs(fx);
    if (Number.isNaN(ts)) {
      // Utan känd avsparkstid går matchen inte att tidsbegränsa – ta då bara med
      // den om den ännu inte spelats (annars vet vi inte om sändningen ligger kvar).
      if (isFinishedFixture(key, fx, results)) continue;
    } else {
      if (ts - now > preWin) continue; // för långt fram i tiden
      if (now - ts > postWin) continue; // avspark för länge sedan
    }
    out.push({ key, home: fx.home, away: fx.away, date: fx.date, idH, idA });
  }
  return out;
}

/** Bygg uppslag: lagpar -> matchnyckel för spelade matcher. */
export function buildPairIndex(fixtures) {
  const idx = new Map();
  for (const fx of fixtures) idx.set(pairKey(fx.idH, fx.idA), fx.key);
  return idx;
}

/**
 * Matcha en klipptitel mot en matchnyckel. Kräver att exakt två kända lag
 * nämns och att de bildar en spelad match.
 */
export function matchTitleToKey(title, pairIndex) {
  const ids = extractTeamIds(title);
  if (ids.length !== 2) return null;
  return pairIndex.get(pairKey(ids[0], ids[1])) || null;
}

/** Matchnyckel från ett redan extraherat lagpar (två kanoniska lag-id:n). */
export function keyForIds(ids, pairIndex) {
  if (!ids || ids.length !== 2) return null;
  return pairIndex.get(pairKey(ids[0], ids[1])) || null;
}
