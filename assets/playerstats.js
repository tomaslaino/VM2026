/*
  VM 2026 – statistik (window.VMPlayerStats).

  Två lägen i samma vy ("Statistik"):
    • Spelare – sorterbar/filtrerbar tabell över alla spelare i trupperna,
      berikad med VM-statistik som samlas in från matchhändelserna
      (data/matchdetails.json via app.js): matcher, spelade minuter, mål,
      assist, poäng, mål/90, assist/90, straffmål, självmål, gula/röda kort.
    • Lag – aggregerad tabell per lag: matcher, vinster/oavgjort/förlust,
      poäng, gjorda/insläppta mål, målskillnad, mål per match, hållna
      nollor och kort.

  Spelade minuter beräknas ur startelvor + inbyten (lineups/subs) och
  justeras för röda kort. Per-90-värden använder en minutkvalificering så
  att enstaka inhopp inte ger missvisande topplaceringar.

  Truppdata (position, ålder, klubb, landskamper) kommer från
  window.VMPlayers (data/wc2026_players.json). Händelsespelare matchas mot
  truppen via diakritik-tolerant namnjämförelse.

  app.js anropar:
    VMPlayerStats.setDetails(details)  – nya matchdetaljer
    VMPlayerStats.mount(viewEl)        – rendera vyn i #view
*/
(function () {
  "use strict";

  /* Samma round-robin-ordning som app.js använder för gruppmatcher. */
  var RR = [ [[0,1],[2,3]], [[0,2],[3,1]], [[3,0],[1,2]] ];

  /* Minuter en spelare måste ha spelat för att kvalificera till per-90-toppar. */
  var QUAL_MIN = 45;

  var details = {};        // resultatnyckel -> matchdetaljer
  var playerRowsCache = null;
  var teamRowsCache = null;
  var pidIndex = null;     // pid -> spelarrad (för uppslag utifrån, t.ex. spelarmodalen)
  var rootEl = null;       // monteringspunkt (sätts av mount)

  /* UI-läge (ej persistent) */
  var stateUi = {
    mode: "players",     // "players" | "teams"
    q: "",
    team: "",            // iso eller "" = alla
    pos: "",             // GK/DF/MF/FW eller "" = alla
    conf: "",            // förbundskod (UEFA m.fl.) eller "" = alla (lag-läget)
    limit: 50,
    sort: {
      players: { key: "points", dir: -1 },
      teams:   { key: "points", dir: -1 }
    }
  };

  var PAGE = 100;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function flagImg(iso) {
    if (!iso) return "";
    return '<img class="flag" loading="lazy" src="https://flagcdn.com/' + iso + '.svg" alt="" ' +
      'onerror="this.style.visibility=\'hidden\'">';
  }
  function norm(s) {
    return String(s || "").toLowerCase().normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9 ]+/g, " ")
      .replace(/\s+/g, " ").trim();
  }
  function round1(n) {
    return Math.round(n * 10) / 10;
  }
  function round2(n) {
    return Math.round(n * 100) / 100;
  }
  function fmt2(n) {
    if (!isFinite(n)) return "0.00";
    return n.toFixed(2);
  }
  function per90(v, min) {
    return min > 0 ? v / min * 90 : 0;
  }

  /* ---------- Lagindex ---------- */

  function allTeams() {
    var arr = [];
    if (!window.WC) return arr;
    WC.groupLetters.forEach(function (L) {
      WC.groups[L].forEach(function (t) {
        arr.push({ iso: t.iso, sv: t.sv, name: t.name, letter: L, team: t });
      });
    });
    return arr;
  }

  function teamShort(t) {
    if (t.svShort) return t.svShort;
    var och = t.sv.indexOf(" och ");
    return och > 0 ? t.sv.slice(0, och) : t.sv;
  }

  /* Konfederation/världsdel för ett lag (ISO) och svensk regionetikett. */
  function confOf(iso) {
    return (window.WC && WC.confed && WC.confed[iso]) || "";
  }
  function confLabel(code) {
    var list = (window.WC && WC.confeds) || [];
    for (var i = 0; i < list.length; i++) if (list[i].code === code) return list[i].region;
    return "";
  }

  /* Hemma/borta-lag för en resultatnyckel ("g:A:0" / "k:73"). */
  function matchTeams(key) {
    var g = /^g:([A-L]):(\d+)$/.exec(key);
    if (g && window.WC && WC.groups[g[1]]) {
      var i = parseInt(g[2], 10);
      var pair = RR[Math.floor(i / 2)] && RR[Math.floor(i / 2)][i % 2];
      if (!pair) return null;
      return { h: WC.groups[g[1]][pair[0]], a: WC.groups[g[1]][pair[1]] };
    }
    if (/^k:\d+$/.test(key) && window.VMApp && VMApp.describeMatch) {
      var info = VMApp.describeMatch(key);
      if (info && info.home && info.away) return { h: info.home, a: info.away };
    }
    return null;
  }

  /* Matchens fulla speltid (minuter) – 120 vid förlängning, annars 90. */
  function matchFull(det) {
    return det && det.duration && det.duration !== "REGULAR" ? 120 : 90;
  }
  /* ---------- Aggregera spelarhändelser + minuter per spelare ---------- */

  function statBucket(map, team, name) {
    var k = team.iso + "|" + norm(name);
    return map[k] || (map[k] = {
      name: name, team: team,
      goals: 0, pens: 0, og: 0, assists: 0, y: 0, r: 0,
      min: 0, apps: 0
    });
  }

  /* Beräkna spelade minuter för ett lag i en match och addera till map. */
  function addSideMinutes(map, det, side, team) {
    var lu = det.lineups && det.lineups[side];
    if (!lu) return;
    var full = matchFull(det);
    var play = {}; // norm namn -> { name, in, out }

    (lu.starters || []).forEach(function (s) {
      if (!s || !s.name) return;
      play[norm(s.name)] = { name: s.name, in: 0, out: full };
    });

    (det.subs || []).forEach(function (sb) {
      if (sb.team !== side) return;
      if (sb.out) {
        var ko = norm(sb.out);
        if (play[ko] && sb.minute != null) play[ko].out = Math.min(play[ko].out, sb.minute);
      }
      if (sb.in) {
        var ki = norm(sb.in);
        if (!play[ki]) play[ki] = { name: sb.in, in: (sb.minute == null ? full : sb.minute), out: full };
      }
    });

    (det.bookings || []).forEach(function (bk) {
      if (bk.team !== side || bk.minute == null) return;
      if (bk.card === "RED" || bk.card === "YELLOW_RED") {
        var kr = norm(bk.player);
        if (play[kr]) play[kr].out = Math.min(play[kr].out, bk.minute);
      }
    });

    Object.keys(play).forEach(function (k) {
      var pl = play[k];
      var mins = Math.max(0, (pl.out == null ? full : pl.out) - (pl.in == null ? 0 : pl.in));
      var b = statBucket(map, team, pl.name);
      b.min += mins;
      b.apps += 1;
    });
  }

  function aggregateEvents() {
    var map = {};
    Object.keys(details || {}).forEach(function (key) {
      var det = details[key];
      if (!det) return;
      var sides = matchTeams(key);
      if (!sides) return;
      function sideTeam(side) { return side === "h" ? sides.h : side === "a" ? sides.a : null; }

      (det.goals || []).forEach(function (gl) {
        var t = sideTeam(gl.team);
        if (!t || !gl.scorer) return;
        if (gl.type === "OWN") {
          var opp = gl.team === "h" ? sides.a : sides.h;
          statBucket(map, opp, gl.scorer).og++;
          return;
        }
        var b = statBucket(map, t, gl.scorer);
        b.goals++;
        if (gl.type === "PENALTY") b.pens++;
        if (gl.assist) statBucket(map, t, gl.assist).assists++;
      });

      (det.bookings || []).forEach(function (bk) {
        var t = sideTeam(bk.team);
        if (!t || !bk.player) return;
        var b = statBucket(map, t, bk.player);
        if (bk.card === "YELLOW") b.y++;
        else if (bk.card === "YELLOW_RED" || bk.card === "RED") b.r++;
      });

      addSideMinutes(map, det, "h", sides.h);
      addSideMinutes(map, det, "a", sides.a);
    });
    return map;
  }

  /* ---------- Matcha händelsenamn mot truppen ---------- */

  function squadIndex(teamIso) {
    var vp = window.VMPlayers;
    var team = vp && vp.isLoaded() ? vp.getTeamByIso(teamIso) : null;
    var idx = { byFull: {}, byLast: {}, players: team ? (team.players || []) : [] };
    idx.players.forEach(function (p) {
      var n = norm(p.name);
      idx.byFull[n] = p;
      var parts = n.split(" ");
      var last = parts[parts.length - 1];
      (idx.byLast[last] = idx.byLast[last] || []).push(p);
    });
    return idx;
  }

  function findSquadPlayer(idx, evName) {
    var n = norm(evName);
    if (idx.byFull[n]) return idx.byFull[n];
    var parts = n.split(" ");
    var last = parts[parts.length - 1];
    var cands = idx.byLast[last] || [];
    if (cands.length === 1) return cands[0];
    if (cands.length > 1 && parts.length > 1) {
      var ini = parts[0].charAt(0);
      var hit = cands.filter(function (p) { return norm(p.name).charAt(0) === ini; });
      if (hit.length === 1) return hit[0];
    }
    return null;
  }

  /* ---------- Bygg spelarrader (trupp + statistik) ---------- */

  function buildPlayerRows() {
    if (playerRowsCache) return playerRowsCache;
    pidIndex = null;
    var rows = [];
    var events = aggregateEvents();
    var claimed = {};

    allTeams().forEach(function (te) {
      var idx = squadIndex(te.iso);
      idx.players.forEach(function (p) {
        var st = null;
        for (var k in events) {
          if (claimed[k]) continue;
          var ev = events[k];
          if (ev.team.iso !== te.iso) continue;
          if (findSquadPlayer(idx, ev.name) === p || norm(ev.name) === norm(p.name)) {
            st = ev; claimed[k] = true; break;
          }
        }
        rows.push(makePlayerRow(te, p, st));
      });
    });

    Object.keys(events).forEach(function (k) {
      if (claimed[k]) return;
      var ev = events[k];
      var te = allTeams().filter(function (t) { return t.iso === ev.team.iso; })[0];
      if (!te) return;
      rows.push(makePlayerRow(te, null, ev, ev.name));
    });

    playerRowsCache = rows;
    return rows;
  }

  function makePlayerRow(te, p, st, fallbackName) {
    st = st || { goals: 0, pens: 0, og: 0, assists: 0, y: 0, r: 0, min: 0, apps: 0 };
    var goals = st.goals, assists = st.assists, min = st.min || 0;
    return {
      name: p ? p.name : (fallbackName || "?"),
      nameN: norm(p ? p.name : fallbackName),
      pid: p ? p.id : null,
      captain: !!(p && p.captain),
      shirt: p && p.shirt_number != null ? p.shirt_number : null,
      teamIso: te.iso, teamSv: te.sv, teamShort: teamShort(te), teamN: norm(te.sv + " " + te.name),
      letter: te.letter, teamObj: te.team,
      pos: p ? p.pos_code : null, posSv: p ? p.position_sv : null,
      age: p && p.age != null ? p.age : null,
      club: p ? (p.club || null) : null, clubN: norm(p && p.club),
      caps: p && p.caps != null ? p.caps : null,
      goals: goals, pens: st.pens, og: st.og, assists: assists,
      y: st.y, r: st.r,
      min: min, apps: st.apps || 0,
      points: goals + assists,
      g90: per90(goals, min),
      a90: per90(assists, min),
      gi90: per90(goals + assists, min),
      qualified: min >= QUAL_MIN,
      hasStats: !!(goals || assists || st.og || st.y || st.r),
      played: (st.apps || 0) > 0 || min > 0
    };
  }
  /* ---------- Bygg lagrader (aggregerat per lag) ---------- */

  function buildTeamRows() {
    if (teamRowsCache) return teamRowsCache;
    var byIso = {};
    allTeams().forEach(function (te) {
      byIso[te.iso] = {
        iso: te.iso, sv: te.sv, short: teamShort(te), teamN: norm(te.sv + " " + te.name),
        letter: te.letter, teamObj: te.team,
        conf: confOf(te.iso), region: confLabel(confOf(te.iso)),
        played: 0, w: 0, d: 0, l: 0, pts: 0,
        gf: 0, ga: 0, gd: 0, y: 0, r: 0, cs: 0
      };
    });

    Object.keys(details || {}).forEach(function (key) {
      var det = details[key];
      if (!det) return;
      var sides = matchTeams(key);
      if (!sides) return;
      var ft = det.score && det.score.ft;
      if (!ft || ft.h == null || ft.a == null) return; // bara spelade matcher

      var hr = byIso[sides.h.iso], ar = byIso[sides.a.iso];
      if (!hr || !ar) return;

      hr.played++; ar.played++;
      hr.gf += ft.h; hr.ga += ft.a;
      ar.gf += ft.a; ar.ga += ft.h;
      if (ft.a === 0) hr.cs++;
      if (ft.h === 0) ar.cs++;
      if (ft.h > ft.a) { hr.w++; ar.l++; hr.pts += 3; }
      else if (ft.h < ft.a) { ar.w++; hr.l++; ar.pts += 3; }
      else { hr.d++; ar.d++; hr.pts++; ar.pts++; }

      (det.bookings || []).forEach(function (bk) {
        var r = bk.team === "h" ? hr : bk.team === "a" ? ar : null;
        if (!r) return;
        if (bk.card === "YELLOW") r.y++;
        else if (bk.card === "RED" || bk.card === "YELLOW_RED") r.r++;
      });
    });

    var rows = Object.keys(byIso).map(function (iso) {
      var r = byIso[iso];
      r.gd = r.gf - r.ga;
      r.gpm = r.played > 0 ? r.gf / r.played : 0;
      r.gapm = r.played > 0 ? r.ga / r.played : 0;
      r.played0 = r.played === 0;
      return r;
    });
    teamRowsCache = rows;
    return rows;
  }

  /* ---------- Sorteringsdefinitioner ---------- */

  var PLAYER_SORTS = {
    name:    { type: "str", get: function (r) { return r.name; } },
    team:    { type: "str", get: function (r) { return r.teamSv; } },
    pos:     { type: "num", get: function (r) { return r.pos ? ["GK","DF","MF","FW"].indexOf(r.pos) : 9; } },
    age:     { type: "num", get: function (r) { return r.age; } },
    club:    { type: "str", get: function (r) { return r.club || "öööö"; } },
    apps:    { type: "num", get: function (r) { return r.apps; } },
    min:     { type: "num", get: function (r) { return r.min; } },
    goals:   { type: "num", get: function (r) { return r.goals; } },
    assists: { type: "num", get: function (r) { return r.assists; } },
    points:  { type: "num", get: function (r) { return r.points; } },
    g90:     { type: "num", qual: true, get: function (r) { return r.g90; } },
    a90:     { type: "num", qual: true, get: function (r) { return r.a90; } },
    y:       { type: "num", get: function (r) { return r.y; } },
    r:       { type: "num", get: function (r) { return r.r; } }
  };

  var TEAM_SORTS = {
    team:    { type: "str", get: function (r) { return r.sv; } },
    group:   { type: "str", get: function (r) { return r.letter; } },
    region:  { type: "str", get: function (r) { return r.region || "Övrigt"; } },
    played:  { type: "num", get: function (r) { return r.played; } },
    w:       { type: "num", get: function (r) { return r.w; } },
    d:       { type: "num", get: function (r) { return r.d; } },
    l:       { type: "num", get: function (r) { return r.l; } },
    gf:      { type: "num", get: function (r) { return r.gf; } },
    ga:      { type: "num", get: function (r) { return r.ga; } },
    gd:      { type: "num", get: function (r) { return r.gd; } },
    gpm:     { type: "num", get: function (r) { return r.gpm; } },
    y:       { type: "num", get: function (r) { return r.y; } },
    r:       { type: "num", get: function (r) { return r.r; } },
    cs:      { type: "num", get: function (r) { return r.cs; } },
    pts:     { type: "num", get: function (r) { return r.pts; } }
  };

  /* Per-90 som skiljedomare: vid lika rubriksiffra (t.ex. lika många mål)
     rankas den med högre mål/90 högre upp – dvs den som gjort det på färre
     minuter. Men bara för spelare med tillräckligt underlag (>=45 min);
     annars skulle korta inhopp (1 mål på 6 min ≈ 15 mål/90) blåsa upp värdet
     och felaktigt toppa listan. Okvalificerade rankas efter kvalificerade och
     sinsemellan på flest spelade minuter. Returnerar positivt om b före a. */
  function per90Tie(a, b, kind) {
    if (a.qualified && b.qualified) {
      var av = kind === "a" ? a.a90 : kind === "gi" ? a.gi90 : a.g90;
      var bv = kind === "a" ? b.a90 : kind === "gi" ? b.gi90 : b.g90;
      return bv - av;
    }
    if (a.qualified !== b.qualified) return a.qualified ? -1 : 1;
    return b.min - a.min;
  }

  /* Sekundärordning. Mål väger alltid tyngre än assist: 3 mål rankas högre
     än 1 mål + 2 assist trots lika poäng. Först total produktion (mål, sedan
     assist), därefter effektivitet (per 90 spelade minuter) och till sist
     namn. Per-90 är alltså en finliga skiljedomare, inte överordnad antalet. */
  function playerTiebreak(a, b, key) {
    if (key === "goals") {
      return (b.goals - a.goals) || (b.assists - a.assists) ||
        per90Tie(a, b, "g") || a.name.localeCompare(b.name, "sv");
    }
    if (key === "assists") {
      return (b.assists - a.assists) || (b.goals - a.goals) ||
        per90Tie(a, b, "a") || a.name.localeCompare(b.name, "sv");
    }
    /* points + övriga kolumner: poäng → mål → assist → per-90 → speltid → namn */
    return (b.points - a.points) || (b.goals - a.goals) || (b.assists - a.assists) ||
      per90Tie(a, b, "gi") || (b.min - a.min) || a.name.localeCompare(b.name, "sv");
  }

  function cmpPlayers(a, b) {
    var st = stateUi.sort.players;
    var s = PLAYER_SORTS[st.key] || PLAYER_SORTS.points;
    var av = s.get(a), bv = s.get(b), d = 0;
    if (s.type === "num") {
      var an = av == null ? -Infinity : av;
      var bn = bv == null ? -Infinity : bv;
      if (s.qual) {
        if (!a.qualified) an = -Infinity;
        if (!b.qualified) bn = -Infinity;
      }
      d = an - bn;
    } else {
      d = String(av).localeCompare(String(bv), "sv");
    }
    d *= st.dir;
    if (d) return d;
    return playerTiebreak(a, b, st.key);
  }

  function cmpTeams(a, b) {
    var st = stateUi.sort.teams;
    var s = TEAM_SORTS[st.key] || TEAM_SORTS.pts;
    var av = s.get(a), bv = s.get(b), d = 0;
    if (s.type === "num") d = (av == null ? -Infinity : av) - (bv == null ? -Infinity : bv);
    else d = String(av).localeCompare(String(bv), "sv");
    d *= st.dir;
    if (d) return d;
    return (b.pts - a.pts) || (b.gd - a.gd) || (b.gf - a.gf) || a.sv.localeCompare(b.sv, "sv");
  }

  /* ---------- Filtrering ---------- */

  function filteredPlayerRows() {
    var q = norm(stateUi.q);
    return buildPlayerRows().filter(function (r) {
      if (stateUi.team && r.teamIso !== stateUi.team) return false;
      if (stateUi.pos && r.pos !== stateUi.pos) return false;
      if (q && r.nameN.indexOf(q) === -1 && r.teamN.indexOf(q) === -1 &&
          r.clubN.indexOf(q) === -1) return false;
      return true;
    }).sort(cmpPlayers);
  }

  function filteredTeamRows() {
    var q = norm(stateUi.q);
    return buildTeamRows().filter(function (r) {
      if (stateUi.conf && r.conf !== stateUi.conf) return false;
      if (q && r.teamN.indexOf(q) === -1) return false;
      return true;
    }).sort(cmpTeams);
  }

  /* Förbund som faktiskt har lag i turneringen, i WC.confeds visningsordning. */
  function teamConfeds() {
    var present = {};
    buildTeamRows().forEach(function (r) { if (r.conf) present[r.conf] = true; });
    return ((window.WC && WC.confeds) || []).filter(function (c) { return present[c.code]; });
  }
  /* ---------- Topplistor (leader-kort + topp-20-modal) ---------- */

  function cardsCell(n, kind) {
    if (!n) return '<span class="ps-zero">–</span>';
    return '<span class="cards-cell"><span class="card-ico ' + kind + '" aria-hidden="true"></span>' + n + "</span>";
  }

  /* Returnerar konfig för de tre topplistorna i aktuellt läge. */
  function leaderConfigs() {
    if (stateUi.mode === "teams") {
      var trows = buildTeamRows();
      return [
        {
          id: "gf", kind: "teams", title: "Flest mål", icon: "⚽", rows: trows,
          valFn: function (r) { return r.gf; },
          mainFn: function (r) { return String(r.gf); },
          rateFn: function (r) { return fmt2(r.gpm) + " mål/match"; }
        },
        {
          id: "gd", kind: "teams", title: "Bäst målskillnad", icon: "📈", rows: trows,
          valFn: function (r) { return r.gd; },
          rankFn: function (r) { return r.gd + r.gf / 100; },
          mainFn: function (r) { return (r.gd > 0 ? "+" : "") + r.gd; },
          rateFn: function (r) { return r.gf + "–" + r.ga; }
        },
        {
          id: "tcards", kind: "teams", title: "Flest kort", icon: "🟨", rows: trows,
          valFn: function (r) { return r.y + 3 * r.r; },
          mainFn: function (r) { return cardsLine(r.y, r.r); },
          rateFn: function (r) { return (r.y + r.r) + " kort totalt"; }
        }
      ];
    }
    var prows = buildPlayerRows();
    return [
      {
        id: "goals", kind: "players", title: "Skytteliga", icon: "⚽", rows: prows,
        valFn: function (r) { return r.goals; },
        tieKind: "g",
        mainFn: function (r) { return String(r.goals); },
        rateFn: function (r) { return fmt2(r.g90) + " mål/90 min"; }
      },
      {
        id: "assists", kind: "players", title: "Flest assist", icon: "🎯", rows: prows,
        valFn: function (r) { return r.assists; },
        tieKind: "a",
        mainFn: function (r) { return String(r.assists); },
        rateFn: function (r) { return fmt2(r.a90) + " ass/90 min"; }
      },
      {
        id: "cards", kind: "players", title: "Flest kort", icon: "🟥", rows: prows,
        valFn: function (r) { return r.y + 3 * r.r; },
        mainFn: function (r) { return cardsLine(r.y, r.r); },
        rateFn: function (r) { return r.apps + (r.apps === 1 ? " match" : " matcher"); }
      }
    ];
  }

  function cardsLine(y, r) {
    var s = "";
    if (y) s += cardsCell(y, "y");
    if (r) s += cardsCell(r, "r");
    return s || '<span class="ps-zero">–</span>';
  }

  function leaderRanked(cfg, n) {
    var rank = cfg.rankFn || cfg.valFn;
    return cfg.rows.filter(function (r) { return cfg.valFn(r) > 0; })
      .sort(function (a, b) {
        return (rank(b) - rank(a)) ||
          (cfg.kind === "teams" ? (b.pts - a.pts) : (b.points - a.points)) ||
          (cfg.tieKind ? per90Tie(a, b, cfg.tieKind) : 0) ||
          (cfg.kind === "teams" ? 0 : (b.min - a.min));
      })
      .slice(0, n);
  }

  function leaderName(cfg, r) {
    return cfg.kind === "teams" ? r.sv : r.name;
  }
  function leaderTitle(cfg, r) {
    return cfg.kind === "teams" ? r.sv : (r.name + " · " + r.teamSv);
  }

  function leaderCard(cfg) {
    var top = leaderRanked(cfg, 5);
    if (!top.length) return "";
    var h = '<button type="button" class="ps-leader card" data-ps-top="' + cfg.id + '">' +
      '<div class="ps-leader-title">' + cfg.icon + " " + esc(cfg.title) + "</div>";
    top.forEach(function (r, i) {
      h += '<div class="ps-leader-row' + (i === 0 ? " first" : "") + '">' +
        '<span class="ps-leader-pos">' + (i + 1) + "</span>" +
        flagImg(r.iso || r.teamIso) +
        '<span class="ps-leader-name" title="' + esc(leaderTitle(cfg, r)) + '">' + esc(leaderName(cfg, r)) + "</span>" +
        '<span class="ps-leader-val">' + cfg.mainFn(r) + "</span>" +
        "</div>";
    });
    h += '<span class="ps-leader-more">Visa topp 20 →</span>';
    return h + "</button>";
  }

  function leadersHtml() {
    var cfgs = leaderConfigs();
    var h = cfgs.map(leaderCard).join("");
    if (!h.replace(/\s/g, "")) return "";
    return '<div class="ps-leaders">' + h + "</div>";
  }

  /* ---------- Topp-20-modal ---------- */

  function ensureModal() {
    var m = document.getElementById("psTopModal");
    if (m) return m;
    m = document.createElement("div");
    m.id = "psTopModal";
    m.className = "ps-modal";
    m.innerHTML = '<div class="ps-modal-backdrop"></div>' +
      '<div class="ps-modal-card" role="dialog" aria-modal="true"></div>';
    document.body.appendChild(m);
    m.querySelector(".ps-modal-backdrop").addEventListener("click", closeTopModal);
    m.querySelector(".ps-modal-card").addEventListener("click", function (e) {
      if (e.target.closest && e.target.closest(".ps-modal-close")) { closeTopModal(); return; }
      var row = e.target.closest && e.target.closest("[data-ps-player]");
      if (row) { closeTopModal(); openPlayer(row.getAttribute("data-ps-player")); }
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeTopModal(); });
    return m;
  }

  function openTopModal(id) {
    var cfg = leaderConfigs().filter(function (c) { return c.id === id; })[0];
    if (!cfg) return;
    var top = leaderRanked(cfg, 20);
    var isTeam = cfg.kind === "teams";
    var rows = top.map(function (r, i) {
      var clickable = !isTeam && r.pid;
      return '<div class="ps-top-row' + (i === 0 ? " first" : "") + '"' +
        (clickable ? ' data-ps-player="' + esc(r.pid) + '" role="button" tabindex="0"' : "") + ">" +
        '<span class="ps-top-pos">' + (i + 1) + "</span>" +
        flagImg(r.iso || r.teamIso) +
        '<span class="ps-top-name">' + esc(leaderName(cfg, r)) +
          (isTeam ? "" : '<span class="ps-top-team">' + esc(r.teamShort) + "</span>") + "</span>" +
        '<span class="ps-top-rate">' + esc(cfg.rateFn(r)) + "</span>" +
        '<span class="ps-top-val">' + cfg.mainFn(r) + "</span>" +
        "</div>";
    }).join("");

    var m = ensureModal();
    m.querySelector(".ps-modal-card").innerHTML =
      '<button class="ps-modal-close" title="Stäng">×</button>' +
      '<div class="ps-modal-head"><span class="ps-modal-icon">' + cfg.icon + "</span>" +
        "<h3>" + esc(cfg.title) + "</h3>" +
        '<span class="ps-modal-sub">Topp ' + top.length + " · " + (isTeam ? "lag" : "spelare") + "</span></div>" +
      '<div class="ps-top-list">' + (rows || '<div class="ps-empty">Ingen statistik ännu.</div>') + "</div>" +
      '<div class="ps-modal-note">' + (isTeam
        ? "Värdena bredvid visar lagets snitt per match."
        : "Värdet till höger visar antalet per 90 spelade minuter (för mål/assist) respektive antal matcher.") +
        (isTeam ? "" : " Klicka på en spelare för full profil.") + "</div>";
    m.classList.add("open");
  }

  function closeTopModal() {
    var m = document.getElementById("psTopModal");
    if (m) m.classList.remove("open");
  }
  /* ---------- Tabell: gemensam sorteringsrubrik ---------- */

  function thSort(key, label, cls, title) {
    var defs = stateUi.mode === "teams" ? TEAM_SORTS : PLAYER_SORTS;
    var st = stateUi.sort[stateUi.mode];
    var on = st.key === key;
    return '<th class="ps-sortable ' + (cls || "") + (on ? " sort-on" : "") + '" data-ps-sort="' + key + '"' +
      (title ? ' title="' + esc(title) + '"' : "") + ">" +
      esc(label) + (on ? '<span class="ps-arrow">' + (st.dir < 0 ? "▼" : "▲") + "</span>" : "") +
      "</th>";
  }

  /* ---------- Spelartabell ---------- */

  function num(v, hot) {
    return v ? '<span class="ps-num' + (hot ? " hot" : "") + '">' + v + "</span>" : '<span class="ps-zero">–</span>';
  }

  function playerRowHtml(r, i) {
    var posTitle = r.posSv || "Position saknas";
    var goalsTitle = [];
    if (r.pens) goalsTitle.push(r.pens + " på straff");
    if (r.og) goalsTitle.push(r.og + " självmål (räknas ej)");
    var clickable = !!r.pid;
    var g90 = r.qualified ? fmt2(r.g90) : (r.min > 0 ? '<span class="ps-zero" title="För få minuter för rättvist snitt">' + fmt2(r.g90) + "</span>" : '<span class="ps-zero">–</span>');
    var a90 = r.qualified ? fmt2(r.a90) : (r.min > 0 ? '<span class="ps-zero" title="För få minuter för rättvist snitt">' + fmt2(r.a90) + "</span>" : '<span class="ps-zero">–</span>');
    return '<tr class="' + (r.hasStats ? "ps-has-stats" : "") + (clickable ? " ps-openable" : "") + '"' +
      (clickable ? ' data-ps-player="' + esc(r.pid) + '" tabindex="0" role="button"' : "") + ">" +
      '<td class="c-pos">' + (i + 1) + "</td>" +
      '<td class="ps-c-name"><span class="team">' + flagImg(r.teamIso) +
        '<span class="t-name" title="' + esc(r.name) + '">' + esc(r.name) +
        (r.captain ? '<span class="ps-cap" title="Lagkapten">C</span>' : "") +
        "</span></span></td>" +
      '<td class="ps-c-team"><span class="t-name" title="' + esc(r.teamSv) + '">' + esc(r.teamShort) + "</span></td>" +
      '<td class="ps-c-pos" title="' + esc(posTitle) + '">' + (r.pos ? esc(r.pos) : "–") + "</td>" +
      '<td class="c-stat">' + (r.age != null ? r.age : "–") + "</td>" +
      '<td class="ps-c-club"><span title="' + esc(r.club || "") + '">' + (r.club ? esc(r.club) : "–") + "</span></td>" +
      '<td class="c-stat ps-num' + (r.goals ? " hot" : "") + '"' +
        (goalsTitle.length ? ' title="' + esc(goalsTitle.join(" · ")) + '"' : "") + ">" +
        (r.goals || (r.og ? '<span class="ps-og" title="' + r.og + ' självmål">sj</span>' : '<span class="ps-zero">–</span>')) + "</td>" +
      '<td class="c-stat ps-num' + (r.assists ? " hot" : "") + '">' + (r.assists || '<span class="ps-zero">–</span>') + "</td>" +
      '<td class="c-stat ps-num ps-pts">' + (r.points || '<span class="ps-zero">–</span>') + "</td>" +
      '<td class="c-stat ps-rate">' + g90 + "</td>" +
      '<td class="c-stat ps-rate">' + a90 + "</td>" +
      '<td class="c-stat">' + cardsCell(r.y, "y") + "</td>" +
      '<td class="c-stat">' + cardsCell(r.r, "r") + "</td>" +
      '<td class="c-stat">' + num(r.apps) + "</td>" +
      '<td class="c-stat">' + (r.min ? '<span class="ps-num">' + r.min + "'</span>" : '<span class="ps-zero">–</span>') + "</td>" +
      "</tr>";
  }

  function playerTableHtml() {
    var rows = filteredPlayerRows();
    var shown = rows.slice(0, stateUi.limit);
    var h = '<div class="ps-table-wrap"><table class="standings ps-table"><thead><tr>' +
      '<th class="c-pos">#</th>' +
      thSort("name", "Spelare", "ps-c-name") +
      thSort("team", "Lag", "ps-c-team") +
      thSort("pos", "Pos", "ps-c-pos", "Position: GK målvakt · DF försvarare · MF mittfältare · FW anfallare") +
      thSort("age", "Ålder", "") +
      thSort("club", "Klubb", "ps-c-club") +
      thSort("goals", "Mål", "", "Mål i VM 2026") +
      thSort("assists", "Ass", "", "Assist i VM 2026") +
      thSort("points", "P", "", "Poäng = mål + assist") +
      thSort("g90", "Mål/90", "", "Mål per 90 spelade minuter (kräver minst 45 min)") +
      thSort("a90", "Ass/90", "", "Assist per 90 spelade minuter (kräver minst 45 min)") +
      thSort("y", "Gul", "", "Gula kort") +
      thSort("r", "Röd", "", "Röda kort (inkl. två gula)") +
      thSort("apps", "M", "", "Spelade matcher i VM 2026") +
      thSort("min", "Min", "", "Spelade minuter i VM 2026") +
      "</tr></thead><tbody>";
    if (!shown.length) {
      h += '<tr><td class="ps-empty" colspan="15">Inga spelare matchar filtren.</td></tr>';
    } else {
      shown.forEach(function (r, i) { h += playerRowHtml(r, i); });
    }
    h += "</tbody></table></div>";
    if (rows.length > shown.length) {
      h += '<button type="button" class="ps-more" data-ps-more>Visa fler (' +
        shown.length + " av " + rows.length + ")</button>";
    }
    return h;
  }

  /* ---------- Lagtabell ---------- */

  function teamRowHtml(r, i) {
    return '<tr>' +
      '<td class="c-pos">' + (i + 1) + "</td>" +
      '<td class="ps-c-name"><span class="team">' + flagImg(r.iso) +
        '<span class="t-name" title="' + esc(r.sv) + '">' + esc(r.sv) + "</span></span></td>" +
      '<td class="ps-c-pos">' + esc(r.letter) + "</td>" +
      '<td class="ps-c-conf"' + (r.region ? ' title="' + esc(r.region) + '"' : "") + ">" +
        (r.conf ? esc(r.conf) : "–") + "</td>" +
      '<td class="c-stat">' + (r.played || '<span class="ps-zero">–</span>') + "</td>" +
      '<td class="c-stat">' + num(r.w) + "</td>" +
      '<td class="c-stat">' + num(r.d) + "</td>" +
      '<td class="c-stat">' + num(r.l) + "</td>" +
      '<td class="c-stat ps-num' + (r.gf ? " hot" : "") + '">' + (r.gf || '<span class="ps-zero">–</span>') + "</td>" +
      '<td class="c-stat">' + (r.played ? r.ga : '<span class="ps-zero">–</span>') + "</td>" +
      '<td class="c-stat ps-num">' + (r.played ? (r.gd > 0 ? "+" + r.gd : r.gd) : '<span class="ps-zero">–</span>') + "</td>" +
      '<td class="c-stat ps-rate">' + (r.played ? fmt2(r.gpm) : '<span class="ps-zero">–</span>') + "</td>" +
      '<td class="c-stat">' + cardsCell(r.y, "y") + "</td>" +
      '<td class="c-stat">' + cardsCell(r.r, "r") + "</td>" +
      '<td class="c-stat">' + num(r.cs) + "</td>" +
      '<td class="c-stat ps-num ps-pts">' + (r.played ? r.pts : '<span class="ps-zero">–</span>') + "</td>" +
      "</tr>";
  }

  function teamTableHtml() {
    var rows = filteredTeamRows();
    var shown = rows.slice(0, stateUi.limit);
    var h = '<div class="ps-table-wrap"><table class="standings ps-table"><thead><tr>' +
      '<th class="c-pos">#</th>' +
      thSort("team", "Lag", "ps-c-name") +
      thSort("group", "Grp", "ps-c-pos", "Grupp") +
      thSort("region", "Förb", "ps-c-conf", "Förbund / världsdel") +
      thSort("played", "M", "", "Spelade matcher") +
      thSort("w", "V", "", "Vinster") +
      thSort("d", "O", "", "Oavgjorda") +
      thSort("l", "F", "", "Förluster") +
      thSort("gf", "GM", "", "Gjorda mål") +
      thSort("ga", "IM", "", "Insläppta mål") +
      thSort("gd", "MS", "", "Målskillnad") +
      thSort("gpm", "Mål/M", "", "Mål per match") +
      thSort("y", "Gul", "", "Gula kort") +
      thSort("r", "Röd", "", "Röda kort") +
      thSort("cs", "Nollor", "", "Matcher utan insläppt mål") +
      thSort("pts", "P", "", "Poäng") +
      "</tr></thead><tbody>";
    if (!shown.length) {
      h += '<tr><td class="ps-empty" colspan="16">Inga lag matchar filtren.</td></tr>';
    } else {
      shown.forEach(function (r, i) { h += teamRowHtml(r, i); });
    }
    h += "</tbody></table></div>";
    if (rows.length > shown.length) {
      h += '<button type="button" class="ps-more" data-ps-more>Visa fler (' +
        shown.length + " av " + rows.length + ")</button>";
    }
    return h;
  }

  function tableHtml() {
    return stateUi.mode === "teams" ? teamTableHtml() : playerTableHtml();
  }
  /* ---------- Lägesväljare + verktygsrad ---------- */

  function modeToggleHtml() {
    function seg(mode, label) {
      return '<button type="button" class="ps-mode-seg' + (stateUi.mode === mode ? " on" : "") +
        '" data-ps-mode="' + mode + '">' + label + "</button>";
    }
    return '<div class="ps-modes" role="tablist" aria-label="Statistiktyp">' +
      seg("players", "Spelare") + seg("teams", "Lag") + "</div>";
  }

  function toolbarHtml() {
    if (stateUi.mode === "teams") {
      var confList = teamConfeds();
      var confOpts = '<option value="">Alla förbund</option>' + confList.map(function (c) {
        return '<option value="' + esc(c.code) + '"' + (stateUi.conf === c.code ? " selected" : "") + ">" +
          esc(c.code) + " – " + esc(c.region) + "</option>";
      }).join("");
      return '<div class="ps-toolbar">' +
        '<input id="psSearch" type="search" autocomplete="off" placeholder="Sök lag…" ' +
          'aria-label="Sök lag" value="' + esc(stateUi.q) + '">' +
        '<select id="psConf" aria-label="Filtrera på förbund">' + confOpts + "</select>" +
        '<span class="ps-count" id="psCount"></span>' +
        "</div>";
    }
    var teams = allTeams().slice().sort(function (a, b) { return a.sv.localeCompare(b.sv, "sv"); });
    var teamOpts = '<option value="">Alla lag</option>' + teams.map(function (t) {
      return '<option value="' + t.iso + '"' + (stateUi.team === t.iso ? " selected" : "") + ">" +
        esc(t.sv) + " (" + t.letter + ")</option>";
    }).join("");
    var posOpts = [["", "Alla positioner"], ["GK", "Målvakter"], ["DF", "Försvarare"],
      ["MF", "Mittfältare"], ["FW", "Anfallare"]].map(function (o) {
        return '<option value="' + o[0] + '"' + (stateUi.pos === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
      }).join("");
    return '<div class="ps-toolbar">' +
      '<input id="psSearch" type="search" autocomplete="off" placeholder="Sök spelare, lag eller klubb…" ' +
        'aria-label="Sök spelare" value="' + esc(stateUi.q) + '">' +
      '<select id="psTeam" aria-label="Filtrera på lag">' + teamOpts + "</select>" +
      '<select id="psPos" aria-label="Filtrera på position">' + posOpts + "</select>" +
      '<span class="ps-count" id="psCount"></span>' +
      "</div>";
  }

  function noteHtml() {
    if (stateUi.mode === "teams") {
      return '<p class="note ps-note">Lagstatistiken räknas fram automatiskt ur matchresultaten (ESPN) under VM 2026: ' +
        "matcher, vinster/oavgjort/förlust, mål, målskillnad, kort och hållna nollor.</p>";
    }
    return '<p class="note ps-note">Statistik (matcher, minuter, mål, assist, kort) samlas in automatiskt från ' +
      "matchrapporterna (ESPN) under VM 2026. Mål/90 och assist/90 visas för spelare med minst 45 spelade minuter. " +
      "Truppdata – position, ålder, klubb – kommer från Wikipedia. Klicka på en spelare för full profil.</p>";
  }

  function render() {
    if (!rootEl || !document.body.contains(rootEl)) return;
    rootEl.innerHTML =
      modeToggleHtml() +
      leadersHtml() +
      '<section class="card ps-card">' +
      toolbarHtml() +
      '<div id="psTableBox">' + tableHtml() + "</div>" +
      noteHtml() +
      "</section>";
    updateCount();
  }

  function renderTable() {
    var box = document.getElementById("psTableBox");
    if (!box) { render(); return; }
    box.innerHTML = tableHtml();
    updateCount();
  }

  function updateCount() {
    var el = document.getElementById("psCount");
    if (!el) return;
    if (stateUi.mode === "teams") {
      var tn = filteredTeamRows().length;
      el.textContent = tn + (tn === 1 ? " lag" : " lag");
      return;
    }
    var n = filteredPlayerRows().length;
    var played = buildPlayerRows().filter(function (r) { return r.played; }).length;
    el.textContent = n + " spelare" + (played ? " · " + played + " har spelat" : "");
  }

  /* ---------- Events (delegerade på rotelementet) ---------- */

  function setMode(mode) {
    if (mode === stateUi.mode) return;
    stateUi.mode = mode;
    stateUi.q = "";
    stateUi.limit = 50;
    render();
  }

  function onClick(e) {
    var seg = e.target.closest && e.target.closest("[data-ps-mode]");
    if (seg) { setMode(seg.getAttribute("data-ps-mode")); return; }

    var top = e.target.closest && e.target.closest("[data-ps-top]");
    if (top) { openTopModal(top.getAttribute("data-ps-top")); return; }

    var th = e.target.closest && e.target.closest("[data-ps-sort]");
    if (th) {
      var key = th.getAttribute("data-ps-sort");
      var defs = stateUi.mode === "teams" ? TEAM_SORTS : PLAYER_SORTS;
      var st = stateUi.sort[stateUi.mode];
      if (st.key === key) st.dir = -st.dir;
      else {
        st.key = key;
        st.dir = (defs[key] && defs[key].type === "str") ? 1 : -1;
      }
      renderTable();
      return;
    }
    if (e.target.closest && e.target.closest("[data-ps-more]")) {
      stateUi.limit += PAGE;
      renderTable();
      return;
    }
    var tr = e.target.closest && e.target.closest("[data-ps-player]");
    if (tr) openPlayer(tr.getAttribute("data-ps-player"));
  }

  function onInput(e) {
    if (e.target && e.target.id === "psSearch") {
      stateUi.q = e.target.value;
      stateUi.limit = 50;
      renderTable();
    }
  }

  function onChange(e) {
    if (!e.target) return;
    if (e.target.id === "psTeam") { stateUi.team = e.target.value; stateUi.limit = 50; renderTable(); }
    else if (e.target.id === "psPos") { stateUi.pos = e.target.value; stateUi.limit = 50; renderTable(); }
    else if (e.target.id === "psConf") { stateUi.conf = e.target.value; stateUi.limit = 50; renderTable(); }
  }

  function onKeydown(e) {
    if ((e.key === "Enter" || e.key === " ") && e.target && e.target.getAttribute &&
        e.target.getAttribute("data-ps-player")) {
      e.preventDefault();
      openPlayer(e.target.getAttribute("data-ps-player"));
    }
  }

  function openPlayer(pid) {
    var vp = window.VMPlayers;
    if (!vp || !window.VMLive || typeof VMLive.openPlayer !== "function") return;
    var p = vp.getPlayerById(pid);
    var team = vp.getTeamOfPlayer(pid);
    if (!p || !team) return;
    var te = allTeams().filter(function (t) {
      return vp.isoToCode(t.iso) === team.fifa_code;
    })[0];
    VMLive.openPlayer(p, te ? te.team : { sv: team.name_sv, name: team.name });
  }

  /* VM-statistik för en enskild spelare (utifrån truppens spelar-id). Används
     av spelarmodalen (assets/live.js) för att slå ihop Wikipedia-profilen med
     det som spelaren samlat på sig under VM 2026. Returnerar spelarraden (samma
     form som tabellen) eller null om id saknas/inte hittas. */
  function getPlayerStatsById(pid) {
    if (pid == null) return null;
    var rows = buildPlayerRows();
    if (!pidIndex) {
      pidIndex = {};
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].pid != null) pidIndex[rows[i].pid] = rows[i];
      }
    }
    return pidIndex[pid] || null;
  }

  /* ---------- Publikt API ---------- */

  function mount(viewEl) {
    rootEl = document.createElement("div");
    rootEl.className = "ps-view";
    viewEl.innerHTML = "";
    viewEl.appendChild(rootEl);
    rootEl.addEventListener("click", onClick);
    rootEl.addEventListener("input", onInput);
    rootEl.addEventListener("change", onChange);
    rootEl.addEventListener("keydown", onKeydown);
    if (window.VMPlayers && !VMPlayers.isLoaded()) {
      VMPlayers.load().then(function () { playerRowsCache = null; render(); }).catch(function () {});
    }
    render();
  }

  function setDetails(next) {
    details = next || {};
    playerRowsCache = null;
    teamRowsCache = null;
    if (rootEl && document.body.contains(rootEl)) render();
  }

  window.VMPlayerStats = { mount: mount, setDetails: setDetails, getPlayerStats: getPlayerStatsById };
})();
