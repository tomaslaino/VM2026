/* VM 2026 – app-logik: tabeller, bästa trea, slutspelsträd, kalender,
   lagsök, slutspelsinfo och realtidsuppdatering. */
(function () {
  "use strict";

  var STORE_KEY = "vm2026:v1";

  /* ---------- State ---------- */
  var state = loadState();
  var expandedGroups = {};      // letter -> bool (visa matcher)
  var selectedTeam = null;      // { group, idx } för lag-panelen (ej persistent)
  var hoverMatch = null;        // matchnummer med öppen infopanel i slutspelet
  var autoSync = { active: false, source: null, updatedAt: null, status: "pending" };
  var apiFixtures = {}; // nyckel -> { date, time, home, away, homeRef, awayRef, status } från API
  var apiStandings = {}; // grupp-bokstav -> [{ idx, position, pld, w, d, l, gf, ga, gd, pts }] från API
  var calScrollPending = false; // scrolla till nästa matchdag vid öppning av kalender
  var calGroupOpen = null;      // grupp-bokstav för öppen tabell-popup i kalendern

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
  function matchExpandBtn(matchNo, expanded) {
    var label = expanded ? "Dölj matchinfo" : "Visa matchinfo";
    return '<button type="button" class="match-expand' + (expanded ? " on" : "") + '" data-expand-match="' + matchNo + '" ' +
      'title="' + label + '" aria-label="' + label + '" aria-expanded="' + (expanded ? "true" : "false") + '">' +
      '<svg class="match-expand-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path fill="currentColor" d="M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6 1.41-1.41z"/></svg></button>';
  }
  function teamSvFixture(team) {
    if (team.svShort) return team.svShort;
    var sv = team.sv;
    var och = sv.indexOf(" och ");
    if (och > 0) return sv.slice(0, och);
    return sv;
  }
  function fixtureTeamName(team) {
    var compact = teamSvFixture(team);
    return '<span class="t-name" title="' + esc(team.sv) + '">' + esc(compact) + '</span>';
  }
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function parseDateUTC(s) {
    var p = s.split("-").map(Number);
    return new Date(Date.UTC(p[0], p[1] - 1, p[2]));
  }
  function shiftDateUTC(dateStr, days) {
    var d = parseDateUTC(dateStr);
    d.setUTCDate(d.getUTCDate() + days);
    return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate());
  }

  /* Absolut tidpunkt (UTC) för avspark. Tider i data lagras som svensk tid (CEST, UTC+2). */
  function kickoffUTC(m) {
    var p = m.date.split("-").map(Number);
    var hh = 18, mm = 0;
    if (m.edt) {
      var parts = m.edt.split(":");
      hh = parseInt(parts[0], 10);
      mm = parseInt(parts[1] || "0", 10);
    }
    return new Date(Date.UTC(p[0], p[1] - 1, p[2], hh - 2, mm));
  }

  /* Datum/tid-etiketter (svensk tid). */
  function whenLabels(m) {
    var d2 = parseDateUTC(m.date);
    var dateLabel = WEEKDAYS[d2.getUTCDay()] + " " + d2.getUTCDate() + " " + MONTHS[d2.getUTCMonth()];
    if (!m.edt) return { dateLabel: dateLabel, time: "tid TBC" };
    return { dateLabel: dateLabel, time: m.edt };
  }

  /* Relativ tid till avspark, ex "om 3 dagar", "Pågår", "Spelad". */
  function relativeLabel(m, played, resKey) {
    if (played) return { cls: "done", txt: "Spelad" };
    if (resKey) {
      var rs = getRes(resKey);
      if (rs && (rs.status === "IN_PLAY" || rs.status === "PAUSED" || rs.status === "LIVE"))
        return { cls: "live", txt: "Pågår nu" };
    }
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

  /* ---------- Resultathantering (endast från API) ---------- */
  function getRes(key) { return state.results[key] || null; }
  function isPlayed(r) { return r && r.h !== undefined && r.a !== undefined; }

  function isLiveStatus(status) {
    return status === "IN_PLAY" || status === "PAUSED" || status === "LIVE";
  }

  function isMatchLive(key) {
    var fx = getApiFixture(key);
    if (fx && isLiveStatus(fx.status)) return true;
    var rs = getRes(key);
    return rs && isLiveStatus(rs.status);
  }

  function scoreDisplay(val) {
    var empty = val === undefined || val === null || val === "";
    return '<span class="score-display' + (empty ? " score-empty" : "") + '">' + (empty ? "–" : val) + "</span>";
  }

  function scorePair(r) {
    r = r || {};
    return '<span class="fx-score">' + scoreDisplay(r.h) + '<span class="dash">–</span>' + scoreDisplay(r.a) + "</span>";
  }

  function liveTimeLabel(key, fallback) {
    if (!isMatchLive(key)) return fallback;
    return '<span class="fx-live"><span class="live-dot"></span>LIVE</span>';
  }

  function getApiFixture(key) { return apiFixtures[key] || null; }

  /** Slå in resultat + schema från backend (football-data). Uppdaterar grupper/slutspel/kalender. */
  function mergeRemoteResults(payload) {
    if (!payload) return false;
    var changed = false;
    var fixturesChanged = false;

    if (payload.fixtures) {
      var nextFx = JSON.stringify(payload.fixtures);
      if (nextFx !== JSON.stringify(apiFixtures)) {
        apiFixtures = payload.fixtures;
        fixturesChanged = true;
      }
    }

    if (payload.standings) {
      var nextSt = JSON.stringify(payload.standings);
      if (nextSt !== JSON.stringify(apiStandings)) {
        apiStandings = payload.standings;
        fixturesChanged = true;
      }
    }

    if (payload.results) {
      var results = payload.results;
      for (var key in results) {
        if (!Object.prototype.hasOwnProperty.call(results, key)) continue;
        var r = results[key];
        if (r.h === undefined || r.a === undefined) continue;
        var cur = state.results[key];
        if (!cur || cur.h !== r.h || cur.a !== r.a || cur.pw !== r.pw || cur.status !== r.status) {
          state.results[key] = { h: r.h, a: r.a };
          if (r.pw) state.results[key].pw = r.pw;
          if (r.status) state.results[key].status = r.status;
          changed = true;
        }
      }
    }

    if (payload.meta) {
      autoSync.active = true;
      autoSync.status = "ok";
      autoSync.source = payload.meta.source || "football-data";
      autoSync.updatedAt = payload.meta.updatedAt || null;
    }

    if (changed || fixturesChanged) {
      if (changed) saveState();
      refresh({ full: true });
      updateSyncBadge();
    } else if (payload.meta) {
      updateSyncBadge();
    }
    return changed || fixturesChanged;
  }

  function setSyncStatus(status) {
    autoSync.status = status;
    if (status === "ok") autoSync.active = true;
    updateSyncBadge();
  }

  function updateSyncBadge() {
    var el = document.getElementById("syncBadge");
    if (!el) return;
    el.hidden = false;
    el.classList.remove("pending", "ok", "error");
    if (autoSync.status === "ok" && autoSync.updatedAt) {
      el.classList.add("ok");
      el.textContent = "Auto · football-data";
      el.title = "Senast uppdaterad: " + new Date(autoSync.updatedAt).toLocaleString("sv-SE");
    } else if (autoSync.status === "error") {
      el.classList.add("error");
      el.textContent = "Ingen backend";
      el.title = "Kunde inte hämta resultat. Kontrollera att servern körs och att VM_CONFIG.backend pekar rätt.";
    } else {
      el.classList.add("pending");
      el.textContent = "Hämtar…";
      el.title = "Resultat hämtas automatiskt från football-data.org";
    }
  }

  /* ---------- Gruppspelets matcher (round-robin, 4 lag) ---------- */
  var RR = [ [[0,1],[2,3]], [[0,2],[3,1]], [[3,0],[1,2]] ];

  function koMatchDisplay(mt) {
    var fx = getApiFixture("k:" + mt.m);
    return {
      date: (fx && fx.date) || mt.date,
      edt: (fx && fx.time) || mt.edt,
      m: mt.m, round: mt.round, venue: mt.venue, home: mt.home, away: mt.away,
      status: fx ? fx.status : null
    };
  }

  function sideFromApiRef(ref) {
    if (!ref || !WC.groups[ref.group]) return null;
    var t = WC.groups[ref.group][ref.idx];
    if (!t) return null;
    return { team: t, decided: true, label: t.sv, fromApi: true };
  }

  function apiKnockoutSide(fx, which) {
    if (!fx) return null;
    var ref = which === "home" ? fx.homeRef : fx.awayRef;
    return sideFromApiRef(ref);
  }

  function groupFixtures(letter) {
    var out = [], idx = 0;
    for (var md = 0; md < RR.length; md++) {
      for (var j = 0; j < RR[md].length; j++) {
        var key = "g:" + letter + ":" + idx;
        var api = getApiFixture(key);
        var sched = api || (WC.groupSchedule && WC.groupSchedule[key]);
        out.push({
          key: key, md: md + 1,
          h: RR[md][j][0], a: RR[md][j][1],
          date: sched ? sched.date : WC.groupDates[letter][md],
          edt: sched ? (sched.time || sched.edt) : null,
          letter: letter
        });
        idx++;
      }
    }
    return out;
  }

  function sortFixturesChrono(fixtures) {
    return fixtures.slice().sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      var at = a.edt || "99:99", bt = b.edt || "99:99";
      return at < bt ? -1 : at > bt ? 1 : 0;
    });
  }

  /* ---------- Tabellberäkning ---------- */
  function emptyStat(team, idx) {
    return { team: team, idx: idx, pld:0, w:0, d:0, l:0, gf:0, ga:0, gd:0, pts:0 };
  }
  /* Jämförelse av två lag enligt FIFA-ordning (utom inbördes möte): poäng → målskillnad → gjorda mål → vinster. */
  function cmpOverall(y, x) { // returnerar positivt om y ska före x
    return (y.pts - x.pts) || (y.gd - x.gd) || (y.gf - x.gf) || (y.w - x.w) || (x.idx - y.idx);
  }
  /* Sortera tabellen enligt football-data:s officiella ordning (om den finns
     och täcker alla lag i gruppen). Returnerar true om ordningen tillämpades. */
  function applyApiOrder(letter, st) {
    var rows = apiStandings[letter];
    if (!rows || !rows.length) return false;
    var posByIdx = {};
    rows.forEach(function (row) { posByIdx[row.idx] = row.position; });
    var allHave = st.every(function (s) { return posByIdx[s.idx] != null; });
    if (!allHave) return false;
    st.sort(function (x, y) {
      return (posByIdx[x.idx] - posByIdx[y.idx]) || cmpOverall(y, x) || (x.idx - y.idx);
    });
    st.forEach(function (s, k) { s.rank = k; });
    return true;
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
      if (r.h > r.a) { H.w++; A.l++; H.pts += 3; }
      else if (r.h < r.a) { A.w++; H.l++; A.pts += 3; }
      else { H.d++; A.d++; H.pts++; A.pts++; }
    });
    st.forEach(function (s) { s.gd = s.gf - s.ga; });

    // Officiell tabellordning från football-data (inkl. fair play och övriga
    // särskiljningsregler som inte går att räkna fram lokalt). Statistiken visas
    // från matchresultaten (uppdateras live), men placeringarna styrs av API:t.
    if (applyApiOrder(letter, st)) return st;

    var allZeroPts = st.every(function (s) { return s.pts === 0; });
    if (allZeroPts) {
      st.sort(function (x, y) { return x.team.sv.localeCompare(y.team.sv, "sv"); });
    } else {
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
      // inbördes: poäng → målskillnad → gjorda mål, sedan total: vinster → lottning
      return (my.pts - mx.pts) || (my.gd - mx.gd) || (my.gf - mx.gf) ||
             (y.w - x.w) || (x.idx - y.idx);
    });
    for (var k = 0; k < group.length; k++) st[from + k] = group[k];
  }

  /* ---------- Tredjeplacerade lag ---------- */
  function fifaRankOf(team) {
    var r = WC.fifaRank && team ? WC.fifaRank[team.iso] : null;
    return (typeof r === "number") ? r : 999;
  }
  /* FIFA:s kriterier för bästa treor: poäng → målskillnad → gjorda mål →
     fair play → FIFA-ranking. Fair play saknas i football-data, så vi går
     direkt från gjorda mål till FIFA-rankingen (det officiella sista steget). */
  function cmpThirdsStat(a, b) { // positivt om a ska före b
    return (a.pts - b.pts) || (a.gd - b.gd) || (a.gf - b.gf);
  }
  function computeThirds(tables) {
    var arr = WC.groupLetters.map(function (L) {
      var t = tables[L][2];
      return { L: L, team: t.team, s: t };
    });
    var allZeroPts = arr.every(function (e) { return e.s.pts === 0; });
    if (allZeroPts) {
      arr.sort(function (x, y) { return x.team.sv.localeCompare(y.team.sv, "sv"); });
    } else {
      arr.sort(function (x, y) {
        return cmpThirdsStat(y.s, x.s) ||
          (fifaRankOf(x.team) - fifaRankOf(y.team)) ||
          (x.L < y.L ? -1 : 1);
      });
    }

    // Markera lag som är lika på de kriterier vi kan räkna fram (poäng/
    // målskillnad/gjorda mål). Där avgör egentligen fair play, som API:t
    // inte ger oss – ordningen mellan dem bygger på FIFA-ranking och är osäker.
    arr.forEach(function (e) { e.contested = false; });
    var i = 0;
    while (i < arr.length) {
      var j = i + 1;
      while (j < arr.length &&
             arr[j].s.pts === arr[i].s.pts &&
             arr[j].s.gd === arr[i].s.gd &&
             arr[j].s.gf === arr[i].s.gf) j++;
      if (j - i > 1 && arr[i].s.pld > 0) {
        for (var k = i; k < j; k++) arr[k].contested = true;
      }
      i = j;
    }

    arr.forEach(function (e, idx) { e.qualified = idx < 8; });
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
      var fx = getApiFixture("k:" + mt.m);
      var home = apiKnockoutSide(fx, "home") || resolveSlot(mt.home, ctx);
      var away = apiKnockoutSide(fx, "away") || resolveSlot(mt.away, ctx);
      var r = getRes("k:" + mt.m);
      var winner = null, loser = null;
      var bothTeams = home.team && away.team;
      if (bothTeams && isPlayed(r)) {
        var dec = (home.decided || home.fromApi) && (away.decided || away.fromApi);
        if (r.h > r.a) { winner = mk(home, dec); loser = mk(away, dec); }
        else if (r.a > r.h) { winner = mk(away, dec); loser = mk(home, dec); }
        else if (r.pw === "h") { winner = mk(home, dec); loser = mk(away, dec); }
        else if (r.pw === "a") { winner = mk(away, dec); loser = mk(home, dec); }
      }
      ctx.resolved[mt.m] = {
        match: koMatchDisplay(mt), home: home, away: away,
        result: r, winner: winner, loser: loser, bothTeams: bothTeams
      };
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
  /* Vilka treor som faktiskt hamnar i matchens trea-platser (FIFA Annex C). */
  function assignedThirdGroups(ctx, base) {
    var assigned = {};
    var assign = window.ANNEX_C[ctx.thirds.key];
    if (!assign) return assigned;
    base.forEach(function (s) {
      if (s.t !== "3" || !s._m) return;
      var slotId = MATCH_TO_SLOT[s._m];
      if (!slotId) return;
      var pos = window.ANNEX_C_SLOTS.indexOf(slotId);
      if (pos < 0) return;
      var grp = assign.charAt(pos);
      if (grp) assigned[grp] = true;
    });
    return assigned;
  }

  /* ====================================================================
     RENDERING
  ==================================================================== */
  var viewEl;
  var countdownTimer = null;

  var HERO_TEXTS = {
    groups: { title: "Gruppspel", sub: "11 juni – 19 juli · 48 lag · 104 matcher" },
    bracket: { title: "Slutspel", sub: "" },
    calendar: { title: "Kalender", sub: "Alla matcher · grupp- & slutspelsfas" }
  };

  /* Vytitel (Gruppspel/Slutspel/Kalender) visas i innehållsytan,
     inte i bannern – bannern är identisk i alla vyer. */
  function renderPageIntro(view) {
    if (!viewEl) return;
    var t = HERO_TEXTS[view] || HERO_TEXTS.groups;
    var html = '<div class="page-intro"><div class="page-intro-main">' +
      "<h2>" + t.title + "</h2>" +
      (t.sub ? "<p>" + t.sub + "</p>" : "") +
      "</div></div>";
    /* Slutspel: lägg rubriken i scroll-ytan så att den följer med uppåt när
       man scrollar i trädet (annars låser den fast och täcker tabellen). */
    if (view === "bracket") {
      var sc = viewEl.querySelector(".bracket-scroll");
      if (sc) { sc.insertAdjacentHTML("afterbegin", html); return; }
    }
    viewEl.insertAdjacentHTML("afterbegin", html);
  }

  /* Sticky-offset: hela headern är sticky men med negativ top så att
     bara navraden blir kvar synlig högst upp när man scrollar. */
  function updateHeroSticky() {
    var header = document.querySelector(".hero-header");
    if (!header) return;
    if (ui("view", "groups") === "bracket") {
      header.style.top = "0";
      return;
    }
    var nav = header.querySelector(".topbar");
    var navH = nav ? nav.offsetHeight : 0;
    header.style.top = Math.min(0, navH - header.offsetHeight) + "px";
  }

  function setBracketHeroCollapsed(on) {
    var header = document.querySelector(".hero-header");
    if (!header) return;
    var was = header.classList.contains("hero-collapsed");
    header.classList.toggle("hero-collapsed", !!on);
    if (was !== !!on && ui("view", "groups") === "bracket") {
      requestAnimationFrame(drawBracketConnectors);
    }
  }

  /* Grupp/kalender: fäll ihop headern (dölj sök + badge) när bannern
     scrollats förbi, så bara navraden ligger kvar högst upp. */
  function syncHeaderCompact() {
    if (ui("view", "groups") === "bracket") return;
    var header = document.querySelector(".hero-header");
    if (!header) return;
    var topVal = parseFloat(header.style.top) || 0;
    var threshold = Math.max(20, -topVal - 6);
    setBracketHeroCollapsed(window.scrollY > threshold);
  }

  function setupBracketHeroCollapse() {
    var sc = viewEl.querySelector(".bracket-scroll");
    if (!sc || sc._heroCollapseBound) return;
    sc._heroCollapseBound = true;

    sc.addEventListener("scroll", function () {
      if (sc.scrollTop > 6) setBracketHeroCollapsed(true);
      else if (sc.scrollTop <= 0) setBracketHeroCollapsed(false);
    }, { passive: true });
  }

  function render() {
    var view = ui("view", "groups");
    document.documentElement.classList.toggle("view-bracket", view === "bracket");
    document.querySelectorAll("[data-nav]").forEach(function (b) {
      b.classList.toggle("active", b.getAttribute("data-nav") === view);
    });
    if (view === "groups") renderGroups();
    else if (view === "bracket") {
      setBracketHeroCollapsed(false);
      renderBracket();
    }
    else renderCalendar();
    renderPageIntro(view);

    if (view !== "calendar") hideCalGroupPopup();
    if (view !== "bracket") {
      hoverMatch = null;
      hideAside();
      setBracketHeroCollapsed(false);
    }
    renderTeamDrawer();
    updateHeroSticky();
    syncHeaderCompact();
  }

  /* Re-render utan att störa pågående inmatning (för realtid/timer). */
  function refresh(opts) {
    opts = opts || {};
    var a = document.activeElement;
    if (a && a.classList && a.classList.contains("score")) return;
    if (a && a.id === "teamSearch") { render(); restoreSearchFocus(); return; }
    if (!opts.full && ui("view", "groups") === "bracket") {
      updateBracketTimers();
      return;
    }
    render();
  }

  /** Uppdatera "om X tim" / LIVE på slutspelskort utan att bygga om hela trädet. */
  function updateBracketTimers() {
    if (ui("view", "groups") !== "bracket") return;
    var ctx = getCtx();
    viewEl.querySelectorAll(".bracket .match[data-m]").forEach(function (el) {
      var m = parseInt(el.getAttribute("data-m"), 10);
      var res = ctx.resolved[m];
      if (!res) return;
      var played = res.bothTeams && isPlayed(res.result);
      var resKey = "k:" + m;
      var liveNow = isMatchLive(resKey);
      var rel = liveNow ? { cls: "live", txt: "Pågår nu" } : relativeLabel(res.match, played, resKey);
      var relEl = el.querySelector(".m-rel");
      if (relEl) {
        relEl.className = "m-rel " + rel.cls;
        relEl.textContent = rel.txt;
      }
      el.classList.toggle("live-now", liveNow);
    });
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

    var html = '<div class="groups-layout">' +
      nextMatchesRow(ctx) +
      '<div class="groups-grid">';
    WC.groupLetters.forEach(function (L) { html += groupCard(L, ctx.tables[L], qualifiedLetters[L]); });
    html += thirdsPanel(ctx.thirds);
    html += '</div></div>';
    viewEl.innerHTML = html;
    updateNextCountdown();
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
        '<td class="c-team"><span class="team">' +
          flagImg(s.team.iso) + '<span class="t-name">' + esc(s.team.sv) + '</span></span></td>' +
        '<td class="c-stat">' + s.pld + '</td><td class="c-stat">' + s.w + '</td>' +
        '<td class="c-stat">' + s.d + '</td><td class="c-stat">' + s.l + '</td>' +
        '<td class="c-goals">' + s.gf + '–' + s.ga + '</td>' +
        '<td class="c-stat">' + (s.gd > 0 ? "+" + s.gd : s.gd) + '</td>' +
        '<td class="c-pts">' + s.pts + '</td></tr>';
    });
    return h;
  }

  function groupCard(L, table, thirdQualified) {
    var fixtures = groupFixtures(L);
    var open = !!expandedGroups[L];
    var h = '<section class="card group-card' + (open ? " is-open" : "") + '">';
    h += '<div class="group-head"><h3><span class="group-letter">' + L + '</span>Grupp ' + L + '</h3></div>';
    h += '<table class="standings"><thead><tr>' +
         '<th class="c-pos">#</th><th class="c-team">Lag</th>' +
         '<th class="c-stat">S</th><th class="c-stat">V</th><th class="c-stat">O</th><th class="c-stat">F</th>' +
         '<th class="c-goals">Mål</th><th class="c-stat">+/-</th>' +
         '<th class="c-pts">P</th>' +
         '</tr></thead><tbody>' + standingsRows(table, { thirdQualified: thirdQualified }) + '</tbody></table>';

    h += '<button class="matches-toggle" data-toggle-group="' + L + '">' +
         (open ? "Dölj matcher ▲" : "Visa matcher ▼") + '</button>';

    if (open) {
      h += '<div class="fixtures">';
      sortFixturesChrono(fixtures).forEach(function (fx) {
        var th = WC.groups[L][fx.h], ta = WC.groups[L][fx.a];
        var r = getRes(fx.key) || {};
        var when = whenLabels(fx);
        var liveFx = isMatchLive(fx.key);
        h += '<div class="fixture' + (liveFx ? " live" : "") + '">' +
          '<div class="fx-date">' + (liveFx ? liveTimeLabel(fx.key, when.dateLabel + ' · ' + when.time) : when.dateLabel + ' · ' + when.time) + '</div>' +
          '<div class="fx-match">' +
          teamOpenBtn(th, fixtureTeamName(th) + flagImg(th.iso), "fx-team home") +
          scorePair(r) +
          teamOpenBtn(ta, flagImg(ta.iso) + fixtureTeamName(ta), "fx-team away") +
          '</div></div>';
      });
      h += '</div>';
    }
    h += '</section>';
    return h;
  }

  function thirdsPanel(thirds) {
    var h = '<section class="card thirds-card">' +
      '<div class="group-head"><h3>Ranking – tredjeplacerade lag</h3>' +
      '<span class="host-tag info">8 bästa går vidare</span></div>' +
      '<table class="standings thirds-table"><thead><tr>' +
      '<th class="c-pos">#</th><th class="c-grp">Gr</th><th class="c-team">Lag</th>' +
      '<th class="c-stat">S</th><th class="c-stat">V</th><th class="c-stat">O</th><th class="c-stat">F</th>' +
      '<th class="c-goals">Mål</th><th class="c-stat">+/-</th>' +
      '<th class="c-pts">P</th><th class="c-status">Kval</th></tr></thead><tbody>';
    var anyContested = thirds.ranking.some(function (e) { return e.contested; });
    thirds.ranking.forEach(function (e, i) {
      var cls = e.qualified ? "r-third-q" : "r-third-o";
      if (i === 7) cls += " cut-line"; // sista kvalplatsen
      if (e.contested) cls += " r-contested";
      var contestedMark = e.contested
        ? ' <sup class="fp-mark" title="Lika på poäng, målskillnad och gjorda mål. FIFA avgör på fair play (saknas i API:t) → ordnas på FIFA-ranking.">FP?</sup>'
        : "";
      h += '<tr class="' + cls + '" data-team="' + e.team.iso + '">' +
        '<td class="c-pos">' + (i + 1) + '</td><td class="c-grp">' + e.L + '</td>' +
        '<td class="c-team"><span class="team">' + flagImg(e.team.iso) +
          '<span class="t-name">' + esc(e.team.sv) + contestedMark + '</span></span></td>' +
        '<td class="c-stat">' + e.s.pld + '</td><td class="c-stat">' + e.s.w + '</td>' +
        '<td class="c-stat">' + e.s.d + '</td><td class="c-stat">' + e.s.l + '</td>' +
        '<td class="c-goals">' + e.s.gf + '–' + e.s.ga + '</td>' +
        '<td class="c-stat">' + (e.s.gd > 0 ? "+" + e.s.gd : e.s.gd) + '</td>' +
        '<td class="c-pts">' + e.s.pts + '</td>' +
        '<td class="c-status">' + (e.qualified ? '<span class="qbadge">✓</span>' : '<span class="xbadge">✗</span>') + '</td></tr>';
    });
    h += '</tbody></table><p class="note">Endast de <strong>8 bästa treorna</strong> går vidare (de 4 sämsta treorna + alla fyror åker ut). ' +
      'Rangordning enligt FIFA: poäng → målskillnad → gjorda mål → fair play → FIFA-ranking. ' +
      (anyContested
        ? '<br><strong>FP?</strong> = lag som står lika på poäng, målskillnad och gjorda mål. ' +
          'Där avgör egentligen <em>fair play</em>, men den datan finns inte i football-data – ' +
          'dessa lag ordnas därför preliminärt på FIFA-ranking och kan ändras. '
        : '') +
      'De 8 placeras automatiskt i slutspelsträdet enligt FIFA:s 495 kombinationer (Annex C).</p></section>';
    return h;
  }

  /* ---------- Slutspelsvy (tvåsidigt träd, final i mitten) ---------- */
  var BR = {
    leftR32: [74,77,73,75,83,84,81,82], leftR16: [89,90,93,94], leftQF: [97,98], leftSF: [101],
    rightSF: [102], rightQF: [99,100], rightR16: [91,92,95,96], rightR32: [76,78,79,80,86,88,85,87]
  };

  var BR_HALF = {
    left: [
      { title: "Sextondelsfinal", nums: BR.leftR32, round: 0 },
      { title: "Åttondelsfinal",  nums: BR.leftR16, round: 1 },
      { title: "Kvartsfinal",     nums: BR.leftQF,  round: 2 },
      { title: "Semifinal",       nums: BR.leftSF,  round: 3 }
    ],
    right: [
      { title: "Semifinal",       nums: BR.rightSF,  round: 3 },
      { title: "Kvartsfinal",     nums: BR.rightQF,  round: 2 },
      { title: "Åttondelsfinal",  nums: BR.rightR16, round: 1 },
      { title: "Sextondelsfinal", nums: BR.rightR32, round: 0 }
    ]
  };

  function bracketGridCol(round, side) {
    return side === "left" ? round + 1 : 9 - round;
  }

  /** Höger halva av trädet → panel till vänster så matchkorten inte täcks. */
  function bracketAsideSide(matchNo) {
    var right = BR.rightR32.concat(BR.rightR16, BR.rightQF, BR.rightSF);
    return right.indexOf(matchNo) >= 0 ? "left" : "right";
  }

  function bracketGridRow(round, idx) {
    var span = Math.pow(2, round);
    return "grid-row:" + (2 + idx * span) + "/span " + span;
  }

  function bracketRoundTitle(title, col, opts) {
    opts = opts || {};
    var cls = "round-title bracket-jump";
    if (opts.final) cls += " final-label";
    if (opts.bronze) cls += " bronze-title";
    var sub = opts.sub ? '<span class="round-sub">' + esc(opts.sub) + '</span>' : "";
    var btn = '<button type="button" class="' + cls + '" data-bracket-col="' + col + '">' + title + sub + '</button>';
    if (opts.bronze) return btn;
    return '<div class="round-cell' + (opts.final ? " is-final" : "") + '" style="grid-column:' + col + '">' + btn + '</div>';
  }

  /* Datumintervall för en slutspelsfas, t.ex. "28 juni–3 juli". */
  function bracketRoundDates(nums, resolved) {
    var dates = nums.map(function (n) { return resolved[n].match.date; }).sort();
    var a = parseDateUTC(dates[0]), b = parseDateUTC(dates[dates.length - 1]);
    if (dates[0] === dates[dates.length - 1]) return a.getUTCDate() + " " + MONTHS[a.getUTCMonth()];
    if (a.getUTCMonth() === b.getUTCMonth()) {
      return a.getUTCDate() + "–" + b.getUTCDate() + " " + MONTHS[a.getUTCMonth()];
    }
    return a.getUTCDate() + " " + MONTHS[a.getUTCMonth()] + "–" + b.getUTCDate() + " " + MONTHS[b.getUTCMonth()];
  }

  function renderBracket() {
    var ctx = getCtx();

    var html = '<div class="bracket-shell">' +
      '<div class="bracket-scroll"><div class="bracket-wrap">';
    html += '<svg class="bracket-lines" aria-hidden="true"></svg>';
    html += '<div class="bracket two-sided">';

    BR_HALF.left.forEach(function (col) {
      html += bracketRoundTitle(col.title, bracketGridCol(col.round, "left"),
        { sub: bracketRoundDates(col.nums, ctx.resolved) });
    });
    html += bracketRoundTitle("Final", 5, { final: true, sub: bracketRoundDates([104], ctx.resolved) });
    BR_HALF.right.forEach(function (col) {
      html += bracketRoundTitle(col.title, bracketGridCol(col.round, "right"),
        { sub: bracketRoundDates(col.nums, ctx.resolved) });
    });

    BR_HALF.left.forEach(function (col) {
      col.nums.forEach(function (n, idx) {
        html += matchCard(ctx.resolved[n], null, {
          side: "left",
          grid: "grid-column:" + bracketGridCol(col.round, "left") + ";" + bracketGridRow(col.round, idx)
        });
      });
    });

    html += '<div class="bracket-center-stack" style="grid-column:5;grid-row:2/span 8">' +
      '<div class="bracket-finals-block">' +
        championBanner(ctx.resolved[104]) +
        matchCard(ctx.resolved[104], "final") +
      '</div>' +
      '<div class="bracket-bronze-block">' +
        bracketRoundTitle("Bronsmatch", 5, { bronze: true }) +
        matchCard(ctx.resolved[103], "bronze") +
      '</div></div>';

    BR_HALF.right.forEach(function (col) {
      col.nums.forEach(function (n, idx) {
        html += matchCard(ctx.resolved[n], null, {
          side: "right",
          grid: "grid-column:" + bracketGridCol(col.round, "right") + ";" + bracketGridRow(col.round, idx)
        });
      });
    });

    html += '</div></div></div></div>';

    var sc = viewEl.querySelector(".bracket-scroll");
    var preserveScroll = !!sc;
    var prevScroll = sc ? sc.scrollLeft : 0;

    viewEl.innerHTML = html;

    var newSc = viewEl.querySelector(".bracket-scroll");
    function restoreBracketScroll() {
      if (!newSc || !preserveScroll) return;
      newSc.scrollLeft = Math.max(0, Math.min(prevScroll, newSc.scrollWidth - newSc.clientWidth));
    }

    if (preserveScroll) {
      restoreBracketScroll();
      drawBracketConnectors(restoreBracketScroll);
    } else {
      centerBracketScroll(drawBracketConnectors);
    }

    if (hoverMatch && ctx.resolved[hoverMatch]) updateAside(hoverMatch, ctx);
    else hideAside();
    setupBracketHeroCollapse();
  }

  function drawBracketConnectors(afterLayout) {
    requestAnimationFrame(function () {
      var wrap = viewEl.querySelector(".bracket-wrap");
      var br = wrap && wrap.querySelector(".bracket");
      var svg = wrap && wrap.querySelector(".bracket-lines");
      if (!wrap || !br || !svg) return;

      var wrapRect = wrap.getBoundingClientRect();
      var paths = [];

      function pos(el) {
        var r = el.getBoundingClientRect();
        return {
          y: r.top - wrapRect.top + r.height / 2,
          right: r.right - wrapRect.left,
          left: r.left - wrapRect.left,
          top: r.top - wrapRect.top,
          bottom: r.bottom - wrapRect.top,
          cx: r.left - wrapRect.left + r.width / 2
        };
      }

      function forkPair(aEl, bEl, pEl, side) {
        var a = pos(aEl), b = pos(bEl), p = pos(pEl);
        var midY = (a.y + b.y) / 2;
        if (side === "left") {
          var midX = (Math.max(a.right, b.right) + p.left) / 2;
          paths.push("M" + a.right + "," + a.y + " H" + midX);
          paths.push("M" + b.right + "," + b.y + " H" + midX);
          paths.push("M" + midX + "," + a.y + " V" + b.y);
          paths.push("M" + midX + "," + midY + " H" + p.left);
        } else {
          var midX = (Math.min(a.left, b.left) + p.right) / 2;
          paths.push("M" + a.left + "," + a.y + " H" + midX);
          paths.push("M" + b.left + "," + b.y + " H" + midX);
          paths.push("M" + midX + "," + a.y + " V" + b.y);
          paths.push("M" + midX + "," + midY + " H" + p.right);
        }
      }

      function linkSingle(fromEl, toEl, side) {
        var f = pos(fromEl), t = pos(toEl);
        if (side === "left") {
          var midX = (f.right + t.left) / 2;
          paths.push("M" + f.right + "," + f.y + " H" + midX);
          paths.push("M" + midX + "," + f.y + " V" + t.y);
          paths.push("M" + midX + "," + t.y + " H" + t.left);
        } else {
          var midX = (f.left + t.right) / 2;
          paths.push("M" + f.left + "," + f.y + " H" + midX);
          paths.push("M" + midX + "," + f.y + " V" + t.y);
          paths.push("M" + midX + "," + t.y + " H" + t.right);
        }
      }

      function linkBronze(aEl, bEl, bronzeEl) {
        var a = pos(aEl), b = pos(bEl), brz = pos(bronzeEl);
        var entryY = brz.y;

        paths.push("M" + a.cx + "," + a.bottom + " V" + entryY);
        paths.push("M" + a.cx + "," + entryY + " H" + brz.left);

        paths.push("M" + b.cx + "," + b.bottom + " V" + entryY);
        paths.push("M" + b.cx + "," + entryY + " H" + brz.right);
      }

      ["left", "right"].forEach(function (side) {
        var half = BR_HALF[side];
        for (var r = 0; r < half.length - 1; r++) {
          // Vänster: yttre → inre. Höger: BR_HALF är inre → yttre, vänd parningen.
          var kids = side === "left" ? half[r].nums : half[r + 1].nums;
          var pars = side === "left" ? half[r + 1].nums : half[r].nums;
          for (var j = 0; j < pars.length; j++) {
            var elA = br.querySelector('[data-m="' + kids[j * 2] + '"]');
            var elB = br.querySelector('[data-m="' + kids[j * 2 + 1] + '"]');
            var elP = br.querySelector('[data-m="' + pars[j] + '"]');
            if (elA && elB && elP) forkPair(elA, elB, elP, side);
          }
        }
      });

      var fin = br.querySelector('[data-m="104"]');
      var sfL = br.querySelector('[data-m="101"]');
      var sfR = br.querySelector('[data-m="102"]');
      var bronze = br.querySelector('[data-m="103"]');
      if (fin && sfL) linkSingle(sfL, fin, "left");
      if (fin && sfR) linkSingle(sfR, fin, "right");
      if (bronze && sfL && sfR) linkBronze(sfL, sfR, bronze);

      var w = wrap.offsetWidth;
      var h = wrap.offsetHeight;
      svg.setAttribute("viewBox", "0 0 " + w + " " + h);
      svg.setAttribute("width", w);
      svg.setAttribute("height", h);
      svg.innerHTML = paths.map(function (d) {
        return '<path d="' + d + '" fill="none" stroke-linecap="square"/>';
      }).join("");
      if (afterLayout) afterLayout();
    });
  }

  function centerBracketColumn(col, anchorEl) {
    requestAnimationFrame(function () {
      var sc = viewEl.querySelector(".bracket-scroll");
      var br = sc && sc.querySelector(".bracket");
      if (!sc || !br) return;
      var el = anchorEl || br.querySelector('[data-bracket-col="' + col + '"]');
      if (!el) return;
      var scRect = sc.getBoundingClientRect();
      var elRect = el.getBoundingClientRect();
      var colCenter = elRect.left + elRect.width / 2 - scRect.left + sc.scrollLeft;
      sc.scrollLeft = Math.max(0, Math.min(sc.scrollWidth - sc.clientWidth, colCenter - sc.clientWidth / 2));
    });
  }

  function centerBracketScroll(cb) {
    requestAnimationFrame(function () {
      var sc = viewEl.querySelector(".bracket-scroll");
      var br = sc && sc.querySelector(".bracket");
      if (!sc || !br) { if (cb) cb(); return; }
      sc.scrollLeft = Math.max(0, (br.scrollWidth - sc.clientWidth) / 2);
      if (cb) requestAnimationFrame(cb);
    });
  }

  function championBanner(fin) {
    if (!fin.winner || !fin.winner.team) return '<div class="champ-slot empty final-label">VM-final</div>';
    var c = fin.winner.team;
    return '<div class="champ-slot' + (fin.winner.decided ? " decided" : " prov") + '">' +
      teamOpenBtn(c, flagImg(c.iso) +
      '<span class="champ-txt">VM-final' +
      '<strong>' + esc(bracketTeamName(fin.winner)) + '</strong></span>', "champ-open") + '</div>';
  }

  /** Hypotetiskt lag i slutspelsträdet – parentes tills platsen är helt avgjord. */
  function bracketTeamName(side) {
    if (!side || !side.team) return "";
    var name = teamSvFixture(side.team);
    return side.decided ? name : "(" + name + ")";
  }

  /* Längre, mer läsbar seed-etikett för "vem möter vem"-grafiken. */
  function slotSeedLong(slot) {
    if (slot.t === "w") return "Etta grupp " + slot.g;
    if (slot.t === "r") return "Tvåa grupp " + slot.g;
    if (slot.t === "3") return "3:a grupp " + slot.from.join("/");
    if (slot.t === "wm") return "Vinnare match " + slot.m;
    if (slot.t === "lm") return "Förlorare match " + slot.m;
    return "?";
  }

  /* Typklass för seed-chip – färgkodar kvalvägen i linje med grupptabellerna
     (grön = 1:a/2:a som avancerar, guld = bästa trea, neutral = match-resultat). */
  function seedTypeClass(slot) {
    if (!slot) return "seed-m";
    if (slot.t === "w" || slot.t === "r") return "seed-adv";
    if (slot.t === "3") return "seed-third";
    return "seed-m";
  }

  /* En sida i matchup-grafiken: seed-etikett + flagga + lagnamn (eller platshållare). */
  function asideMatchupSide(slot, side, which, isWin) {
    var seed = slotSeedLong(slot);
    var inner;
    if (side.team) {
      var prov = !side.decided;
      inner = teamOpenBtn(side.team,
        flagImg(side.team.iso) + '<span class="mu-name">' + esc(bracketTeamName(side)) + '</span>',
        "mu-team" + (prov ? " prov" : ""));
    } else {
      inner = '<span class="mu-team tbd"><span class="mu-flag-ph"></span>' +
        '<span class="mu-name">Ej klart</span></span>';
    }
    return '<div class="mu-side mu-' + which + (isWin ? " win" : "") + '">' +
      '<span class="mu-seed seed-chip ' + seedTypeClass(slot) + '">' + esc(seed) + '</span>' +
      inner + '</div>';
  }

  function matchCard(res, variant, opts) {
    opts = opts || {};
    var m = res.match;
    var when = whenLabels(m);
    var played = res.bothTeams && isPlayed(res.result);
    var resKey = "k:" + m.m;
    var liveNow = isMatchLive(resKey);
    var rel = liveNow ? { cls: "live", txt: "Pågår nu" } : relativeLabel(m, played, resKey);
    var expanded = hoverMatch === m.m;
    var cls = "match" + (variant ? " " + variant : "") + (liveNow ? " live-now" : "") + (expanded ? " expanded" : "");
    if (opts.side) cls += " side-" + opts.side;

    var hWin = res.winner && res.home.team && res.winner.team === res.home.team;
    var aWin = res.winner && res.away.team && res.winner.team === res.away.team;

    var h = '<div class="' + cls + '" data-m="' + m.m + '"' + (opts.grid ? ' style="' + opts.grid + '"' : '') + '">';
    h += '<div class="m-meta"><span class="m-no">M' + m.m + '</span>' +
         '<span class="m-rel ' + rel.cls + '">' + rel.txt + '</span></div>';
    h += sideRow(res.home, res, "h", hWin);
    h += sideRow(res.away, res, "a", aWin);

    var r = res.result;
    if (played && r.h === r.a && r.pw) {
      var penWinner = r.pw === "h"
        ? (res.home.team ? teamSvFixture(res.home.team) : "Hemma")
        : (res.away.team ? teamSvFixture(res.away.team) : "Borta");
      h += '<div class="pen-row"><span>Straffar: ' + esc(penWinner) + " vann</span></div>";
    }
    h += '<div class="m-footer">' +
         '<span class="m-when">' + when.dateLabel + ' · ' + when.time + '</span>' +
         matchExpandBtn(m.m, expanded) + '</div>';
    h += '</div>';
    return h;
  }

  function sideRow(side, res, ha, isWin) {
    var prov = side.team && !side.decided;
    var cls = "side" + (isWin ? " win" : "") + (prov ? " prov" : "") + (side.team ? "" : " tbd");
    var slot = ha === "h" ? res.match.home : res.match.away;
    var inner = side.team
      ? teamOpenBtn(side.team, flagImg(side.team.iso) + '<span class="s-name" title="' + esc(side.team.sv) + '">' + esc(bracketTeamName(side)) + '</span>', "side-team")
      : '<span class="s-name placeholder seed-chip ' + seedTypeClass(slot) + '">' + esc(side.label) + '</span>';
    var r = res.result || {};
    var scoreCell = scoreDisplay(r[ha]);
    return '<div class="' + cls + '">' + inner + scoreCell + '</div>';
  }

  /* ---------- Sidopanel (möjliga lag + tabeller) ---------- */
  function hideAside() {
    var el = document.getElementById("bracketAside");
    if (el) el.classList.remove("show", "aside-left");
  }

  function syncExpandButtons() {
    document.querySelectorAll(".match-expand").forEach(function (btn) {
      var no = parseInt(btn.getAttribute("data-expand-match"), 10);
      var open = hoverMatch === no;
      btn.classList.toggle("on", open);
      var label = open ? "Dölj matchinfo" : "Visa matchinfo";
      btn.title = label;
      btn.setAttribute("aria-label", label);
      btn.setAttribute("aria-expanded", open ? "true" : "false");
      var card = btn.closest(".match");
      if (card) card.classList.toggle("expanded", open);
    });
  }

  function updateAside(matchNo, ctx) {
    var el = document.getElementById("bracketAside");
    if (!el) return;
    el.classList.toggle("aside-left", bracketAsideSide(matchNo) === "left");
    el.classList.add("show");
    var res = ctx.resolved[matchNo];
    var mt = res.match;

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

    // Panelen äger kvalvägen (seed) + tabellerna och visar tydligt vem som möter
    // vem. Matchrutan i trädet visar bara lagen.
    var h = '<div class="aside-head">' +
      '<div class="aside-title">' +
      '<span class="aside-round">' + WC.roundNames[mt.round] + '</span>' +
      '<span class="aside-match-no">Match ' + matchNo + '</span>' +
      '</div>' +
      '<button class="aside-close" id="asideClose" title="Återställ">×</button></div>';

    // Tydlig "vem möter vem"-grafik: två lagpaneler med seed-etikett (t.ex.
    // "Tvåa grupp A"), flagga och lagnamn, samt en VS-bricka emellan. Funkar i
    // alla slutspelsrundor även innan lagen är avgjorda (visar då platshållare).
    var hWin = res.winner && res.home.team && res.winner.team === res.home.team;
    var aWin = res.winner && res.away.team && res.winner.team === res.away.team;
    h += '<div class="aside-matchup">' +
      asideMatchupSide(mt.home, res.home, "home", hWin) +
      '<div class="mu-vs"><span>VS</span></div>' +
      asideMatchupSide(mt.away, res.away, "away", aWin) +
      '</div>';

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
      var assignedThirds = assignedThirdGroups(ctx, base);
      h += '<div class="aside-section-title">Trea-plats – möjliga grupper: ' + thirdList.join(", ") + '</div>';
      h += asideThirdsTable(ctx, thirdGroups, assignedThirds);
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

  function asideThirdsTable(ctx, highlightGroups, assignedGroups) {
    assignedGroups = assignedGroups || {};
    var h = '<div class="mini-group thirds"><div class="mini-group-head">Tabell – tredjeplacerade (8 bästa går vidare)</div>' +
      '<table class="standings mini"><tbody>';
    ctx.thirds.ranking.forEach(function (e, i) {
      var cls = e.qualified ? "r-third-q" : "r-third-o";
      if (assignedGroups[e.L]) cls += " r-highlight";
      else if (highlightGroups[e.L]) cls += " r-highlight-grp";
      h += '<tr class="' + cls + '" data-team="' + e.team.iso + '"><td class="c-pos">' + (i + 1) + '</td>' +
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
  /* ---------- Kalendervy ---------- */
  function buildSchedule() {
    var items = [];
    WC.groupLetters.forEach(function (L) {
      groupFixtures(L).forEach(function (fx) {
        items.push({ kind: "group", date: fx.date, edt: fx.edt, letter: L, fx: fx });
      });
    });
    WC.knockout.forEach(function (m) {
      var disp = koMatchDisplay(m);
      items.push({ kind: "ko", date: disp.date, edt: disp.edt, m: m });
    });
    items.sort(function (a, b) {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      var ax = a.edt || "99:99", bx = b.edt || "99:99";
      return ax < bx ? -1 : ax > bx ? 1 : 0;
    });
    return items;
  }

  function tvChHtml(ch) {
    if (!ch) return "";
    return '<span class="cal-tv ' + (ch === "SVT" ? "svt" : "tv4") + '">' + ch + "</span>";
  }

  function tvLookupGroup(fx, th, ta) {
    var sched = WC.tvSchedule;
    if (sched && fx.date && fx.edt) {
      var k1 = fx.date + "|" + fx.edt + "|" + th.name + "|" + ta.name;
      var k2 = fx.date + "|" + fx.edt + "|" + ta.name + "|" + th.name;
      if (sched[k1]) return sched[k1];
      if (sched[k2]) return sched[k2];
    }
    return (WC.tvBroadcast && WC.tvBroadcast[fx.key]) || "";
  }

  function tvLookupKo(m) {
    var slot = m.date + "|" + (m.edt || "");
    if (WC.tvKoTime && WC.tvKoTime[slot]) return WC.tvKoTime[slot];
    return (WC.tvBroadcast && WC.tvBroadcast["k:" + m.m]) || "";
  }

  var ROUND_SHORT = { R32: "S16", R16: "Å16", QF: "Kvarts", SF: "Semi", "3RD": "Brons", FINAL: "Final" };

  function countdownParts(targetMs) {
    var diff = Math.max(0, targetMs - Date.now());
    var sec = Math.floor(diff / 1000);
    var days = Math.floor(sec / 86400); sec %= 86400;
    var hrs = Math.floor(sec / 3600); sec %= 3600;
    var mins = Math.floor(sec / 60); sec %= 60;
    return { d: days, h: hrs, m: mins, s: sec };
  }

  function koTeamsLabel(res) {
    var h = res.home.team ? bracketTeamName(res.home) : res.home.label;
    var a = res.away.team ? bracketTeamName(res.away) : res.away.label;
    return h + " – " + a;
  }

  /* Datum + tid för kompakta paneler (nästa match, Sverige/Uruguay). */
  function panelWhenCompact(m, live) {
    if (live) return "Pågår";
    var d = parseDateUTC(m.date);
    return d.getUTCDate() + " " + MONTHS[d.getUTCMonth()] + " · " + (m.edt || "TBC");
  }

  /** Nästa (eller pågående) match(er) – alla med samma avspark räknas som samtidiga. */
  function findNextMatches(ctx) {
    var items = buildSchedule();
    var now = Date.now();
    var twoH = 2 * 3600 * 1000;
    var candidates = [];

    items.forEach(function (it) {
      var m, key, label, teams, channel, played, live;
      if (it.kind === "group") {
        var fx = it.fx, L = it.letter;
        key = fx.key;
        played = isPlayed(getRes(key));
        if (played) return;
        m = fx;
        var th = WC.groups[L][fx.h], ta = WC.groups[L][fx.a];
        channel = tvLookupGroup(fx, th, ta);
        label = "Grupp " + L;
        teams = teamSvFixture(th) + " – " + teamSvFixture(ta);
      } else {
        var res = ctx.resolved[it.m.m];
        key = "k:" + it.m.m;
        played = res.bothTeams && isPlayed(getRes(key));
        if (played) return;
        m = koMatchDisplay(it.m);
        channel = tvLookupKo(m);
        label = (ROUND_SHORT[m.round] || m.round) + " · M" + m.m;
        teams = koTeamsLabel(res);
      }
      var when = whenLabels(m);
      var ko = kickoffUTC(m).getTime();
      var rs = getRes(key);
      var inPlay = rs && (rs.status === "IN_PLAY" || rs.status === "PAUSED" || rs.status === "LIVE");
      live = inPlay || isMatchLive(key) || (ko <= now && ko > now - twoH);
      if (!live && ko < now - twoH) return;
      candidates.push({
        ko: ko, live: live, label: label, teams: teams, channel: channel,
        time: when.time, whenText: panelWhenCompact(m, live)
      });
    });

    var liveOnes = candidates.filter(function (c) { return c.live; });
    if (liveOnes.length) return { live: true, kickoff: liveOnes[0].ko, matches: liveOnes };

    var future = candidates.filter(function (c) { return c.ko >= now - twoH; });
    if (!future.length) return { live: false, kickoff: null, matches: [] };

    future.sort(function (a, b) { return a.ko - b.ko; });
    var best = future[0].ko;
    return { live: false, kickoff: best, matches: future.filter(function (c) { return c.ko === best; }) };
  }

  function nextMatchTimerUnit(id, val, lbl) {
    return '<span class="nm-unit"><span class="nm-val" id="' + id + '">' + val + '</span><span class="nm-lbl">' + lbl + '</span></span>';
  }

  function nextMatchItemHtml(m) {
    return '<div class="nm-item"><span class="nm-meta">' + esc(m.label) + " · " + esc(m.whenText) + "</span>" +
      '<span class="nm-teams">' + esc(m.teams) + "</span>" +
      (m.channel ? tvChHtml(m.channel) : "") + "</div>";
  }

  var TEAM_SPOTLIGHT = [
    { iso: "se", title: "Sverige" },
    { iso: "uy", title: "Uruguay" }
  ];

  function findTeamByIso(iso) {
    var found = null;
    WC.groupLetters.forEach(function (L) {
      WC.groups[L].forEach(function (t, idx) {
        if (t.iso === iso) found = { team: t, group: L, idx: idx };
      });
    });
    return found;
  }

  function openTeamByIso(iso) {
    var found = findTeamByIso(iso);
    if (found) openTeam(found.group, found.idx);
  }

  /** Klickbart lag (knapp) – öppnar statistikfliken. */
  function teamOpenBtn(team, inner, className) {
    if (!team || !team.iso) return inner;
    var cls = "team-open" + (className ? " " + className : "");
    return '<button type="button" class="' + cls + '" data-team-open="' + team.iso + '">' + inner + "</button>";
  }

  function matchTeamsLabel(home, away) {
    var h = home && home.sv ? home.sv : (home || "");
    var a = away && away.sv ? away.sv : (away || "");
    return h + " – " + a;
  }

  /** Kompakt matchrad i Sverige/Uruguay-panelen – kortare namn än referens får plats. */
  function teamSvSpotlightBase(team) {
    if (!team || !team.sv) return "";
    return teamSvFixture(team);
  }

  function matchTeamsLabelCompact(home, away) {
    return teamSvSpotlightBase(home) + " – " + teamSvSpotlightBase(away);
  }

  function findTeamNextMatch(ctx, teamIso) {
    var info = findTeamByIso(teamIso);
    if (!info) return null;
    var matches = teamMatches(info.team, info.group, ctx);
    var now = Date.now();
    var twoH = 2 * 3600 * 1000;

    for (var i = 0; i < matches.length; i++) {
      var mm = matches[i];
      if (mm.played) continue;
      if (!mm.home || !mm.away) continue;

      var m = mm.m;
      var key = mm.kind === "group" ? mm.m.key : "k:" + mm.m.m;
      var when = whenLabels(m);
      var ko = kickoffUTC(m).getTime();
      var rs = getRes(key);
      var inPlay = rs && (rs.status === "IN_PLAY" || rs.status === "PAUSED" || rs.status === "LIVE");
      var live = inPlay || isMatchLive(key) || (ko <= now && ko > now - twoH);
      if (!live && ko < now - twoH) continue;

      var channel = mm.kind === "group"
        ? tvLookupGroup(mm.m, mm.home, mm.away)
        : tvLookupKo(mm.m);

      return {
        kickoff: ko,
        live: live,
        label: mm.label,
        time: when.time,
        whenText: panelWhenCompact(m, live),
        teams: matchTeamsLabelCompact(mm.home, mm.away),
        teamsFull: matchTeamsLabel(mm.home, mm.away),
        channel: channel,
        team: info.team
      };
    }
    return null;
  }

  function spotlightTvHtml(ch) {
    if (!ch) return '<span class="cal-tv cal-tv-empty" aria-hidden="true"></span>';
    return tvChHtml(ch);
  }

  function teamSpotlightItemHtml(tp) {
    var m = tp.match;
    if (!m) {
      return '<button type="button" class="nm-spot-row is-empty team-open" data-team-open="' + tp.iso + '">' +
        '<span class="nm-spot-when nm-muted">–</span>' +
        '<span class="nm-spot-teams nm-muted">Ingen match</span></button>';
    }
    return '<button type="button" class="nm-spot-row team-open' + (m.live ? " is-live" : "") + '" data-team-open="' + tp.iso + '">' +
      '<span class="nm-spot-when">' + esc(m.whenText) + "</span>" +
      '<span class="nm-spot-teams"' + (m.teamsFull && m.teamsFull !== m.teams ? ' title="' + esc(m.teamsFull) + '"' : "") + ">" + esc(m.teams) + "</span>" +
      spotlightTvHtml(m.channel) +
      "</button>";
  }

  function teamsSpotlightPanel(ctx) {
    var teams = TEAM_SPOTLIGHT.map(function (t) {
      return { title: t.title, iso: t.iso, match: findTeamNextMatch(ctx, t.iso) };
    }).sort(function (a, b) {
      if (!a.match && !b.match) return 0;
      if (!a.match) return 1;
      if (!b.match) return -1;
      return a.match.kickoff - b.match.kickoff;
    });
    var anyLive = teams.some(function (t) { return t.match && t.match.live; });
    var h = '<div class="next-matches teams-spotlight' + (anyLive ? " is-live" : "") + '">';
    h += '<div class="nm-head"><span class="nm-title">' +
      flagImg("se") + flagImg("uy") + "Sverige & Uruguay</span></div>";
    h += '<div class="nm-spot-list">';
    teams.forEach(function (tp) { h += teamSpotlightItemHtml(tp); });
    h += "</div></div>";
    return h;
  }

  function nextMatchesRow(ctx) {
    return '<div class="next-matches-row">' +
      nextMatchesPanel(ctx) +
      teamsSpotlightPanel(ctx) +
      "</div>";
  }

  function nextMatchesPanel(ctx) {
    var next = findNextMatches(ctx);
    if (!next.matches.length) {
      return '<div class="next-matches empty" id="nextMatches">' +
        '<span class="nm-title">Nästa match</span>' +
        '<p class="nm-empty">Inga kvarvarande matcher</p></div>';
    }
    var title = next.matches.length > 1 ? "Nästa matcher" : "Nästa match";
    var h = '<div class="next-matches' + (next.live ? " is-live" : "") + '" id="nextMatches" ' +
      'data-kickoff="' + (next.kickoff || "") + '" data-live="' + (next.live ? "1" : "0") + '">';
    h += '<div class="nm-head"><span class="nm-title">' + title + '</span>';
    if (next.live) {
      h += '<span class="nm-live"><span class="live-dot"></span>Pågår nu</span>';
    } else {
      var p = countdownParts(next.kickoff);
      h += '<div class="nm-timer" aria-live="polite">' +
        nextMatchTimerUnit("nm-d", p.d, "d") +
        nextMatchTimerUnit("nm-h", pad(p.h), "h") +
        nextMatchTimerUnit("nm-m", pad(p.m), "m") +
        nextMatchTimerUnit("nm-s", pad(p.s), "s") +
        "</div>";
    }
    h += '</div><div class="nm-list">';
    next.matches.forEach(function (m) {
      h += nextMatchItemHtml(m);
    });
    h += "</div></div>";
    return h;
  }

  function updateNextCountdown() {
    var el = document.getElementById("nextMatches");
    if (!el || el.getAttribute("data-live") === "1") return;
    var ko = parseInt(el.getAttribute("data-kickoff"), 10);
    if (!ko) return;
    var p = countdownParts(ko);
    var d = document.getElementById("nm-d");
    var hrs = document.getElementById("nm-h");
    var mins = document.getElementById("nm-m");
    var secs = document.getElementById("nm-s");
    if (d) d.textContent = p.d;
    if (hrs) hrs.textContent = pad(p.h);
    if (mins) mins.textContent = pad(p.m);
    if (secs) secs.textContent = pad(p.s);
  }

  /** Nyckel, matchobjekt och spelad-status för kalenderpost. */
  function scheduleItemKey(it) {
    return it.kind === "ko" ? "k" + it.m.m : it.fx.key;
  }
  function scheduleItemMatch(it, ctx) {
    return it.kind === "ko" ? ctx.resolved[it.m.m].match : it.fx;
  }
  function scheduleItemResKey(it) {
    return it.kind === "ko" ? "k:" + it.m.m : it.fx.key;
  }
  function scheduleItemPlayed(it, ctx) {
    return isPlayed(getRes(scheduleItemResKey(it)));
  }

  /** Nästa match(er), nyligen spelade + scrollmål för kalendervyn. */
  function calendarViewState(items, ctx) {
    var now = Date.now();
    var twoH = 2 * 3600 * 1000;
    var nextKeys = [];
    var bestKo = Infinity;

    items.forEach(function (it) {
      if (scheduleItemPlayed(it, ctx)) return;
      var ko = kickoffUTC(scheduleItemMatch(it, ctx)).getTime();
      if (ko >= now - twoH && ko < bestKo) bestKo = ko;
    });

    if (bestKo !== Infinity) {
      items.forEach(function (it) {
        if (scheduleItemPlayed(it, ctx)) return;
        if (kickoffUTC(scheduleItemMatch(it, ctx)).getTime() === bestKo) {
          nextKeys.push(scheduleItemKey(it));
        }
      });
    }

    var nextDate = null;
    if (nextKeys.length) {
      items.forEach(function (it) {
        if (nextKeys.indexOf(scheduleItemKey(it)) >= 0) nextDate = it.date;
      });
    }

    var anyPlayed = items.some(function (it) { return scheduleItemPlayed(it, ctx); });
    var scrollTop = !anyPlayed && nextKeys.length > 0;
    var scrollDate = null;
    var recentKeys = [];

    if (scrollTop) {
      // inför första matchen – börja högst upp
    } else if (!nextKeys.length) {
      scrollDate = items.length ? items[items.length - 1].date : null;
      items.forEach(function (it) {
        if (it.date === scrollDate && scheduleItemPlayed(it, ctx)) {
          recentKeys.push(scheduleItemKey(it));
        }
      });
    } else {
      var prevDay = shiftDateUTC(nextDate, -1);
      var hasPrevDay = items.some(function (it) { return it.date === prevDay; });
      if (hasPrevDay) scrollDate = prevDay;
      else {
        for (var i = items.length - 1; i >= 0; i--) {
          if (items[i].date < nextDate) { scrollDate = items[i].date; break; }
        }
      }
      if (scrollDate) {
        items.forEach(function (it) {
          if (it.date === scrollDate && scheduleItemPlayed(it, ctx)) {
            recentKeys.push(scheduleItemKey(it));
          }
        });
      }
    }

    return { nextKeys: nextKeys, recentKeys: recentKeys, scrollDate: scrollDate, scrollTop: scrollTop };
  }

  function scrollCalendarTop() {
    requestAnimationFrame(function () {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
    });
  }

  function scrollCalendarToDate(dateStr) {
    if (!dateStr || !viewEl) return;
    requestAnimationFrame(function () {
      var el = viewEl.querySelector('.cal-day[data-date="' + dateStr + '"]');
      if (!el) return;
      var topbar = document.querySelector(".topbar");
      var offset = (topbar ? topbar.offsetHeight : 72) + 8;
      var top = el.getBoundingClientRect().top + window.scrollY - offset;
      window.scrollTo({ top: Math.max(0, top), left: 0, behavior: "instant" });
    });
  }

  function renderCalendar() {
    var ctx = getCtx();
    var items = buildSchedule();
    var calView = calendarViewState(items, ctx);

    var html = '<div class="calendar-layout">' +
      nextMatchesRow(ctx) +
      '<div class="cal-shell"><div class="cal">';
    var lastDate = null;
    items.forEach(function (it) {
      if (it.date !== lastDate) {
        if (lastDate !== null) html += '</div></div>'; // stäng föregående cal-body + cal-day
        var d = parseDateUTC(it.date);
        html += '<div class="cal-day" data-date="' + it.date + '"><div class="cal-date">' +
          '<span class="cal-dow">' + WEEKDAYS_LONG[d.getUTCDay()] + '</span>' +
          '<span class="cal-dnum">' + d.getUTCDate() + '</span>' +
          '<span class="cal-mon">' + MONTHS_LONG[d.getUTCMonth()] + '</span></div>' +
          '<div class="cal-body">';
        lastDate = it.date;
      }
      var key = scheduleItemKey(it);
      var isNext = calView.nextKeys.indexOf(key) >= 0;
      var isRecent = calView.recentKeys.indexOf(key) >= 0;
      html += it.kind === "ko" ? calKoRow(ctx.resolved[it.m.m], isNext, isRecent)
                               : calGroupRow(it, isNext, isRecent);
    });
    if (lastDate !== null) html += '</div></div>';
    html += '</div></div></div>';
    viewEl.innerHTML = html;
    updateNextCountdown();

    if (calScrollPending) {
      calScrollPending = false;
      if (calView.scrollTop) scrollCalendarTop();
      else scrollCalendarToDate(calView.scrollDate);
    }
    if (calGroupOpen) renderCalGroupPopup();
  }

  function hideCalGroupPopup() {
    calGroupOpen = null;
    renderCalGroupPopup();
  }

  function openCalGroupPopup(L) {
    calGroupOpen = L;
    renderCalGroupPopup();
  }

  function renderCalGroupPopup() {
    var popup = document.getElementById("calGroupPopup");
    var backdrop = document.getElementById("calGroupBackdrop");
    if (!popup || !backdrop) return;
    if (!calGroupOpen) {
      popup.classList.remove("open");
      backdrop.classList.remove("open");
      popup.innerHTML = "";
      return;
    }
    var ctx = getCtx();
    var L = calGroupOpen;
    var thirdQ = isThirdQ(ctx, L);
    popup.innerHTML =
      '<div class="cal-group-head">' +
        "<h3>Grupp " + L + "</h3>" +
        '<button type="button" class="cal-group-close" id="calGroupClose" title="Stäng">×</button>' +
      "</div>" +
      '<table class="standings mini"><thead><tr>' +
        '<th class="c-pos">#</th><th class="c-team">Lag</th>' +
        "<th>S</th><th>V</th><th>O</th><th>F</th><th>Mål</th><th>+/-</th>" +
        '<th class="c-pts">P</th>' +
      "</tr></thead><tbody>" +
      standingsRows(ctx.tables[L], { thirdQualified: thirdQ }) +
      "</tbody></table>";
    popup.classList.add("open");
    backdrop.classList.add("open");
  }

  function calRowClass(isNext, isRecent, extra) {
    var cls = "cal-row";
    if (extra) cls += " " + extra;
    if (isNext) cls += " is-next";
    else if (isRecent) cls += " is-recent";
    return cls;
  }

  function calVenueCell(channel, isNext) {
    var tv = channel ? tvChHtml(channel) : "";
    return '<span class="cal-venue">' +
      (isNext ? '<span class="cal-next">Nästa</span>' : '<span class="cal-next cal-next-slot" aria-hidden="true">Nästa</span>') +
      (tv || '<span class="cal-tv cal-tv-empty" aria-hidden="true"></span>') +
      "</span>";
  }

  function calGroupRow(it, isNext, isRecent) {
    var L = it.letter, fx = it.fx;
    var th = WC.groups[L][fx.h], ta = WC.groups[L][fx.a];
    var r = getRes(fx.key) || {};
    var played = isPlayed(r);
    var when = whenLabels(fx);
    var live = isMatchLive(fx.key);
    var score = (played || live) ? '<span class="cal-score">' + (r.h || 0) + '–' + (r.a || 0) + '</span>'
                       : '<span class="cal-vs">–</span>';
    return '<div class="' + calRowClass(isNext, isRecent, live ? "is-live" : "") + '">' +
      '<span class="cal-time">' + (live ? liveTimeLabel(fx.key, when.time) : when.time) + '</span>' +
      '<button type="button" class="cal-badge grp cal-group-btn" data-cal-group="' + L + '">Grupp ' + L + '</button>' +
      '<span class="cal-match">' + teamOpenBtn(th, '<span title="' + esc(th.sv) + '">' + esc(teamSvFixture(th)) + '</span>' + flagImg(th.iso), "cal-side home") +
        score +
        teamOpenBtn(ta, flagImg(ta.iso) + '<span title="' + esc(ta.sv) + '">' + esc(teamSvFixture(ta)) + '</span>', "cal-side away") + '</span>' +
      calVenueCell(tvLookupGroup(fx, th, ta), isNext) +
      '</div>';
  }

  var CAL_ROUND = { R32: "S16", R16: "Å16", QF: "Kvarts", SF: "Semi", "3RD": "Brons", FINAL: "Final" };

  function calKoRow(res, isNext, isRecent) {
    var m = res.match;
    var when = whenLabels(m);
    var r = getRes("k:" + m.m) || res.result || {};
    var played = isPlayed(r);
    var hProv = res.home.team && !res.home.decided;
    var aProv = res.away.team && !res.away.decided;
    var hName = res.home.team ? esc(bracketTeamName(res.home)) : '<i>' + esc(res.home.label) + '</i>';
    var aName = res.away.team ? esc(bracketTeamName(res.away)) : '<i>' + esc(res.away.label) + '</i>';
    var hFlag = res.home.team ? flagImg(res.home.team.iso) : "";
    var aFlag = res.away.team ? flagImg(res.away.team.iso) : "";
    var live = isMatchLive("k:" + m.m);
    var score = (played || live) ? '<span class="cal-score">' + (r.h || 0) + '–' + (r.a || 0) +
      (played && r.h === r.a && r.pw ? '<sup>S</sup>' : '') + '</span>' : '<span class="cal-vs">–</span>';
    var hHome = res.home.team
      ? teamOpenBtn(res.home.team, hName + hFlag, "cal-side home" + (hProv ? " prov" : ""))
      : '<span class="cal-side home' + (hProv ? " prov" : "") + '">' + hName + hFlag + '</span>';
    var hAway = res.away.team
      ? teamOpenBtn(res.away.team, aFlag + aName, "cal-side away" + (aProv ? " prov" : ""))
      : '<span class="cal-side away' + (aProv ? " prov" : "") + '">' + aFlag + aName + '</span>';
    return '<div class="' + calRowClass(isNext, isRecent, "ko" + (live ? " is-live" : "")) + '" data-m="' + m.m + '">' +
      '<span class="cal-time">' + (live ? liveTimeLabel("k:" + m.m, when.time) : when.time) + '</span>' +
      '<span class="cal-badge ' + m.round + '">' + (CAL_ROUND[m.round] || m.round) + ' · M' + m.m + '</span>' +
      '<span class="cal-match">' + hHome + score + hAway + '</span>' +
      calVenueCell(tvLookupKo(m), isNext) +
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
        kind: "ko", date: res.match.date, edt: res.match.edt, m: res.match,
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
    var playedMatches = matches.filter(function (mm) { return mm.played && mm.home && mm.away; }).reverse();
    var upcomingMatches = matches.filter(function (mm) { return !mm.played && mm.home && mm.away; });

    var h = '<div class="drawer-head">' +
      '<span class="dh-flag">' + flagImg(team.iso) + '</span>' +
      '<div class="dh-title"><h3>' + esc(team.sv) + '</h3>' +
        '<span class="dh-sub">' + esc(team.name) + ' · Grupp ' + L + '</span></div>' +
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
        return '<tr class="' + cls + '" data-team="' + s.team.iso + '"><td class="c-pos">' + (i + 1) + '</td>' +
          '<td class="c-team"><span class="team">' + flagImg(s.team.iso) + '<span class="t-name">' + esc(s.team.sv) + '</span></span></td>' +
          '<td>' + s.pld + '</td><td class="c-pts">' + s.pts + '</td>' +
          '<td>' + (s.gd > 0 ? "+" + s.gd : s.gd) + '</td></tr>';
      }).join("") + '</tbody></table></div>';

    // Spelade matcher (hela mästerskapet, senaste först)
    h += '<div class="drawer-card"><div class="dc-title">Spelade matcher</div>';
    if (playedMatches.length) {
      playedMatches.forEach(function (mm) { h += teamMatchRow(team, mm, false); });
    } else {
      h += '<div class="dc-empty">Inga matcher spelade ännu.</div>';
    }
    h += '</div>';

    // Kommande matcher
    h += '<div class="drawer-card"><div class="dc-title">Spelschema</div>';
    if (upcomingMatches.length) {
      upcomingMatches.forEach(function (mm) { h += teamMatchRow(team, mm, false); });
    } else {
      h += '<div class="dc-empty">Inga kommande matcher kvar.</div>';
    }
    h += '</div>';

    h += '</div>';
    drawer.innerHTML = h;
    drawer.classList.add("open");
    document.getElementById("drawerBackdrop").classList.add("open");

    // Hook: låter live-modulen (assets/live.js) injicera spelarlista + statistik.
    if (window.VMLive && typeof window.VMLive.onTeamDrawer === "function") {
      try { window.VMLive.onTeamDrawer(team, L, drawer); } catch (e) {}
    }
  }

  function statBox(label, val) {
    return '<div class="stat-box"><span class="sb-val">' + esc("" + val) + '</span><span class="sb-lbl">' + label + '</span></div>';
  }

  function teamMatchRow(team, mm, big) {
    var opp = mm.isHome ? mm.away : mm.home;
    var when = whenLabels(mm.m);
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

    // Hovern äger enbart "var spelas matchen" – tid och lag visas redan i rutan.
    var h = '<div class="tip-head"><b>' + WC.roundNames[m.round] + '</b> · Match ' + m.m + '</div>';
    h += '<div class="tip-row"><span>📍</span>' + esc(v.stadium) + ', ' + esc(v.city) + ' (' + esc(v.country) + ')</div>';
    h += '<div class="tip-row tip-dim"><span>🏟️</span>' + esc(v.real) + '</div>';

    tipEl.innerHTML = h;
    tipEl.classList.add("show");
    positionTip(x, y);
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
     EVENT-HANTERING
  ==================================================================== */

  function onInput(e) {
    if (e.target.id === "teamSearch") renderSearchResults(e.target.value);
  }

  function onClick(e) {
    var t = e.target;
    var nav = t.closest && t.closest("[data-nav]");
    if (nav) {
      var v = nav.getAttribute("data-nav");
      if (v === "calendar") calScrollPending = true;
      if (v !== "calendar") hideCalGroupPopup();
      setUi("view", v);
      hoverMatch = null;
      render();
      return;
    }
    var sr = t.closest && t.closest(".sr-item");
    if (sr) { openTeam(sr.getAttribute("data-team-group"), parseInt(sr.getAttribute("data-team-idx"), 10)); return; }

    var brCol = t.closest && t.closest("[data-bracket-col]");
    if (brCol) {
      centerBracketColumn(brCol.getAttribute("data-bracket-col"), brCol);
      return;
    }

    if (t.id === "drawerClose" || t.id === "drawerBackdrop") { closeTeam(); return; }
    if (t.id === "calGroupClose" || t.id === "calGroupBackdrop") { hideCalGroupPopup(); return; }
    if (t.id === "asideClose") { hoverMatch = null; hideAside(); syncExpandButtons(); return; }

    var calGrp = t.closest && t.closest("[data-cal-group]");
    if (calGrp) {
      var gL = calGrp.getAttribute("data-cal-group");
      if (calGroupOpen === gL) hideCalGroupPopup();
      else openCalGroupPopup(gL);
      return;
    }

    var exp = t.closest && t.closest("[data-expand-match]");
    if (exp) {
      var mno = parseInt(exp.getAttribute("data-expand-match"), 10);
      hoverMatch = hoverMatch === mno ? null : mno;
      if (hoverMatch) updateAside(hoverMatch, getCtx());
      else hideAside();
      syncExpandButtons();
      return;
    }

    var tg = t.closest && t.closest("[data-toggle-group]");
    if (tg) { var L = tg.getAttribute("data-toggle-group"); expandedGroups[L] = !expandedGroups[L]; render(); return; }

    // klick på lag → öppna statistikflik (alla vyer)
    var teamEl = t.closest && t.closest("[data-team-open]");
    if (teamEl) {
      openTeamByIso(teamEl.getAttribute("data-team-open"));
      return;
    }
    var trow = t.closest && t.closest("tr[data-team]");
    if (trow) {
      openTeamByIso(trow.getAttribute("data-team"));
      return;
    }
  }

  function onOver(e) {
    var mc = e.target.closest && e.target.closest("[data-m]");
    if (mc) {
      var no = parseInt(mc.getAttribute("data-m"), 10);
      showTip(no, e.clientX, e.clientY);
    }
  }
  function onMove(e) {
    if (tipEl.classList.contains("show")) positionTip(e.clientX, e.clientY);
  }
  function onOut(e) {
    var mc = e.target.closest && e.target.closest("[data-m]");
    if (mc && (!e.relatedTarget || !e.relatedTarget.closest || !e.relatedTarget.closest("[data-m]"))) {
      hideTip();
    }
  }

  function onDocClick(e) {
    if (!e.target.closest || !e.target.closest(".search")) {
      var box = document.getElementById("searchResults");
      if (box) { box.hidden = true; }
    }
    if (hoverMatch && ui("view", "groups") === "bracket") {
      var inside = e.target.closest && (e.target.closest("#bracketAside") || e.target.closest("[data-expand-match]"));
      if (!inside) {
        hoverMatch = null;
        hideAside();
        syncExpandButtons();
      }
    }
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

    var calGroupBackdrop = document.createElement("div");
    calGroupBackdrop.id = "calGroupBackdrop";
    calGroupBackdrop.className = "cal-group-backdrop";
    document.body.appendChild(calGroupBackdrop);
    var calGroupPopup = document.createElement("div");
    calGroupPopup.id = "calGroupPopup";
    calGroupPopup.className = "cal-group-popup";
    document.body.appendChild(calGroupPopup);

    var aside = document.createElement("aside"); aside.id = "bracketAside"; aside.className = "bracket-aside";
    document.body.appendChild(aside);
    document.body.addEventListener("input", onInput);
    document.body.addEventListener("click", onClick);
    document.addEventListener("click", onDocClick);
    viewEl.addEventListener("mouseover", onOver);
    viewEl.addEventListener("mousemove", onMove);
    viewEl.addEventListener("mouseout", onOut);

    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") {
        closeTeam(); hideTip();
        hideCalGroupPopup();
        if (hoverMatch) { hoverMatch = null; hideAside(); syncExpandButtons(); }
      }
    });

    // Realtid: synk mellan flikar + nedräkningar
    window.addEventListener("storage", function (e) {
      if (e.key === STORE_KEY) { state = loadState(); refresh(); }
    });
    setInterval(refresh, 30000); // uppdatera "om X / Pågår" m.m.
    countdownTimer = setInterval(function () {
      var view = ui("view", "groups");
      if (view === "groups" || view === "calendar") updateNextCountdown();
    }, 1000);

    var bracketLineTimer;
    window.addEventListener("resize", function () {
      if (ui("view", "groups") !== "bracket") return;
      clearTimeout(bracketLineTimer);
      bracketLineTimer = setTimeout(drawBracketConnectors, 120);
    });

    var heroStickyTimer;
    window.addEventListener("resize", function () {
      clearTimeout(heroStickyTimer);
      heroStickyTimer = setTimeout(updateHeroSticky, 80);
    });
    window.addEventListener("load", updateHeroSticky);
    window.addEventListener("scroll", syncHeaderCompact, { passive: true });

    window.addEventListener("wheel", function (e) {
      if (ui("view", "groups") !== "bracket") return;
      var sc = viewEl.querySelector(".bracket-scroll");
      if (e.deltaY > 2) setBracketHeroCollapsed(true);
      else if (e.deltaY < -2 && (!sc || sc.scrollTop <= 0)) setBracketHeroCollapsed(false);
    }, { passive: true });

    if (ui("view", "groups") === "calendar") calScrollPending = true;
    render();
    updateSyncBadge();
  }

  window.VMApp = { mergeRemoteResults: mergeRemoteResults, setSyncStatus: setSyncStatus, autoSync: autoSync };

  document.addEventListener("DOMContentLoaded", init);
})();
