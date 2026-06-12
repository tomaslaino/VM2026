import {
  KNOCKOUT,
  WC_GROUPS,
  canonicalTeam,
  extractResult,
  groupPairLookup,
  isLiveStatus,
  normName,
  parseGroupLetter,
} from "./wcFixtures.js";

/*
  Appens gruppnycklar (g:A:0 …) har en fast hemma/borta-ordning som inte
  alltid stämmer med API:ets verkliga spelordning. När ordningen är omvänd
  (reversed) speglas h/a här, så att ALLT som sparas på en gruppnyckel är i
  appens ordning – annars hamnar resultat och händelser på fel lag.
*/
function flipResult(r) {
  if (!r) return r;
  const out = { ...r, h: r.a, a: r.h };
  if (r.pw === "h") out.pw = "a";
  else if (r.pw === "a") out.pw = "h";
  return out;
}

function pad(n) {
  return String(n).padStart(2, "0");
}

/** UTC ISO → svensk tid (CEST, UTC+2). */
export function utcToSwedish(utcDate) {
  const d = new Date(utcDate);
  const sw = new Date(d.getTime() + 2 * 3600000);
  return {
    date: `${sw.getUTCFullYear()}-${pad(sw.getUTCMonth() + 1)}-${pad(sw.getUTCDate())}`,
    time: `${pad(sw.getUTCHours())}:${pad(sw.getUTCMinutes())}`,
    utcDate: String(utcDate),
  };
}

/** Hitta lag i WC_GROUPS utifrån API-namn. */
export function findAppTeamIndex(apiName) {
  if (!apiName) return null;
  const canon = canonicalTeam(apiName);
  const cn = normName(canon);
  for (const [letter, teams] of Object.entries(WC_GROUPS)) {
    for (let i = 0; i < teams.length; i++) {
      const t = teams[i];
      if (normName(t) === cn || normName(canonicalTeam(t)) === cn) return { group: letter, idx: i };
    }
  }
  return null;
}

/*
  Mappar football-data-matchobjekt till appens resultatnycklar.
*/

/*
  Parar football-data:s slutspelsmatcher mot appens matchnummer (k:73 … k:104).

  Slutspelets matchnummer följer FIFA:s fasta bracket-position, vilket INTE är
  samma som kronologisk ordning. Att bara sortera båda listorna på tid och para
  index-för-index lägger därför flera matcher på fel plats i trädet.

  Därför matchar vi i första hand på exakt avsparkstid (UTC) mot KNOCKOUT.utc,
  som är hämtad från det officiella schemat. Skulle en match ha flyttats (ingen
  exakt tidsträff) faller vi tillbaka på kronologisk ordning för de som blir
  över – så att inget lämnas omappat.
*/
export function buildKoSlotMap(fdMatches) {
  const koFd = fdMatches.filter((m) => m.stage && m.stage !== "GROUP_STAGE");
  const byStage = {};
  for (const m of koFd) {
    if (!byStage[m.stage]) byStage[m.stage] = [];
    byStage[m.stage].push(m);
  }

  const slotMap = new Map(); // fd match id -> "k:73"

  for (const stage of Object.keys(byStage)) {
    const ours = KNOCKOUT.filter((k) => k.stage === stage);
    const theirs = byStage[stage];

    const utcToOurs = new Map();
    for (const k of ours) {
      if (k.utc) utcToOurs.set(Date.parse(k.utc), k);
    }

    const takenM = new Set();
    const matchedIds = new Set();

    // 1) Exakt parning på avsparkstid.
    for (const m of theirs) {
      const t = m.utcDate ? Date.parse(m.utcDate) : NaN;
      const k = utcToOurs.get(t);
      if (k && !takenM.has(k.m)) {
        slotMap.set(m.id, `k:${k.m}`);
        takenM.add(k.m);
        matchedIds.add(m.id);
      }
    }

    // 2) Kronologisk fallback för ev. omflyttade matcher.
    const restOurs = ours
      .filter((k) => !takenM.has(k.m))
      .sort((a, b) => String(a.utc || a.date).localeCompare(String(b.utc || b.date)));
    const restTheirs = theirs
      .filter((m) => !matchedIds.has(m.id))
      .sort((a, b) => String(a.utcDate).localeCompare(String(b.utcDate)));
    for (let i = 0; i < Math.min(restOurs.length, restTheirs.length); i++) {
      slotMap.set(restTheirs[i].id, `k:${restOurs[i].m}`);
    }
  }
  return slotMap;
}

export function mapMatchesToResults(fdMatches) {
  const pairMap = groupPairLookup();
  const koMap = buildKoSlotMap(fdMatches);

  const results = {};
  const live = [];
  let mapped = 0;
  let skipped = 0;

  for (const m of fdMatches) {
    let r = extractResult(m);
    let homeName = m.homeTeam?.name;
    let awayName = m.awayTeam?.name;

    let key = null;
    let reversed = false;

    if (m.stage === "GROUP_STAGE" && homeName && awayName) {
      const hit = pairMap.get(`${canonicalTeam(homeName)}|${canonicalTeam(awayName)}`) || null;
      key = hit ? hit.key : null;
      reversed = hit ? hit.reversed : false;
      if (!key) {
        const g = parseGroupLetter(m.group);
        if (g) {
          // Fallback: matcha på grupp + lagnamn via pairMap (redan täckt)
          skipped++;
        }
      }
    } else if (m.stage !== "GROUP_STAGE") {
      key = koMap.get(m.id) || null;
    }

    if (!key) {
      if (r) skipped++;
      continue;
    }

    if (reversed) {
      r = flipResult(r);
      [homeName, awayName] = [awayName, homeName];
    }

    if (r) {
      results[key] = r;
      mapped++;
    }

    if (isLiveStatus(m.status) && r) {
      live.push({
        key,
        status: m.status,
        minute: m.minute ?? null,
        home: homeName,
        away: awayName,
        score: `${r.h}-${r.a}`,
      });
    }
  }

  return { results, live, mapped, skipped, koMap: Object.fromEntries(koMap) };
}

/*
  Mappar football-data:s tabellsvar (/standings) till appens grupper.
  football-data publicerar redan den officiella ordningen (position), vilket
  innefattar alla särskiljningsregler – inkl. fair play – som vi inte kan
  räkna fram lokalt. Frontend använder denna ordning för placeringarna.

  Returnerar { A: [{ idx, position, pld, w, d, l, gf, ga, gd, pts }], ... }
  där idx är lagets index i WC_GROUPS-gruppen.
*/
export function mapStandings(fdStandings) {
  const out = {};
  const standings = fdStandings?.standings || [];

  for (const s of standings) {
    // Endast totalställningar för gruppspelet (inte hemma/borta-uppdelningar).
    if (s.type && s.type !== "TOTAL") continue;
    const letter = parseGroupLetter(s.group);
    if (!letter) continue;

    const rows = [];
    for (const row of s.table || []) {
      const name = row.team?.name || row.team?.shortName || row.team?.tla;
      const ref = findAppTeamIndex(name);
      if (!ref || ref.group !== letter) continue;

      const gf = row.goalsFor ?? 0;
      const ga = row.goalsAgainst ?? 0;
      rows.push({
        idx: ref.idx,
        position: row.position ?? rows.length + 1,
        pld: row.playedGames ?? 0,
        w: row.won ?? 0,
        d: row.draw ?? 0,
        l: row.lost ?? 0,
        gf,
        ga,
        gd: row.goalDifference ?? gf - ga,
        pts: row.points ?? 0,
      });
    }

    rows.sort((a, b) => a.position - b.position);
    if (rows.length) out[letter] = rows;
  }

  return out;
}

/**
 * football-data match-id → { key, reversed } där key är appens resultat-
 * nyckel ("g:A:0" / "k:73") och reversed anger om API:ets hemma/borta-ordning
 * är omvänd mot appens (endast relevant för gruppmatcher).
 */
export function buildKeyMap(fdMatches) {
  const pairMap = groupPairLookup();
  const koMap = buildKoSlotMap(fdMatches);
  const map = new Map();

  for (const m of fdMatches) {
    if (m.stage === "GROUP_STAGE" && m.homeTeam?.name && m.awayTeam?.name) {
      const hit =
        pairMap.get(`${canonicalTeam(m.homeTeam.name)}|${canonicalTeam(m.awayTeam.name)}`) || null;
      if (hit) map.set(m.id, { key: hit.key, reversed: hit.reversed });
    } else if (m.stage !== "GROUP_STAGE") {
      const key = koMap.get(m.id) || null;
      if (key) map.set(m.id, { key, reversed: false });
    }
  }
  return map;
}

/** Alla matcher → schema (datum/tid/lag) för frontend. */
export function mapMatchesToFixtures(fdMatches) {
  const pairMap = groupPairLookup();
  const koMap = buildKoSlotMap(fdMatches);
  const fixtures = {};

  for (const m of fdMatches) {
    let homeName = m.homeTeam?.name || null;
    let awayName = m.awayTeam?.name || null;
    let key = null;

    if (m.stage === "GROUP_STAGE" && homeName && awayName) {
      const hit = pairMap.get(`${canonicalTeam(homeName)}|${canonicalTeam(awayName)}`) || null;
      key = hit ? hit.key : null;
      // Spegla till appens fasta hemma/borta-ordning (se groupPairLookup).
      if (hit && hit.reversed) [homeName, awayName] = [awayName, homeName];
    } else if (m.stage !== "GROUP_STAGE") {
      key = koMap.get(m.id) || null;
    }

    if (!key || !m.utcDate) continue;

    const { date, time, utcDate } = utcToSwedish(m.utcDate);
    fixtures[key] = {
      date,
      time,
      utcDate,
      status: m.status || null,
      matchday: m.matchday ?? null,
      home: homeName,
      away: awayName,
      homeRef: findAppTeamIndex(homeName),
      awayRef: findAppTeamIndex(awayName),
    };
  }

  return fixtures;
}
