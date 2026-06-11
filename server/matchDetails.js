/*
  Matchdetaljer (mål, kort, byten, domare, publik …) från football-data.org.

  Strategi (samma princip som "smart polling"):
   - Pågående matcher hämtas varje synk så att man kan följa dem live.
   - Avslutade matcher hämtas EN gång och sparas permanent i
     data/matchdetails.json – så kan man klicka sig in på gamla matcher
     och se informationen även långt senare.
   - Kommande matcher hämtas inte alls (sparar API-anrop).
*/

const LIVE_STATUSES = new Set(["IN_PLAY", "PAUSED", "LIVE"]);
const FINAL_STATUSES = new Set(["FINISHED", "AWARDED"]);

/** Max antal detalj-anrop per synk – håller oss under rate limit (10/min). */
export const MAX_DETAIL_CALLS = 6;

export function isLive(status) {
  return LIVE_STATUSES.has(status);
}

export function isFinal(status) {
  return FINAL_STATUSES.has(status);
}

function side(detail, teamRef) {
  if (!teamRef) return null;
  const id = typeof teamRef === "object" ? teamRef.id : teamRef;
  if (id != null && detail.homeTeam?.id === id) return "h";
  if (id != null && detail.awayTeam?.id === id) return "a";
  // fallback på namn
  const name = typeof teamRef === "object" ? teamRef.name : null;
  if (name && detail.homeTeam?.name === name) return "h";
  if (name && detail.awayTeam?.name === name) return "a";
  return null;
}

function scorePair(s) {
  if (!s || (s.home == null && s.away == null)) return null;
  return { h: s.home, a: s.away };
}

/**
 * football-data:s matchobjekt (från /v4/matches/{id}) → kompakt format
 * som frontend kan rendera direkt.
 */
export function mapMatchDetail(fd) {
  const m = fd?.match || fd || {};
  const score = m.score || {};

  const goals = (m.goals || []).map((g) => ({
    minute: g.minute ?? null,
    injuryTime: g.injuryTime ?? null,
    team: side(m, g.team),
    scorer: g.scorer?.name ?? null,
    assist: g.assist?.name ?? null,
    type: g.type ?? null, // REGULAR / OWN / PENALTY
    score: scorePair(g.score),
  }));

  const bookings = (m.bookings || []).map((b) => ({
    minute: b.minute ?? null,
    team: side(m, b.team),
    player: b.player?.name ?? null,
    card: b.card ?? null, // YELLOW / RED / YELLOW_RED
  }));

  const subs = (m.substitutions || []).map((s) => ({
    minute: s.minute ?? null,
    team: side(m, s.team),
    out: s.playerOut?.name ?? null,
    in: s.playerIn?.name ?? null,
  }));

  const referee =
    (m.referees || []).find((r) => r.type === "REFEREE" || !r.type)?.name ?? null;

  const penalties = (m.penalties || []).map((p) => ({
    team: side(m, p.team),
    player: p.player?.name ?? null,
    scored: p.scored ?? null,
  }));

  return {
    fdId: m.id ?? null,
    status: m.status ?? null,
    minute: m.minute ?? null,
    utcDate: m.utcDate ?? null,
    duration: score.duration ?? null, // REGULAR / EXTRA_TIME / PENALTY_SHOOTOUT
    winner: score.winner ?? null,
    score: {
      ft: scorePair(score.fullTime),
      ht: scorePair(score.halfTime),
      rt: scorePair(score.regularTime),
      et: scorePair(score.extraTime),
      pen: scorePair(score.penalties),
    },
    goals,
    bookings,
    subs,
    penalties,
    referee,
    venue: m.venue ?? null,
    attendance: m.attendance ?? null,
    injuryTimeFirstHalf: m.injuryTime?.firstHalf ?? null,
    injuryTimeSecondHalf: m.injuryTime?.secondHalf ?? null,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Välj vilka matcher som behöver detalj-hämtas denna synk.
 *
 * @param {Array} fdMatches  alla matcher från /competitions/WC/matches
 * @param {Map}   keyMap     fd-id → appnyckel
 * @param {Object} stored    befintliga detaljer { key: detail }
 * @returns {Array<{ id, key }>}
 */
export function pickDetailTargets(fdMatches, keyMap, stored, max = MAX_DETAIL_CALLS) {
  const liveTargets = [];
  const finishedTargets = [];

  for (const m of fdMatches) {
    const key = keyMap.get(m.id);
    if (!key) continue;

    if (isLive(m.status)) {
      liveTargets.push({ id: m.id, key });
      continue;
    }

    if (isFinal(m.status)) {
      const have = stored[key];
      // Hämta om vi saknar detaljer, eller om det vi har inte är slutgiltigt.
      if (!have || !isFinal(have.status)) {
        finishedTargets.push({ id: m.id, key, utcDate: m.utcDate || "" });
      }
    }
  }

  // Nyligast avslutade först – mest relevanta om vi måste kapa listan.
  finishedTargets.sort((a, b) => String(b.utcDate).localeCompare(String(a.utcDate)));

  return liveTargets.concat(finishedTargets).slice(0, max);
}
