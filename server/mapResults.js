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

function buildKoSlotMap(fdMatches) {
  const koFd = fdMatches.filter((m) => m.stage && m.stage !== "GROUP_STAGE");
  const byStage = {};
  for (const m of koFd) {
    if (!byStage[m.stage]) byStage[m.stage] = [];
    byStage[m.stage].push(m);
  }

  const slotMap = new Map(); // fd match id -> "k:73"

  for (const stage of Object.keys(byStage)) {
    const ours = KNOCKOUT.filter((k) => k.stage === stage).sort((a, b) =>
      a.date.localeCompare(b.date)
    );
    const theirs = byStage[stage].sort((a, b) =>
      String(a.utcDate).localeCompare(String(b.utcDate))
    );
    for (let i = 0; i < Math.min(ours.length, theirs.length); i++) {
      slotMap.set(theirs[i].id, `k:${ours[i].m}`);
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
