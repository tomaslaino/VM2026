/*
  VM 2026 – statiskt datalager för truppdata (window.VMPlayers).

  Arkitektur: spelardata är STATISK. Den hämtas EN gång från den lokala filen
  data/wc2026_players.json (samma origin) som GitHub Actions uppdaterar dagligen
  via scripts/fetch_player_details.py. Inga runtime-anrop mot Wikipedia sker
  någonsin från klienten. Live-data (mål, kort, resultat) hanteras separat i
  assets/live.js och berörs inte här.

  Projektet använder inte TypeScript – typerna nedan dokumenteras med JSDoc.

  @typedef {Object} Player
  @property {string}        id            url-slug, t.ex. "swe-viktor-gyokeres"
  @property {string}        name
  @property {number|null}   shirt_number
  @property {string}        position      goalkeeper|defender|midfielder|forward
  @property {string}        position_sv   Målvakt|Försvarare|Mittfältare|Anfallare
  @property {"GK"|"DF"|"MF"|"FW"} pos_code
  @property {boolean}       captain
  @property {string|null}   date_of_birth ISO (YYYY-MM-DD)
  @property {number|null}   age
  @property {number|null}   caps
  @property {number|null}   goals
  @property {string|null}   club
  @property {string|null}   club_country

  @typedef {Object} Team
  @property {string}    name        engelskt namn
  @property {string}    name_sv
  @property {string}    fifa_code   t.ex. "SWE"
  @property {string}    group       gruppbokstav A–L
  @property {string|null} coach     förbundskapten
  @property {number}    squad_size
  @property {Player[]}  players

  @typedef {Object} PositionGroup
  @property {"GK"|"DF"|"MF"|"FW"} pos_code
  @property {string}    label       svensk pluraletikett (Målvakter …)
  @property {Player[]}  players
*/
(function () {
  "use strict";

  var DATA_URL = (window.VM_CONFIG && window.VM_CONFIG.players) || "data/wc2026_players.json";
  var STATUS_URL = (window.VM_CONFIG && window.VM_CONFIG.playerStatus) || "data/wc2026_player_status.json";

  var SV_MONTHS_SHORT = ["jan", "feb", "mar", "apr", "maj", "jun",
    "jul", "aug", "sep", "okt", "nov", "dec"];

  // Pluraletiketter för rubriker i truppvyn (singularvarianten finns i position_sv).
  var POS_LABEL = { GK: "Målvakter", DF: "Försvarare", MF: "Mittfältare", FW: "Anfallare" };
  var POS_ORDER = ["GK", "DF", "MF", "FW"];

  // FIFA-kod -> grupp och iso (assets/data.js använder iso, datafilen fifa_code).
  // iso-mappningen låter oss slå upp truppen utifrån lag-objektet i data.js.
  var ISO_TO_CODE = {
    mx: "MEX", kr: "KOR", za: "RSA", cz: "CZE",
    ca: "CAN", ch: "SUI", qa: "QAT", ba: "BIH",
    br: "BRA", ma: "MAR", "gb-sct": "SCO", ht: "HAI",
    us: "USA", py: "PAR", au: "AUS", tr: "TUR",
    de: "GER", ec: "ECU", ci: "CIV", cw: "CUW",
    nl: "NED", jp: "JPN", tn: "TUN", se: "SWE",
    be: "BEL", ir: "IRN", eg: "EGY", nz: "NZL",
    es: "ESP", uy: "URU", sa: "KSA", cv: "CPV",
    fr: "FRA", sn: "SEN", no: "NOR", iq: "IRQ",
    ar: "ARG", at: "AUT", dz: "ALG", jo: "JOR",
    pt: "POR", co: "COL", uz: "UZB", cd: "COD",
    "gb-eng": "ENG", hr: "CRO", pa: "PAN", gh: "GHA",
  };

  var data = null;                 // hela JSON-payloaden när den laddats
  var byCode = {};                 // fifa_code -> Team
  var byPlayerId = {};             // player.id -> { player, team }
  var loadPromise = null;          // singel-laddning (cachas)

  var statusMap = {};              // player.id -> rå statuspost (skade-/avstängningsstatus)
  var statusUpdated = null;        // när statusdatan senast uppdaterades (ISO)

  function index(payload) {
    data = payload;
    byCode = {};
    byPlayerId = {};
    (payload.teams || []).forEach(function (team) {
      byCode[team.fifa_code] = team;
      (team.players || []).forEach(function (p) {
        byPlayerId[p.id] = { player: p, team: team };
      });
    });
  }

  /* Laddar spelarstatus (skador/avstängningar). Valfri datakälla – får aldrig
     stjälpa truppladdningen, så fel sväljs och ger en tom statuskarta. */
  function loadStatus() {
    return fetch(STATUS_URL, { headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (payload) {
        statusMap = (payload && payload.statuses) || {};
        statusUpdated = (payload && payload.updated) || null;
      })
      .catch(function () { statusMap = {}; statusUpdated = null; });
  }

  /** Laddar datafilen en gång och cachar resultatet. Returnerar ett Promise. */
  function load() {
    if (loadPromise) return loadPromise;
    var playersP = fetch(DATA_URL, { headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (payload) { index(payload); });
    // Truppdatan är obligatorisk; statusdatan är valfri och blockerar inte.
    loadPromise = Promise.all([playersP, loadStatus()])
      .then(function () { return data; })
      .catch(function (err) {
        loadPromise = null; // tillåt nytt försök senare
        throw err;
      });
    return loadPromise;
  }

  function isLoaded() { return !!data; }

  /** Normaliserar en FIFA-kod eller ISO-kod till FIFA-kod. */
  function toCode(code) {
    if (!code) return null;
    var c = String(code);
    if (byCode[c]) return c;
    var up = c.toUpperCase();
    if (byCode[up]) return up;
    return ISO_TO_CODE[c.toLowerCase()] || null;
  }

  /** @returns {Team|null} */
  function getTeamByCode(code) {
    var c = toCode(code);
    return c ? (byCode[c] || null) : null;
  }

  /** Slå upp lag utifrån data.js iso-kod (t.ex. "se", "gb-eng"). @returns {Team|null} */
  function getTeamByIso(iso) {
    return getTeamByCode(ISO_TO_CODE[String(iso || "").toLowerCase()]);
  }

  /** @returns {Player|null} */
  function getPlayerById(id) {
    var hit = byPlayerId[id];
    return hit ? hit.player : null;
  }

  /** @returns {Team|null} laget som en spelare tillhör */
  function getTeamOfPlayer(id) {
    var hit = byPlayerId[id];
    return hit ? hit.team : null;
  }

  /**
   * Spelare för ett lag, grupperade per position i ordningen GK → DF → MF → FW.
   * @returns {PositionGroup[]}
   */
  function getPlayersByTeam(code) {
    var team = getTeamByCode(code);
    if (!team) return [];
    return POS_ORDER.map(function (pc) {
      var players = (team.players || [])
        .filter(function (p) { return p.pos_code === pc; })
        .sort(function (a, b) {
          var an = a.shirt_number == null ? 999 : a.shirt_number;
          var bn = b.shirt_number == null ? 999 : b.shirt_number;
          return an - bn || a.name.localeCompare(b.name, "sv");
        });
      return { pos_code: pc, label: POS_LABEL[pc], players: players };
    }).filter(function (g) { return g.players.length > 0; });
  }

  /** Datum då truppdatan senast hämtades (fetched-fältet), eller null. */
  function getFetchedDate() {
    return data ? (data.fetched || null) : null;
  }

  /* ---------- Spelarstatus (skador / avstängningar / osäkra) ---------- */

  // "2026-06-28" -> "28 jun" (kort svensk form för pill/banner).
  function fmtShortDate(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ""));
    if (!m) return null;
    return parseInt(m[3], 10) + " " + SV_MONTHS_SHORT[parseInt(m[2], 10) - 1];
  }

  // Engelska API-orsaker -> svensk text (de vanligaste; okända visas i original).
  var REASON_SV = {
    "injury": "Skada", "knock": "Känning", "suspended": "Avstängd",
    "red card": "Rött kort", "yellow cards": "Gula kort", "illness": "Sjukdom",
    "ill": "Sjuk", "muscle injury": "Muskelskada", "hamstring": "Hamstringskada",
    "knee injury": "Knäskada", "ankle injury": "Fotledsskada",
    "calf injury": "Vadskada", "thigh injury": "Lårskada",
    "groin injury": "Ljumskskada", "back injury": "Ryggskada",
    "fitness": "Träningsbrist", "rest": "Vila", "national selection": "Ej uttagen"
  };
  function reasonSv(reason) {
    if (!reason) return null;
    var key = String(reason).trim().toLowerCase();
    return REASON_SV[key] || reason;
  }

  // Kort svensk etikett (pill-text) utifrån typ + tillgänglighet.
  function statusLabel(kind, avail) {
    if (kind === "suspension") return avail === "out" ? "Avstängd" : "Avstängningshot";
    if (kind === "illness") return avail === "out" ? "Sjuk" : "Sjukdomsoro";
    if (kind === "injury") return avail === "out" ? "Skadad" : "Skadeoro";
    return avail === "out" ? "Missar matchen" : "Osäker";
  }

  // CSS-variant: avstängning egen färg, annars styr tillgängligheten.
  function statusCls(kind, avail) {
    if (kind === "suspension") return "susp";
    return avail === "out" ? "out" : "doubtful";
  }

  /**
   * Presentationsklart statusobjekt för en spelare, eller null om ingen status.
   * @returns {{cls:string,label:string,text:string,availability:string,kind:string,updated:?string}|null}
   */
  function describeStatus(s) {
    if (!s || typeof s !== "object") return null;
    var avail = s.availability === "doubtful" ? "doubtful" : "out";
    var kind = ({ injury: 1, suspension: 1, illness: 1, other: 1 })[s.kind] ? s.kind : "other";
    var label = s.label || statusLabel(kind, avail);
    var detail = s.detail || reasonSv(s.reason);
    var upd = fmtShortDate(s.updated);
    var text = label;
    if (detail && detail.toLowerCase() !== label.toLowerCase()) text += " – " + detail;
    if (upd) text += " · uppdaterad " + upd;
    return {
      cls: statusCls(kind, avail), label: label, text: text,
      availability: avail, kind: kind, updated: s.updated || null
    };
  }

  /** Presentationsklar status för ett spelar-id, eller null. */
  function getPlayerStatus(id) {
    if (id == null) return null;
    return describeStatus(statusMap[id]);
  }

  /** Antal spelare med registrerad status (skada/avstängning/osäker). */
  function statusCount() {
    return Object.keys(statusMap).length;
  }

  /** ISO-datum då statusdatan senast uppdaterades, eller null. */
  function getStatusUpdated() {
    return statusUpdated;
  }

  /**
   * Fritextsök bland spelare och förbundskaptener.
   * @returns {{players: {player: Player, team: Team}[], coaches: {name: string, team: Team}[]}}
   */
  function search(query, limit) {
    var empty = { players: [], coaches: [] };
    if (!data) return empty;
    var q = String(query || "").trim().toLowerCase();
    if (!q) return empty;

    var players = [];
    var coaches = [];
    (data.teams || []).forEach(function (team) {
      if (team.coach && team.coach.toLowerCase().indexOf(q) !== -1) {
        coaches.push({ name: team.coach, team: team });
      }
      (team.players || []).forEach(function (p) {
        if (p.name && p.name.toLowerCase().indexOf(q) !== -1) {
          players.push({ player: p, team: team });
        }
      });
    });

    // Träffar som börjar på söksträngen rankas före träffar mitt i namnet.
    function rank(name) { return name.toLowerCase().indexOf(q) === 0 ? 0 : 1; }
    players.sort(function (a, b) {
      return rank(a.player.name) - rank(b.player.name) ||
        a.player.name.localeCompare(b.player.name, "sv");
    });
    coaches.sort(function (a, b) {
      return rank(a.name) - rank(b.name) || a.name.localeCompare(b.name, "sv");
    });

    if (limit) players = players.slice(0, limit);
    return { players: players, coaches: coaches };
  }

  window.VMPlayers = {
    load: load,
    isLoaded: isLoaded,
    getTeamByCode: getTeamByCode,
    getTeamByIso: getTeamByIso,
    getPlayerById: getPlayerById,
    getTeamOfPlayer: getTeamOfPlayer,
    getPlayersByTeam: getPlayersByTeam,
    getFetchedDate: getFetchedDate,
    getPlayerStatus: getPlayerStatus,
    getStatusUpdated: getStatusUpdated,
    statusCount: statusCount,
    search: search,
    isoToCode: function (iso) { return ISO_TO_CODE[String(iso || "").toLowerCase()] || null; },
  };

  // Förladda i bakgrunden så att lag-lådan har datan redo direkt.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { load().catch(function () {}); });
  } else {
    load().catch(function () {});
  }
})();
