/*
  VM 2026 – statistik (window.VMPlayerStats).

  Fyra lägen i samma vy ("Statistik"):
    • Spelare – sorterbar/filtrerbar tabell över alla spelare i trupperna,
      berikad med VM-statistik som samlas in från matchhändelserna
      (data/matchdetails.json via app.js): matcher, spelade minuter, mål,
      assist, poäng, mål/90, assist/90, straffmål, självmål, gula/röda kort,
      ett matchbetyg (FotMob, se nedan) samt xG och ±xG (mål − xG,
      avslutseffektivitet) ur FotMobs skottdata (data/fotmob_ratings.json).
    • Lag – aggregerad tabell per lag: matcher, vinster/oavgjort/förlust,
      poäng, gjorda/insläppta mål, målskillnad, mål per match, hållna
      nollor och kort – plus xG/±xG (skapar laget chanser? gör det mer än
      chanserna borde ge?) och xGA/±xGA (samma sak bakåt) ur samma
      FotMob-data, samt kvoterna Mål/xG och IM/xGA som normaliserar
      över-/underprestationen mot volymen (2 mål över förväntan är mer
      anmärkningsvärt på 2 xG än på 25). Det fångar lag som Marocko/
      Norge-arketypen: få chanser men sjukt effektiva.
    • Region – samma aggregat per konfederation/världsdel.
    • Ligor – klubbligornas VM: spelarna grupperas på vilken liga (land +
      division, data/club_leagues.json) deras klubb spelar i, med minut-
      viktat FotMob-betyg, produktion och två överprestationsmått:
        ±Prislapp (betyg mot förväntat betyg utifrån spelarnas marknads-
        värden – minutviktad regression betyg ~ log(marknadsvärde) på
        spelarnivå, visualiserad i en scatter-graf med logaritmisk x-axel)
        samt Δ Förväntan (landslagens utveckling mot turneringsstartens
        slutspelsförväntan, data/bracket_probs_pre.json vs
        bracket_probs.json). En hopfällbar "Vad betyder siffrorna?" under
        verktygsraden förklarar måtten. Klick på en liga öppnar en modal
        med ligans VM-spelare.

  Matchbetyget är FotMobs Opta-baserade spelarbetyg (10-gradigt) ur
  data/fotmob_ratings.json, kopplat till ESPN-lineupens namn. Det fångar hela
  spelet – även tacklingar, brytningar, passningar och positionsspel – som
  ESPN:s gratisdata saknar. Turneringsbetyget är minutviktat över spelarens
  matcher; saknar FotMob betyg för en match räknas den inte in.

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
  var QUAL_MIN = 2;
  /* Minuter för kvalificerat betyg (spelare) resp. liga-rankning (Ligor). */
  var RATING_QUAL_MIN = 90;
  var LEAGUE_QUAL_MIN = 450;

  var details = {};        // resultatnyckel -> matchdetaljer
  var playerRowsCache = null;
  var teamRowsCache = null;
  var regionRowsCache = null;
  var leagueRowsCache = null;
  var pidIndex = null;     // pid -> spelarrad (för uppslag utifrån, t.ex. spelarmodalen)
  var rootEl = null;       // monteringspunkt (sätts av mount)

  /* FotMobs spelarbetyg (data/fotmob_ratings.json): matchnyckel -> { players:
     { h/a: { espnNormNamn: betyg } } }. Laddas en gång på mount. */
  var fotmobRatings = null;
  var fotmobLoad = 0;      // 0 = ej startad · 1 = laddar · 2 = klar (även vid fel)

  /* Ligadata (laddas först när Ligor-fliken öppnas). */
  var leagueData = null;   // data/club_leagues.json ({ leagues, clubs })
  var preRounds = null;    // data/bracket_probs_pre.json rounds (förväntan vid start)
  var curRounds = null;    // data/bracket_probs.json rounds (nuläget)
  var leagueLoad = 0;      // 0 = ej startad · 1 = laddar · 2 = klar (även vid fel)

  /* UI-läge (ej persistent) */
  var stateUi = {
    mode: "players",     // "players" | "teams" | "regions" | "leagues"
    q: "",
    team: "",            // iso eller "" = alla
    pos: "",             // GK/DF/MF/FW eller "" = alla
    status: "",          // ""=alla · "issue"=någon status · "out"=ej tillgänglig · "doubtful"=osäker
    conf: "",            // regionnamn (Europa m.fl.) eller "" = alla (lag-läget)
    limit: 50,
    sort: {
      players: { key: "points", dir: -1 },
      teams:   { key: "points", dir: -1 },
      regions: { key: "ppm",    dir: -1 },
      leagues: { key: "opmv",   dir: -1 }
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

  /* FIFA:s fair play-poäng för en match, per lag (h/a). Avdrag räknas per
     spelare med hårdaste avdraget gällande:
       gult −1 · andra gula (utvisning) −3 · direkt rött −4 · gult + rött −5.
     Returnerar negativa poäng, t.ex. { h: -4, a: -1 }. */
  function fairPlayForMatch(det) {
    var res = { h: 0, a: 0 };
    if (!det || !det.bookings || !det.bookings.length) return res;
    var players = {};
    det.bookings.forEach(function (b) {
      if (!b || (b.team !== "h" && b.team !== "a")) return;
      var pk = b.team + "|" + (b.player || "?" + b.minute);
      var p = players[pk] || (players[pk] = { side: b.team, y: 0, yr: 0, r: 0 });
      if (b.card === "YELLOW") p.y++;
      else if (b.card === "YELLOW_RED") p.yr++;
      else if (b.card === "RED") p.r++;
    });
    Object.keys(players).forEach(function (pk) {
      var p = players[pk];
      var ded;
      if (p.yr || (!p.r && p.y >= 2)) ded = 3;   // andra gula kortet
      else if (p.r) ded = p.y ? 5 : 4;           // direkt rött (+ ev. gult)
      else ded = p.y ? 1 : 0;
      res[p.side] -= ded;
    });
    return res;
  }
  /* ---------- Aggregera spelarhändelser + minuter per spelare ---------- */

  function statBucket(map, team, name) {
    var k = team.iso + "|" + norm(name);
    return map[k] || (map[k] = {
      name: name, team: team,
      goals: 0, pens: 0, og: 0, assists: 0, y: 0, r: 0,
      min: 0, apps: 0,
      sh: 0, sg: 0, sv: 0, fc: 0, fs: 0,   // boxscore: skott/på mål/räddningar/fouls
      rSum: 0, rMin: 0,                     // FotMob-betyg: Σ(betyg × min) och Σ(min över matcher med betyg)
      xg: 0, xgot: 0, xgShots: 0,           // FotMob-xG: summerade skott-xG (straffläggning/självmål exkl.)
      xgGoals: 0, xgApps: 0,                // mål + matcher i matcher MED xG-data (för ärlig mål−xG-diff)
      log: []                               // per-match-rader (spelarmodalens matchlogg)
    });
  }

  /* Matchmetadata till spelarens matchlogg: rundetikett + datum via
     VMApp.describeMatch (samma källa som matchinfo-modalen). */
  function matchMeta(key) {
    var label = null, date = null;
    if (window.VMApp && typeof VMApp.describeMatch === "function") {
      try {
        var info = VMApp.describeMatch(key);
        if (info) {
          label = info.label || null;
          date = info.m && info.m.date ? info.m.date : null;
        }
      } catch (e) {}
    }
    if (!label) {
      var g = /^g:([A-L]):/.exec(key);
      if (g) label = "Grupp " + g[1];
    }
    return { label: label, date: date };
  }

  /*
    Matchbetyget är FotMobs Opta-baserade spelarbetyg (10-gradigt), hämtat i
    data/fotmob_ratings.json och kopplat till ESPN-lineupens spelarnamn (k =
    normaliserat namn). Det fångar hela spelet – även tacklingar, brytningar,
    passningar och positionsspel – till skillnad från ESPN:s gratisdata som
    saknar defensiva aktioner. Saknas betyget för en spelare i en match (sena
    inhopp eller namn som inte kunnat kopplas) bidrar hen inte till snittet.
    Turneringsbetyget är minutviktat (ESPN-minuter): Σ(betyg × min) / Σ(min).
    Lag-, regions- och ligasnitt bygger vidare på samma per-spelare-betyg.
  */
  function addSideMatch(map, key, meta, det, side, team, oppTeam) {
    var lu = det.lineups && det.lineups[side];
    if (!lu) return;
    var full = matchFull(det);
    var opp = side === "h" ? "a" : "h";
    var play = {}; // norm namn -> { name, in, out, starter }

    (lu.starters || []).forEach(function (s) {
      if (!s || !s.name) return;
      play[norm(s.name)] = { name: s.name, in: 0, out: full, starter: true };
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

    /* Boxscore per spelare (skott/räddningar/fouls till spelarmodalen). */
    var box = {};
    (lu.starters || []).forEach(function (s) {
      if (s && s.name && s.st) box[norm(s.name)] = s.st;
    });
    (lu.bench || []).forEach(function (s) {
      if (s && s.name && s.st) box[norm(s.name)] = s.st;
    });

    /* Den här matchens individuella händelser för sidans spelare. */
    var ind = {};
    function indOf(n) {
      return ind[n] || (ind[n] = { g: 0, pen: 0, og: 0, a: 0, y: 0, yr: 0, rd: 0 });
    }
    (det.goals || []).forEach(function (gl) {
      if (!gl.scorer) return;
      if (gl.type === "OWN") {
        if (gl.team === opp) indOf(norm(gl.scorer)).og++; // självmålsskytten hör till oss
        return;
      }
      if (gl.team !== side) return;
      var o = indOf(norm(gl.scorer));
      o.g++;
      if (gl.type === "PENALTY") o.pen++;
      if (gl.assist) indOf(norm(gl.assist)).a++;
    });
    (det.bookings || []).forEach(function (bk) {
      if (bk.team !== side || !bk.player) return;
      var o = indOf(norm(bk.player));
      if (bk.card === "YELLOW") o.y++;
      else if (bk.card === "YELLOW_RED") o.yr++;
      else if (bk.card === "RED") o.rd++;
    });

    var ft = det.score && det.score.ft;
    var res = ft && ft.h != null && ft.a != null
      ? (ft[side] > ft[opp] ? 1 : ft[side] < ft[opp] ? -1 : 0)
      : 0;

    Object.keys(play).forEach(function (k) {
      var pl = play[k];
      var pin = pl.in == null ? 0 : pl.in;
      var pout = pl.out == null ? full : pl.out;
      var mins = Math.max(0, pout - pin);
      var b = statBucket(map, team, pl.name);
      b.min += mins;
      b.apps += 1;

      var st = box[k];
      if (st) {
        b.sh += st.sh || 0; b.sg += st.sg || 0; b.sv += st.sv || 0;
        b.fc += st.fc || 0; b.fs += st.fs || 0;
      }

      var o = ind[k] || { g: 0, pen: 0, og: 0, a: 0, y: 0, yr: 0, rd: 0 };

      /* Matchloggrad (spelarmodalen): motståndare, resultat, speltid,
         händelser och matchbetyg (sätts nedan när minuter finns). */
      var entry = {
        key: key, label: meta.label, date: meta.date,
        oppIso: oppTeam ? oppTeam.iso : null,
        oppSv: oppTeam ? teamShort(oppTeam) : "?",
        gf: ft ? ft[side] : null, ga: ft ? ft[opp] : null,
        res: (ft && ft.h != null && ft.a != null) ? res : null,
        min: mins, on: pin, off: pout, full: full, starter: !!pl.starter,
        g: o.g, pen: o.pen, og: o.og, a: o.a, y: o.y, yr: o.yr, rd: o.rd,
        sv: st ? (st.sv || 0) : 0,
        rating: null, xg: null
      };
      b.log.push(entry);

      if (mins <= 0) return;

      /* Matchbetyg = FotMobs Opta-baserade betyg, kopplat på ESPN:s
         normaliserade namn (k) i data/fotmob_ratings.json. Saknas betyget
         (t.ex. sena inhopp eller namn som inte kunnat kopplas) bidrar spelaren
         inte till snittet och visas som "–". Minutviktat turneringsbetyg:
         Σ(betyg × minuter) / Σ(minuter över matcher med betyg). */
      var fmMap = fotmobRatings && fotmobRatings[key] && fotmobRatings[key].players
        ? fotmobRatings[key].players[side] : null;
      var fmR = fmMap && fmMap[k] != null ? fmMap[k] : null;
      if (fmR != null) {
        entry.rating = fmR;
        b.rSum += fmR * mins;
        b.rMin += mins;
      }

      /* xG per spelare = summan av skottens xG i matchen (FotMob/Opta, samma
         källa som betyget). En spelare utan skott har 0.00 xG i matchen –
         det är data, inte databrist – så täckningen räknas per match med
         xG-underlag (xgApps). Målen ur samma underlag ger en ärlig mål−xG-
         diff även om ESPN- och FotMob-datan skulle glappa om en match. */
      var xgSide = fotmobRatings && fotmobRatings[key] && fotmobRatings[key].playerXg
        ? fotmobRatings[key].playerXg[side] : null;
      if (xgSide) {
        b.xgApps += 1;
        var xe = xgSide[k];
        if (xe) {
          entry.xg = xe.xg;
          b.xg += xe.xg || 0;
          b.xgot += xe.xgot || 0;
          b.xgShots += xe.shots || 0;
          b.xgGoals += xe.goals || 0;
        }
      }
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

      var meta = matchMeta(key);
      addSideMatch(map, key, meta, det, "h", sides.h, sides.a);
      addSideMatch(map, key, meta, det, "a", sides.a, sides.h);
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
    st = st || { goals: 0, pens: 0, og: 0, assists: 0, y: 0, r: 0, min: 0, apps: 0,
                 sh: 0, sg: 0, sv: 0, fc: 0, fs: 0, rSum: 0, rMin: 0,
                 xg: 0, xgot: 0, xgShots: 0, xgGoals: 0, xgApps: 0, log: [] };
    var goals = st.goals, assists = st.assists, min = st.min || 0;
    var avail = (p && window.VMPlayers && VMPlayers.getPlayerStatus) ? VMPlayers.getPlayerStatus(p.id) : null;
    var met = (p && window.VMPlayers && VMPlayers.getPlayerMetrics) ? VMPlayers.getPlayerMetrics(p.id) : null;
    var csGoals = met && met.season ? met.season.total.goals : null;
    var csApps = met && met.season ? met.season.total.apps : null;
    return {
      name: p ? p.name : (fallbackName || "?"),
      nameN: norm(p ? p.name : fallbackName),
      pid: p ? p.id : null,
      captain: !!(p && p.captain),
      avail: avail,
      shirt: p && p.shirt_number != null ? p.shirt_number : null,
      teamIso: te.iso, teamSv: te.sv, teamShort: teamShort(te), teamN: norm(te.sv + " " + te.name),
      letter: te.letter, teamObj: te.team,
      pos: p ? p.pos_code : null, posSv: p ? p.position_sv : null,
      age: p && p.age != null ? p.age : null,
      club: p ? (p.club || null) : null, clubN: norm(p && p.club),
      caps: p && p.caps != null ? p.caps : null,
      /* Betting-metrik (marknadsvärde + klubbform 2025/26) från player_metrics. */
      mv: met && met.market_value_eur != null ? met.market_value_eur : null,
      mvLabel: met && met.market_value ? met.market_value : null,
      csGoals: csGoals, csApps: csApps,
      csGpa: met && met.season ? met.season.gpa : null,
      goals: goals, pens: st.pens, og: st.og, assists: assists,
      y: st.y, r: st.r,
      min: min, apps: st.apps || 0,
      points: goals + assists,
      g90: per90(goals, min),
      a90: per90(assists, min),
      gi90: per90(goals + assists, min),
      sh: st.sh || 0, sg: st.sg || 0, sv: st.sv || 0, fc: st.fc || 0, fs: st.fs || 0,
      rSum: st.rSum || 0, rMin: st.rMin || 0,
      /* xG (FotMob/Opta): null = inget xG-underlag för spelarens matcher ännu.
         xgd = mål − xG ur samma underlag: positivt = klinisk avslutare som
         gör mer av sina chanser än förväntat (Marocko/Norge-effekten). */
      xg: (st.xgApps || 0) > 0 ? st.xg : null,
      xgGoals: st.xgGoals || 0,
      xgShots: st.xgShots || 0,
      xgd: (st.xgApps || 0) > 0 ? (st.xgGoals || 0) - st.xg : null,
      /* Matchlogg i kronologisk ordning (datum, sedan nyckel som stabil backup). */
      log: (st.log || []).slice().sort(function (a, b) {
        var ad = a.date || "", bd = b.date || "";
        return ad < bd ? -1 : ad > bd ? 1 : (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
      }),
      rating: (st.rMin || 0) > 0 ? st.rSum / st.rMin : null,
      ratingQ: (st.rMin || 0) >= RATING_QUAL_MIN,
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
        gf: 0, ga: 0, gd: 0, y: 0, r: 0, cs: 0, fp: 0,
        /* xG (FotMob/Opta): summeras bara över matcher med xG-underlag; xgGf/
           xgGa = mål i samma matcher så mål−xG-diffen jämför äpplen med äpplen. */
        xg: 0, xga: 0, xgGf: 0, xgGa: 0, xgM: 0
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

      var fmx = fotmobRatings && fotmobRatings[key] ? fotmobRatings[key].xg : null;
      if (fmx && fmx.h != null && fmx.a != null) {
        hr.xg += fmx.h; hr.xga += fmx.a;
        ar.xg += fmx.a; ar.xga += fmx.h;
        hr.xgGf += ft.h; hr.xgGa += ft.a;
        ar.xgGf += ft.a; ar.xgGa += ft.h;
        hr.xgM++; ar.xgM++;
      }

      (det.bookings || []).forEach(function (bk) {
        var r = bk.team === "h" ? hr : bk.team === "a" ? ar : null;
        if (!r) return;
        if (bk.card === "YELLOW") r.y++;
        else if (bk.card === "RED" || bk.card === "YELLOW_RED") r.r++;
      });

      var fp = fairPlayForMatch(det);
      hr.fp += fp.h; ar.fp += fp.a;
    });

    var rows = Object.keys(byIso).map(function (iso) {
      var r = byIso[iso];
      r.gd = r.gf - r.ga;
      r.gpm = r.played > 0 ? r.gf / r.played : 0;
      r.gapm = r.played > 0 ? r.ga / r.played : 0;
      r.ypm = r.played > 0 ? r.y / r.played : 0;
      r.rpm = r.played > 0 ? r.r / r.played : 0;
      r.fppm = r.played > 0 ? r.fp / r.played : 0;
      r.played0 = r.played === 0;
      /* xG-effektivitet: ±xG = mål − xG (positivt = kliniska avslut, gör mer
         än chanserna "borde" ge); ±xGA = xGA − insläppta (positivt = släpper
         in färre än motståndarnas chanser borde ge – försvar/målvakt).
         Kvoterna (mål/xG resp. insläppta/xGA) normaliserar mot volymen:
         4 insläppta på 2 förväntade (2.00) är en annan sak än 27 på 25
         (1.08) fast differensen är −2 i båda fallen. */
      r.hasXg = r.xgM > 0;
      r.xgpm = r.xgM > 0 ? r.xg / r.xgM : 0;
      r.xgd = r.hasXg ? r.xgGf - r.xg : null;
      r.xgad = r.hasXg ? r.xga - r.xgGa : null;
      r.xgr = r.hasXg && r.xg > 0 ? r.xgGf / r.xg : null;
      r.xgar = r.hasXg && r.xga > 0 ? r.xgGa / r.xga : null;
      return r;
    });
    teamRowsCache = rows;
    return rows;
  }

  /* ---------- Bygg förbundsrader (aggregerat per konfederation) ----------

     Summerar lagraderna per förbund. En match räknas en gång per deltagande
     lag, så en intern match (t.ex. UEFA–UEFA) bidrar med två lagmatcher till
     förbundet och poängen/målen delas inom samma förbund. Per-match-värdena
     är därför snitt över förbundets samtliga lagmatcher. */

  function buildRegionRows() {
    if (regionRowsCache) return regionRowsCache;
    var byConf = {};
    ((window.WC && WC.confeds) || []).forEach(function (c) {
      byConf[c.code] = {
        conf: c.code, code: c.code, region: c.region,
        teams: 0, played: 0, w: 0, d: 0, l: 0, pts: 0,
        gf: 0, ga: 0, gd: 0, y: 0, r: 0, cs: 0, fp: 0
      };
    });

    buildTeamRows().forEach(function (t) {
      var r = byConf[t.conf];
      if (!r) return;
      r.teams++;
      r.played += t.played;
      r.w += t.w; r.d += t.d; r.l += t.l;
      r.pts += t.pts;
      r.gf += t.gf; r.ga += t.ga;
      r.y += t.y; r.r += t.r; r.cs += t.cs;
      r.fp += t.fp;
    });

    var rows = Object.keys(byConf).map(function (code) {
      var r = byConf[code];
      r.gd = r.gf - r.ga;
      r.ppm = r.played > 0 ? r.pts / r.played : 0;   // poäng per match
      r.gpm = r.played > 0 ? r.gf / r.played : 0;    // gjorda mål per match
      r.gapm = r.played > 0 ? r.ga / r.played : 0;   // insläppta mål per match
      r.ypm = r.played > 0 ? r.y / r.played : 0;     // gula kort per match
      r.rpm = r.played > 0 ? r.r / r.played : 0;     // röda kort per match
      r.fppm = r.played > 0 ? r.fp / r.played : 0;   // fair play-poäng per match
      r.played0 = r.played === 0;
      return r;
    }).filter(function (r) { return r.teams > 0; });

    regionRowsCache = rows;
    return rows;
  }

  /* ---------- Bygg ligarader (aggregerat per klubbliga) ----------

     Varje truppspelare hör till en klubb, varje klubb till en liga (land +
     division, data/club_leagues.json). Utöver produktion och minutviktat
     FotMob-betyg beräknas två överprestationsmått:

       • ±Snitt – ligans minutviktade betyg minus hela turneringens
         minutviktade snittbetyg. Positivt = ligans spelare har presterat
         bättre än VM-snittet på planen.
       • ±Prislapp – ligans betyg minus det betyg man kan förvänta sig av
         spelarnas marknadsvärden (Transfermarkt, wc2026_player_metrics).
         Förväntat betyg sätts PER SPELARE ur en minutviktad regression
         betyg ~ ln(marknadsvärde) över alla betygsatta VM-spelare med
         känt värde – logaritmen fångar att pengar ger avtagande avkastning
         (en dubbelt så dyr spelare är inte dubbelt så bra). Ligans värde
         är det minutviktade snittet av spelarnas egna residualer: varje
         spelare jämförs med spelare i samma prisklass var de än spelar,
         så en liga vars VM-spelare kommer från ett par dominanta stor-
         klubbar (Celtic/Rangers-fallet) bedöms efter de spelarnas pris-
         lappar, inte efter ligans genomsnittsstandard. Negativ lutning
         klipps till 0 så små/tidiga urval inte ger dyra ligor lägre
         förväntningar.
       • Δ Förväntan – hur landslagen som ligans spelare spelar i har
         utvecklats mot turneringsstartens slutspelsförväntan. För varje
         landslag: (förväntade avancemang nu) − (förväntade avancemang vid
         starten), där förväntade avancemang = P(sextondel) + P(åttondel) +
         P(kvart) + P(semi) + P(final) + P(titel). Lagets delta fördelas på
         ligor viktat med ligans andel av lagets totala spelarminuter och
         summeras per liga. Enhet: avancemang ("rundor"). */

  function loadLeagueData() {
    if (leagueLoad) return;
    leagueLoad = 1;
    function get(url) {
      return fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" })
        .then(function (r) { return r && r.ok ? r.json() : null; })
        .catch(function () { return null; });
    }
    Promise.all([
      get("data/club_leagues.json"),
      get("data/bracket_probs_pre.json"),
      get("data/bracket_probs.json")
    ]).then(function (res) {
      leagueData = res[0];
      preRounds = res[1] && res[1].rounds ? res[1].rounds : null;
      curRounds = res[2] && res[2].rounds ? res[2].rounds : null;
      leagueLoad = 2;
      leagueRowsCache = null;
      if (rootEl && document.body.contains(rootEl) && stateUi.mode === "leagues") render();
    });
  }

  /* FotMobs spelarbetyg – laddas en gång, oberoende av flik. Vid klar (även
     fel) nollas spelar-cachen så betygen kcommer in i nästa render. */
  function loadFotmobRatings() {
    if (fotmobLoad) return;
    fotmobLoad = 1;
    var url = (window.VM_CONFIG && window.VM_CONFIG.fotmobRatings) || "data/fotmob_ratings.json";
    fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" })
      .then(function (r) { return r && r.ok ? r.json() : null; })
      .catch(function () { return null; })
      .then(function (j) {
        fotmobRatings = j && j.matches ? j.matches : null;
        fotmobLoad = 2;
        playerRowsCache = null;
        teamRowsCache = null;
        regionRowsCache = null;
        leagueRowsCache = null;
        if (rootEl && document.body.contains(rootEl)) render();
      });
  }

  /* Förväntat antal avancemang för ett lag ur rundsannolikheterna. */
  function expRounds(r) {
    if (!r) return null;
    return (r.r32 || 0) + (r.r16 || 0) + (r.qf || 0) + (r.sf || 0) + (r.final || 0) + (r.win || 0);
  }

  function buildLeagueRows() {
    if (leagueRowsCache) return leagueRowsCache;
    if (!leagueData || !leagueData.leagues || !leagueData.clubs) return [];

    var prows = buildPlayerRows();

    /* Turneringens minutviktade snittbetyg (alla spelare, även omappade). */
    var gSum = 0, gMin = 0;
    prows.forEach(function (r) { gSum += r.rSum; gMin += r.rMin; });
    var globalRating = gMin > 0 ? gSum / gMin : null;

    /* Lagens totala spelarminuter + landslagens förväntansdelta. */
    var teamMin = {}, teamDelta = {};
    prows.forEach(function (r) {
      teamMin[r.teamIso] = (teamMin[r.teamIso] || 0) + r.min;
    });
    allTeams().forEach(function (te) {
      var pre = preRounds && expRounds(preRounds[te.name]);
      var cur = curRounds && expRounds(curRounds[te.name]);
      teamDelta[te.iso] = pre != null && cur != null ? cur - pre : null;
    });

    var by = {};
    prows.forEach(function (r) {
      if (!r.pid || !r.club) return; // bara truppspelare med klubb
      var lid = leagueData.clubs[r.club];
      var lg = lid && leagueData.leagues[lid];
      if (!lg) return; // klubb utan mappning (t.ex. efter truppuppdatering)
      var b = by[lid] || (by[lid] = {
        id: lid, country: lg.country, name: lg.name, tier: lg.tier || 1,
        iso: lg.iso || null, flag: lg.flag || "",
        label: lg.country + " – " + lg.name,
        labelN: norm(lg.country + " " + lg.name),
        players: 0, active: 0, teamIsos: {}, clubSet: {}, min: 0,
        goals: 0, assists: 0, y: 0, r: 0,
        rSum: 0, rMin: 0, tMin: {},
        mvRSum: 0, mvRMin: 0, mvLogSum: 0
      });
      b.players++;
      if (r.min > 0) b.active++;
      b.teamIsos[r.teamIso] = true;
      b.clubSet[r.club] = true;
      b.min += r.min;
      b.goals += r.goals; b.assists += r.assists;
      b.y += r.y; b.r += r.r;
      b.rSum += r.rSum; b.rMin += r.rMin;
      b.tMin[r.teamIso] = (b.tMin[r.teamIso] || 0) + r.min;
      /* Prislapps-underlaget: bara spelare med både betygsatta minuter och
         känt marknadsvärde (ln-summan bär regressionens x-värde). */
      if (r.mv > 0 && r.rMin > 0) {
        b.mvRSum += r.rSum; b.mvRMin += r.rMin;
        b.mvLogSum += r.rMin * Math.log(r.mv);
      }
    });

    var rows = Object.keys(by).map(function (lid) {
      var b = by[lid];
      b.teams = Object.keys(b.teamIsos).length;
      b.clubCount = Object.keys(b.clubSet).length;
      b.points = b.goals + b.assists;
      b.gi90 = per90(b.points, b.min);
      b.rating = b.rMin > 0 ? b.rSum / b.rMin : null;
      b.ratingQ = b.rMin >= LEAGUE_QUAL_MIN;
      b.op = b.rating != null && globalRating != null ? b.rating - globalRating : null;
      /* Prislapps-siffrorna: minutviktat geometriskt snittvärde + betyget
         över samma spelarurval (så att ± exakt blir snittresidualen). */
      b.mvAvg = b.mvRMin > 0 ? Math.exp(b.mvLogSum / b.mvRMin) : null;
      b.mvRating = b.mvRMin > 0 ? b.mvRSum / b.mvRMin : null;
      b.mvQ = b.mvRMin >= LEAGUE_QUAL_MIN;

      /* Δ Förväntan: fördela lagens delta på ligans minutandel per lag. */
      var d = 0, dOk = false;
      Object.keys(b.tMin).forEach(function (iso) {
        var td = teamDelta[iso];
        if (td == null || !teamMin[iso]) return;
        d += td * (b.tMin[iso] / teamMin[iso]);
        dOk = true;
      });
      b.dexp = dOk ? d : null;
      return b;
    });

    /* ±Prislapp: minutviktad regression betyg ~ ln(marknadsvärde) på
       SPELARNIVÅ (alla betygsatta spelare med känt värde, vikt = betygsatta
       minuter). Ligans förväntade betyg = regressionen i ligans viktade
       ln-snittvärde, så residualen blir exakt det minutviktade snittet av
       spelarnas egna residualer: varje spelare jämförs med spelare i samma
       prisklass oavsett liga – en liga kan inte se överpresterande ut bara
       för att dess VM-spelare kommer från ligans storklubbar. Negativ
       lutning klipps till 0 (= jämför mot viktade snittet) i små urval. */
    var reg = null;
    var W = 0, mx = 0, my = 0, nP = 0;
    prows.forEach(function (r) {
      if (!(r.mv > 0) || !(r.rMin > 0)) return;
      nP++; W += r.rMin;
      mx += r.rMin * Math.log(r.mv);
      my += r.rSum;
    });
    if (nP >= 8 && W > 0) {
      mx /= W; my /= W;
      var sxx = 0, sxy = 0;
      prows.forEach(function (r) {
        if (!(r.mv > 0) || !(r.rMin > 0)) return;
        var dx = Math.log(r.mv) - mx, dy = r.rSum / r.rMin - my;
        sxx += r.rMin * dx * dx;
        sxy += r.rMin * dx * dy;
      });
      var slope = sxx > 0 ? Math.max(0, sxy / sxx) : 0;
      reg = { b: slope, a: my - slope * mx };
    }
    rows.forEach(function (r) {
      r.expRating = reg && r.mvAvg != null ? reg.a + reg.b * Math.log(r.mvAvg) : null;
      r.opmv = r.expRating != null && r.mvRating != null ? r.mvRating - r.expRating : null;
    });

    rows.regression = reg;
    rows.globalRating = globalRating;
    leagueRowsCache = rows;
    return rows;
  }

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
    rating:  { type: "num", qual: "rating", get: function (r) { return r.rating; } },
    xg:      { type: "num", get: function (r) { return r.xg; } },
    xgd:     { type: "num", get: function (r) { return r.xgd; } },
    y:       { type: "num", get: function (r) { return r.y; } },
    r:       { type: "num", get: function (r) { return r.r; } },
    mv:      { type: "num", get: function (r) { return r.mv; } },
    csgoals: { type: "num", get: function (r) { return r.csGoals; } },
    csgpa:   { type: "num", get: function (r) { return r.csGpa; } }
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
    xg:      { type: "num", get: function (r) { return r.hasXg ? r.xg : null; } },
    xgd:     { type: "num", get: function (r) { return r.hasXg ? r.xgd : null; } },
    xgr:     { type: "num", get: function (r) { return r.xgr; } },
    xga:     { type: "num", get: function (r) { return r.hasXg ? r.xga : null; } },
    xgad:    { type: "num", get: function (r) { return r.hasXg ? r.xgad : null; } },
    xgar:    { type: "num", get: function (r) { return r.xgar; } },
    y:       { type: "num", get: function (r) { return r.y; } },
    r:       { type: "num", get: function (r) { return r.r; } },
    ypm:     { type: "num", get: function (r) { return r.ypm; } },
    rpm:     { type: "num", get: function (r) { return r.rpm; } },
    fp:      { type: "num", get: function (r) { return r.fp; } },
    fppm:    { type: "num", get: function (r) { return r.fppm; } },
    cs:      { type: "num", get: function (r) { return r.cs; } },
    pts:     { type: "num", get: function (r) { return r.pts; } }
  };

  var REGION_SORTS = {
    region:  { type: "str", get: function (r) { return r.region; } },
    teams:   { type: "num", get: function (r) { return r.teams; } },
    played:  { type: "num", get: function (r) { return r.played; } },
    w:       { type: "num", get: function (r) { return r.w; } },
    d:       { type: "num", get: function (r) { return r.d; } },
    l:       { type: "num", get: function (r) { return r.l; } },
    gf:      { type: "num", get: function (r) { return r.gf; } },
    ga:      { type: "num", get: function (r) { return r.ga; } },
    gd:      { type: "num", get: function (r) { return r.gd; } },
    ppm:     { type: "num", get: function (r) { return r.ppm; } },
    gpm:     { type: "num", get: function (r) { return r.gpm; } },
    gapm:    { type: "num", get: function (r) { return r.gapm; } },
    cs:      { type: "num", get: function (r) { return r.cs; } },
    y:       { type: "num", get: function (r) { return r.y; } },
    r:       { type: "num", get: function (r) { return r.r; } },
    ypm:     { type: "num", get: function (r) { return r.ypm; } },
    rpm:     { type: "num", get: function (r) { return r.rpm; } },
    fp:      { type: "num", get: function (r) { return r.fp; } },
    fppm:    { type: "num", get: function (r) { return r.fppm; } },
    pts:     { type: "num", get: function (r) { return r.pts; } }
  };

  var LEAGUE_SORTS = {
    league:  { type: "str", get: function (r) { return r.label; } },
    players: { type: "num", get: function (r) { return r.players; } },
    goals:   { type: "num", get: function (r) { return r.goals; } },
    assists: { type: "num", get: function (r) { return r.assists; } },
    min:     { type: "num", get: function (r) { return r.min; } },
    mv:      { type: "num", get: function (r) { return r.mvAvg; } },
    rating:  { type: "num", qual: true, get: function (r) { return r.rating; } },
    opmv:    { type: "num", qual: "mv", get: function (r) { return r.opmv; } },
    dexp:    { type: "num", get: function (r) { return r.dexp; } }
  };

  /* Aktuell sorteringsuppsättning för rådande läge. */
  function sortDefs() {
    return stateUi.mode === "teams" ? TEAM_SORTS
      : stateUi.mode === "regions" ? REGION_SORTS
      : stateUi.mode === "leagues" ? LEAGUE_SORTS
      : PLAYER_SORTS;
  }

  /* Tiebreak-steg: 0/NaN ignoreras så nästa kriterium provas (|| skulle
     felaktigt hoppa över t.ex. per-90 vid NaN och falla tillbaka på minuter). */
  function tieChain() {
    for (var i = 0; i < arguments.length; i++) {
      var d = arguments[i];
      if (d) return d;
    }
    return 0;
  }

  function per90Rate(r, kind) {
    if (kind === "a") return r.a90 != null ? r.a90 : per90(r.assists, r.min);
    if (kind === "gi") return r.gi90 != null ? r.gi90 : per90(r.goals + r.assists, r.min);
    return r.g90 != null ? r.g90 : per90(r.goals, r.min);
  }

  /* Per-90 som skiljedomare: vid lika rubriksiffra rankas högre mål/90 (eller
     ass/90 / mål+ass/90) högre upp. Kräver minst 2 spelade minuter; okvalificerade
     (0–1 min) rankas efter kvalificerade. Returnerar positivt om b före a. */
  function per90Tie(a, b, kind) {
    if (a.qualified && b.qualified) {
      return per90Rate(b, kind) - per90Rate(a, kind);
    }
    if (a.qualified !== b.qualified) return a.qualified ? -1 : 1;
    return b.min - a.min;
  }

  /* Färre spelade minuter = högre effektivitet vid lika per-90. */
  function minEffTie(a, b) {
    return a.min - b.min;
  }

  /* Sekundärordning. Vid sortering på mål/assist-kolumnerna: först antal,
     sedan per-90 (högre mål/90 eller ass/90 rankas högre vid lika rubriksiffra),
     därefter övrig produktion och namn. Vid poäng/övriga kolumner väger mål
     tyngre än assist (3 mål slår 1 mål + 2 assist) innan per-90 används. */
  function playerTiebreak(a, b, key) {
    if (key === "goals") {
      return tieChain(b.goals - a.goals, per90Tie(a, b, "g"),
        b.assists - a.assists, minEffTie(a, b), a.name.localeCompare(b.name, "sv"));
    }
    if (key === "assists") {
      return tieChain(b.assists - a.assists, per90Tie(a, b, "a"),
        b.goals - a.goals, minEffTie(a, b), a.name.localeCompare(b.name, "sv"));
    }
    if (key === "g90") {
      return tieChain(per90Tie(a, b, "g"), b.goals - a.goals, b.assists - a.assists,
        minEffTie(a, b), a.name.localeCompare(b.name, "sv"));
    }
    if (key === "a90") {
      return tieChain(per90Tie(a, b, "a"), b.assists - a.assists, b.goals - a.goals,
        minEffTie(a, b), a.name.localeCompare(b.name, "sv"));
    }
    /* points + övriga kolumner: poäng → mål → assist → per-90 → färre min → namn */
    return tieChain(b.points - a.points, b.goals - a.goals, b.assists - a.assists,
      per90Tie(a, b, "gi"), minEffTie(a, b), a.name.localeCompare(b.name, "sv"));
  }

  function cmpPlayers(a, b) {
    var st = stateUi.sort.players;
    var s = PLAYER_SORTS[st.key] || PLAYER_SORTS.points;
    var av = s.get(a), bv = s.get(b), d = 0;
    if (s.type === "num") {
      var an = av == null ? -Infinity : av;
      var bn = bv == null ? -Infinity : bv;
      if (s.qual) {
        /* "rating" kräver minst RATING_QUAL_MIN minuter, övriga QUAL_MIN. */
        if (!(s.qual === "rating" ? a.ratingQ : a.qualified)) an = -Infinity;
        if (!(s.qual === "rating" ? b.ratingQ : b.qualified)) bn = -Infinity;
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

  function cmpRegions(a, b) {
    var st = stateUi.sort.regions;
    var s = REGION_SORTS[st.key] || REGION_SORTS.ppm;
    var av = s.get(a), bv = s.get(b), d = 0;
    if (s.type === "num") d = (av == null ? -Infinity : av) - (bv == null ? -Infinity : bv);
    else d = String(av).localeCompare(String(bv), "sv");
    d *= st.dir;
    if (d) return d;
    return (b.ppm - a.ppm) || (b.gd - a.gd) || (b.gf - a.gf) || a.region.localeCompare(b.region, "sv");
  }

  function cmpLeagues(a, b) {
    var st = stateUi.sort.leagues;
    var s = LEAGUE_SORTS[st.key] || LEAGUE_SORTS.rating;
    var av = s.get(a), bv = s.get(b), d = 0;
    if (s.type === "num") {
      var an = av == null ? -Infinity : av;
      var bn = bv == null ? -Infinity : bv;
      /* Betygsbaserade kolumner kräver LEAGUE_QUAL_MIN spelade minuter
         ("mv" = samma krav men räknat på spelare med känt marknadsvärde). */
      if (s.qual) {
        if (!(s.qual === "mv" ? a.mvQ : a.ratingQ)) an = -Infinity;
        if (!(s.qual === "mv" ? b.mvQ : b.ratingQ)) bn = -Infinity;
      }
      d = an - bn;
    } else {
      d = String(av).localeCompare(String(bv), "sv");
    }
    d *= st.dir;
    if (d) return d;
    var ar = a.ratingQ && a.rating != null ? a.rating : -Infinity;
    var br = b.ratingQ && b.rating != null ? b.rating : -Infinity;
    return (br - ar) || (b.min - a.min) || a.label.localeCompare(b.label, "sv");
  }

  /* ---------- Filtrering ---------- */

  function filteredPlayerRows() {
    var q = norm(stateUi.q);
    return buildPlayerRows().filter(function (r) {
      if (stateUi.team && r.teamIso !== stateUi.team) return false;
      if (stateUi.pos && r.pos !== stateUi.pos) return false;
      if (stateUi.status) {
        if (!r.avail) return false;
        if (stateUi.status !== "issue" && r.avail.availability !== stateUi.status) return false;
      }
      if (q && r.nameN.indexOf(q) === -1 && r.teamN.indexOf(q) === -1 &&
          r.clubN.indexOf(q) === -1) return false;
      return true;
    }).sort(cmpPlayers);
  }

  function filteredTeamRows() {
    var q = norm(stateUi.q);
    return buildTeamRows().filter(function (r) {
      if (stateUi.conf && r.region !== stateUi.conf) return false;
      if (q && r.teamN.indexOf(q) === -1) return false;
      return true;
    }).sort(cmpTeams);
  }

  function filteredRegionRows() {
    return buildRegionRows().slice().sort(cmpRegions);
  }

  function filteredLeagueRows() {
    var q = norm(stateUi.q);
    return buildLeagueRows().filter(function (r) {
      if (q && r.labelN.indexOf(q) === -1) return false;
      return true;
    }).sort(cmpLeagues);
  }

  /* Regioner som faktiskt har lag i turneringen, i WC.confeds visningsordning. */
  function teamRegions() {
    var present = {};
    buildTeamRows().forEach(function (r) { if (r.conf) present[r.conf] = true; });
    return ((window.WC && WC.confeds) || []).filter(function (c) { return present[c.code]; });
  }
  /* ---------- Topplistor (leader-kort + topp-20-modal) ---------- */

  function cardsCell(n, kind) {
    if (!n) return '<span class="ps-zero">–</span>';
    return '<span class="cards-cell"><span class="card-ico ' + kind + '" aria-hidden="true"></span>' + n + "</span>";
  }

  /* Kort-per-match: visar snittet (två decimaler) med kortikonen. */
  function cardsRateCell(v, played, kind) {
    if (!played) return '<span class="ps-zero">–</span>';
    return '<span class="cards-cell"><span class="card-ico ' + kind + '" aria-hidden="true"></span>' + fmt2(v) + "</span>";
  }

  /* Litet förbundsmärke (UEFA m.fl.) – ersätter flaggan i förbundsläget. */
  function confBadge(code) {
    return '<span class="ps-conf-badge">' + esc(code) + "</span>";
  }
  /* Ligans flagga (klubblandets, inte landslagets). Flaggbild via samma
     flagcdn som lagen; emoji som reserv (Windows saknar flagg-emoji). */
  function leagueFlag(r) {
    if (r.iso) return flagImg(r.iso);
    return '<span class="ps-league-flag">' + (r.flag || "🏳️") + "</span>";
  }
  /* Ledarkortets vänsterikon: flagga för spelare/lag, förbundsmärke för förbund. */
  function leaderFlag(cfg, r) {
    if (cfg.kind === "regions") return confBadge(r.code);
    if (cfg.kind === "leagues") return leagueFlag(r);
    return flagImg(r.iso || r.teamIso);
  }

  /* Formatera betyg (10-gradigt, en decimal) och signerade ±-värden. */
  function fmtRating(v) {
    return isFinite(v) ? (Math.round(v * 10) / 10).toFixed(1) : "–";
  }
  function fmtSigned(v, dec) {
    if (v == null || !isFinite(v)) return "–";
    var s = v.toFixed(dec == null ? 2 : dec);
    return (v > 0 ? "+" : "") + s;
  }

  /* Marknadsvärde i euro → kompakt etikett ("4.5 M€", "600 k€"). */
  function fmtMv(v) {
    if (v == null || !isFinite(v) || v <= 0) return "–";
    if (v >= 950e3) {
      var m = v / 1e6;
      return (m >= 20 ? String(Math.round(m)) : m.toFixed(1)) + " M€";
    }
    return Math.round(v / 1e3) + " k€";
  }

  /* Returnerar konfig för de tre topplistorna i aktuellt läge. */
  function leaderConfigs() {
    if (stateUi.mode === "leagues") {
      var lrows = buildLeagueRows();
      return [
        {
          id: "lrating", kind: "leagues", title: "Högst betyg (FotMob)", icon: "⭐", rows: lrows,
          valFn: function (r) { return r.ratingQ && r.rating != null ? r.rating : 0; },
          mainFn: function (r) { return fmtRating(r.rating); },
          rateFn: function (r) { return r.active + " spelare · " + r.min + " min"; }
        },
        {
          id: "ldexp", kind: "leagues", title: "Störst lyft mot förväntan", icon: "🚀", rows: lrows,
          valFn: function (r) { return r.dexp != null && r.min > 0 ? r.dexp : 0; },
          mainFn: function (r) { return fmtSigned(r.dexp); },
          rateFn: function (r) { return r.teams + " landslag · " + r.min + " min"; }
        },
        {
          id: "lopmv", kind: "leagues", title: "Över sin prislapp", icon: "💎", rows: lrows,
          valFn: function (r) { return r.mvQ && r.opmv != null && r.opmv > 0 ? r.opmv : 0; },
          mainFn: function (r) { return fmtSigned(r.opmv); },
          rateFn: function (r) { return "betyg " + fmtRating(r.mvRating) + " · förväntat " + fmtRating(r.expRating); }
        }
      ];
    }
    if (stateUi.mode === "regions") {
      var rrows = buildRegionRows();
      return [
        {
          id: "ppm", kind: "regions", title: "Bäst poäng/match", icon: "🏆", rows: rrows,
          valFn: function (r) { return r.played; },
          rankFn: function (r) { return r.ppm; },
          mainFn: function (r) { return fmt2(r.ppm); },
          rateFn: function (r) { return r.pts + " p · " + r.played + " matcher"; }
        },
        {
          id: "rgpm", kind: "regions", title: "Flest mål/match", icon: "⚽", rows: rrows,
          valFn: function (r) { return r.played; },
          rankFn: function (r) { return r.gpm; },
          mainFn: function (r) { return fmt2(r.gpm); },
          rateFn: function (r) { return r.gf + " mål totalt"; }
        },
        {
          id: "rgapm", kind: "regions", title: "Minst insläppta mål/match", icon: "🛡️", rows: rrows,
          valFn: function (r) { return r.played; },
          rankFn: function (r) { return -r.gapm; },
          mainFn: function (r) { return fmt2(r.gapm); },
          rateFn: function (r) { return r.ga + " insläppta totalt"; }
        }
      ];
    }
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
          id: "txgd", kind: "teams", title: "Kliniska lag (mål − xG)", icon: "🎯", rows: trows,
          valFn: function (r) { return r.hasXg && r.xgd > 0 ? r.xgd : 0; },
          mainFn: function (r) { return fmtSigned(r.xgd); },
          rateFn: function (r) { return r.xgGf + " mål på " + fmt2(r.xg) + " xG"; }
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
        id: "rating", kind: "players", title: "Högst betyg (FotMob)", icon: "⭐", rows: prows,
        valFn: function (r) { return r.ratingQ && r.rating != null ? r.rating : 0; },
        mainFn: function (r) { return fmtRating(r.rating); },
        rateFn: function (r) { return r.min + " min · " + r.apps + (r.apps === 1 ? " match" : " matcher"); }
      },
      {
        id: "pxgd", kind: "players", title: "Kliniska avslutare (mål − xG)", icon: "🎯", rows: prows,
        valFn: function (r) { return r.xg != null && r.xgd > 0 ? r.xgd : 0; },
        mainFn: function (r) { return fmtSigned(r.xgd); },
        rateFn: function (r) { return r.xgGoals + " mål på " + fmt2(r.xg) + " xG (" + r.xgShots + " skott)"; }
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
        var d = rank(b) - rank(a);
        if (d) return d;
        if (cfg.kind === "players" && (cfg.id === "goals" || cfg.id === "assists")) {
          return playerTiebreak(a, b, cfg.id);
        }
        return tieChain(
          cfg.tieKind ? per90Tie(a, b, cfg.tieKind) : 0,
          cfg.kind === "players" ? (b.points - a.points) : (b.pts - a.pts),
          cfg.kind === "players" ? minEffTie(a, b) : 0
        );
      })
      .slice(0, n);
  }

  function leaderName(cfg, r) {
    if (cfg.kind === "teams") return r.sv;
    if (cfg.kind === "regions") return r.region;
    /* Flaggan visar redan klubblandet – visa bara liganamnet (fulla landet i title). */
    if (cfg.kind === "leagues") return r.name;
    return r.name;
  }
  function leaderTitle(cfg, r) {
    if (cfg.kind === "teams") return r.sv;
    if (cfg.kind === "regions") return r.region;
    if (cfg.kind === "leagues") return r.label + " (nivå " + r.tier + ")";
    return r.name + " · " + r.teamSv;
  }

  function leaderCard(cfg) {
    var isRegion = cfg.kind === "regions";
    /* Regioner är få (en handfull världsdelar) – visa alla i kortet utan
       topp-20-modal. Övriga lägen: topp 5 + klickbart kort som öppnar modal. */
    var top = leaderRanked(cfg, isRegion ? cfg.rows.length : 5);
    if (!top.length) return "";
    var tag = isRegion ? "div" : "button";
    var open = isRegion ? "" : ' type="button" data-ps-top="' + cfg.id + '"';
    var h = "<" + tag + ' class="ps-leader card' + (isRegion ? " ps-static" : "") + '"' + open + ">" +
      '<div class="ps-leader-title">' + cfg.icon + " " + esc(cfg.title) + "</div>";
    top.forEach(function (r, i) {
      h += '<div class="ps-leader-row' + (i === 0 ? " first" : "") + (isRegion ? " is-region" : "") + '">' +
        '<span class="ps-leader-pos">' + (i + 1) + "</span>" +
        (isRegion ? "" : leaderFlag(cfg, r)) +
        '<span class="ps-leader-name" title="' + esc(leaderTitle(cfg, r)) + '">' + esc(leaderName(cfg, r)) + "</span>" +
        '<span class="ps-leader-val">' + cfg.mainFn(r) + "</span>" +
        "</div>";
    });
    if (!isRegion) h += '<span class="ps-leader-more">Visa topp 20 →</span>';
    return h + "</" + tag + ">";
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
      if (row) { closeTopModal(); openPlayer(row.getAttribute("data-ps-player")); return; }
      var lrow = e.target.closest && e.target.closest("[data-ps-league]");
      if (lrow) openLeagueModal(lrow.getAttribute("data-ps-league"));
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") closeTopModal(); });
    return m;
  }

  function openTopModal(id) {
    var cfg = leaderConfigs().filter(function (c) { return c.id === id; })[0];
    if (!cfg) return;
    var top = leaderRanked(cfg, 20);
    var isPlayers = cfg.kind === "players";
    var kindLabel = cfg.kind === "teams" ? "lag" : cfg.kind === "regions" ? "regioner"
      : cfg.kind === "leagues" ? "ligor" : "spelare";
    var isRegions = cfg.kind === "regions";
    var rows = top.map(function (r, i) {
      var clickable = isPlayers && r.pid;
      var rowAttr = clickable ? ' data-ps-player="' + esc(r.pid) + '" role="button" tabindex="0"'
        : cfg.kind === "leagues" ? ' data-ps-league="' + esc(r.id) + '" role="button" tabindex="0"' : "";
      return '<div class="ps-top-row' + (i === 0 ? " first" : "") + (isRegions ? " is-region" : "") + '"' +
        rowAttr + ">" +
        '<span class="ps-top-pos">' + (i + 1) + "</span>" +
        (isRegions ? "" : leaderFlag(cfg, r)) +
        '<span class="ps-top-name">' + esc(leaderName(cfg, r)) +
          (isPlayers ? '<span class="ps-top-team">' + esc(r.teamShort) + "</span>" : "") + "</span>" +
        (isRegions ? leaderFlag(cfg, r) : "") +
        '<span class="ps-top-rate">' + esc(cfg.rateFn(r)) + "</span>" +
        '<span class="ps-top-val">' + cfg.mainFn(r) + "</span>" +
        "</div>";
    }).join("");

    var note = cfg.kind === "teams" ? "Värdena bredvid visar lagets snitt per match."
      : cfg.kind === "regions" ? "Värdena bredvid visar förbundets totaler. Per-match-värdet räknas över förbundets samtliga lagmatcher."
      : cfg.kind === "leagues" ? "Ligorna avser spelarnas klubbtillhörighet (division enligt säsongen 2025/26). Betyg kräver minst " + LEAGUE_QUAL_MIN + " spelade minuter totalt för ligan. Klicka på en liga för dess VM-spelare."
      : "Värdet till höger visar antalet per 90 spelade minuter (för mål/assist) respektive antal matcher. Klicka på en spelare för full profil.";

    var m = ensureModal();
    m.querySelector(".ps-modal-card").innerHTML =
      '<button class="ps-modal-close" title="Stäng">×</button>' +
      '<div class="ps-modal-head"><span class="ps-modal-icon">' + cfg.icon + "</span>" +
        "<h3>" + esc(cfg.title) + "</h3>" +
        '<span class="ps-modal-sub">Topp ' + top.length + " · " + kindLabel + "</span></div>" +
      '<div class="ps-top-list">' + (rows || '<div class="ps-empty">Ingen statistik ännu.</div>') + "</div>" +
      '<div class="ps-modal-note">' + note + "</div>";
    m.classList.add("open");
  }

  function closeTopModal() {
    var m = document.getElementById("psTopModal");
    if (m) m.classList.remove("open");
  }

  /* ---------- Ligamodal: alla VM-spelare från en klubbliga ---------- */

  function openLeagueModal(lid) {
    var lg = buildLeagueRows().filter(function (r) { return r.id === lid; })[0];
    if (!lg || !leagueData || !leagueData.clubs) return;
    var players = buildPlayerRows().filter(function (r) {
      return r.club && leagueData.clubs[r.club] === lid;
    }).sort(function (a, b) {
      /* Kvalificerat betyg först, sedan speltid – okvalificerade hamnar sist. */
      var ar = a.ratingQ && a.rating != null ? a.rating : -Infinity;
      var br = b.ratingQ && b.rating != null ? b.rating : -Infinity;
      return (br - ar) || (b.min - a.min) || a.name.localeCompare(b.name, "sv");
    });
    var rows = players.map(function (r, i) {
      var val = r.rating == null ? '<span class="ps-zero">–</span>'
        : r.ratingQ ? fmtRating(r.rating)
        : '<span class="ps-zero" title="Under ' + RATING_QUAL_MIN + ' spelade minuter – osäkert betyg">' + fmtRating(r.rating) + "</span>";
      var rate = (r.min || 0) + "'" + (r.points ? " · " + r.goals + "+" + r.assists : "");
      return '<div class="ps-top-row' + (i === 0 ? " first" : "") + '"' +
        (r.pid ? ' data-ps-player="' + esc(r.pid) + '" role="button" tabindex="0"' : "") + ">" +
        '<span class="ps-top-pos">' + (i + 1) + "</span>" +
        flagImg(r.teamIso) +
        '<span class="ps-top-name">' + esc(r.name) +
          '<span class="ps-top-team">' + esc(r.teamShort) + (r.club ? " · " + esc(r.club) : "") + "</span></span>" +
        '<span class="ps-top-rate">' + rate + "</span>" +
        '<span class="ps-top-val">' + val + "</span>" +
        "</div>";
    }).join("");
    var facts = [];
    if (lg.mvAvg != null) facts.push("Marknadsvärde/spelare <strong>" + fmtMv(lg.mvAvg) + "</strong>");
    if (lg.ratingQ && lg.rating != null) facts.push("ligabetyg <strong>" + fmtRating(lg.rating) + "</strong>");
    if (lg.mvQ && lg.opmv != null) facts.push("±Prislapp <strong>" + fmtSigned(lg.opmv) + "</strong>");
    var m = ensureModal();
    m.querySelector(".ps-modal-card").innerHTML =
      '<button class="ps-modal-close" title="Stäng">×</button>' +
      '<div class="ps-modal-head"><span class="ps-modal-icon">' + leagueFlag(lg) + "</span>" +
        "<h3>" + esc(lg.label) + "</h3>" +
        '<span class="ps-modal-sub">' + lg.players + " spelare · " + lg.clubCount +
          (lg.clubCount === 1 ? " klubb" : " klubbar") + " · " + lg.teams + " landslag</span></div>" +
      '<div class="ps-top-list">' + (rows || '<div class="ps-empty">Inga spelare.</div>') + "</div>" +
      '<div class="ps-modal-note">' + (facts.length ? facts.join(" · ") + ". " : "") +
        "Minuter, mål+assist och betyg avser VM 2026. Klicka på en spelare för full profil.</div>";
    m.classList.add("open");
  }

  /* ---------- Scatter: FotMob-betyg mot marknadsvärde (Ligor-läget) ----------
     Varje punkt är en kvalificerad liga (≥ LEAGUE_QUAL_MIN betygsatta minuter
     av spelare med känt marknadsvärde). X-axeln är ligans typiska marknads-
     värde per spelare på LOGARITMISK skala – pengar ger avtagande avkastning,
     så förväntanslinjen (spelarregressionen betyg ~ ln(värde)) blir rak här.
     Avståndet till linjen är exakt tabellens ±Prislapp. Byggs efter render
     (behöver containerns bredd) och återbyggs vid fönsterresize. */

  function renderLeagueScatter() {
    var box = document.getElementById("psScatterBox");
    if (!box) return;
    var rows = stateUi.mode === "leagues" && leagueLoad >= 2 ? buildLeagueRows() : [];
    var reg = rows.regression;
    var pts = rows.filter ? rows.filter(function (r) {
      return r.mvQ && r.mvRating != null && r.mvAvg > 0;
    }) : [];
    if (!reg || pts.length < 3) { box.innerHTML = ""; box.style.display = "none"; return; }
    box.style.display = "";

    var W = Math.max(300, (box.clientWidth || 752) - 32); // minus paddingen
    var H = 300, mL = 48, mR = 14, mT = 14, mB = 36;
    var iw = W - mL - mR, ih = H - mT - mB;

    /* Domäner: marknadsvärde log-skalat med luft i kanterna, betyg efter
       data + förväntanslinjens ändpunkter. */
    var vMin = Infinity, vMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    pts.forEach(function (r) {
      if (r.mvAvg < vMin) vMin = r.mvAvg;
      if (r.mvAvg > vMax) vMax = r.mvAvg;
      if (r.mvRating < yMin) yMin = r.mvRating;
      if (r.mvRating > yMax) yMax = r.mvRating;
    });
    var x0 = vMin / 1.3, x1 = vMax * 1.3;
    if (x1 <= x0) x1 = x0 * 10;
    var lx0 = Math.log(x0), lx1 = Math.log(x1);
    [reg.a + reg.b * lx0, reg.a + reg.b * lx1].forEach(function (v) {
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    });
    var y0 = Math.floor((yMin - 0.1) * 2) / 2;
    var y1 = Math.ceil((yMax + 0.1) * 2) / 2;
    if (y1 <= y0) y1 = y0 + 1;
    var yStep = (y1 - y0) / 0.5 > 7 ? 1 : 0.5;
    function X(v) { return mL + ((Math.log(v) - lx0) / (lx1 - lx0)) * iw; }
    function Y(v) { return mT + ((y1 - v) / (y1 - y0)) * ih; }

    /* Skalstreck på log-axeln: 1–2–5-serie inom domänen (10 k€ – 1 000 M€);
       blir det trångt glesas de ut till 1- och 5-stegen. */
    var ticks = [];
    for (var ex = 4; ex <= 9; ex++) {
      [1, 2, 5].forEach(function (mant) {
        var v = mant * Math.pow(10, ex);
        if (v >= x0 && v <= x1) ticks.push(v);
      });
    }
    if (ticks.length > Math.max(4, Math.floor(iw / 55))) {
      ticks = ticks.filter(function (v) {
        var mant = v / Math.pow(10, Math.floor(Math.log(v) / Math.LN10 + 1e-9));
        return mant < 1.5 || (mant > 4 && mant < 6);
      });
    }

    var s = '<svg width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + " " + H +
      '" style="width:100%;height:auto" role="img" aria-label="Punktdiagram: ligornas FotMob-betyg mot spelarnas marknadsvärde (logaritmisk skala)">';
    /* Rutnät + axelvärden (hårfina linjer, dämpad text). */
    for (var yv = y0; yv <= y1 + 1e-9; yv += yStep) {
      s += '<line class="grid" x1="' + mL + '" y1="' + Y(yv) + '" x2="' + (W - mR) + '" y2="' + Y(yv) + '"></line>' +
        '<text class="axis-text" x="' + (mL - 7) + '" y="' + (Y(yv) + 3.5) + '" text-anchor="end">' + fmtRating(yv) + "</text>";
    }
    ticks.forEach(function (tv) {
      s += '<line class="grid" x1="' + X(tv) + '" y1="' + mT + '" x2="' + X(tv) + '" y2="' + (mT + ih) + '"></line>' +
        '<text class="axis-text" x="' + X(tv) + '" y="' + (mT + ih + 15) + '" text-anchor="middle">' + (tv / 1e6) + "</text>";
    });
    s += '<text class="axis-title" x="' + (mL + iw / 2) + '" y="' + (H - 4) + '" text-anchor="middle">Marknadsvärde per spelare (M€ · log-skala)</text>';
    s += '<text class="axis-title" transform="rotate(-90)" x="' + (-(mT + ih / 2)) + '" y="13" text-anchor="middle">FotMob-betyg</text>';
    /* Förväntanslinjen (rak på log-skalan) över hela domänen. */
    s += '<line class="reg" x1="' + X(x0) + '" y1="' + Y(reg.a + reg.b * lx0) +
      '" x2="' + X(x1) + '" y2="' + Y(reg.a + reg.b * lx1) + '"></line>';

    /* Selektiva direktetiketter: extremerna i ±Prislapp + dyrast liga.
       Landsnamn (kort, unikt) – liganamn först om två ligor delar land. */
    var byOp = pts.slice().sort(function (a, b) { return b.opmv - a.opmv; });
    var labelSet = {};
    [byOp[0], byOp[1], byOp[byOp.length - 1], byOp[byOp.length - 2]].forEach(function (r) {
      if (r) labelSet[r.id] = true;
    });
    var topMv = pts.reduce(function (m2, r) { return r.mvAvg > m2.mvAvg ? r : m2; }, pts[0]);
    labelSet[topMv.id] = true;
    var countryCount = {};
    pts.forEach(function (r) {
      if (labelSet[r.id]) countryCount[r.country] = (countryCount[r.country] || 0) + 1;
    });
    var placed = [];

    var dots = "", hits = "", labels = "";
    pts.forEach(function (r, i) {
      var cx = X(r.mvAvg), cy = Y(r.mvRating);
      var dir = r.opmv >= 0 ? "up" : "down";
      dots += '<circle class="pt ' + dir + '" data-i="' + i + '" cx="' + cx + '" cy="' + cy + '" r="5"></circle>';
      hits += '<circle class="hit" data-i="' + i + '" data-ps-league="' + esc(r.id) + '" cx="' + cx + '" cy="' + cy +
        '" r="13" tabindex="0" role="button" aria-label="' + esc(r.label + ": betyg " + fmtRating(r.mvRating) +
        ", marknadsvärde " + fmtMv(r.mvAvg) + " per spelare, ±prislapp " + fmtSigned(r.opmv)) + '"></circle>';
      if (labelSet[r.id]) {
        /* Hoppa över etiketter som skulle krocka med en redan placerad. */
        var collide = placed.some(function (p) { return Math.abs(p.y - cy) < 13 && Math.abs(p.x - cx) < 100; });
        if (!collide) {
          var left = cx > W - 90;
          var txt = countryCount[r.country] > 1 ? r.country + " – " + r.name : r.country;
          labels += '<text class="pt-label" x="' + (left ? cx - 8 : cx + 8) + '" y="' + (cy - 7) +
            '" text-anchor="' + (left ? "end" : "start") + '">' + esc(txt) + "</text>";
          placed.push({ x: cx, y: cy });
        }
      }
    });
    s += dots + labels + hits + "</svg>";

    box.innerHTML =
      '<div class="ps-scatter">' +
        '<div class="ps-scat-head">' +
          "<h4>Presterar ligorna över sin prislapp?</h4>" +
          '<p>Varje punkt är en liga, placerad efter VM-spelarnas typiska marknadsvärde (logaritmisk skala – pengar ger avtagande avkastning). Ligor <span class="ps-up">över</span> den streckade linjen presterar bättre än vad spelare i den prisklassen brukar, <span class="ps-down">under</span> sämre.</p>' +
        "</div>" +
        '<div class="ps-scat-legend">' +
          '<span class="ps-scat-key"><span class="k-dot up"></span>Över förväntat</span>' +
          '<span class="ps-scat-key"><span class="k-dot down"></span>Under förväntat</span>' +
          '<span class="ps-scat-key"><span class="k-line"></span>Förväntat betyg</span>' +
        "</div>" +
        '<div class="ps-scat-plot">' + s + '<div class="ps-scat-tip" role="status"></div></div>' +
        '<div class="ps-scat-sub">Klicka på en punkt för ligans spelare.</div>' +
      "</div>";

    /* Hover/fokus-tooltip (värdena finns även i tabellen under). */
    var tip = box.querySelector(".ps-scat-tip");
    function tipRow(label, val) {
      var row = document.createElement("div");
      row.className = "t-row";
      var l = document.createElement("span"); l.textContent = label;
      var v = document.createElement("b"); v.textContent = val;
      row.appendChild(l); row.appendChild(v);
      return row;
    }
    function showTip(hit) {
      var r = pts[+hit.getAttribute("data-i")];
      if (!r) return;
      tip.textContent = "";
      var name = document.createElement("span");
      name.className = "t-name"; name.textContent = r.label;
      tip.appendChild(name);
      tip.appendChild(tipRow("FotMob-betyg", fmtRating(r.mvRating)));
      tip.appendChild(tipRow("Förväntat", fmtRating(r.expRating)));
      tip.appendChild(tipRow("±Prislapp", fmtSigned(r.opmv)));
      tip.appendChild(tipRow("MV/spelare", fmtMv(r.mvAvg)));
      tip.appendChild(tipRow("Speltid", r.min + "' · " + r.players + " spelare"));
      tip.classList.add("on");
      var cx = +hit.getAttribute("cx"), cy = +hit.getAttribute("cy");
      var scale = (box.querySelector("svg").getBoundingClientRect().width || W) / W;
      var lx = cx * scale + 14, ly = Math.max(cy * scale - 12, 0);
      if (lx + tip.offsetWidth > W * scale) lx = Math.max(cx * scale - tip.offsetWidth - 14, 0);
      tip.style.left = lx + "px";
      tip.style.top = ly + "px";
      var dot = box.querySelector('.pt[data-i="' + hit.getAttribute("data-i") + '"]');
      if (dot) dot.classList.add("on");
    }
    function hideTip(hit) {
      tip.classList.remove("on");
      var dot = box.querySelector('.pt[data-i="' + hit.getAttribute("data-i") + '"]');
      if (dot) dot.classList.remove("on");
    }
    box.querySelectorAll(".hit").forEach(function (hit) {
      hit.addEventListener("pointerenter", function () { showTip(hit); });
      hit.addEventListener("pointerleave", function () { hideTip(hit); });
      hit.addEventListener("focus", function () { showTip(hit); });
      hit.addEventListener("blur", function () { hideTip(hit); });
    });
  }

  /* ---------- Tabell: gemensam sorteringsrubrik ---------- */

  function thSort(key, label, cls, title) {
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

  /* Signerad xG-diff-cell: grönt = överprestation, rött = underprestation. */
  function xgdCell(v, title) {
    if (v == null || !isFinite(v)) return '<span class="ps-zero">–</span>';
    var cls = v > 0.05 ? " ps-xgd-pos" : v < -0.05 ? " ps-xgd-neg" : "";
    return '<span class="ps-num' + cls + '"' + (title ? ' title="' + esc(title) + '"' : "") + ">" +
      fmtSigned(v) + "</span>";
  }

  /* xG-kvotcell: neutralpunkten är 1.00 (utfall = förväntan). invert för
     kvoter där högt är dåligt (insläppta/xGA). */
  function xgRatioCell(v, invert, title) {
    if (v == null || !isFinite(v)) return '<span class="ps-zero">–</span>';
    var d = invert ? 1 - v : v - 1;
    var cls = d > 0.05 ? " ps-xgd-pos" : d < -0.05 ? " ps-xgd-neg" : "";
    return '<span class="ps-num' + cls + '"' + (title ? ' title="' + esc(title) + '"' : "") + ">" +
      fmt2(v) + "</span>";
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
        (r.avail ? '<span class="pstat-mini pstat--' + r.avail.cls + '" title="' + esc(r.avail.text) + '"></span>' : "") +
        "</span></span></td>" +
      '<td class="ps-c-team"><span class="t-name" title="' + esc(r.teamSv) + '">' + esc(r.teamShort) + "</span></td>" +
      '<td class="ps-c-pos" title="' + esc(posTitle) + '">' + (r.pos ? esc(r.pos) : "–") + "</td>" +
      '<td class="c-stat">' + (r.age != null ? r.age : "–") + "</td>" +
      '<td class="ps-c-club"><span title="' + esc(r.club || "") + '">' + (r.club ? esc(r.club) : "–") + "</span></td>" +
      '<td class="c-stat ps-c-mv">' + (r.mvLabel
        ? '<span class="ps-mv">' + esc(r.mvLabel) + "</span>"
        : '<span class="ps-zero">–</span>') + "</td>" +
      '<td class="c-stat ps-num' + (r.csGoals ? " hot" : "") + '"' +
        (r.csApps != null ? ' title="' + r.csGoals + " mål på " + r.csApps + ' matcher i klubben 2025/26"' : "") + ">" +
        (r.csGoals != null ? r.csGoals : '<span class="ps-zero">–</span>') + "</td>" +
      '<td class="c-stat ps-rate">' + (r.csGpa != null ? fmt2(r.csGpa) : '<span class="ps-zero">–</span>') + "</td>" +
      '<td class="c-stat ps-num' + (r.goals ? " hot" : "") + '"' +
        (goalsTitle.length ? ' title="' + esc(goalsTitle.join(" · ")) + '"' : "") + ">" +
        (r.goals || (r.og ? '<span class="ps-og" title="' + r.og + ' självmål">sj</span>' : '<span class="ps-zero">–</span>')) + "</td>" +
      '<td class="c-stat ps-num' + (r.assists ? " hot" : "") + '">' + (r.assists || '<span class="ps-zero">–</span>') + "</td>" +
      '<td class="c-stat ps-num ps-pts">' + (r.points || '<span class="ps-zero">–</span>') + "</td>" +
      '<td class="c-stat ps-rating">' + (r.rating == null ? '<span class="ps-zero" title="FotMob har inte satt betyg (t.ex. sena inhopp eller namn som inte kunnat kopplas)">–</span>'
        : r.ratingQ ? '<span class="ps-num">' + fmtRating(r.rating) + "</span>"
        : '<span class="ps-zero" title="Under ' + RATING_QUAL_MIN + ' spelade minuter – osäkert betyg">' + fmtRating(r.rating) + "</span>") + "</td>" +
      '<td class="c-stat ps-rate">' + (r.xg == null
        ? '<span class="ps-zero" title="xG-underlag saknas för spelarens matcher">–</span>'
        : '<span title="' + esc(fmt2(r.xg) + " xG på " + r.xgShots + " skott") + '">' + fmt2(r.xg) + "</span>") + "</td>" +
      '<td class="c-stat ps-rate">' + xgdCell(r.xgd, r.xg == null ? null
        : r.xgGoals + " mål på " + fmt2(r.xg) + " förväntade (xG)") + "</td>" +
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
      thSort("mv", "Värde", "ps-c-mv", "Marknadsvärde (Transfermarkt) – proxy för spelarens kvalitet/klass") +
      thSort("csgoals", "Kl.mål", "", "Mål i klubblaget säsongen 2025/26 (alla turneringar). Källa: Wikipedia. Målform är den viktigaste betting-signalen för målskyttsmarknaderna.") +
      thSort("csgpa", "Mål/M", "", "Mål per match i klubblaget 2025/26") +
      thSort("goals", "Mål", "", "Mål i VM 2026") +
      thSort("assists", "Ass", "", "Assist i VM 2026") +
      thSort("points", "P", "", "Poäng = mål + assist") +
      thSort("rating", "Betyg", "", "FotMobs matchbetyg (10-gradigt, minutviktat över matcherna). Bygger på Opta-liknande händelsedata och fångar hela spelet – även tacklingar, brytningar, passningar och positionsspel. Kräver " + RATING_QUAL_MIN + " min för rankning; saknas för spelare FotMob inte betygsatt.") +
      thSort("xg", "xG", "", "Förväntade mål (Opta via FotMob): summan av chansernas kvalitet över spelarens VM-matcher. Straffar under matchen ingår; straffläggning gör det inte.") +
      thSort("xgd", "±xG", "", "Effektivitet framför mål: VM-mål minus xG. Positivt = gör mer av sina chanser än förväntat (klinisk avslutare), negativt = bränner lägen.") +
      thSort("g90", "Mål/90", "", "Mål per 90 spelade minuter (kräver minst " + QUAL_MIN + " min)") +
      thSort("a90", "Ass/90", "", "Assist per 90 spelade minuter (kräver minst " + QUAL_MIN + " min)") +
      thSort("y", "Gul", "", "Gula kort") +
      thSort("r", "Röd", "", "Röda kort (inkl. två gula)") +
      thSort("apps", "M", "", "Spelade matcher i VM 2026") +
      thSort("min", "Min", "", "Spelade minuter i VM 2026") +
      "</tr></thead><tbody>";
    if (!shown.length) {
      h += '<tr><td class="ps-empty" colspan="21">Inga spelare matchar filtren.</td></tr>';
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
      '<td class="ps-c-conf">' +
        (r.region ? esc(r.region) : "–") + "</td>" +
      '<td class="c-stat">' + (r.played || '<span class="ps-zero">–</span>') + "</td>" +
      '<td class="c-stat">' + num(r.w) + "</td>" +
      '<td class="c-stat">' + num(r.d) + "</td>" +
      '<td class="c-stat">' + num(r.l) + "</td>" +
      '<td class="c-stat ps-num' + (r.gf ? " hot" : "") + '">' + (r.gf || '<span class="ps-zero">–</span>') + "</td>" +
      '<td class="c-stat">' + (r.played ? r.ga : '<span class="ps-zero">–</span>') + "</td>" +
      '<td class="c-stat ps-num">' + (r.played ? (r.gd > 0 ? "+" + r.gd : r.gd) : '<span class="ps-zero">–</span>') + "</td>" +
      '<td class="c-stat ps-rate">' + (r.played ? fmt2(r.gpm) : '<span class="ps-zero">–</span>') + "</td>" +
      '<td class="c-stat ps-rate">' + (r.hasXg
        ? '<span title="' + esc(fmt2(r.xg) + " xG på " + r.xgM + " matcher (" + fmt2(r.xgpm) + "/match)") + '">' + fmt2(r.xg) + "</span>"
        : '<span class="ps-zero" title="xG-underlag saknas ännu">–</span>') + "</td>" +
      '<td class="c-stat ps-rate">' + xgdCell(r.xgd, r.hasXg
        ? r.xgGf + " mål på " + fmt2(r.xg) + " förväntade – positivt = kliniska avslut" : null) + "</td>" +
      '<td class="c-stat ps-rate">' + xgRatioCell(r.xgr, false, r.xgr != null
        ? r.xgGf + " mål ÷ " + fmt2(r.xg) + " xG = " + fmt2(r.xgr) + "× förväntat antal mål" : null) + "</td>" +
      '<td class="c-stat ps-rate">' + (r.hasXg
        ? '<span title="' + esc("Motståndarnas samlade chanskvalitet: " + fmt2(r.xga) + " xGA") + '">' + fmt2(r.xga) + "</span>"
        : '<span class="ps-zero">–</span>') + "</td>" +
      '<td class="c-stat ps-rate">' + xgdCell(r.xgad, r.hasXg
        ? r.xgGa + " insläppta mot " + fmt2(r.xga) + " förväntade – positivt = försvar/målvakt räddar mer än väntat" : null) + "</td>" +
      '<td class="c-stat ps-rate">' + xgRatioCell(r.xgar, true, r.xgar != null
        ? r.xgGa + " insläppta ÷ " + fmt2(r.xga) + " xGA = " + fmt2(r.xgar) + "× förväntat antal insläppta" : null) + "</td>" +
      '<td class="c-stat">' + cardsCell(r.y, "y") + "</td>" +
      '<td class="c-stat">' + cardsCell(r.r, "r") + "</td>" +
      '<td class="c-stat ps-rate">' + cardsRateCell(r.ypm, r.played, "y") + "</td>" +
      '<td class="c-stat ps-rate">' + cardsRateCell(r.rpm, r.played, "r") + "</td>" +
      '<td class="c-stat ps-num' + (r.fp ? " ps-fp" : "") + '">' + (r.played ? r.fp : '<span class="ps-zero">–</span>') + "</td>" +
      '<td class="c-stat ps-rate' + (r.fp ? " ps-fp" : "") + '">' + (r.played ? fmt2(r.fppm) : '<span class="ps-zero">–</span>') + "</td>" +
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
      thSort("region", "Region", "ps-c-conf", "Världsdel") +
      thSort("played", "M", "", "Spelade matcher") +
      thSort("w", "V", "", "Vinster") +
      thSort("d", "O", "", "Oavgjorda") +
      thSort("l", "F", "", "Förluster") +
      thSort("gf", "GM", "", "Gjorda mål") +
      thSort("ga", "IM", "", "Insläppta mål") +
      thSort("gd", "MS", "", "Målskillnad") +
      thSort("gpm", "Mål/M", "", "Mål per match") +
      thSort("xg", "xG", "", "Förväntade mål (Opta via FotMob): summan av lagets chanskvalitet över VM-matcherna. Ett lag med högt xG skapar mycket – oavsett om bollen gått in.") +
      thSort("xgd", "±xG", "", "Effektivitet framför mål: gjorda mål minus xG. Positivt = gör mer än chanserna borde ge (kliniskt lag), negativt = bränner lägen. Lag som Marocko/Norge kan skapa lite men ändå vinna på hög effektivitet.") +
      thSort("xgr", "Mål/xG", "", "Utväxling framåt: gjorda mål delat med xG. 1.00 = precis som förväntat, 2.00 = dubbelt så många mål som chanserna borde ge. Till skillnad från ±xG tar kvoten hänsyn till volymen: +2 mål mot 2 förväntade är mer anmärkningsvärt än +2 mot 25.") +
      thSort("xga", "xGA", "", "Förväntade insläppta mål: motståndarnas samlade chanskvalitet. Lågt xGA = släpper inte till chanser.") +
      thSort("xgad", "±xGA", "", "Effektivitet bakåt: xGA minus insläppta mål. Positivt = släpper in färre än motståndarnas chanser borde ge (försvar/målvakt räddar mer än väntat).") +
      thSort("xgar", "IM/xGA", "", "Utväxling bakåt: insläppta mål delat med xGA. 1.00 = precis som förväntat, 2.00 = dubbelt så många insläppta som motståndarnas chanser borde ge (grönt under 1, rött över). Till skillnad från ±xGA tar kvoten hänsyn till volymen: 4 insläppta mot 2 förväntade är värre än 27 mot 25.") +
      thSort("y", "Gul", "", "Gula kort") +
      thSort("r", "Röd", "", "Röda kort") +
      thSort("ypm", "Gul/M", "", "Gula kort per match") +
      thSort("rpm", "Röd/M", "", "Röda kort per match") +
      thSort("fp", "FP", "", "Fair play-poäng: −1 gult · −3 andra gula · −4 direkt rött · −5 gult + rött (per spelare och match)") +
      thSort("fppm", "FP/M", "", "Fair play-poäng per match") +
      thSort("cs", "Nollor", "", "Matcher utan insläppt mål") +
      thSort("pts", "P", "", "Poäng") +
      "</tr></thead><tbody>";
    if (!shown.length) {
      h += '<tr><td class="ps-empty" colspan="26">Inga lag matchar filtren.</td></tr>';
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

  /* ---------- Förbundstabell ---------- */

  function regionRowHtml(r, i) {
    var p0 = r.played0;
    var dash = '<span class="ps-zero">–</span>';
    return '<tr>' +
      '<td class="c-pos">' + (i + 1) + "</td>" +
      '<td class="ps-c-name"><span class="team">' +
        '<span class="t-name" title="' + esc(r.region) + '">' + esc(r.region) + "</span></span></td>" +
      '<td class="c-stat">' + r.teams + "</td>" +
      '<td class="c-stat">' + (p0 ? dash : r.played) + "</td>" +
      '<td class="c-stat">' + num(r.w) + "</td>" +
      '<td class="c-stat">' + num(r.d) + "</td>" +
      '<td class="c-stat">' + num(r.l) + "</td>" +
      '<td class="c-stat ps-num' + (r.gf ? " hot" : "") + '">' + (r.gf || dash) + "</td>" +
      '<td class="c-stat">' + (p0 ? dash : r.ga) + "</td>" +
      '<td class="c-stat ps-num">' + (p0 ? dash : (r.gd > 0 ? "+" + r.gd : r.gd)) + "</td>" +
      '<td class="c-stat ps-num ps-pts">' + (p0 ? dash : fmt2(r.ppm)) + "</td>" +
      '<td class="c-stat ps-rate">' + (p0 ? dash : fmt2(r.gpm)) + "</td>" +
      '<td class="c-stat ps-rate">' + (p0 ? dash : fmt2(r.gapm)) + "</td>" +
      '<td class="c-stat">' + num(r.cs) + "</td>" +
      '<td class="c-stat">' + cardsCell(r.y, "y") + "</td>" +
      '<td class="c-stat">' + cardsCell(r.r, "r") + "</td>" +
      '<td class="c-stat ps-rate">' + cardsRateCell(r.ypm, r.played, "y") + "</td>" +
      '<td class="c-stat ps-rate">' + cardsRateCell(r.rpm, r.played, "r") + "</td>" +
      '<td class="c-stat ps-num' + (r.fp ? " ps-fp" : "") + '">' + (p0 ? dash : r.fp) + "</td>" +
      '<td class="c-stat ps-rate' + (r.fp ? " ps-fp" : "") + '">' + (p0 ? dash : fmt2(r.fppm)) + "</td>" +
      '<td class="c-stat ps-num ps-pts">' + (p0 ? dash : r.pts) + "</td>" +
      "</tr>";
  }

  function regionTableHtml() {
    var rows = filteredRegionRows();
    var h = '<div class="ps-table-wrap"><table class="standings ps-table"><thead><tr>' +
      '<th class="c-pos">#</th>' +
      thSort("region", "Region", "ps-c-name") +
      thSort("teams", "Lag", "", "Antal lag i turneringen") +
      thSort("played", "M", "", "Spelade lagmatcher (en match räknas per deltagande lag)") +
      thSort("w", "V", "", "Vinster") +
      thSort("d", "O", "", "Oavgjorda") +
      thSort("l", "F", "", "Förluster") +
      thSort("gf", "GM", "", "Gjorda mål") +
      thSort("ga", "IM", "", "Insläppta mål") +
      thSort("gd", "MS", "", "Målskillnad") +
      thSort("ppm", "P/M", "", "Poäng per match") +
      thSort("gpm", "Mål/M", "", "Gjorda mål per match") +
      thSort("gapm", "IM/M", "", "Insläppta mål per match") +
      thSort("cs", "Nollor", "", "Matcher utan insläppt mål") +
      thSort("y", "Gul", "", "Gula kort") +
      thSort("r", "Röd", "", "Röda kort") +
      thSort("ypm", "Gul/M", "", "Gula kort per match") +
      thSort("rpm", "Röd/M", "", "Röda kort per match") +
      thSort("fp", "FP", "", "Fair play-poäng: −1 gult · −3 andra gula · −4 direkt rött · −5 gult + rött (per spelare och match)") +
      thSort("fppm", "FP/M", "", "Fair play-poäng per match") +
      thSort("pts", "P", "", "Poäng totalt") +
      "</tr></thead><tbody>";
    if (!rows.length) {
      h += '<tr><td class="ps-empty" colspan="21">Ingen regionstatistik ännu.</td></tr>';
    } else {
      rows.forEach(function (r, i) { h += regionRowHtml(r, i); });
    }
    h += "</tbody></table></div>";
    return h;
  }

  /* ---------- Ligatabell ---------- */

  function leagueRowHtml(r, i) {
    var dash = '<span class="ps-zero">–</span>';
    var unq = !r.ratingQ;
    var ratingCell = r.rating == null ? dash
      : unq ? '<span class="ps-zero" title="Under ' + LEAGUE_QUAL_MIN + ' spelade minuter – osäkert snitt">' + fmtRating(r.rating) + "</span>"
      : '<span class="ps-num">' + fmtRating(r.rating) + "</span>";
    var opmvCell = r.opmv == null ? dash
      : '<span class="' + (!r.mvQ ? "ps-zero" : r.opmv >= 0 ? "ps-up" : "ps-down") + '"' +
        (r.expRating != null ? ' title="Förväntat betyg av prislappen: ' + fmtRating(r.expRating) + '"' : "") + ">" +
        fmtSigned(r.opmv) + "</span>";
    var dexpCell = r.dexp == null || r.min <= 0 ? dash
      : '<span class="' + (r.dexp >= 0 ? "ps-up" : "ps-down") + '">' + fmtSigned(r.dexp) + "</span>";
    /* Divisionsnivån vävs in i liganamnet (bara när den inte är högsta serien)
       i stället för en egen kolumn. */
    var tierSuffix = r.tier > 1 ? ' · nivå ' + r.tier : "";
    return '<tr class="ps-openable' + (unq ? " ps-league-unq" : "") + '" data-ps-league="' + esc(r.id) + '" tabindex="0" role="button">' +
      '<td class="c-pos">' + (i + 1) + "</td>" +
      '<td class="ps-c-name"><span class="team">' + leagueFlag(r) +
        '<span class="t-name" title="' + esc(r.label) + '">' + esc(r.name) + tierSuffix +
        "</span></span></td>" +
      '<td class="c-stat">' + r.players + "</td>" +
      '<td class="c-stat ps-num' + (r.goals ? " hot" : "") + '">' + (r.goals || dash) + "</td>" +
      '<td class="c-stat ps-num' + (r.assists ? " hot" : "") + '">' + (r.assists || dash) + "</td>" +
      '<td class="c-stat">' + (r.min ? '<span class="ps-num">' + r.min + "'</span>" : dash) + "</td>" +
      '<td class="c-stat">' + (r.mvAvg != null ? '<span class="ps-num">' + fmtMv(r.mvAvg) + "</span>" : dash) + "</td>" +
      '<td class="c-stat ps-rating">' + ratingCell + "</td>" +
      '<td class="c-stat">' + opmvCell + "</td>" +
      '<td class="c-stat">' + dexpCell + "</td>" +
      "</tr>";
  }

  function leagueTableHtml() {
    if (leagueLoad < 2) {
      return '<div class="ps-empty">Laddar ligadata …</div>';
    }
    if (!leagueData) {
      return '<div class="ps-empty">Kunde inte ladda data/club_leagues.json.</div>';
    }
    var rows = filteredLeagueRows();
    var shown = rows.slice(0, stateUi.limit);
    var h = '<div class="ps-table-wrap"><table class="standings ps-table ps-table-leagues"><thead><tr>' +
      '<th class="c-pos">#</th>' +
      thSort("league", "Liga", "ps-c-name", "Klubbliga: land och division") +
      thSort("players", "Spelare", "", "Antal spelare i VM-trupperna från ligan") +
      thSort("goals", "Mål", "", "Mål av ligans spelare i VM") +
      thSort("assists", "Ass", "", "Assist av ligans spelare i VM") +
      thSort("min", "Min", "", "Spelade minuter totalt i VM") +
      thSort("mv", "Marknadsvärde", "", "Typiskt marknadsvärde (Transfermarkt) för ligans VM-spelare: minutviktat geometriskt snitt.") +
      thSort("rating", "Betyg", "", "Minutviktat FotMob-betyg 1–10 för ligans spelare (kräver " + LEAGUE_QUAL_MIN + " spelade minuter).") +
      thSort("opmv", "±Prislapp", "", "Betyg minus förväntat betyg utifrån spelarnas marknadsvärden. Plus = ligans spelare presterar bättre än spelare i samma prisklass brukar.") +
      thSort("dexp", "Δ Förv.", "", "Landslagens utveckling mot slutspelsförväntan vid VM-start. Plus = ligans landslag går bättre än väntat.") +
      "</tr></thead><tbody>";
    if (!shown.length) {
      h += '<tr><td class="ps-empty" colspan="10">Inga ligor matchar filtren.</td></tr>';
    } else {
      shown.forEach(function (r, i) { h += leagueRowHtml(r, i); });
    }
    h += "</tbody></table></div>";
    if (rows.length > shown.length) {
      h += '<button type="button" class="ps-more" data-ps-more>Visa fler (' +
        shown.length + " av " + rows.length + ")</button>";
    }
    return h;
  }

  function tableHtml() {
    if (stateUi.mode === "teams") return teamTableHtml();
    if (stateUi.mode === "regions") return regionTableHtml();
    if (stateUi.mode === "leagues") return leagueTableHtml();
    return playerTableHtml();
  }
  /* ---------- Lägesväljare + verktygsrad ---------- */

  function modeToggleHtml() {
    function seg(mode, label) {
      return '<button type="button" class="ps-mode-seg' + (stateUi.mode === mode ? " on" : "") +
        '" data-ps-mode="' + mode + '">' + label + "</button>";
    }
    return '<div class="ps-modes" role="tablist" aria-label="Statistiktyp">' +
      seg("players", "Spelare") + seg("teams", "Lag") + seg("regions", "Region") +
      seg("leagues", "Ligor") + "</div>";
  }

  /* Toppra: vytitel till vänster, lägesväxlaren centrerad – på samma rad.
     Statistikvyn äger #view själv (app.js hoppar över sin page-intro här). */
  function introHtml() {
    return '<div class="page-intro ps-intro">' +
      '<div class="page-intro-main"><h2>Statistik</h2></div>' +
      modeToggleHtml() +
      "</div>";
  }

  function toolbarHtml() {
    if (stateUi.mode === "regions") {
      return '<div class="ps-toolbar ps-toolbar-region">' +
        '<span class="ps-toolbar-hint">Sammanställning per region (världsdel) – klicka på en kolumn för att sortera.</span>' +
        '<span class="ps-count" id="psCount"></span>' +
        "</div>";
    }
    if (stateUi.mode === "leagues") {
      return '<div class="ps-toolbar">' +
        '<input id="psSearch" type="search" autocomplete="off" placeholder="Sök liga eller land…" ' +
          'aria-label="Sök liga" value="' + esc(stateUi.q) + '">' +
        '<span class="ps-count" id="psCount"></span>' +
        "</div>";
    }
    if (stateUi.mode === "teams") {
      var regionList = teamRegions();
      var regionOpts = '<option value="">Alla regioner</option>' + regionList.map(function (c) {
        return '<option value="' + esc(c.region) + '"' + (stateUi.conf === c.region ? " selected" : "") + ">" +
          esc(c.region) + "</option>";
      }).join("");
      return '<div class="ps-toolbar">' +
        '<input id="psSearch" type="search" autocomplete="off" placeholder="Sök lag…" ' +
          'aria-label="Sök lag" value="' + esc(stateUi.q) + '">' +
        '<select id="psConf" aria-label="Filtrera på region">' + regionOpts + "</select>" +
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
    var hasStatus = window.VMPlayers && VMPlayers.statusCount && VMPlayers.statusCount() > 0;
    var statusSel = "";
    if (hasStatus) {
      var statusOpts = [["", "Alla statusar"], ["issue", "Skadade/avstängda/osäkra"],
        ["out", "Ej tillgängliga"], ["doubtful", "Osäkra"]].map(function (o) {
          return '<option value="' + o[0] + '"' + (stateUi.status === o[0] ? " selected" : "") + ">" + o[1] + "</option>";
        }).join("");
      statusSel = '<select id="psStatus" aria-label="Filtrera på spelarstatus">' + statusOpts + "</select>";
    }
    return '<div class="ps-toolbar">' +
      '<input id="psSearch" type="search" autocomplete="off" placeholder="Sök spelare, lag eller klubb…" ' +
        'aria-label="Sök spelare" value="' + esc(stateUi.q) + '">' +
      '<select id="psTeam" aria-label="Filtrera på lag">' + teamOpts + "</select>" +
      '<select id="psPos" aria-label="Filtrera på position">' + posOpts + "</select>" +
      statusSel +
      '<span class="ps-count" id="psCount"></span>' +
      "</div>";
  }

  /* Pedagogisk förklaring av Ligor-fliken: en alltid synlig ledtext plus en
     hopfällbar kolumnnyckel. Ersätter de tidigare utspridda hjälptexterna. */
  function leagueExplainerHtml() {
    return '<div class="ps-explain">' +
      '<p class="ps-explain-lead">Varje rad är en <strong>klubbliga</strong>. Måttet i fokus är hur ligans VM-spelare presterar mot vad deras <strong>marknadsvärden</strong> förväntar sig.</p>' +
      '<details class="ps-explain-more">' +
        "<summary>Vad betyder kolumnerna?</summary>" +
        "<dl>" +
          "<dt>Marknadsvärde</dt><dd>Typiskt marknadsvärde (Transfermarkt) för ligans VM-spelare – minutviktat geometriskt snitt. I grafen på logaritmisk skala: pengar ger avtagande avkastning, en dubbelt så dyr spelare är inte dubbelt så bra.</dd>" +
          "<dt>Betyg</dt><dd>FotMobs snittbetyg 1–10 för ligans spelare i VM hittills, viktat efter speltid.</dd>" +
          '<dt>±Prislapp</dt><dd><span class="ps-up">Plus</span> = ligans spelare presterar bättre än spelare i samma prisklass brukar, <span class="ps-down">minus</span> = sämre. Förväntat betyg sätts <strong>per spelare</strong> utifrån spelarens eget marknadsvärde, inte utifrån ligans standard – en liga vars VM-spelare kommer från ett par dominanta storklubbar (tänk Celtic/Rangers) bedöms efter de spelarnas prislappar och ser inte överpresterande ut bara för att resten av ligan är svag. Samma sak som avståndet till linjen i grafen.</dd>' +
          "<dt>Δ Förv.</dt><dd>Hur ligans landslag har över- eller underpresterat mot slutspelsförväntan vid VM-start.</dd>" +
        "</dl>" +
        '<p class="ps-explain-note">Gråa rader har spelat för lite (under ' + LEAGUE_QUAL_MIN + ' min) för ett rättvist betyg. Klicka på en liga för dess VM-spelare.</p>' +
      "</details>" +
    "</div>";
  }

  function render() {
    if (!rootEl || !document.body.contains(rootEl)) return;
    var isLeagues = stateUi.mode === "leagues";
    rootEl.innerHTML =
      introHtml() +
      leadersHtml() +
      '<section class="card ps-card">' +
      toolbarHtml() +
      (isLeagues ? leagueExplainerHtml() : "") +
      (isLeagues ? '<div id="psScatterBox"></div>' : "") +
      '<div id="psTableBox">' + tableHtml() + "</div>" +
      "</section>";
    updateCount();
    if (isLeagues) renderLeagueScatter();
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
    if (stateUi.mode === "leagues") {
      var ln = filteredLeagueRows().length;
      el.textContent = ln + (ln === 1 ? " liga" : " ligor");
      return;
    }
    if (stateUi.mode === "regions") {
      var rn = filteredRegionRows().length;
      el.textContent = rn + (rn === 1 ? " region" : " regioner");
      return;
    }
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
    if (mode === "leagues") loadLeagueData();
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
      var defs = sortDefs();
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
    if (tr) { openPlayer(tr.getAttribute("data-ps-player")); return; }
    var lr = e.target.closest && e.target.closest("[data-ps-league]");
    if (lr) openLeagueModal(lr.getAttribute("data-ps-league"));
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
    else if (e.target.id === "psStatus") { stateUi.status = e.target.value; stateUi.limit = 50; renderTable(); }
    else if (e.target.id === "psConf") { stateUi.conf = e.target.value; stateUi.limit = 50; renderTable(); }
  }

  function onKeydown(e) {
    if ((e.key !== "Enter" && e.key !== " ") || !e.target || !e.target.getAttribute) return;
    if (e.target.getAttribute("data-ps-player")) {
      e.preventDefault();
      openPlayer(e.target.getAttribute("data-ps-player"));
    } else if (e.target.getAttribute("data-ps-league")) {
      e.preventDefault();
      openLeagueModal(e.target.getAttribute("data-ps-league"));
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
    loadFotmobRatings(); // säkerställ att FotMob-betygen laddas även från spelarmodalen
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

  var resizeBound = false;

  function mount(viewEl) {
    rootEl = document.createElement("div");
    rootEl.className = "ps-view";
    viewEl.innerHTML = "";
    viewEl.appendChild(rootEl);
    rootEl.addEventListener("click", onClick);
    rootEl.addEventListener("input", onInput);
    rootEl.addEventListener("change", onChange);
    rootEl.addEventListener("keydown", onKeydown);
    if (!resizeBound) {
      resizeBound = true;
      var rsz;
      window.addEventListener("resize", function () {
        clearTimeout(rsz);
        rsz = setTimeout(function () {
          if (rootEl && document.body.contains(rootEl) && stateUi.mode === "leagues") renderLeagueScatter();
        }, 150);
      });
    }
    if (window.VMPlayers && !VMPlayers.isLoaded()) {
      VMPlayers.load().then(function () {
        playerRowsCache = null;
        leagueRowsCache = null;
        render();
      }).catch(function () {});
    }
    if (stateUi.mode === "leagues") loadLeagueData();
    loadFotmobRatings();
    render();
  }

  function setDetails(next) {
    details = next || {};
    playerRowsCache = null;
    teamRowsCache = null;
    regionRowsCache = null;
    leagueRowsCache = null;
    if (rootEl && document.body.contains(rootEl)) render();
  }

  window.VMPlayerStats = { mount: mount, setDetails: setDetails, getPlayerStats: getPlayerStatsById };
})();
