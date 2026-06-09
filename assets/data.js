/*
  Statisk turneringsdata för VM 2026 (USA, Mexiko, Kanada).
  Grupper, lag och slutspelsstruktur är hämtade från den bifogade
  faktarutan samt FIFA / Wikipedia (2026 FIFA World Cup knockout stage).
  Matchtider anges i EDT och är preliminära – verifiera mot FIFA.com nära matchdag.
  Svensk tid (CEST) = EDT + 6 timmar.
*/

window.WC = {};

/* ---------- Arenor ---------- */
WC.venues = {
  losangeles:   { city: "Los Angeles",            country: "USA",    stadium: "Los Angeles Stadium",            real: "SoFi Stadium, Inglewood" },
  boston:       { city: "Boston",                 country: "USA",    stadium: "Boston Stadium",                 real: "Gillette Stadium, Foxborough" },
  monterrey:    { city: "Monterrey",              country: "Mexiko", stadium: "Estadio Monterrey",              real: "Estadio BBVA, Guadalupe" },
  houston:      { city: "Houston",                country: "USA",    stadium: "Houston Stadium",                real: "NRG Stadium" },
  newyork:      { city: "New York / New Jersey",  country: "USA",    stadium: "New York New Jersey Stadium",    real: "MetLife Stadium, East Rutherford" },
  dallas:       { city: "Dallas",                 country: "USA",    stadium: "Dallas Stadium",                 real: "AT&T Stadium, Arlington" },
  mexicocity:   { city: "Mexico City",            country: "Mexiko", stadium: "Estadio Azteca",                 real: "Estadio Azteca, Mexico City" },
  atlanta:      { city: "Atlanta",                country: "USA",    stadium: "Atlanta Stadium",                real: "Mercedes-Benz Stadium" },
  sanfrancisco: { city: "San Francisco Bay Area", country: "USA",    stadium: "San Francisco Bay Area Stadium", real: "Levi's Stadium, Santa Clara" },
  seattle:      { city: "Seattle",                country: "USA",    stadium: "Seattle Stadium",                real: "Lumen Field" },
  toronto:      { city: "Toronto",                country: "Kanada", stadium: "Toronto Stadium",                real: "BMO Field" },
  vancouver:    { city: "Vancouver",              country: "Kanada", stadium: "BC Place Vancouver",             real: "BC Place" },
  miami:        { city: "Miami",                  country: "USA",    stadium: "Miami Stadium",                  real: "Hard Rock Stadium, Miami Gardens" },
  kansascity:   { city: "Kansas City",            country: "USA",    stadium: "Kansas City Stadium",            real: "Arrowhead Stadium" },
  philadelphia: { city: "Philadelphia",           country: "USA",    stadium: "Philadelphia Stadium",           real: "Lincoln Financial Field" },
  guadalajara:  { city: "Guadalajara",            country: "Mexiko", stadium: "Estadio Guadalajara",            real: "Estadio Akron" }
};

/* ---------- Grupper (A–L) ---------- */
/* host = värdnation (Mexiko, USA, Kanada) */
WC.groups = {
  A: [
    { name: "Mexico",            sv: "Mexiko",                 iso: "mx",     host: true },
    { name: "South Korea",       sv: "Sydkorea",               iso: "kr" },
    { name: "South Africa",      sv: "Sydafrika",              iso: "za" },
    { name: "Czechia",           sv: "Tjeckien",               iso: "cz" }
  ],
  B: [
    { name: "Canada",            sv: "Kanada",                 iso: "ca",     host: true },
    { name: "Switzerland",       sv: "Schweiz",                iso: "ch" },
    { name: "Qatar",             sv: "Qatar",                  iso: "qa" },
    { name: "Bosnia-Herzegovina",sv: "Bosnien och Hercegovina",iso: "ba" }
  ],
  C: [
    { name: "Brazil",            sv: "Brasilien",              iso: "br" },
    { name: "Morocco",           sv: "Marocko",                iso: "ma" },
    { name: "Scotland",          sv: "Skottland",              iso: "gb-sct" },
    { name: "Haiti",             sv: "Haiti",                  iso: "ht" }
  ],
  D: [
    { name: "USA",               sv: "USA",                    iso: "us",     host: true },
    { name: "Paraguay",          sv: "Paraguay",               iso: "py" },
    { name: "Australia",         sv: "Australien",             iso: "au" },
    { name: "Türkiye",           sv: "Turkiet",                iso: "tr" }
  ],
  E: [
    { name: "Germany",           sv: "Tyskland",               iso: "de" },
    { name: "Ecuador",           sv: "Ecuador",                iso: "ec" },
    { name: "Ivory Coast",       sv: "Elfenbenskusten",        iso: "ci" },
    { name: "Curaçao",           sv: "Curaçao",                iso: "cw" }
  ],
  F: [
    { name: "Netherlands",       sv: "Nederländerna",          iso: "nl" },
    { name: "Japan",             sv: "Japan",                  iso: "jp" },
    { name: "Tunisia",           sv: "Tunisien",               iso: "tn" },
    { name: "Sweden",            sv: "Sverige",                iso: "se" }
  ],
  G: [
    { name: "Belgium",           sv: "Belgien",                iso: "be" },
    { name: "Iran",              sv: "Iran",                   iso: "ir" },
    { name: "Egypt",             sv: "Egypten",                iso: "eg" },
    { name: "New Zealand",       sv: "Nya Zeeland",            iso: "nz" }
  ],
  H: [
    { name: "Spain",             sv: "Spanien",                iso: "es" },
    { name: "Uruguay",           sv: "Uruguay",                iso: "uy" },
    { name: "Saudi Arabia",      sv: "Saudiarabien",           iso: "sa" },
    { name: "Cape Verde",        sv: "Kap Verde",              iso: "cv" }
  ],
  I: [
    { name: "France",            sv: "Frankrike",              iso: "fr" },
    { name: "Senegal",           sv: "Senegal",                iso: "sn" },
    { name: "Norway",            sv: "Norge",                  iso: "no" },
    { name: "Iraq",              sv: "Irak",                   iso: "iq" }
  ],
  J: [
    { name: "Argentina",         sv: "Argentina",              iso: "ar" },
    { name: "Austria",           sv: "Österrike",              iso: "at" },
    { name: "Algeria",           sv: "Algeriet",               iso: "dz" },
    { name: "Jordan",            sv: "Jordanien",              iso: "jo" }
  ],
  K: [
    { name: "Portugal",          sv: "Portugal",               iso: "pt" },
    { name: "Colombia",          sv: "Colombia",               iso: "co" },
    { name: "Uzbekistan",        sv: "Uzbekistan",             iso: "uz" },
    { name: "DR Congo",          sv: "DR Kongo",               iso: "cd" }
  ],
  L: [
    { name: "England",           sv: "England",                iso: "gb-eng" },
    { name: "Croatia",           sv: "Kroatien",               iso: "hr" },
    { name: "Panama",            sv: "Panama",                 iso: "pa" },
    { name: "Ghana",             sv: "Ghana",                  iso: "gh" }
  ]
};

WC.groupLetters = ["A","B","C","D","E","F","G","H","I","J","K","L"];

/*
  Gruppspelets datum (preliminära) – per grupp och omgång (1,2,3).
  Gruppspelet spelas 11–27 juni. Exakta matchtider/arenor per gruppmatch
  publiceras av FIFA – tiderna här lämnas som "TBC". Datumen ligger inom
  de officiella fönstren och är fördelade jämnt; verifiera mot FIFA.com.
*/
WC.groupRoundWindows = ["11–17 juni", "18–23 juni", "24–27 juni"];
WC.groupDates = {
  A: ["2026-06-11", "2026-06-18", "2026-06-24"],
  B: ["2026-06-11", "2026-06-18", "2026-06-24"],
  C: ["2026-06-12", "2026-06-19", "2026-06-24"],
  D: ["2026-06-12", "2026-06-19", "2026-06-25"],
  E: ["2026-06-13", "2026-06-20", "2026-06-25"],
  F: ["2026-06-13", "2026-06-20", "2026-06-25"],
  G: ["2026-06-14", "2026-06-21", "2026-06-26"],
  H: ["2026-06-14", "2026-06-21", "2026-06-26"],
  I: ["2026-06-15", "2026-06-22", "2026-06-26"],
  J: ["2026-06-15", "2026-06-22", "2026-06-27"],
  K: ["2026-06-16", "2026-06-23", "2026-06-27"],
  L: ["2026-06-16", "2026-06-23", "2026-06-27"]
};

/*
  Slutspelsschema – matcherna 73–104.
  Datum/arena: officiella FIFA-schemat (Wikipedia). Tider i EDT är preliminära.
  slot-typer:
    {t:'w', g:'A'}                  -> Etta i grupp A
    {t:'r', g:'B'}                  -> Tvåa i grupp B
    {t:'3', from:['C','E','F','H','I']} -> Bästa trea från någon av grupperna
    {t:'wm', m:74}                  -> Vinnare av match 74
    {t:'lm', m:101}                 -> Förlorare av match 101
*/
WC.knockout = [
  // ---- Sextondelsfinal (Round of 32) ----
  { m:73, round:"R32", date:"2026-06-28", edt:"15:00", venue:"losangeles",   home:{t:'r',g:'A'},                       away:{t:'r',g:'B'} },
  { m:74, round:"R32", date:"2026-06-29", edt:"13:00", venue:"boston",       home:{t:'w',g:'E'},                       away:{t:'3',from:['A','B','C','D','F']} },
  { m:75, round:"R32", date:"2026-06-29", edt:"16:30", venue:"monterrey",    home:{t:'w',g:'F'},                       away:{t:'r',g:'C'} },
  { m:76, round:"R32", date:"2026-06-29", edt:"21:00", venue:"houston",      home:{t:'w',g:'C'},                       away:{t:'r',g:'F'} },
  { m:77, round:"R32", date:"2026-06-30", edt:"12:00", venue:"newyork",      home:{t:'w',g:'I'},                       away:{t:'3',from:['C','D','F','G','H']} },
  { m:78, round:"R32", date:"2026-06-30", edt:"20:00", venue:"dallas",       home:{t:'r',g:'E'},                       away:{t:'r',g:'I'} },
  { m:79, round:"R32", date:"2026-06-30", edt:"15:00", venue:"mexicocity",   home:{t:'w',g:'A'},                       away:{t:'3',from:['C','E','F','H','I']} },
  { m:80, round:"R32", date:"2026-07-01", edt:"21:00", venue:"atlanta",      home:{t:'w',g:'L'},                       away:{t:'3',from:['E','H','I','J','K']} },
  { m:81, round:"R32", date:"2026-07-01", edt:"15:00", venue:"sanfrancisco", home:{t:'w',g:'D'},                       away:{t:'3',from:['B','E','F','I','J']} },
  { m:82, round:"R32", date:"2026-07-01", edt:"15:00", venue:"seattle",      home:{t:'w',g:'G'},                       away:{t:'3',from:['A','E','H','I','J']} },
  { m:83, round:"R32", date:"2026-07-02", edt:"18:00", venue:"toronto",      home:{t:'r',g:'K'},                       away:{t:'r',g:'L'} },
  { m:84, round:"R32", date:"2026-07-02", edt:"21:00", venue:"losangeles",   home:{t:'w',g:'H'},                       away:{t:'r',g:'J'} },
  { m:85, round:"R32", date:"2026-07-02", edt:"15:00", venue:"vancouver",    home:{t:'w',g:'B'},                       away:{t:'3',from:['E','F','G','I','J']} },
  { m:86, round:"R32", date:"2026-07-03", edt:null,    venue:"miami",        home:{t:'w',g:'J'},                       away:{t:'r',g:'H'} },
  { m:87, round:"R32", date:"2026-07-03", edt:null,    venue:"kansascity",   home:{t:'w',g:'K'},                       away:{t:'3',from:['D','E','I','J','L']} },
  { m:88, round:"R32", date:"2026-07-03", edt:"21:00", venue:"dallas",       home:{t:'r',g:'D'},                       away:{t:'r',g:'G'} },

  // ---- Åttondelsfinal (Round of 16) ----
  { m:89, round:"R16", date:"2026-07-04", edt:"13:00", venue:"philadelphia", home:{t:'wm',m:74}, away:{t:'wm',m:77} },
  { m:90, round:"R16", date:"2026-07-04", edt:"17:00", venue:"houston",      home:{t:'wm',m:73}, away:{t:'wm',m:75} },
  { m:91, round:"R16", date:"2026-07-05", edt:"20:00", venue:"newyork",      home:{t:'wm',m:76}, away:{t:'wm',m:78} },
  { m:92, round:"R16", date:"2026-07-05", edt:"15:00", venue:"mexicocity",   home:{t:'wm',m:79}, away:{t:'wm',m:80} },
  { m:93, round:"R16", date:"2026-07-06", edt:"15:00", venue:"dallas",       home:{t:'wm',m:83}, away:{t:'wm',m:84} },
  { m:94, round:"R16", date:"2026-07-06", edt:"15:00", venue:"seattle",      home:{t:'wm',m:81}, away:{t:'wm',m:82} },
  { m:95, round:"R16", date:"2026-07-07", edt:"20:00", venue:"atlanta",      home:{t:'wm',m:86}, away:{t:'wm',m:88} },
  { m:96, round:"R16", date:"2026-07-07", edt:"20:00", venue:"vancouver",    home:{t:'wm',m:85}, away:{t:'wm',m:87} },

  // ---- Kvartsfinal ----
  { m:97,  round:"QF", date:"2026-07-09", edt:"16:00", venue:"boston",     home:{t:'wm',m:89}, away:{t:'wm',m:90} },
  { m:98,  round:"QF", date:"2026-07-10", edt:"15:00", venue:"losangeles", home:{t:'wm',m:93}, away:{t:'wm',m:94} },
  { m:99,  round:"QF", date:"2026-07-11", edt:"17:00", venue:"miami",      home:{t:'wm',m:91}, away:{t:'wm',m:92} },
  { m:100, round:"QF", date:"2026-07-11", edt:"21:00", venue:"kansascity", home:{t:'wm',m:95}, away:{t:'wm',m:96} },

  // ---- Semifinal ----
  { m:101, round:"SF", date:"2026-07-14", edt:"15:00", venue:"dallas",  home:{t:'wm',m:97}, away:{t:'wm',m:98} },
  { m:102, round:"SF", date:"2026-07-15", edt:"15:00", venue:"atlanta", home:{t:'wm',m:99}, away:{t:'wm',m:100} },

  // ---- Bronsmatch ----
  { m:103, round:"3RD", date:"2026-07-18", edt:"17:00", venue:"miami", home:{t:'lm',m:101}, away:{t:'lm',m:102} },

  // ---- Final ----
  { m:104, round:"FINAL", date:"2026-07-19", edt:"15:00", venue:"newyork", home:{t:'wm',m:101}, away:{t:'wm',m:102} }
];

WC.roundNames = {
  R32:   "Sextondelsfinal",
  R16:   "Åttondelsfinal",
  QF:    "Kvartsfinal",
  SF:    "Semifinal",
  "3RD": "Bronsmatch",
  FINAL: "Final"
};
