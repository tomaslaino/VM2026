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

  /** Laddar datafilen en gång och cachar resultatet. Returnerar ett Promise. */
  function load() {
    if (loadPromise) return loadPromise;
    loadPromise = fetch(DATA_URL, { headers: { Accept: "application/json" } })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (payload) {
        index(payload);
        return data;
      })
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
