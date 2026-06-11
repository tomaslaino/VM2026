import {
  KNOCKOUT,
  WC_GROUPS,
  canonicalTeam,
  extractResult,
  groupPairToKey,
  isLiveStatus,
  normName,
  parseGroupLetter,
} from "./wcFixtures.js";

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
  const pairMap = groupPairToKey();
  const koMap = buildKoSlotMap(fdMatches);

  const results = {};
  const live = [];
  let mapped = 0;
  let skipped = 0;

  for (const m of fdMatches) {
    const r = extractResult(m);
    const homeName = m.homeTeam?.name;
    const awayName = m.awayTeam?.name;

    let key = null;

    if (m.stage === "GROUP_STAGE" && homeName && awayName) {
      key =
        pairMap.get(`${canonicalTeam(homeName)}|${canonicalTeam(awayName)}`) ||
        pairMap.get(`${canonicalTeam(awayName)}|${canonicalTeam(homeName)}`) ||
        null;
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

/** football-data match-id → appens resultatnyckel ("g:A:0" / "k:73"). */
export function buildKeyMap(fdMatches) {
  const pairMap = groupPairToKey();
  const koMap = buildKoSlotMap(fdMatches);
  const map = new Map();

  for (const m of fdMatches) {
    let key = null;
    if (m.stage === "GROUP_STAGE" && m.homeTeam?.name && m.awayTeam?.name) {
      key =
        pairMap.get(`${canonicalTeam(m.homeTeam.name)}|${canonicalTeam(m.awayTeam.name)}`) || null;
    } else if (m.stage !== "GROUP_STAGE") {
      key = koMap.get(m.id) || null;
    }
    if (key) map.set(m.id, key);
  }
  return map;
}

/** Alla matcher → schema (datum/tid/lag) för frontend. */
export function mapMatchesToFixtures(fdMatches) {
  const pairMap = groupPairToKey();
  const koMap = buildKoSlotMap(fdMatches);
  const fixtures = {};

  for (const m of fdMatches) {
    const homeName = m.homeTeam?.name || null;
    const awayName = m.awayTeam?.name || null;
    let key = null;

    if (m.stage === "GROUP_STAGE" && homeName && awayName) {
      key =
        pairMap.get(`${canonicalTeam(homeName)}|${canonicalTeam(awayName)}`) ||
        pairMap.get(`${canonicalTeam(awayName)}|${canonicalTeam(homeName)}`) ||
        null;
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
