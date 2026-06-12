/*
  Mappar ESPN:s dataformat till samma interna format som football-data
  använde. Tack vare det kan mapResults.js (resultatnycklar, fixtures,
  knockout-parning) och frontend återanvändas helt oförändrade.

   - adaptEvent():        ESPN-scoreboardevent → "fd-liknande" matchobjekt
   - mapEspnDetail():     ESPN-summary → matchdetaljer (mål/kort/byten/statistik)
   - mapEspnStandings():  ESPN-standings → appens tabellformat
*/

import { findAppTeamIndex } from "./mapResults.js";

/* ---------- Status & klocka ---------- */

const SLUG_TO_STAGE = {
  "group-stage": "GROUP_STAGE",
  "round-of-32": "LAST_32",
  "round-of-16": "LAST_16",
  quarterfinals: "QUARTER_FINALS",
  semifinals: "SEMI_FINALS",
  "3rd-place-match": "THIRD_PLACE",
  final: "FINAL",
};

/** ESPN-status → football-data-status som resten av appen förstår. */
export function statusFromEspn(statusObj) {
  const name = statusObj?.type?.name || "";
  const state = statusObj?.type?.state || "";
  if (state === "in") return /HALFTIME/i.test(name) ? "PAUSED" : "IN_PLAY";
  if (state === "post") {
    if (/POSTPONED/i.test(name)) return "POSTPONED";
    if (/CANCEL/i.test(name)) return "CANCELLED";
    return "FINISHED";
  }
  return "TIMED";
}

/** "45'+2'" → { minute: 45, injuryTime: 2 } */
export function parseClock(displayClock) {
  const m = String(displayClock || "").match(/(\d+)'(?:\s*\+\s*(\d+)')?/);
  if (!m) return { minute: null, injuryTime: null };
  return { minute: Number(m[1]), injuryTime: m[2] ? Number(m[2]) : null };
}

function intOrNull(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function competitorsOf(comp) {
  const list = comp?.competitors || [];
  return {
    home: list.find((c) => c.homeAway === "home") || list[0] || null,
    away: list.find((c) => c.homeAway === "away") || list[1] || null,
  };
}

/* ---------- Scoreboard-event → matchobjekt ---------- */

/**
 * ESPN-event → objekt med samma fält som football-data:s matcher
 * (id, utcDate, stage, status, score.fullTime, score.winner, homeTeam, awayTeam)
 * så att mapResults.js kan användas rakt av.
 */
export function adaptEvent(ev) {
  const comp = ev.competitions?.[0] || {};
  const { home, away } = competitorsOf(comp);
  const status = statusFromEspn(ev.status);
  const started = status === "IN_PLAY" || status === "PAUSED" || status === "FINISHED";

  const ft = started
    ? { home: intOrNull(home?.score), away: intOrNull(away?.score) }
    : { home: null, away: null };

  let winner = null;
  if (status === "FINISHED" && ft.home != null && ft.away != null) {
    if (ft.home > ft.away) winner = "HOME_TEAM";
    else if (ft.away > ft.home) winner = "AWAY_TEAM";
    else {
      // Oavgjort – avgör via straffläggning om sådan finns.
      const hp = intOrNull(home?.shootoutScore);
      const ap = intOrNull(away?.shootoutScore);
      if (hp != null && ap != null && hp !== ap) winner = hp > ap ? "HOME_TEAM" : "AWAY_TEAM";
      else if (home?.winner) winner = "HOME_TEAM";
      else if (away?.winner) winner = "AWAY_TEAM";
      else winner = "DRAW";
    }
  }

  return {
    id: ev.id,
    utcDate: ev.date || null,
    stage: SLUG_TO_STAGE[ev.season?.slug] || null,
    status,
    minute: parseClock(ev.status?.displayClock).minute,
    matchday: null,
    homeTeam: { name: home?.team?.displayName || null },
    awayTeam: { name: away?.team?.displayName || null },
    score: { fullTime: ft, winner },
  };
}

/* ---------- Summary → matchdetaljer ---------- */

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "Goal! Mexico 1, South Africa 0. …" → { h: 1, a: 0 } */
function scoreFromText(text, homeName, awayName) {
  if (!text || !homeName || !awayName) return null;
  const h = text.match(new RegExp(escapeRe(homeName) + "\\s+(\\d+)"));
  const a = text.match(new RegExp(escapeRe(awayName) + "\\s+(\\d+)"));
  return h && a ? { h: Number(h[1]), a: Number(a[1]) } : null;
}

/** Statistikrader som sparas och visas i matchmodalen. */
const STAT_KEYS = [
  "possessionPct",
  "totalShots",
  "shotsOnTarget",
  "wonCorners",
  "foulsCommitted",
  "offsides",
  "saves",
  "totalPasses",
  "passPct",
  "yellowCards",
  "redCards",
];

function extractStats(boxscore) {
  const teams = boxscore?.teams || [];
  const h = teams.find((t) => t.homeAway === "home") || teams[0];
  const a = teams.find((t) => t.homeAway === "away") || teams[1];
  if (!h || !a) return [];

  const raw = (team, key) => (team.statistics || []).find((s) => s.name === key)?.displayValue ?? null;
  const val = (team, key) => {
    if (key === "possessionPct") {
      const n = parseFloat(raw(team, key));
      return Number.isFinite(n) ? `${Math.round(n)}%` : null;
    }
    if (key === "passPct") {
      // ESPN:s displayValue är grovt avrundad (t.ex. "0.9") – räkna själv.
      const acc = parseFloat(raw(team, "accuratePasses"));
      const tot = parseFloat(raw(team, "totalPasses"));
      return Number.isFinite(acc) && tot > 0 ? `${Math.round((acc / tot) * 100)}%` : null;
    }
    return raw(team, key);
  };

  const stats = [];
  for (const key of STAT_KEYS) {
    const sh = val(h, key);
    const sa = val(a, key);
    if (sh != null && sa != null) stats.push({ key, h: sh, a: sa });
  }
  return stats;
}

/* ---------- Laguppställningar ---------- */

function mapRosterSide(r) {
  const starters = [];
  const bench = [];
  for (const p of r.roster || []) {
    const name = p.athlete?.displayName || null;
    if (!name) continue;
    if (p.starter) {
      starters.push({
        name,
        jersey: p.jersey || null,
        pos: p.position?.abbreviation || null,
        place: intOrNull(p.formationPlace),
      });
    } else {
      const sub = { name, jersey: p.jersey || null };
      if (p.subbedIn) sub.in = true;
      bench.push(sub);
    }
  }
  // formationPlace 1 = målvakt, sedan position för position bakifrån.
  starters.sort((x, y) => (x.place ?? 99) - (y.place ?? 99));
  for (const s of starters) delete s.place;
  return { formation: r.formation || null, starters, bench };
}

/**
 * ESPN-summary → startelvor + avbytare per lag, eller null om ESPN inte
 * publicerat laguppställningarna ännu (de dyker upp strax före avspark).
 */
export function extractLineups(summary) {
  const rosters = summary?.rosters || [];
  const h = rosters.find((r) => r.homeAway === "home");
  const a = rosters.find((r) => r.homeAway === "away");
  if (!h?.roster?.length || !a?.roster?.length) return null;
  const lh = mapRosterSide(h);
  const la = mapRosterSide(a);
  if (!lh.starters.length || !la.starters.length) return null;
  return { h: lh, a: la };
}

/**
 * ESPN-summary → kompakt detaljobjekt i samma form som tidigare
 * (mapMatchDetail) plus `stats` med matchstatistik.
 */
export function mapEspnDetail(summary) {
  const comp = summary?.header?.competitions?.[0] || {};
  const { home, away } = competitorsOf(comp);
  const homeName = home?.team?.displayName || null;
  const awayName = away?.team?.displayName || null;
  const status = statusFromEspn(comp.status);
  const period = comp.status?.period ?? null;

  const sideOf = (teamObj) => {
    if (!teamObj) return null;
    if (teamObj.id != null && home?.team?.id != null && String(teamObj.id) === String(home.team.id)) return "h";
    if (teamObj.id != null && away?.team?.id != null && String(teamObj.id) === String(away.team.id)) return "a";
    if (teamObj.displayName && teamObj.displayName === homeName) return "h";
    if (teamObj.displayName && teamObj.displayName === awayName) return "a";
    return null;
  };

  const goals = [];
  const bookings = [];
  const subs = [];
  const penalties = []; // straffläggning
  let lastClock = null;

  for (const k of summary?.keyEvents || []) {
    const type = String(k.type?.type || "").toLowerCase();
    const typeText = String(k.type?.text || "");
    const { minute, injuryTime } = parseClock(k.clock?.displayValue);
    if (minute != null) lastClock = { minute, injuryTime };
    const team = sideOf(k.team);
    const p0 = k.participants?.[0]?.athlete?.displayName || null;
    const p1 = k.participants?.[1]?.athlete?.displayName || null;

    if (k.shootout) {
      if (/pen/.test(type)) {
        penalties.push({ team, player: p0, scored: k.scoringPlay === true || /scored|goal/i.test(type + typeText) });
      }
      continue;
    }

    if (type.includes("goal") || k.scoringPlay) {
      const own = /own/i.test(type + typeText);
      const pen = /pen/i.test(type + typeText);
      goals.push({
        minute,
        injuryTime,
        team,
        scorer: p0,
        assist: own || pen ? null : p1,
        type: own ? "OWN" : pen ? "PENALTY" : "REGULAR",
        score: scoreFromText(k.text, homeName, awayName),
      });
    } else if (type.includes("card")) {
      const red = /red/.test(type);
      const yellow = /yellow/.test(type);
      bookings.push({
        minute,
        team,
        player: p0,
        card: red && yellow ? "YELLOW_RED" : red ? "RED" : "YELLOW",
      });
    } else if (type.includes("substitution")) {
      // ESPN: participants[0] = in, participants[1] = ut ("X replaces Y")
      subs.push({ minute, team, in: p0, out: p1 });
    }
  }

  const ft =
    status === "TIMED" || status === "POSTPONED" || status === "CANCELLED"
      ? null
      : { h: intOrNull(home?.score), a: intOrNull(away?.score) };

  // Halvtidsresultat ur period-delresultaten (linescores[0] = första halvlek).
  let ht = null;
  if ((period != null && period >= 2) || status === "FINISHED") {
    const h1 = intOrNull(home?.linescores?.[0]?.displayValue);
    const a1 = intOrNull(away?.linescores?.[0]?.displayValue);
    if (h1 != null && a1 != null) ht = { h: h1, a: a1 };
  }

  const penH = intOrNull(home?.shootoutScore);
  const penA = intOrNull(away?.shootoutScore);
  const pen = penH != null && penA != null ? { h: penH, a: penA } : null;
  const extraTime = (home?.linescores || []).length > 2 || (period != null && period > 2 && !pen);
  const duration = pen ? "PENALTY_SHOOTOUT" : extraTime ? "EXTRA_TIME" : "REGULAR";

  let winner = null;
  if (status === "FINISHED" && ft) {
    if (ft.h > ft.a) winner = "HOME_TEAM";
    else if (ft.a > ft.h) winner = "AWAY_TEAM";
    else if (pen && pen.h !== pen.a) winner = pen.h > pen.a ? "HOME_TEAM" : "AWAY_TEAM";
    else winner = "DRAW";
  }

  const gi = summary?.gameInfo || {};
  const referee =
    (gi.officials || []).find((o) => /referee/i.test(o.position?.displayName || "") && !/assistant|video|fourth/i.test(o.position?.displayName || ""))
      ?.displayName ||
    (gi.officials || [])[0]?.displayName ||
    null;
  const venueName = gi.venue?.fullName || null;
  const venueCity = gi.venue?.address?.city || null;

  const liveClock = parseClock(comp.status?.displayClock);
  const minuteNow = liveClock.minute != null ? liveClock.minute : lastClock ? lastClock.minute : null;

  return {
    espnId: summary?.header?.id || comp.id || null,
    status,
    minute: status === "IN_PLAY" || status === "PAUSED" ? minuteNow : null,
    utcDate: comp.date || null,
    duration: ft ? duration : null,
    winner,
    score: {
      ft,
      ht,
      rt: null,
      et: extraTime && ft ? { ...ft } : null,
      pen,
    },
    goals,
    bookings,
    subs,
    penalties,
    lineups: extractLineups(summary),
    referee,
    venue: venueName ? (venueCity ? `${venueName}, ${venueCity}` : venueName) : null,
    attendance: gi.attendance ?? null,
    stats: extractStats(summary?.boxscore),
    updatedAt: new Date().toISOString(),
  };
}

/* ---------- Standings → appens tabellformat ---------- */

export function mapEspnStandings(data) {
  const out = {};
  for (const child of data?.children || []) {
    const m = String(child.name || child.abbreviation || "").match(/Group\s+([A-L])/i);
    if (!m) continue;
    const letter = m[1].toUpperCase();

    const rows = [];
    for (const entry of child.standings?.entries || []) {
      const ref = findAppTeamIndex(entry.team?.displayName || entry.team?.name);
      if (!ref || ref.group !== letter) continue;

      const stat = (name) => {
        const s = (entry.stats || []).find((x) => x.name === name);
        const v = s ? Number(s.value) : NaN;
        return Number.isFinite(v) ? v : 0;
      };

      const gf = stat("pointsFor");
      const ga = stat("pointsAgainst");
      rows.push({
        idx: ref.idx,
        position: stat("rank") || rows.length + 1,
        pld: stat("gamesPlayed"),
        w: stat("wins"),
        d: stat("ties"),
        l: stat("losses"),
        gf,
        ga,
        gd: stat("pointDifferential") || gf - ga,
        pts: stat("points"),
      });
    }

    rows.sort((a, b) => a.position - b.position);
    if (rows.length) out[letter] = rows;
  }
  return out;
}
