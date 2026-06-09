/*
  Server-sidans bild av vilka lag som ingår i VM och i vilken grupp de spelar.
  Speglar WC.groups i assets/data.js (engelska namn används för att matcha
  mot API-Footballs lagnamn). Uppdatera här om lottningen ändras.
*/
export const WC_GROUPS = {
  A: ["Mexico", "South Korea", "South Africa", "Czechia"],
  B: ["Canada", "Switzerland", "Qatar", "Bosnia-Herzegovina"],
  C: ["Brazil", "Morocco", "Scotland", "Haiti"],
  D: ["USA", "Paraguay", "Australia", "Türkiye"],
  E: ["Germany", "Ecuador", "Ivory Coast", "Curaçao"],
  F: ["Netherlands", "Japan", "Tunisia", "Sweden"],
  G: ["Belgium", "Iran", "Egypt", "New Zealand"],
  H: ["Spain", "Uruguay", "Saudi Arabia", "Cape Verde"],
  I: ["France", "Senegal", "Norway", "Iraq"],
  J: ["Argentina", "Austria", "Algeria", "Jordan"],
  K: ["Portugal", "Colombia", "Uzbekistan", "DR Congo"],
  L: ["England", "Croatia", "Panama", "Ghana"],
};

/** Plattare lista: [{ name, group }] */
export const WC_TEAM_LIST = Object.entries(WC_GROUPS).flatMap(([group, names]) =>
  names.map((name) => ({ name, group }))
);

/** Alternativa namn -> kanoniskt namn (API-Football kan skilja sig från data.js). */
export const NAME_ALIASES = {
  "korea republic": "South Korea",
  "south korea": "South Korea",
  "czech republic": "Czechia",
  "turkey": "Türkiye",
  "turkiye": "Türkiye",
  "ivory coast": "Ivory Coast",
  "cote d'ivoire": "Ivory Coast",
  "côte d'ivoire": "Ivory Coast",
  "usa": "USA",
  "united states": "USA",
  "cape verde islands": "Cape Verde",
  "dr congo": "DR Congo",
  "congo dr": "DR Congo",
  "bosnia and herzegovina": "Bosnia-Herzegovina",
};
