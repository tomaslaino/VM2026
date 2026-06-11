/*
  VM 2026 – spelarstatistik (window.VMPlayerStats).

  Sorterbar och filtrerbar tabell över alla spelare i VM-trupperna,
  berikad med statistik som samlas in från matchhändelserna under
  turneringen (data/matchdetails.json via app.js):

    mål · assist · straffmål · självmål · gula kort · röda kort

  Truppdata (position, ålder, klubb, landskamper) kommer från
  window.VMPlayers (data/wc2026_players.json). Händelsespelare matchas
  mot truppen via diakritik-tolerant namnjämförelse; spelare som inte
  kan matchas visas ändå (med lag från matchens hemma/borta-sida).

  app.js anropar:
    VMPlayerStats.setDetails(details)  – nya matchdetaljer
    VMPlayerStats.mount(viewEl)        – rendera vyn i #view
*/
(function () {
  "use strict";

  /* Samma round-robin-ordning som app.js använder för gruppmatcher. */
  var RR = [ [[0,1],[2,3]], [[0,2],[3,1]], [[3,0],[1,2]] ];

  var details = {};        // resultatnyckel -> matchdetaljer
  var rowsCache = null;    // byggda spelarrader (invalideras vid ny data)
  var rootEl = null;       // monteringspunkt (sätts av mount)

  /* UI-läge (ej persistent) */
  var stateUi = {
    q: "",
    team: "",            // iso eller "" = alla
    pos: "",             // GK/DF/MF/FW eller "" = alla
    onlyStats: false,
    sortKey: "points",
    sortDir: -1,         // -1 = fallande
    limit: 50
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

  /* ---------- Aggregera händelser per spelare ---------- */

  function statBucket(map, team, name) {
    var k = team.iso + "|" + norm(name);
    return map[k] || (map[k] = {
      name: name, team: team,
      goals: 0, pens: 0, og: 0, assists: 0, y: 0, r: 0
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
          // Självmål: spelaren tillhör motståndarlaget till det lag som fick målet.
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

  /* ---------- Bygg tabellrader (trupp + händelsestatistik) ---------- */

  function buildRows() {
    if (rowsCache) return rowsCache;
    var rows = [];
    var events = aggregateEvents();
    var claimed = {}; // statnyckel -> true när den kopplats till en truppspelare

    allTeams().forEach(function (te) {
      var idx = squadIndex(te.iso);
      idx.players.forEach(function (p) {
        var st = null;
        // hitta ev. statpost för spelaren
        for (var k in events) {
          if (claimed[k]) continue;
          var ev = events[k];
          if (ev.team.iso !== te.iso) continue;
          if (findSquadPlayer(idx, ev.name) === p || norm(ev.name) === norm(p.name)) {
            st = ev; claimed[k] = true; break;
          }
        }
        rows.push(makeRow(te, p, st));
      });
    });

    // Händelsespelare som inte kunde matchas mot truppdatan
    Object.keys(events).forEach(function (k) {
      if (claimed[k]) return;
      var ev = events[k];
      var te = allTeams().filter(function (t) { return t.iso === ev.team.iso; })[0];
      if (!te) return;
      rows.push(makeRow(te, null, ev, ev.name));
    });

    rowsCache = rows;
    return rows;
  }

  function makeRow(te, p, st, fallbackName) {
    st = st || { goals: 0, pens: 0, og: 0, assists: 0, y: 0, r: 0 };
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
      goals: st.goals, pens: st.pens, og: st.og, assists: st.assists,
      y: st.y, r: st.r,
      points: st.goals + st.assists,
      hasStats: !!(st.goals || st.assists || st.og || st.y || st.r)
    };
  }

  /* ---------- Sortering & filtrering ---------- */

  var SORTS = {
    name:    { type: "str", get: function (r) { return r.name; } },
    team:    { type: "str", get: function (r) { return r.teamSv; } },
    pos:     { type: "str", get: function (r) { return r.pos ? ["GK","DF","MF","FW"].indexOf(r.pos) : 9; } },
    age:     { type: "num", get: function (r) { return r.age; } },
    club:    { type: "str", get: function (r) { return r.club || "öööö"; } },
    caps:    { type: "num", get: function (r) { return r.caps; } },
    goals:   { type: "num", get: function (r) { return r.goals; } },
    assists: { type: "num", get: function (r) { return r.assists; } },
    points:  { type: "num", get: function (r) { return r.points; } },
    y:       { type: "num", get: function (r) { return r.y; } },
    r:       { type: "num", get: function (r) { return r.r; } }
  };

  function cmpRows(a, b) {
    var s = SORTS[stateUi.sortKey] || SORTS.points;
    var av = s.get(a), bv = s.get(b);
    var d = 0;
    if (s.type === "num") {
      var an = av == null ? -Infinity : av;
      var bn = bv == null ? -Infinity : bv;
      d = an - bn;
    } else {
      d = String(av).localeCompare(String(bv), "sv");
    }
    d *= stateUi.sortDir;
    if (d) return d;
    // standard-särskiljning: poäng → mål → assist → namn
    return (b.points - a.points) || (b.goals - a.goals) || (b.assists - a.assists) ||
      a.name.localeCompare(b.name, "sv");
  }

  function filteredRows() {
    var q = norm(stateUi.q);
    return buildRows().filter(function (r) {
      if (stateUi.onlyStats && !r.hasStats) return false;
      if (stateUi.team && r.teamIso !== stateUi.team) return false;
      if (stateUi.pos && r.pos !== stateUi.pos) return false;
      if (q && r.nameN.indexOf(q) === -1 && r.teamN.indexOf(q) === -1 &&
          r.clubN.indexOf(q) === -1) return false;
      return true;
    }).sort(cmpRows);
  }

  /* ---------- Rendering ---------- */

  function leaderCard(title, icon, rows, valFn, dispFn) {
    var top = rows.filter(function (r) { return valFn(r) > 0; })
      .sort(function (a, b) { return valFn(b) - valFn(a) || (b.points - a.points); })
      .slice(0, 3);
    if (!top.length) return "";
    var h = '<div class="ps-leader card"><div class="ps-leader-title">' + icon + " " + esc(title) + '</div>';
    top.forEach(function (r, i) {
      h += '<div class="ps-leader-row' + (i === 0 ? " first" : "") + '">' +
        '<span class="ps-leader-pos">' + (i + 1) + '</span>' +
        flagImg(r.teamIso) +
        '<span class="ps-leader-name" title="' + esc(r.name + " · " + r.teamSv) + '">' + esc(r.name) + '</span>' +
        '<span class="ps-leader-val">' + dispFn(r) + '</span>' +
        '</div>';
    });
    return h + "</div>";
  }

  function leadersHtml() {
    var rows = buildRows();
    var h = leaderCard("Skytteliga", "⚽", rows,
        function (r) { return r.goals; }, function (r) { return r.goals; }) +
      leaderCard("Flest assist", "🎯", rows,
        function (r) { return r.assists; }, function (r) { return r.assists; }) +
      leaderCard("Flest kort", "🟨", rows,
        function (r) { return r.y + 3 * r.r; },
        function (r) {
          var s = "";
          if (r.y) s += cardsCell(r.y, "y");
          if (r.r) s += cardsCell(r.r, "r");
          return s;
        });
    if (!h) return "";
    return '<div class="ps-leaders">' + h + "</div>";
  }

  function thSort(key, label, cls, title) {
    var on = stateUi.sortKey === key;
    return '<th class="ps-sortable ' + (cls || "") + (on ? " sort-on" : "") + '" data-ps-sort="' + key + '"' +
      (title ? ' title="' + esc(title) + '"' : "") + ">" +
      esc(label) + (on ? '<span class="ps-arrow">' + (stateUi.sortDir < 0 ? "▼" : "▲") + "</span>" : "") +
      "</th>";
  }

  function cardsCell(n, kind) {
    if (!n) return '<span class="ps-zero">–</span>';
    return '<span class="cards-cell"><span class="card-ico ' + kind + '" aria-hidden="true"></span>' + n + "</span>";
  }

  function rowHtml(r, i) {
    var posTitle = r.posSv || "Position saknas";
    var goalsTitle = [];
    if (r.pens) goalsTitle.push(r.pens + " på straff");
    if (r.og) goalsTitle.push(r.og + " självmål (räknas ej)");
    var clickable = !!r.pid;
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
      '<td class="c-stat">' + cardsCell(r.y, "y") + "</td>" +
      '<td class="c-stat">' + cardsCell(r.r, "r") + "</td>" +
      "</tr>";
  }

  function tableHtml() {
    var rows = filteredRows();
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
      thSort("y", "Gul", "", "Gula kort") +
      thSort("r", "Röd", "", "Röda kort (inkl. två gula)") +
      "</tr></thead><tbody>";
    if (!shown.length) {
      h += '<tr><td class="ps-empty" colspan="11">Inga spelare matchar filtren.</td></tr>';
    } else {
      shown.forEach(function (r, i) { h += rowHtml(r, i); });
    }
    h += "</tbody></table></div>";
    if (rows.length > shown.length) {
      h += '<button type="button" class="ps-more" data-ps-more>Visa fler (' +
        shown.length + " av " + rows.length + ")</button>";
    }
    return h;
  }

  function toolbarHtml() {
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
      '<button type="button" class="ps-chip' + (stateUi.onlyStats ? " on" : "") + '" data-ps-only ' +
        'title="Visa endast spelare med mål, assist eller kort i VM 2026">Med VM-statistik</button>' +
      '<span class="ps-count" id="psCount"></span>' +
      "</div>";
  }

  function render() {
    if (!rootEl || !document.body.contains(rootEl)) return;
    rootEl.innerHTML =
      leadersHtml() +
      '<section class="card ps-card">' +
      toolbarHtml() +
      '<div id="psTableBox">' + tableHtml() + "</div>" +
      '<p class="note ps-note">Statistik (mål, assist, kort) samlas in automatiskt från matchrapporterna (ESPN) under VM 2026. ' +
      "Truppdata – position, ålder, klubb, landskamper – kommer från Wikipedia och uppdaterades senast före slutspelet. " +
      "Klicka på en spelare för full profil.</p>" +
      "</section>";
    updateCount();
  }

  /* Rendera bara tabellen igen (behåller fokus i sökfältet). */
  function renderTable() {
    var box = document.getElementById("psTableBox");
    if (!box) { render(); return; }
    box.innerHTML = tableHtml();
    updateCount();
  }

  function updateCount() {
    var el = document.getElementById("psCount");
    if (!el) return;
    var n = filteredRows().length;
    var withStats = buildRows().filter(function (r) { return r.hasStats; }).length;
    el.textContent = n + " spelare" + (withStats ? " · " + withStats + " med VM-statistik" : "");
  }

  /* ---------- Events (delegerade på rotelementet) ---------- */

  function onClick(e) {
    var th = e.target.closest && e.target.closest("[data-ps-sort]");
    if (th) {
      var key = th.getAttribute("data-ps-sort");
      if (stateUi.sortKey === key) stateUi.sortDir = -stateUi.sortDir;
      else {
        stateUi.sortKey = key;
        stateUi.sortDir = (SORTS[key] && SORTS[key].type === "str") ? 1 : -1;
      }
      renderTable();
      return;
    }
    if (e.target.closest && e.target.closest("[data-ps-only]")) {
      stateUi.onlyStats = !stateUi.onlyStats;
      stateUi.limit = 50;
      render();
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
    // VMLive.openPlayer förväntar lag-objektet från data.js (sv-namn)
    var te = allTeams().filter(function (t) {
      return vp.isoToCode(t.iso) === team.fifa_code;
    })[0];
    VMLive.openPlayer(p, te ? te.team : { sv: team.name_sv, name: team.name });
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
    // Se till att truppdatan finns – rendera igen när den laddats.
    if (window.VMPlayers && !VMPlayers.isLoaded()) {
      VMPlayers.load().then(function () { rowsCache = null; render(); }).catch(function () {});
    }
    render();
  }

  function setDetails(next) {
    details = next || {};
    rowsCache = null;
    if (rootEl && document.body.contains(rootEl)) render();
  }

  window.VMPlayerStats = { mount: mount, setDetails: setDetails };
})();
