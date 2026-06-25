const MIN_ROWS = 8;
const MAX_ODDS = 2000;
const MIN_ODDS = 1.01;

/**
 * @param {object} match
 * @param {object[]} scores
 * @returns {string[]}
 */
export function validateMatch(match, scores) {
  const errs = [];
  if (!Array.isArray(scores) || scores.length < MIN_ROWS) {
    errs.push(`för få resultatrader (${scores?.length || 0}, min ${MIN_ROWS})`);
  }
  const seen = new Set();
  for (const s of scores || []) {
    const k = `${s.h}-${s.a}`;
    if (seen.has(k)) errs.push(`dublett ${k}`);
    seen.add(k);
    if (!Number.isFinite(s.odds) || s.odds < MIN_ODDS || s.odds > MAX_ODDS) {
      errs.push(`orimligt odds ${k}: ${s.odds}`);
    }
    if (!Number.isInteger(s.h) || !Number.isInteger(s.a) || s.h < 0 || s.a < 0) {
      errs.push(`ogiltig poäng ${k}`);
    }
  }
  if (!match.home || !match.away) errs.push("saknar lagnamn");
  return errs;
}
