/* VM 2026 – app-logik: tabeller, bästa trea, slutspelsträd, kalender,
   lagsök, hover-info och realtidsuppdatering. */
(function () {
  "use strict";

  var STORE_KEY = "vm2026:v1";

  /* ---------- State ---------- */
  var state = loadState();
  var expandedGroups = {};      // letter -> bool (visa matcher)
  var selectedTeam = null;      // { group, idx } för lag-panelen (ej persistent)
  var hoverMatch = null;        // matchnummer som hovras i slutspelet
  var sim = { on: false, key: null, ko: null, minute: 0, timer: null }; // live-simulering

  function loadState() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var p = JSON.parse(raw);
        return { results: p.results || {}, ui: p.ui || {} };
      }
    } catch (e) {}
    return { results: {}, ui: {} };
  }
  function saveState() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function ui(key, def) { return state.ui[key] !== undefined ? state.ui[key] : def; }
  function setUi(key, val) { state.ui[key] = val; saveState(); }

  /* ---------- Hjälpare ---------- */
  var MONTHS = ["jan","feb","mars","apr","maj","juni","juli","aug","sep","okt","nov","dec"];
  var MONTHS_LONG = ["januari","februari","mars","april","maj","juni","juli","augusti","september","oktober","november","december"];
  var WEEKDAYS = ["sön","mån","tis","ons","tors","fre","lör"];
  var WEEKDAYS_LONG = ["söndag","måndag","tisdag","onsdag","torsdag","fredag","lördag"];

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function flagUrl(iso) { return "https://flagcdn.com/" + iso + ".svg"; }
  function flagImg(iso) {
    return '<img class="flag" loading="lazy" src="' + flagUrl(iso) + '" alt="" ' +
           'onerror="this.style.visibility=\'hidden\'">';
  }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function parseDateUTC(s) {
    var p = s.split("-").map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  }

  /* Absolut tidpunkt (UTC-instans) för avspark. EDT = UTC-4 → UTC = EDT + 4h.
     Saknas tid antas 16:00 EDT enbart för nedräkning (visas som "tid TBC"). */
  function kickoffUTC(m) {
    var p = m.date.split("-").map(Number);
    var hh = 16, mm = 0;
    if (m.edt) { var t = m.edt.split(":").map(Number); hh = t[0]; mm = t[1]; }
    return new Date(Date.UTC(p[0], p[1] - 1, p[2], hh + 4, mm));
  }

  /* Datum/tid-etiketter i vald tidszon. */
  function whenLabels(m, tz) {
    if (tz === "edt") {
      var d = parseDateUTC(m.date);
      return {
        dateLabel: WEEKDAYS[d.getUTCDay()] + " " + d.getUTCDate() + " " + MONTHS[d.getUTCMonth()],
        time: m.edt ? m.edt + " EDT" : "tid TBC"
      };
    }
    if (!m.edt) {
      var d2 = parseDateUTC(m.date);
      return {
        dateLabel: WEEKDAYS[d2.getUTCDay()] + " " + d2.getUTCDate() + " " + MONTHS[d2.getUTCMonth()],
        time: "tid TBC"
      };
    }
    var pp = m.date.split("-").map(Number);
    var tt = m.edt.split(":").map(Number);
    var dt = new Date(Date.UTC(pp[0], pp[1] - 1, pp[2], tt[0], tt[1]));
    dt.setUTCMinutes(dt.getUTCMinutes() + 360); // EDT -> CEST
    return {
      dateLabel: WEEKDAYS[dt.getUTCDay()] + " " + dt.getUTCDate() + " " + MONTHS[dt.getUTCMonth()],
      time: pad(dt.getUTCHours()) + ":" + pad(dt.getUTCMinutes())
    };
  }

  /* Relativ tid till avspark, ex "om 3 dagar", "Pågår", "Spelad". */
  function relativeLabel(m, played) {
    if (played) return { cls: "done", txt: "Spelad" };
    var now = Date.now();
    var ko = kickoffUTC(m).getTime();
    var diff = ko - now;
    var twoH = 2 * 3600 * 1000;
    if (diff <= 0 && diff > -twoH) return { cls: "live", txt: "Pågår nu" };
    if (diff <= -twoH) return { cls: "await", txt: "Inväntar resultat" };
    var mins = Math.round(diff / 60000);
    if (mins < 60) return { cls: "soon", txt: "om " + mins + " min" };
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return { cls: "soon", txt: "om " + hrs + " tim" };
    var days = Math.floor(hrs / 24);
    return { cls: "up", txt: "om " + days + (days === 1 ? " dag" : " dagar") };
  }

  /* ---------- Resultathantering ---------- */
  function getRes(key) { return state.results[key] || null; }
  function setScore(key, side, valStr) {
    var r = state.results[key] || {};
    if (valStr === "" || valStr == null) {
      delete r[side];
    } else {
      var n = parseInt(valStr, 10);
      if (isNaN(n) || n < 0) { delete r[side]; } else { r[side] = n; }
    }
    if (r.h === undefined && r.a === undefined) { delete state.results[key]; }
    else { state.results[key] = r; }
    saveState();
  }
  function setPen(key, who) {
    var r = state.results[key] || {};
    r.pw = who; state.results[key] = r; saveState();
  }
  /* field = "hy" | "hr" | "ay" | "ar" (home/away yellow/red) */
  function setCard(key, field, valStr) {
    var r = state.results[key] || {};
    var n = parseInt(valStr, 10);
    if (valStr === "" || valStr == null || isNaN(n) || n < 0) { delete r[field]; }
    else { r[field] = n; }
    if (Object.keys(r).length === 0) { delete state.results[key]; }
    else { state.results[key] = r; }
    saveState();
  }
  function isPlayed(r) { return r && r.h !== undefined && r.a !== undefined; }

  /* ---------- Gruppspelets matcher (round-robin, 4 lag) ---------- */
  var RR = [ [[0,1],[2,3]], [[0,2],[3,1]], [[3,0],[1,2]] ];
  var GROUP_SLOTS = ["12:00", "15:00", "18:00", "21:00"]; // EDT, preliminära
  function groupFixtures(letter) {
    var out = [], idx = 0;
    var li = WC.groupLetters.indexOf(letter);
    for (var md = 0; md < RR.length; md++) {
      for (var j = 0; j < RR[md].length; j++) {
        out.push({
          key: "g:" + letter + ":" + idx, md: md + 1,
          h: RR[md][j][0], a: RR[md][j][1],
          date: WC.groupDates[letter][md],
          edt: GROUP_SLOTS[(li + md + j) % GROUP_SLOTS.length], letter: letter
        });
        idx++;
      }
    }
    return out;
  }

  /* ---------- Tabellberäkning ---------- */
  /* Fair play-poäng enligt FIFA: gult = -1, rött = -4 (lägre antal kort = bättre). */
  var FP_YELLOW = -1, FP_RED = -4;
  function emptyStat(team, idx) {
    return { team: team, idx: idx, pld:0, w:0, d:0, l:0, gf:0, ga:0, gd:0, pts:0, yc:0, rc:0, fp:0 };
  }
  /* Jämförelse av två lag enligt fullständig FIFA-ordning (utom inbördes möte,
     som hanteras separat): poäng → målskillnad → gjorda mål → vinster → fair play. */
  function cmpOverall(y, x) { // returnerar positivt om y ska före x
    return (y.pts - x.pts) || (y.gd - x.gd) || (y.gf - x.gf) || (y.w - x.w) || (y.fp - x.fp);
  }
  function computeTable(letter) {
    var teams = WC.groups[letter];
    var st = teams.map(function (t, i) { return emptyStat(t, i); });
    var fixtures = groupFixtures(letter);
    fixtures.forEach(function (fx) {
      var r = getRes(fx.key);
      if (!isPlayed(r)) return;
      var H = st[fx.h], A = st[fx.a];
      H.pld++; A.pld++;
      H.gf += r.h; H.ga += r.a; A.gf += r.a; A.ga += r.h;
      H.yc += (r.hy || 0); H.rc += (r.hr || 0);
      A.yc += (r.ay || 0); A.rc += (r.ar || 0);
      if (r.h > r.a) { H.w++; A.l++; H.pts += 3; }
      else if (r.h < r.a) { A.w++; H.l++; A.pts += 3; }
      else { H.d++; A.d++; H.pts++; A.pts++; }
    });
    st.forEach(function (s) {
      s.gd = s.gf - s.ga;
      s.fp = s.yc * FP_YELLOW + s.rc * FP_RED;
    });
    st.sort(function (x, y) {
      return cmpOverall(y, x) || (x.idx - y.idx);
    });
    // Inbördes möte vid lika på poäng+målskillnad+gjorda mål
    var i = 0;
    while (i < st.length) {
      var j = i + 1;
      while (j < st.length && st[j].pts === st[i].pts && st[j].gd === st[i].gd && st[j].gf === st[i].gf) j++;
      if (j - i > 1) tieBreakHeadToHead(st, i, j, fixtures);
      i = j;
    }
    st.forEach(function (s, k) { s.rank = k; });
    return st;
  }
  function tieBreakHeadToHead(st, from, to, fixtures) {
    var group = st.slice(from, to);
    var idxs = group.map(function (g) { return g.idx; });
    var mini = {};
    idxs.forEach(function (ix) { mini[ix] = { pts:0, gd:0, gf:0 }; });
    fixtures.forEach(function (fx) {
      if (idxs.indexOf(fx.h) === -1 || idxs.indexOf(fx.a) === -1) return;
      var r = getRes(fx.key);
      if (!isPlayed(r)) return;
      mini[fx.h].gf += r.h; mini[fx.h].gd += (r.h - r.a);
      mini[fx.a].gf += r.a; mini[fx.a].gd += (r.a - r.h);
      if (r.h > r.a) mini[fx.h].pts += 3;
      else if (r.h < r.a) mini[fx.a].pts += 3;
      else { mini[fx.h].pts++; mini[fx.a].pts++; }
    });
    group.sort(function (x, y) {
      var mx = mini[x.idx], my = mini[y.idx];
      // inbördes: poäng → målskillnad → gjorda mål, sedan total: vinster → fair play → lottning
      return (my.pts - mx.pts) || (my.gd - mx.gd) || (my.gf - mx.gf) ||
             (y.w - x.w) || (y.fp - x.fp) || (x.idx - y.idx);
    });
    for (var k = 0; k < group.length; k++) st[from + k] = group[k];
  }

  /* ---------- Tredjeplacerade lag ---------- */
  function computeThirds(tables) {
    var arr = WC.groupLetters.map(function (L) {
      var t = tables[L][2];
      return { L: L, team: t.team, s: t };
    });
    arr.sort(function (x, y) {
      // FIFA: poäng → målskillnad → gjorda mål → vinster → fair play → lottning (grupp-bokstav)
      return cmpOverall(y.s, x.s) || (x.L < y.L ? -1 : 1);
    });
    arr.forEach(function (e, i) { e.qualified = i < 8; });
    var qset = arr.filter(function (e) { return e.qualified; }).map(function (e) { return e.L; });
    qset.sort();
    return { ranking: arr, key: qset.join("") };
  }

  /* ---------- Slutspelsupplösning ---------- */
  var THIRD_SLOT_MATCH = window.ANNEX_C_SLOT_MATCH;
  var MATCH_TO_SLOT = {};
  Object.keys(THIRD_SLOT_MATCH).forEach(function (L) { MATCH_TO_SLOT[THIRD_SLOT_MATCH[L]] = L; });
  var MATCH_BY_NO = {};
  WC.knockout.forEach(function (m) { MATCH_BY_NO[m.m] = m; });

  function buildContext() {
    var tables = {}, groupComplete = {}, allComplete = true;
    WC.groupLetters.forEach(function (L) {
      tables[L] = computeTable(L);
      var done = groupFixtures(L).every(function (f) { return isPlayed(getRes(f.key)); });
      groupComplete[L] = done;
      if (!done) allComplete = false;
    });
    return {
      tables: tables, groupComplete: groupComplete, allComplete: allComplete,
      thirds: computeThirds(tables), resolved: {}
    };
  }

  function resolveSlot(slot, ctx) {
    if (slot.t === "w") {
      return { team: ctx.tables[slot.g][0].team, decided: ctx.groupComplete[slot.g], label: "Etta grupp " + slot.g };
    }
    if (slot.t === "r") {
      return { team: ctx.tables[slot.g][1].team, decided: ctx.groupComplete[slot.g], label: "Tvåa grupp " + slot.g };
    }
    if (slot.t === "3") {
      var label = "3:a (" + slot.from.join("/") + ")";
      var assign = window.ANNEX_C[ctx.thirds.key];
      var matchNo = slot._m;
      if (assign && matchNo && MATCH_TO_SLOT[matchNo]) {
        var pos = window.ANNEX_C_SLOTS.indexOf(MATCH_TO_SLOT[matchNo]);
        var grp = assign.charAt(pos);
        if (grp && ctx.tables[grp]) {
          return { team: ctx.tables[grp][2].team, decided: ctx.allComplete, label: label, thirdGroup: grp };
        }
      }
      return { team: null, decided: false, label: label };
    }
    if (slot.t === "wm" || slot.t === "lm") {
      var src = ctx.resolved[slot.m];
      var want = slot.t === "wm" ? "winner" : "loser";
      var pre = slot.t === "wm" ? "Vinnare match " : "Förlorare match ";
      if (src && src[want]) return { team: src[want].team, decided: src[want].decided, label: pre + slot.m };
      return { team: null, decided: false, label: pre + slot.m };
    }
    return { team: null, decided: false, label: "?" };
  }

  function resolveKnockout(ctx) {
    WC.knockout.forEach(function (mt) {
      if (mt.home.t === "3") mt.home._m = mt.m;
      if (mt.away.t === "3") mt.away._m = mt.m;
      var home = resolveSlot(mt.home, ctx);
      var away = resolveSlot(mt.away, ctx);
      var r = getRes("k:" + mt.m);
      var winner = null, loser = null;
      var bothTeams = home.team && away.team;
      if (bothTeams && isPlayed(r)) {
        var dec = home.decided && away.decided;
        if (r.h > r.a) { winner = mk(home, dec); loser = mk(away, dec); }
        else if (r.a > r.h) { winner = mk(away, dec); loser = mk(home, dec); }
        else if (r.pw === "h") { winner = mk(home, dec); loser = mk(away, dec); }
        else if (r.pw === "a") { winner = mk(away, dec); loser = mk(home, dec); }
      }
      ctx.resolved[mt.m] = { match: mt, home: home, away: away, result: r, winner: winner, loser: loser, bothTeams: bothTeams };
    });
  }
  function mk(side, decided) { return { team: side.team, decided: decided && side.decided }; }

  /* Bygg fullständig kontext (tabeller + upplöst slutspel). */
  function getCtx() {
    var ctx = buildContext();
    resolveKnockout(ctx);
    return ctx;
  }

  /* ---------- Möjliga lag i en slutspelsmatch ---------- */
  /* Plocka ut grundplatser (grupp-slots) som matar en viss slot, rekursivt. */
  function collectBaseSlots(slot, acc) {
    if (slot.t === "wm" || slot.t === "lm") {
      var src = MATCH_BY_NO[slot.m];
      collectBaseSlots(src.home, acc);
      collectBaseSlots(src.away, acc);
    } else {
      acc.push(slot);
    }
  }
  /* Grupper som kan leverera lag till en match (union av båda sidor). */
  function involvedGroups(matchNo) {
    var mt = MATCH_BY_NO[matchNo];
    var acc = [];
    collectBaseSlots(mt.home, acc);
    collectBaseSlots(mt.away, acc);
    var groups = {};
    acc.forEach(function (s) {
      if (s.t === "w" || s.t === "r") groups[s.g] = true;
      else if (s.t === "3") s.from.forEach(function (g) { groups[g] = true; });
    });
    return Object.keys(groups).sort();
  }

  /* ====================================================================
     RENDERING
  ==================================================================== */
  var viewEl;

  function render() {
    var view = ui("view", "groups");
    document.querySelectorAll("[data-nav]").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-nav") === view);
    });
    var tz = ui("tz", "se");
    document.querySelectorAll("[data-tz]").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-tz") === tz);
    });

    if (view === "groups") renderGroups();
    else if (view === "bracket") renderBracket();
    else renderCalendar();

    if (view !== "bracket") { hoverMatch = null; hideAside(); }
    renderTeamDrawer();
  }

  /* Re-render utan att störa pågående inmatning (för realtid/timer). */
  function refresh() {
    var a = document.activeElement;
    if (a && a.classList && (a.classList.contains("score") || a.classList.contains("card-input"))) return;
    if (a && a.id === "teamSearch") { render(); restoreSearchFocus(); return; }
    render();
  }
  function restoreSearchFocus() {
    var s = document.getElementById("teamSearch");
    if (s) { s.focus(); }
  }

  /* ---------- Gruppvy ---------- */
  function renderGroups() {
    var ctx = getCtx();
    var qualifiedLetters = {};
    ctx.thirds.ranking.forEach(function (e) { if (e.qualified) qualifiedLetters[e.L] = true; });

    var html = '<div class="page-intro">' +
      '<h2>Gruppspel</h2>' +
      '<p>Topp 2 i varje grupp går vidare. Dessutom går de <strong>8 bästa treorna</strong> vidare. ' +
      'Fyll i resultat – tabeller, slutspelsträd och kalender uppdateras automatiskt.</p>' +
      '<div class="legend">' +
        '<span class="lg"><i class="dot adv"></i> Avancerar (1:a/2:a)</span>' +
        '<span class="lg"><i class="dot third-q"></i> Trea – kvalificerad</span>' +
        '<span class="lg"><i class="dot third-o"></i> Trea – utanför</span>' +
        '<span class="lg"><i class="dot host-mx"></i> Mexiko</span>' +
        '<span class="lg"><i class="dot host-us"></i> USA</span>' +
        '<span class="lg"><i class="dot host-ca"></i> Kanada</span>' +
      '</div></div>';

    html += '<div class="groups-grid">';
    WC.groupLetters.forEach(function (L) { html += groupCard(L, ctx.tables[L], qualifiedLetters[L]); });
    html += '</div>';
    html += thirdsPanel(ctx.thirds);
    viewEl.innerHTML = html;
  }

  function hostClass(team) {
    if (!team.host) return "";
    if (team.iso === "mx") return " host-mx";
    if (team.iso === "us") return " host-us";
    if (team.iso === "ca") return " host-ca";
    return "";
  }

  function cardsCell(s) {
    return '<td class="c-cards"><span class="card-y">' + s.yc + '</span>' +
           '<span class="card-r">' + s.rc + '</span></td>';
  }
  function standingsRows(table, opts) {
    opts = opts || {};
    var h = "";
    table.forEach(function (s, i) {
      var rowCls = "";
      if (i < 2) rowCls = "r-adv";
      else if (i === 2) rowCls = opts.thirdQualified ? "r-third-q" : "r-third-o";
      if (opts.highlightTeam && s.team === opts.highlightTeam) rowCls += " r-highlight";
      h += '<tr class="' + rowCls + '" data-team="' + s.team.iso + '">' +
        '<td class="c-pos">' + (i + 1) + '</td>' +
        '<td class="c-team"><span class="team' + hostClass(s.team) + '">' +
          flagImg(s.team.iso) + '<span class="t-name">' + esc(s.team.sv) + '</span></span></td>' +
        '<td>' + s.pld + '</td><td>' + s.w + '</td><td>' + s.d + '</td><td>' + s.l + '</td>' +
        '<td class="c-goals">' + s.gf + '–' + s.ga + '</td>' +
        '<td>' + (s.gd > 0 ? "+" + s.gd : s.gd) + '</td>' +
        (opts.cards ? cardsCell(s) : "") +
        '<td class="c-pts">' + s.pts + '</td></tr>';
    });
    return h;
  }

  function groupCard(L, table, thirdQualified) {
    var fixtures = groupFixtures(L);
    var anyHost = WC.groups[L].some(function (t) { return t.host; });
    var h = '<section class="card group-card">';
    h += '<div class="group-head"><h3>Grupp ' + L + '</h3>' +
         (anyHost ? '<span class="host-tag">Värdnation</span>' : '') + '</div>';
    h += '<table class="standings"><thead><tr>' +
         '<th class="c-pos">#</th><th class="c-team">Lag</th>' +
         '<th>S</th><th>V</th><th>O</th><th>F</th><th>Mål</th><th>+/-</th>' +
         '<th class="c-cards" title="Gula / röda kort (fair play)">Kort</th><th class="c-pts">P</th>' +
         '</tr></thead><tbody>' + standingsRows(table, { thirdQualified: thirdQualified, cards: true }) + '</tbody></table>';

    var open = !!expandedGroups[L];
    h += '<button class="matches-toggle" data-toggle-group="' + L + '">' +
         (open ? "Dölj matcher ▲" : "Visa matcher ▼") + '</button>';

    if (open) {
      h += '<div class="fixtures">';
      var lastMd = 0;
      fixtures.forEach(function (fx) {
        if (fx.md !== lastMd) {
          h += '<div class="md-label">Omgång ' + fx.md + ' · <span class="md-win">' +
               WC.groupRoundWindows[fx.md - 1] + '</span></div>';
          lastMd = fx.md;
        }
        var th = WC.groups[L][fx.h], ta = WC.groups[L][fx.a];
        var r = getRes(fx.key) || {};
        var when = whenLabels(fx, ui("tz", "se"));
        var liveFx = sim.on && sim.key === fx.key;
        h += '<div class="fixture' + (liveFx ? " live" : "") + '">' +
          '<span class="fx-date">' + (liveFx ? '<span class="fx-live"><span class="live-dot"></span>LIVE ' + sim.minute + "'</span>" : when.dateLabel + ' · ' + when.time) + '</span>' +
          '<span class="fx-team home"><span class="t-name">' + esc(th.sv) + '</span>' + flagImg(th.iso) + '</span>' +
          '<span class="fx-score">' + scoreInput(fx.key, "h", r.h) + '<span class="dash">–</span>' + scoreInput(fx.key, "a", r.a) + '</span>' +
          '<span class="fx-team away">' + flagImg(ta.iso) + '<span class="t-name">' + esc(ta.sv) + '</span></span>' +
          '<span class="fx-cards home">' + cardInput(fx.key, "hy", r.hy) + cardInput(fx.key, "hr", r.hr) + '</span>' +
          '<span class="fx-cards-label">kort</span>' +
          '<span class="fx-cards away">' + cardInput(fx.key, "ay", r.ay) + cardInput(fx.key, "ar", r.ar) + '</span>' +
          '</div>';
      });
      h += '</div>';
    }
    h += '</section>';
    return h;
  }

  function scoreInput(key, side, val) {
    return '<input class="score" type="number" min="0" inputmode="numeric" ' +
           'data-key="' + key + '" data-side="' + side + '" value="' + (val === undefined ? "" : val) + '">';
  }
  function cardInput(key, field, val) {
    var kind = field.charAt(1) === "y" ? "yellow" : "red";
    return '<input class="card-input ' + kind + '" type="number" min="0" inputmode="numeric" ' +
           'title="' + (kind === "yellow" ? "Gula kort" : "Röda kort") + '" ' +
           'data-card-key="' + key + '" data-card-field="' + field + '" value="' + (val === undefined ? "" : val) + '">';
  }

  function thirdsPanel(thirds) {
    var h = '<section class="card thirds-card">' +
      '<div class="group-head"><h3>Ranking – tredjeplacerade lag</h3>' +
      '<span class="host-tag info">8 bästa går vidare</span></div>' +
      '<table class="standings thirds-table"><thead><tr>' +
      '<th class="c-pos">#</th><th>Gr</th><th class="c-team">Lag</th>' +
      '<th>S</th><th>V</th><th>+/-</th><th>Mål</th>' +
      '<th class="c-cards" title="Gula / röda kort (fair play)">Kort</th>' +
      '<th class="c-pts">P</th><th></th></tr></thead><tbody>';
    thirds.ranking.forEach(function (e, i) {
      var cls = e.qualified ? "r-third-q" : "r-third-o";
      if (i === 7) cls += " cut-line"; // sista kvalplatsen
      h += '<tr class="' + cls + '" data-team="' + e.team.iso + '">' +
        '<td class="c-pos">' + (i + 1) + '</td><td class="c-grp">' + e.L + '</td>' +
        '<td class="c-team"><span class="team">' + flagImg(e.team.iso) +
          '<span class="t-name">' + esc(e.team.sv) + '</span></span></td>' +
        '<td>' + e.s.pld + '</td><td>' + e.s.w + '</td>' +
        '<td>' + (e.s.gd > 0 ? "+" + e.s.gd : e.s.gd) + '</td>' +
        '<td class="c-goals">' + e.s.gf + '–' + e.s.ga + '</td>' +
        cardsCell(e.s) +
        '<td class="c-pts">' + e.s.pts + '</td>' +
        '<td>' + (e.qualified ? '<span class="qbadge">✓</span>' : '<span class="xbadge">✗</span>') + '</td></tr>';
    });
    h += '</tbody></table><p class="note">Endast de <strong>8 bästa treorna</strong> går vidare (de 4 sämsta treorna + alla fyror åker ut). ' +
      'Rangordning enligt FIFA: poäng → målskillnad → gjorda mål → vinster → fair play (färre gula/röda kort) → lottning. ' +
      'De 8 placeras automatiskt i slutspelsträdet enligt FIFA:s 495 kombinationer (Annex C).</p></section>';
    return h;
  }

  /* ---------- Slutspelsvy (tvåsidigt träd, final i mitten) ---------- */
  var BR = {
    leftR32: [74,77,73,75,83,84,81,82], leftR16: [89,90,93,94], leftQF: [97,98], leftSF: [101],
    rightSF: [102], rightQF: [99,100], rightR16: [91,92,95,96], rightR32: [76,78,79,80,86,88,85,87]
  };

  function renderBracket() {
    var ctx = getCtx();
    var tz = ui("tz", "se");

    var html = '<div class="page-intro">' +
      '<h2>Slutspelsträd</h2>' +
      '<p>Trädet läses från båda hållen in mot finalen i mitten. <em>Kursiva lag</em> är preliminära. ' +
      'Håll muspekaren över en match för detaljer och vilka lag som kan hamna där.</p>' +
      (ctx.allComplete ? '' :
        '<p class="hint">Gruppspelet är inte färdigspelat – trädet visar nuvarande hypotetiska läge.</p>') +
      '</div>';

    html += '<div class="bracket-scroll"><div class="bracket two-sided">';

    html += bracketColumn("Sextondelsfinal", BR.leftR32, ctx, tz, "left");
    html += bracketColumn("Åttondelsfinal",  BR.leftR16, ctx, tz, "left");
    html += bracketColumn("Kvartsfinal",      BR.leftQF,  ctx, tz, "left");
    html += bracketColumn("Semifinal",        BR.leftSF,  ctx, tz, "left");

    // Mitten: final + brons + pokal
    html += '<div class="round center-col"><div class="round-body center-body">';
    html += '<div class="round-title final-label">Final</div>';
    html += matchCard(ctx.resolved[104], tz, "final");
    html += championBanner(ctx.resolved[104]);
    html += '<div class="round-title bronze-title">Bronsmatch</div>';
    html += matchCard(ctx.resolved[103], tz, "bronze");
    html += '</div></div>';

    html += bracketColumn("Semifinal",        BR.rightSF,  ctx, tz, "right");
    html += bracketColumn("Kvartsfinal",      BR.rightQF,  ctx, tz, "right");
    html += bracketColumn("Åttondelsfinal",  BR.rightR16, ctx, tz, "right");
    html += bracketColumn("Sextondelsfinal", BR.rightR32, ctx, tz, "right");

    html += '</div></div>';

    viewEl.innerHTML = html;

    // Flytande infopanel – visas endast vid hover över en match
    if (hoverMatch && ctx.resolved[hoverMatch]) updateAside(hoverMatch, ctx);
    else hideAside();
  }

  function bracketColumn(title, nums, ctx, tz, side) {
    var h = '<div class="round side-' + side + '"><div class="round-title">' + title + '</div><div class="round-body">';
    nums.forEach(function (n) { h += matchCard(ctx.resolved[n], tz); });
    h += '</div></div>';
    return h;
  }

  function championBanner(fin) {
    if (!fin.winner || !fin.winner.team) return '<div class="champ-slot empty">🏆 Världsmästare</div>';
    var c = fin.winner.team;
    return '<div class="champ-slot' + (fin.winner.decided ? " decided" : " prov") + '">' +
      '<span class="trophy">🏆</span>' + flagImg(c.iso) +
      '<span class="champ-txt">' + (fin.winner.decided ? "Världsmästare" : "Möjlig mästare") +
      '<strong>' + esc(c.sv) + '</strong></span></div>';
  }

  function slotSeed(slot) {
    if (slot.t === "w") return "Etta " + slot.g;
    if (slot.t === "r") return "Tvåa " + slot.g;
    if (slot.t === "3") return "3:a " + slot.from.join("/");
    if (slot.t === "wm") return "Vinnare M" + slot.m;
    if (slot.t === "lm") return "Förlorare M" + slot.m;
    return "?";
  }

  function matchCard(res, tz, variant) {
    var m = res.match;
    var v = WC.venues[m.venue];
    var when = whenLabels(m, tz);
    var played = res.bothTeams && isPlayed(res.result);
    var liveNow = sim.on && sim.key === ("k:" + m.m);
    var rel = liveNow ? { cls: "live", txt: "LIVE " + sim.minute + "'" } : relativeLabel(m, played);
    var cls = "match" + (variant ? " " + variant : "") + (liveNow ? " live-now" : "");

    var hWin = res.winner && res.home.team && res.winner.team === res.home.team;
    var aWin = res.winner && res.away.team && res.winner.team === res.away.team;

    var h = '<div class="' + cls + '" data-m="' + m.m + '">';
    h += '<div class="m-meta"><span class="m-no">M' + m.m + '</span>' +
         '<span class="m-rel ' + rel.cls + '">' + rel.txt + '</span></div>';
    h += '<div class="m-seed">' + slotSeed(m.home) + ' <span>·</span> ' + slotSeed(m.away) + '</div>';
    h += sideRow(res.home, res, "h", hWin);
    h += sideRow(res.away, res, "a", aWin);

    var r = res.result;
    if (played && r.h === r.a) {
      h += '<div class="pen-row"><span>Straffar:</span>' +
        '<button class="pen-btn' + (r.pw === "h" ? " on" : "") + '" data-pen="' + m.m + '" data-who="h">' +
          esc(res.home.team ? res.home.team.sv : "Hemma") + '</button>' +
        '<button class="pen-btn' + (r.pw === "a" ? " on" : "") + '" data-pen="' + m.m + '" data-who="a">' +
          esc(res.away.team ? res.away.team.sv : "Borta") + '</button></div>';
    }
    h += '<div class="m-venue">' + esc(v.stadium) + ' · ' + esc(v.city) +
         '<span class="m-when">' + when.dateLabel + ' · ' + when.time + '</span></div>';
    h += '</div>';
    return h;
  }

  function sideRow(side, res, ha, isWin) {
    var prov = side.team && !side.decided;
    var cls = "side" + (isWin ? " win" : "") + (prov ? " prov" : "") + (side.team ? "" : " tbd");
    var inner = side.team
      ? flagImg(side.team.iso) + '<span class="s-name">' + esc(side.team.sv) + '</span>'
      : '<span class="s-name placeholder">' + esc(side.label) + '</span>';
    var r = res.result || {};
    var val = r[ha];
    var disabled = (side.team && res.bothTeams) ? "" : "disabled";
    var scoreCell = '<input class="score k-score" type="number" min="0" inputmode="numeric" ' +
      'data-key="k:' + res.match.m + '" data-side="' + ha + '" ' + disabled + ' value="' + (val === undefined ? "" : val) + '">';
    return '<div class="' + cls + '">' + inner + scoreCell + '</div>';
  }

  /* ---------- Sidopanel (möjliga lag + tabeller) ---------- */
  function hideAside() {
    var el = document.getElementById("bracketAside");
    if (el) el.classList.remove("show");
  }

  function updateAside(matchNo, ctx) {
    var el = document.getElementById("bracketAside");
    if (!el) return;
    el.classList.add("show");
    var res = ctx.resolved[matchNo];
    var mt = res.match;
    var v = WC.venues[mt.venue];
    var when = whenLabels(mt, ui("tz", "se"));

    // grundplatser → vilka grupper + ev. trean-platser
    var base = [];
    collectBaseSlots(mt.home, base);
    collectBaseSlots(mt.away, base);
    var directGroups = {}, thirdGroups = {}, hasThird = false;
    base.forEach(function (s) {
      if (s.t === "w" || s.t === "r") directGroups[s.g] = true;
      else if (s.t === "3") { hasThird = true; s.from.forEach(function (g) { thirdGroups[g] = true; }); }
    });
    var directList = Object.keys(directGroups).sort();
    var thirdList = Object.keys(thirdGroups).sort();

    var h = '<div class="aside-head">' +
      '<span class="aside-tag">' + WC.roundNames[mt.round] + ' · M' + matchNo + '</span>' +
      '<button class="aside-close" id="asideClose" title="Återställ">×</button></div>';

    h += '<div class="aside-seed">' + slotSeed(mt.home) + ' <span>mot</span> ' + slotSeed(mt.away) + '</div>';
    h += '<div class="aside-now">' +
      asideSide(res.home) + '<span class="vs">vs</span>' + asideSide(res.away) + '</div>';
    h += '<div class="aside-meta">' + esc(v.stadium) + ' · ' + esc(v.city) + ' · ' + when.dateLabel + ' ' + when.time + '</div>';

    if (directList.length) {
      h += '<div class="aside-section-title">Direktplatser – grupp ' + directList.join(", ") + '</div>';
      directList.forEach(function (L) {
        h += '<div class="mini-group"><div class="mini-group-head">Grupp ' + L + '</div>' +
          '<table class="standings mini"><tbody>' +
          standingsRows(ctx.tables[L], { thirdQualified: isThirdQ(ctx, L) }) +
          '</tbody></table></div>';
      });
    }

    if (hasThird) {
      h += '<div class="aside-section-title">Trea-plats – möjliga grupper: ' + thirdList.join(", ") + '</div>';
      h += asideThirdsTable(ctx, thirdGroups);
      // även de aktuella tabellerna för de möjliga trean-grupperna
      thirdList.forEach(function (L) {
        if (directGroups[L]) return;
        h += '<div class="mini-group third"><div class="mini-group-head">Grupp ' + L + '</div>' +
          '<table class="standings mini"><tbody>' +
          standingsRows(ctx.tables[L], { thirdQualified: isThirdQ(ctx, L) }) +
          '</tbody></table></div>';
      });
    }

    el.innerHTML = h;
  }

  function asideThirdsTable(ctx, highlightGroups) {
    var h = '<div class="mini-group thirds"><div class="mini-group-head">Tabell – tredjeplacerade (8 bästa går vidare)</div>' +
      '<table class="standings mini"><tbody>';
    ctx.thirds.ranking.forEach(function (e, i) {
      var cls = e.qualified ? "r-third-q" : "r-third-o";
      if (highlightGroups[e.L]) cls += " r-highlight";
      h += '<tr class="' + cls + '"><td class="c-pos">' + (i + 1) + '</td>' +
        '<td class="c-grp">' + e.L + '</td>' +
        '<td class="c-team"><span class="team">' + flagImg(e.team.iso) +
          '<span class="t-name">' + esc(e.team.sv) + '</span></span></td>' +
        '<td class="c-pts">' + e.s.pts + '</td>' +
        '<td>' + (e.s.gd > 0 ? "+" + e.s.gd : e.s.gd) + '</td>' +
        '<td>' + (e.qualified ? '<span class="qbadge">✓</span>' : '') + '</td></tr>';
    });
    h += '</tbody></table></div>';
    return h;
  }
  function isThirdQ(ctx, L) {
    var e = ctx.thirds.ranking.filter(function (x) { return x.L === L; })[0];
    return e && e.qualified;
  }
  function asideSide(side) {
    if (side.team) {
      return '<span class="aside-team' + (side.decided ? "" : " prov") + '">' +
        flagImg(side.team.iso) + '<span>' + esc(side.team.sv) + '</span></span>';
    }
    return '<span class="aside-team tbd"><span>' + esc(side.label) + '</span></span>';
  }

  /* ---------- Kalendervy ---------- */
  function buildSchedule() {
    var items = [];
    WC.groupLetters.forEach(function (L) {
      groupFixtures(L).forEach(function (fx) {
        items.push({ kind: "group", date: fx.date, edt: null, letter: L, fx: fx });
      });
    });
    WC.knockout.forEach(function (m) { items.push({ kind: "ko", date: m.date, edt: m.edt, m: m }); });
    items.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      var ax = a.edt || "99:99", bx = b.edt || "99:99";
      return ax < bx ? -1 : ax > bx ? 1 : 0;
    });
    return items;
  }

  function renderCalendar() {
    var ctx = getCtx();
    var tz = ui("tz", "se");
    var items = buildSchedule();

    // hitta nästa kommande match (för markering)
    var now = Date.now();
    var nextKey = null, best = Infinity;
    items.forEach(function (it) {
      var m = it.kind === "ko" ? it.m : it.fx;
      var played = it.kind === "ko"
        ? (ctx.resolved[it.m.m].bothTeams && isPlayed(getRes("k:" + it.m.m)))
        : isPlayed(getRes(it.fx.key));
      if (played) return;
      var ko = kickoffUTC(m).getTime();
      if (ko >= now - 2 * 3600 * 1000 && ko < best) { best = ko; nextKey = it.kind === "ko" ? "k" + it.m.m : it.fx.key; }
    });

    var html = '<div class="page-intro">' +
      '<h2>Kalender</h2>' +
      '<p>Alla matcher i kronologisk ordning. Slutspelets datum är officiella; gruppspelets datum och alla ' +
      'matchtider är preliminära. Håll muspekaren över en slutspelsmatch för mer information.</p></div>';

    html += '<div class="cal">';
    var lastDate = null;
    items.forEach(function (it) {
      if (it.date !== lastDate) {
        if (lastDate !== null) html += '</div></div>'; // stäng föregående cal-body + cal-day
        var d = parseDateUTC(it.date);
        html += '<div class="cal-day"><div class="cal-date">' +
          '<span class="cal-dow">' + WEEKDAYS_LONG[d.getUTCDay()] + '</span>' +
          '<span class="cal-dnum">' + d.getUTCDate() + '</span>' +
          '<span class="cal-mon">' + MONTHS_LONG[d.getUTCMonth()] + '</span></div>' +
          '<div class="cal-body">';
        lastDate = it.date;
      }
      html += it.kind === "ko" ? calKoRow(ctx.resolved[it.m.m], tz, nextKey === "k" + it.m.m)
                               : calGroupRow(it, tz, nextKey === it.fx.key);
    });
    if (lastDate !== null) html += '</div></div>';
    html += '</div>';
    viewEl.innerHTML = html;
  }

  function calGroupRow(it, tz, isNext) {
    var L = it.letter, fx = it.fx;
    var th = WC.groups[L][fx.h], ta = WC.groups[L][fx.a];
    var r = getRes(fx.key) || {};
    var played = isPlayed(r);
    var when = whenLabels(fx, tz);
    var live = sim.on && sim.key === fx.key;
    var score = (played || live) ? '<span class="cal-score">' + (r.h || 0) + '–' + (r.a || 0) + '</span>'
                       : '<span class="cal-vs">–</span>';
    return '<div class="cal-row' + (isNext ? " is-next" : "") + (live ? " is-live" : "") + '">' +
      '<span class="cal-time">' + (live ? '<span class="cal-livet"><span class="live-dot"></span>' + sim.minute + "'</span>" : when.time) + '</span>' +
      '<span class="cal-badge grp">Grupp ' + L + '</span>' +
      '<span class="cal-match"><span class="cal-side home">' + esc(th.sv) + flagImg(th.iso) + '</span>' +
        score +
        '<span class="cal-side away">' + flagImg(ta.iso) + esc(ta.sv) + '</span></span>' +
      '<span class="cal-venue">Gruppspel</span>' +
      (isNext ? '<span class="cal-next">Nästa</span>' : '') +
      '</div>';
  }

  function calKoRow(res, tz, isNext) {
    var m = res.match, v = WC.venues[m.venue];
    var when = whenLabels(m, tz);
    var r = res.result || {};
    var played = res.bothTeams && isPlayed(r);
    var hName = res.home.team ? esc(res.home.team.sv) : '<i>' + esc(res.home.label) + '</i>';
    var aName = res.away.team ? esc(res.away.team.sv) : '<i>' + esc(res.away.label) + '</i>';
    var hFlag = res.home.team ? flagImg(res.home.team.iso) : "";
    var aFlag = res.away.team ? flagImg(res.away.team.iso) : "";
    var live = sim.on && sim.key === ("k:" + m.m);
    var score = (played || live) ? '<span class="cal-score">' + (r.h || 0) + '–' + (r.a || 0) +
      (played && r.h === r.a && r.pw ? '<sup>S</sup>' : '') + '</span>' : '<span class="cal-vs">–</span>';
    return '<div class="cal-row ko' + (isNext ? " is-next" : "") + (live ? " is-live" : "") + '" data-m="' + m.m + '">' +
      '<span class="cal-time">' + (live ? '<span class="cal-livet"><span class="live-dot"></span>' + sim.minute + "'</span>" : when.time) + '</span>' +
      '<span class="cal-badge ' + m.round + '">' + WC.roundNames[m.round] + ' · M' + m.m + '</span>' +
      '<span class="cal-match"><span class="cal-side home">' + hName + hFlag + '</span>' +
        score +
        '<span class="cal-side away">' + aFlag + aName + '</span></span>' +
      '<span class="cal-venue">' + esc(v.stadium) + ' · ' + esc(v.city) + '</span>' +
      (isNext ? '<span class="cal-next">Nästa</span>' : '') +
      '</div>';
  }

  /* ====================================================================
     LAGSÖK + LAG-PANEL
  ==================================================================== */
  function allTeams() {
    var arr = [];
    WC.groupLetters.forEach(function (L) {
      WC.groups[L].forEach(function (t, i) { arr.push({ team: t, group: L, idx: i }); });
    });
    return arr;
  }

  function renderSearchResults(query) {
    var box = document.getElementById("searchResults");
    var q = (query || "").trim().toLowerCase();
    if (!q) { box.hidden = true; box.innerHTML = ""; return; }
    var matches = allTeams().filter(function (e) {
      return e.team.sv.toLowerCase().indexOf(q) !== -1 || e.team.name.toLowerCase().indexOf(q) !== -1;
    }).slice(0, 8);
    if (!matches.length) {
      box.innerHTML = '<div class="sr-empty">Inget lag hittades</div>';
    } else {
      box.innerHTML = matches.map(function (e) {
        return '<button class="sr-item" data-team-group="' + e.group + '" data-team-idx="' + e.idx + '">' +
          flagImg(e.team.iso) + '<span class="sr-name">' + esc(e.team.sv) + '</span>' +
          '<span class="sr-grp">Grupp ' + e.group + '</span></button>';
      }).join("");
    }
    box.hidden = false;
  }

  function openTeam(group, idx) {
    selectedTeam = { group: group, idx: idx };
    var s = document.getElementById("teamSearch");
    if (s) s.value = "";
    var box = document.getElementById("searchResults");
    if (box) { box.hidden = true; box.innerHTML = ""; }
    renderTeamDrawer();
  }
  function closeTeam() { selectedTeam = null; renderTeamDrawer(); }

  /* Alla matcher som rör ett lag (grupp + slutspel där laget är aktuellt). */
  function teamMatches(team, group, ctx) {
    var list = [];
    groupFixtures(group).forEach(function (fx) {
      if (WC.groups[group][fx.h] !== team && WC.groups[group][fx.a] !== team) return;
      var home = WC.groups[group][fx.h], away = WC.groups[group][fx.a];
      var r = getRes(fx.key) || {};
      list.push({
        kind: "group", date: fx.date, edt: null, m: fx,
        home: home, away: away, isHome: home === team,
        played: isPlayed(r), r: r, label: "Grupp " + group, venue: null
      });
    });
    WC.knockout.forEach(function (mt) {
      var res = ctx.resolved[mt.m];
      var isHome = res.home.team === team, isAway = res.away.team === team;
      if (!isHome && !isAway) return;
      var r = res.result || {};
      list.push({
        kind: "ko", date: mt.date, edt: mt.edt, m: mt,
        home: res.home.team, away: res.away.team, isHome: isHome,
        played: res.bothTeams && isPlayed(r), r: r,
        label: WC.roundNames[mt.round] + " · M" + mt.m, venue: WC.venues[mt.venue],
        decided: (isHome ? res.home.decided : res.away.decided)
      });
    });
    list.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.edt || "99:99") < (b.edt || "99:99") ? -1 : 1;
    });
    return list;
  }

  function renderTeamDrawer() {
    var drawer = document.getElementById("teamDrawer");
    var backdrop = document.getElementById("drawerBackdrop");
    if (!drawer) return;
    if (!selectedTeam) {
      drawer.classList.remove("open");
      backdrop.classList.remove("open");
      drawer.innerHTML = "";
      return;
    }
    var ctx = getCtx();
    var L = selectedTeam.group;
    var team = WC.groups[L][selectedTeam.idx];
    var table = ctx.tables[L];
    var st = table.filter(function (s) { return s.team === team; })[0];
    var pos = st.rank + 1;

    // status / projektion
    var statusTxt, statusCls;
    if (pos <= 2) { statusTxt = (pos === 1 ? "Etta" : "Tvåa") + " i grupp " + L + " – mot slutspel"; statusCls = "adv"; }
    else if (pos === 3) {
      var q = isThirdQ(ctx, L);
      statusTxt = "Trea i grupp " + L + (q ? " – kvalificerad (bästa treor)" : " – utanför just nu");
      statusCls = q ? "third-q" : "third-o";
    } else { statusTxt = "Fyra i grupp " + L + " – utanför"; statusCls = "out"; }

    var matches = teamMatches(team, L, ctx);
    var now = Date.now();
    var next = null;
    matches.forEach(function (mm) {
      if (mm.played) return;
      if (!mm.home || !mm.away) return;
      var ko = kickoffUTC(mm.m).getTime();
      if (ko >= now - 2 * 3600 * 1000 && (!next || ko < next._ko)) { next = mm; next._ko = ko; }
    });
    if (!next) {
      for (var i = 0; i < matches.length; i++) {
        if (!matches[i].played && matches[i].home && matches[i].away) { next = matches[i]; break; }
      }
    }
    var recent = matches.filter(function (mm) { return mm.played; }).slice(-3).reverse();

    var h = '<div class="drawer-head">' +
      '<span class="dh-flag">' + flagImg(team.iso) + '</span>' +
      '<div class="dh-title"><h3>' + esc(team.sv) + '</h3>' +
        '<span class="dh-sub">' + esc(team.name) + ' · Grupp ' + L +
        (team.host ? ' · <span class="host-tag">Värdnation</span>' : '') + '</span></div>' +
      '<button class="drawer-close" id="drawerClose" title="Stäng">×</button></div>';

    h += '<div class="drawer-body">';
    h += '<div class="status-pill ' + statusCls + '">' + statusTxt + '</div>';

    // Nästa match
    h += '<div class="drawer-card"><div class="dc-title">Nästa match</div>';
    if (next && next.home && next.away) {
      h += teamMatchRow(team, next, true);
    } else {
      h += '<div class="dc-empty">Ingen kommande match avgjord ännu.</div>';
    }
    h += '</div>';

    // Statistik
    h += '<div class="drawer-card"><div class="dc-title">Statistik (gruppspel)</div>' +
      '<div class="stat-grid">' +
        statBox("Plac.", pos + " / 4") + statBox("Poäng", st.pts) + statBox("Spelade", st.pld) +
        statBox("V-O-F", st.w + "-" + st.d + "-" + st.l) + statBox("Mål", st.gf + "–" + st.ga) +
        statBox("Diff", (st.gd > 0 ? "+" : "") + st.gd) +
      '</div></div>';

    // Tabell
    h += '<div class="drawer-card"><div class="dc-title">Tabell – Grupp ' + L + '</div>' +
      '<table class="standings mini"><thead><tr><th class="c-pos">#</th><th class="c-team">Lag</th>' +
      '<th>S</th><th>P</th><th>+/-</th></tr></thead><tbody>' +
      table.map(function (s, i) {
        var cls = i < 2 ? "r-adv" : (i === 2 ? (isThirdQ(ctx, L) ? "r-third-q" : "r-third-o") : "");
        if (s.team === team) cls += " r-highlight";
        return '<tr class="' + cls + '"><td class="c-pos">' + (i + 1) + '</td>' +
          '<td class="c-team"><span class="team">' + flagImg(s.team.iso) + '<span class="t-name">' + esc(s.team.sv) + '</span></span></td>' +
          '<td>' + s.pld + '</td><td class="c-pts">' + s.pts + '</td>' +
          '<td>' + (s.gd > 0 ? "+" + s.gd : s.gd) + '</td></tr>';
      }).join("") + '</tbody></table></div>';

    // Alla matcher
    h += '<div class="drawer-card"><div class="dc-title">Spelschema</div>';
    matches.forEach(function (mm) { if (mm.home && mm.away) h += teamMatchRow(team, mm, false); });
    h += '</div>';

    h += '</div>';
    drawer.innerHTML = h;
    drawer.classList.add("open");
    document.getElementById("drawerBackdrop").classList.add("open");
  }

  function statBox(label, val) {
    return '<div class="stat-box"><span class="sb-val">' + esc("" + val) + '</span><span class="sb-lbl">' + label + '</span></div>';
  }

  function teamMatchRow(team, mm, big) {
    var opp = mm.isHome ? mm.away : mm.home;
    var tz = ui("tz", "se");
    var when = whenLabels(mm.m, tz);
    var rel = relativeLabel(mm.m, mm.played);
    var resultTxt = "";
    if (mm.played) {
      var myG = mm.isHome ? mm.r.h : mm.r.a, opG = mm.isHome ? mm.r.a : mm.r.h;
      var outcome = myG > opG ? "v" : (myG < opG ? "f" : "o");
      if (myG === opG && mm.r.pw) outcome = (mm.r.pw === (mm.isHome ? "h" : "a")) ? "v" : "f";
      resultTxt = '<span class="tm-res ' + outcome + '">' + myG + '–' + opG + '</span>';
    } else {
      resultTxt = '<span class="tm-rel ' + rel.cls + '">' + rel.txt + '</span>';
    }
    return '<div class="tm-row' + (big ? " big" : "") + '">' +
      '<span class="tm-when">' + when.dateLabel + ' · ' + when.time + '</span>' +
      '<span class="tm-opp">' + (mm.isHome ? "mot " : "borta mot ") +
        (opp ? flagImg(opp.iso) + esc(opp.sv) : "?") + '</span>' +
      '<span class="tm-tag">' + mm.label + '</span>' +
      resultTxt + '</div>';
  }

  /* ====================================================================
     TOOLTIP (hover)
  ==================================================================== */
  var tipEl;
  function showTip(matchNo, x, y) {
    var ctx = getCtx();
    var res = ctx.resolved[matchNo];
    if (!res) return;
    var m = res.match, v = WC.venues[m.venue];
    var se = whenLabels(m, "se"), edt = whenLabels(m, "edt");
    var played = res.bothTeams && isPlayed(res.result);
    var rel = relativeLabel(m, played);

    var h = '<div class="tip-head"><b>' + WC.roundNames[m.round] + '</b> · Match ' + m.m +
      '<span class="tip-rel ' + rel.cls + '">' + rel.txt + '</span></div>';
    h += '<div class="tip-teams">' + tipSide(res.home) + '<span class="tip-vs">vs</span>' + tipSide(res.away) + '</div>';
    if (played) h += '<div class="tip-score">Resultat: <b>' + res.result.h + '–' + res.result.a + '</b></div>';
    h += '<div class="tip-row"><span>🗓️</span>' + se.dateLabel + ' · ' + se.time + ' (sv)</div>';
    h += '<div class="tip-row tip-dim"><span>🕒</span>' + edt.dateLabel + ' · ' + edt.time + '</div>';
    h += '<div class="tip-row"><span>📍</span>' + esc(v.stadium) + ', ' + esc(v.city) + ' (' + esc(v.country) + ')</div>';
    h += '<div class="tip-row tip-dim"><span>🏟️</span>' + esc(v.real) + '</div>';

    tipEl.innerHTML = h;
    tipEl.classList.add("show");
    positionTip(x, y);
  }
  function tipSide(side) {
    if (side.team) return '<span class="tip-team' + (side.decided ? "" : " prov") + '">' + flagImg(side.team.iso) + esc(side.team.sv) + '</span>';
    return '<span class="tip-team tbd">' + esc(side.label) + '</span>';
  }
  function positionTip(x, y) {
    var w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    var left = x + 16, top = y + 16;
    if (left + w > window.innerWidth - 10) left = x - w - 16;
    if (top + h > window.innerHeight - 10) top = y - h - 16;
    if (left < 8) left = 8;
    if (top < 8) top = 8;
    tipEl.style.left = left + "px";
    tipEl.style.top = top + "px";
  }
  function hideTip() { tipEl.classList.remove("show"); }

  /* ====================================================================
     LIVE-SIMULERING (demo) – spelar matcherna i realtid och uppdaterar
     resultat → tabeller → slutspelsträd löpande. Skriver bara i tomma
     matcher (rör inte resultat du själv matat in).
  ==================================================================== */
  function simToggle() { if (sim.on) stopSim(); else startSim(); }
  function startSim() {
    sim.on = true; setSimBtn();
    sim.timer = setInterval(simTick, 1100);
    simTick();
  }
  function stopSim() {
    sim.on = false;
    if (sim.timer) clearInterval(sim.timer);
    sim.timer = null;
    setSimBtn(); updateLiveBanner(); refresh();
  }
  function setSimBtn() {
    var b = document.getElementById("liveBtn");
    if (!b) return;
    b.classList.toggle("on", sim.on);
    b.textContent = sim.on ? "⏸ Pausa live" : "▶ Simulera live";
  }

  function nextSimItem() {
    var ctx = getCtx();
    var items = buildSchedule();
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (it.kind === "group") {
        if (getRes(it.fx.key)) continue;
        return { key: it.fx.key, ko: null };
      }
      var res = ctx.resolved[it.m.m];
      if (!res.bothTeams) continue;
      var key = "k:" + it.m.m;
      if (getRes(key)) continue;
      return { key: key, ko: it.m.m };
    }
    return null;
  }

  function simTick() {
    if (!sim.key) {
      var nx = nextSimItem();
      if (!nx) { stopSim(); flashDone(); return; }
      sim.key = nx.key; sim.ko = nx.ko; sim.minute = 0;
      state.results[sim.key] = { h: 0, a: 0 };
      saveState(); refresh(); updateLiveBanner();
      return;
    }
    sim.minute += 15 + Math.floor(Math.random() * 15);
    var r = state.results[sim.key] || { h: 0, a: 0 };
    if (Math.random() < 0.34) r.h++;
    if (Math.random() < 0.30) r.a++;
    // kort (gula vanligare än röda) – endast gruppmatcher påverkar fair play-tabellen
    if (!sim.ko) {
      if (Math.random() < 0.30) r.hy = (r.hy || 0) + 1;
      if (Math.random() < 0.30) r.ay = (r.ay || 0) + 1;
      if (Math.random() < 0.04) r.hr = (r.hr || 0) + 1;
      if (Math.random() < 0.04) r.ar = (r.ar || 0) + 1;
    }
    if (sim.minute >= 90) {
      sim.minute = 90;
      if (sim.ko && r.h === r.a) r.pw = Math.random() < 0.5 ? "h" : "a";
      state.results[sim.key] = r;
      saveState(); updateLiveBanner(); refresh();
      sim.key = null; sim.ko = null; sim.minute = 0;
      return;
    }
    state.results[sim.key] = r;
    saveState(); updateLiveBanner(); refresh();
  }

  function liveMatchInfo() {
    if (!sim.key) return null;
    var r = state.results[sim.key] || { h: 0, a: 0 };
    if (sim.ko) {
      var res = getCtx().resolved[sim.ko];
      return { home: res.home.team, away: res.away.team, r: r, tag: WC.roundNames[res.match.round] + " · M" + sim.ko };
    }
    var p = sim.key.split(":"), L = p[1], idx = parseInt(p[2], 10);
    var fx = groupFixtures(L)[idx];
    return { home: WC.groups[L][fx.h], away: WC.groups[L][fx.a], r: r, tag: "Grupp " + L };
  }

  function updateLiveBanner() {
    var el = document.getElementById("liveBanner");
    if (!el) return;
    var info = (sim.on && sim.key) ? liveMatchInfo() : null;
    if (!info) { el.classList.remove("show"); return; }
    el.innerHTML =
      '<span class="lb-live"><span class="live-dot"></span>LIVE ' + sim.minute + "'</span>" +
      '<span class="lb-tag">' + info.tag + '</span>' +
      '<span class="lb-match">' + (info.home ? flagImg(info.home.iso) + esc(info.home.sv) : "?") +
        ' <b>' + info.r.h + ' – ' + info.r.a + '</b> ' +
        (info.away ? esc(info.away.sv) + flagImg(info.away.iso) : "?") + '</span>' +
      '<span class="lb-demo">DEMO</span>';
    el.classList.add("show");
  }

  function flashDone() {
    var el = document.getElementById("liveBanner");
    if (!el) return;
    el.innerHTML = '<span class="lb-tag">✓ Simulering klar – alla matcher spelade</span><span class="lb-demo">DEMO</span>';
    el.classList.add("show");
    setTimeout(function () { if (!sim.on) el.classList.remove("show"); }, 4000);
  }

  /* ====================================================================
     EVENT-HANTERING
  ==================================================================== */
  function onChange(e) {
    var el = e.target;
    if (el.classList && el.classList.contains("score")) {
      setScore(el.getAttribute("data-key"), el.getAttribute("data-side"), el.value);
      render();
    } else if (el.classList && el.classList.contains("card-input")) {
      setCard(el.getAttribute("data-card-key"), el.getAttribute("data-card-field"), el.value);
      render();
    }
  }

  function onInput(e) {
    if (e.target.id === "teamSearch") renderSearchResults(e.target.value);
  }

  function onClick(e) {
    var t = e.target;
    var nav = t.closest && t.closest("[data-nav]");
    if (nav) { setUi("view", nav.getAttribute("data-nav")); hoverMatch = null; render(); return; }
    var tz = t.closest && t.closest("[data-tz]");
    if (tz) { setUi("tz", tz.getAttribute("data-tz")); render(); return; }

    var sr = t.closest && t.closest(".sr-item");
    if (sr) { openTeam(sr.getAttribute("data-team-group"), parseInt(sr.getAttribute("data-team-idx"), 10)); return; }

    if (t.id === "drawerClose" || t.id === "drawerBackdrop") { closeTeam(); return; }
    if (t.id === "asideClose") { hoverMatch = null; hideAside(); return; }

    var tg = t.closest && t.closest("[data-toggle-group]");
    if (tg) { var L = tg.getAttribute("data-toggle-group"); expandedGroups[L] = !expandedGroups[L]; render(); return; }

    var pen = t.closest && t.closest("[data-pen]");
    if (pen) { setPen("k:" + pen.getAttribute("data-pen"), pen.getAttribute("data-who")); render(); return; }

    if (t.id === "liveBtn") { simToggle(); return; }
    if (t.id === "resetBtn") {
      if (confirm("Vill du nollställa alla inmatade resultat?")) {
        if (sim.on) stopSim();
        state.results = {}; saveState(); render();
      }
      return;
    }
    // klick på rad i tabell → öppna lag
    var trow = t.closest && t.closest("tr[data-team]");
    if (trow) {
      var iso = trow.getAttribute("data-team");
      var found = allTeams().filter(function (x) { return x.team.iso === iso; })[0];
      if (found) openTeam(found.group, found.idx);
      return;
    }
  }

  var asideHideTimer = null;
  function scheduleAsideHide() {
    clearTimeout(asideHideTimer);
    asideHideTimer = setTimeout(function () { hoverMatch = null; hideAside(); }, 250);
  }

  function onOver(e) {
    var mc = e.target.closest && e.target.closest("[data-m]");
    if (mc) {
      var no = parseInt(mc.getAttribute("data-m"), 10);
      showTip(no, e.clientX, e.clientY);
      if (ui("view", "groups") === "bracket") {
        clearTimeout(asideHideTimer);
        if (no !== hoverMatch) { hoverMatch = no; updateAside(no, getCtx()); }
      }
    }
  }
  function onMove(e) {
    if (tipEl.classList.contains("show")) positionTip(e.clientX, e.clientY);
  }
  function onOut(e) {
    var mc = e.target.closest && e.target.closest("[data-m]");
    if (mc && (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest("[data-m]"))) {
      hideTip();
      if (ui("view", "groups") === "bracket") scheduleAsideHide();
    }
  }

  function onDocClick(e) {
    // stäng sökresultat vid klick utanför
    if (!e.target.closest || !e.target.closest(".search")) {
      var box = document.getElementById("searchResults");
      if (box) { box.hidden = true; }
    }
  }

  /* ---------- Realtid ---------- */
  function tickClock() {
    var el = document.getElementById("clockTime");
    if (!el) return;
    // Svensk tid (CEST = UTC+2)
    var now = new Date();
    var u = new Date(now.getTime() + (now.getTimezoneOffset() + 120) * 60000);
    el.textContent = pad(u.getHours()) + ":" + pad(u.getMinutes()) + ":" + pad(u.getSeconds());
  }

  /* ---------- Init ---------- */
  function init() {
    viewEl = document.getElementById("view");

    // dynamiska element
    tipEl = document.createElement("div"); tipEl.id = "tooltip"; tipEl.className = "tooltip";
    document.body.appendChild(tipEl);

    var backdrop = document.createElement("div"); backdrop.id = "drawerBackdrop"; backdrop.className = "drawer-backdrop";
    document.body.appendChild(backdrop);
    var drawer = document.createElement("aside"); drawer.id = "teamDrawer"; drawer.className = "team-drawer";
    document.body.appendChild(drawer);

    var banner = document.createElement("div"); banner.id = "liveBanner"; banner.className = "live-banner";
    document.body.appendChild(banner);

    var aside = document.createElement("aside"); aside.id = "bracketAside"; aside.className = "bracket-aside";
    document.body.appendChild(aside);
    aside.addEventListener("mouseenter", function () { clearTimeout(asideHideTimer); });
    aside.addEventListener("mouseleave", scheduleAsideHide);

    document.body.addEventListener("change", onChange);
    document.body.addEventListener("input", onInput);
    document.body.addEventListener("click", onClick);
    document.addEventListener("click", onDocClick);
    viewEl.addEventListener("mouseover", onOver);
    viewEl.addEventListener("mousemove", onMove);
    viewEl.addEventListener("mouseout", onOut);

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeTeam(); hideTip(); }
    });

    // Realtid: synk mellan flikar + nedräkningar
    window.addEventListener("storage", function (e) {
      if (e.key === STORE_KEY) { state = loadState(); refresh(); updateLiveBanner(); }
    });
    setInterval(tickClock, 1000);
    setInterval(refresh, 30000); // uppdatera "om X / Pågår" m.m.

    setSimBtn();
    tickClock();
    render();
  }
  document.addEventListener("DOMContentLoaded", init);
})();
