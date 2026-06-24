/*
  Klassificering av klipp till tre typer som matchmodalen visar:
    full  – hela matchen i repris
    long  – längre/utökat sammandrag
    short – kortare sammandrag/höjdpunkter

  SVT och TV4 namnger sina klipp olika, så varje källa har sin egen regel.
  Här finns även hjälpare för att rensa HTML (SVT:s sökträffar märker upp
  sökorden med <em>) och avkoda entiteter.
*/

const ENTITIES = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

export function decodeEntities(s) {
  return String(s == null ? "" : s).replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENTITIES[m] || m);
}

export function stripTags(s) {
  return String(s == null ? "" : s).replace(/<[^>]*>/g, "");
}

/** Rensad, läsbar titel (utan <em>-taggar och utan HTML-entiteter). */
export function cleanTitle(s) {
  return decodeEntities(stripTags(s)).replace(/\s+/g, " ").trim();
}

const RE_LONG = /(ut(ö|o)kade\s+h(ö|o)jdpunkter|l(ä|a)ngre\s+sammandrag|f(ö|o)rl(ä|a)ngt\s+sammandrag|extended)/i;
const RE_SHORT = /(h(ö|o)jdpunkter|sammandrag|^grupp\s+[a-l]\b|(å|a)ttondelsfinal|kvartsfinal|semifinal|bronsmatch|\bfinal\b)/i;

// TV4-klippen är prefixade ("Höjdpunkter: A - B", "Extended: A - B"), så här
// ankras mönstren i början för att inte fånga nyhetsklipp som råkar nämna ordet.
const RE_TV4_LONG = /^(extended|ut(ö|o)kade\s+h(ö|o)jdpunkter|l(ä|a)ngre\s+sammandrag)/i;
const RE_TV4_SHORT = /^(h(ö|o)jdpunkter|sammandrag)\b/i;

/**
 * Klassificera en SVT-sökträff (teaser + item).
 * @returns {"full"|"long"|"short"|null}
 */
export function classifySvt({ typename, urlPath, heading, name }) {
  // Hela matchen ligger som Episode under programmet "FIFA Fotbolls-VM 2026".
  if (typename === "Episode" && /fotbolls-vm/i.test(urlPath || "")) return "full";
  if (typename !== "Clip") return null;
  const text = cleanTitle(`${heading || ""} ${name || ""}`);
  if (RE_LONG.test(text)) return "long";
  if (RE_SHORT.test(text)) return "short";
  return null;
}

/**
 * Klassificera ett TV4-klipp ur panelen "Matchsammandrag".
 * "Extended: …" är det längre sammandraget, "Höjdpunkter: …" det kortare.
 * @returns {"long"|"short"|null}
 */
export function classifyTv4Clip(title) {
  const text = cleanTitle(title);
  if (RE_TV4_LONG.test(text)) return "long";
  if (RE_TV4_SHORT.test(text)) return "short";
  return null;
}
