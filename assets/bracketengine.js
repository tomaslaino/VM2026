/* Slutspelsmotor (HELA trädet) – Monte Carlo som ersätter den servergenererade
 * data/bracket_probs.json med en lokal beräkning på DIN data.
 *
 * Per simulering: alla 12 grupptabeller räknas om ur exakt-resultatodds med
 * FIFA:s 2026-tiebreakers (inbördes först), de 8 bästa treorna placeras enligt
 * Annex C, R32 fylls enligt det officiella trädet (bracket_map) och slutspelet
 * spelas av R16→final där varje match avgörs av lagens styrka (ur vinnarodds,
 * logistisk med K) – samma matchmodell som det tidigare Python-verktyget, men
 * nu byggd ovanpå den korrekta gruppgrunden.
 *
 * Utdata har EXAKT samma form som bracket_probs.json (nodes/rounds/
 * groupPositions/slotLabels) så att resten av UI:t fungerar oförändrat.
 *
 * Determinism: seedad RNG → samma indata ger samma utdata. Körs i Web Worker
 * (assets/bracketworker.js) eller på huvudtråden, samt i Node för tester.
 */
(function (root) {
  "use strict";

  var GROUPS = "ABCDEFGHIJKL".split("");
  var ROUND_ORDER = ["r32", "r16", "qf", "sf", "final"];
  var ROUND_TEAMS = { r32: 32, r16: 16, qf: 8, sf: 4, final: 2 };

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function poisson(rng, lambda) {
    var L = Math.exp(-lambda), k = 0, p = 1;
    do { k++; p *= rng(); } while (p > L);
    return Math.min(k - 1, 8);
  }

  // ---- grupptabell + FIFA 2026-tiebreakers (identiska med r32engine) -------
  function computeOrder(group, results, fifa) {
    var stats = [0, 1, 2, 3].map(function (idx) {
      return { idx: idx, pts: 0, gf: 0, ga: 0, gd: 0 };
    });
    for (var r = 0; r < results.length; r++) {
      var i = results[r][0], j = results[r][1], gi = results[r][2], gj = results[r][3];
      stats[i].gf += gi; stats[i].ga += gj;
      stats[j].gf += gj; stats[j].ga += gi;
      if (gi > gj) stats[i].pts += 3;
      else if (gj > gi) stats[j].pts += 3;
      else { stats[i].pts += 1; stats[j].pts += 1; }
    }
    for (var s = 0; s < 4; s++) stats[s].gd = stats[s].gf - stats[s].ga;
    return { order: orderIdxs([0, 1, 2, 3], stats, results, fifa, group), stats: stats };
  }
  function orderIdxs(idxs, stats, results, fifa, group) {
    idxs = idxs.slice().sort(function (a, b) { return stats[b].pts - stats[a].pts; });
    var out = [], i = 0;
    while (i < idxs.length) {
      var j = i;
      while (j < idxs.length && stats[idxs[j]].pts === stats[idxs[i]].pts) j++;
      var run = idxs.slice(i, j);
      if (run.length === 1) out.push(run[0]);
      else resolveTie(run, stats, results, fifa, group).forEach(function (x) { out.push(x); });
      i = j;
    }
    return out;
  }
  function h2hStats(idxs, results) {
    var s = {}, set = {};
    idxs.forEach(function (x) { s[x] = { pts: 0, gd: 0, gf: 0 }; set[x] = true; });
    for (var r = 0; r < results.length; r++) {
      var i = results[r][0], j = results[r][1], gi = results[r][2], gj = results[r][3];
      if (!set[i] || !set[j]) continue;
      s[i].gf += gi; s[i].gd += gi - gj;
      s[j].gf += gj; s[j].gd += gj - gi;
      if (gi > gj) s[i].pts += 3;
      else if (gj > gi) s[j].pts += 3;
      else { s[i].pts += 1; s[j].pts += 1; }
    }
    return s;
  }
  function resolveTie(idxs, stats, results, fifa, group) {
    var h = h2hStats(idxs, results);
    var ordered = idxs.slice().sort(function (a, b) {
      return (h[b].pts - h[a].pts) || (h[b].gd - h[a].gd) || (h[b].gf - h[a].gf);
    });
    var runs = [], i = 0;
    var key = function (x) { return h[x].pts + "/" + h[x].gd + "/" + h[x].gf; };
    while (i < ordered.length) {
      var j = i;
      while (j < ordered.length && key(ordered[j]) === key(ordered[i])) j++;
      runs.push(ordered.slice(i, j));
      i = j;
    }
    if (runs.length === 1) return orderByOverall(idxs, stats, fifa, group);
    var out = [];
    runs.forEach(function (run) {
      (run.length === 1 ? run : resolveTie(run, stats, results, fifa, group))
        .forEach(function (x) { out.push(x); });
    });
    return out;
  }
  function orderByOverall(idxs, stats, fifa, group) {
    return idxs.slice().sort(function (a, b) {
      return (stats[b].gd - stats[a].gd) || (stats[b].gf - stats[a].gf) ||
        (fifa[group][a] - fifa[group][b]);
    });
  }

  // ---- bästa 8 treor -> Annex C-tilldelning --------------------------------
  function bestEight(thirdRows, annexC) {
    var thirds = thirdRows.slice().sort(function (a, b) {
      return (b.pts - a.pts) || (b.gd - a.gd) || (b.gf - a.gf) || (a.fifa - b.fifa);
    });
    var g8 = thirds.slice(0, 8).map(function (t) { return t.g; }).sort();
    return annexC[g8.join("")] || null;
  }

  // ---- slutspelsstyrka: outright-styrka + måltempo ur dina målodds ---------
  // Gruppmatcher länkar bara lag INOM en grupp, så målodds kan INTE jämföra lag
  // mellan grupper (ett lag som dominerar en svag grupp ser falskt elitartat ut).
  // Därför: lagets ÖVERGRIPANDE styrka (netto n_t) kommer ur outrightmarknaden –
  // den enda giltiga korsgrupps-signalen – medan dina målodds ger målmiljön (μ0)
  // och varje lags TEMPO (hur målrika dess matcher väntas bli). Resultatet:
  //   a_t = (n_t + s_t)/2,  d_t = (s_t − n_t)/2,  λ_{X mot Y} = μ0·exp(a_X + d_Y)
  // dvs nettoskillnaden (n) avgör vem som är favorit, tempot (s) hur många mål
  // (vilket styr andelen oavgjort → förlängning/straffar). Poisson-strukturen
  // ger realistiska, mindre branta utfall än en ren logistisk styrkemodell.
  function fitRatings(matches, strength, strScale, paceScale) {
    var teams = {};
    matches.forEach(function (m) { teams[m.home] = 1; teams[m.away] = 1; });
    var ids = Object.keys(teams);
    var sum = 0, cnt = 0;
    matches.forEach(function (m) { sum += m.muH + m.muA; cnt += 2; });
    var mu0 = cnt ? sum / cnt : 1.3;

    var tot = {}, num = {};
    ids.forEach(function (t) { tot[t] = 0; num[t] = 0; });
    matches.forEach(function (m) { var T = m.muH + m.muA; tot[m.home] += T; num[m.home]++; tot[m.away] += T; num[m.away]++; });

    var gv = [];
    ids.forEach(function (t) { if (strength[t] != null) gv.push(strength[t]); });
    var gm = 0; gv.forEach(function (v) { gm += v; }); gm /= (gv.length || 1);
    var gsd = 0; gv.forEach(function (v) { gsd += (v - gm) * (v - gm); }); gsd = Math.sqrt(gsd / (gv.length || 1)) || 1;

    var STR = strScale != null ? strScale : 0.7;    // netto-log-mål per sd outrightstyrka
    var PACE = paceScale != null ? paceScale : 0.5;  // hur mycket tempo ur målodds slår igenom
    var a = {}, d = {};
    ids.forEach(function (t) {
      var n = STR * (strength[t] != null ? (strength[t] - gm) / gsd : 0);
      var Pt = num[t] ? tot[t] / num[t] : 2 * mu0;
      var s = PACE * 0.5 * (Math.log(Math.max(0.2, Pt)) - Math.log(2 * mu0));
      if (s > 0.4) s = 0.4; else if (s < -0.4) s = -0.4;   // håll tempot rimligt
      a[t] = (n + s) / 2; d[t] = (s - n) / 2;
    });
    return { a: a, d: d, mu0: mu0 };
  }

  // ---- aggregerings-helpers ------------------------------------------------
  function dist(counter, n) {
    var arr = Object.keys(counter).map(function (t) { return [t, counter[t]]; });
    arr.sort(function (a, b) { return b[1] - a[1]; });
    var o = {};
    for (var i = 0; i < arr.length; i++) {
      var p = arr[i][1] / n;
      if (p >= 0.001) o[arr[i][0]] = Math.round(p * 1e4) / 1e4;
    }
    return o;
  }
  function bump(counter, key) { if (key != null) counter[key] = (counter[key] || 0) + 1; }

  // ---- huvudfunktion -------------------------------------------------------
  function compute(input) {
    var n = input.n || 40000;
    var rng = mulberry32(input.seed || 0x9e3779b9);
    var names = input.groups;            // { L: [name x4] }
    var fifa = input.fifa;               // { L: [rank x4] }
    var annexC = input.annexC, annexSlots = input.annexSlots;
    var order = input.order;             // 32 specer (bracket_map.order)
    var labels = input.labels;           // 32 koder (bracket_map.labels)
    var strength = input.strength || {}; // { name: rating }
    var K = input.K != null ? input.K : 0.6;
    var minStr = input.minStrength;
    if (minStr == null) {
      var vals = Object.keys(strength).map(function (k) { return strength[k]; });
      minStr = (vals.length ? Math.min.apply(null, vals) : 0) - 1;
    }
    function S(name) { return strength[name] != null ? strength[name] : minStr; }
    function winA(a, b) { return 1 / (1 + Math.exp(-K * (S(a) - S(b)))); }

    // Slutspelsmatchmodell. Med ratingMatches: realistiska Poisson-mål ur DIN
    // attack/försvar-modell + förlängning och straffar vid oavgjort. Annars
    // faller den tillbaka på den enkla logistiska styrkemodellen (K).
    var R = input.ratingMatches && input.ratingMatches.length ? fitRatings(input.ratingMatches, strength, input.koStrScale, input.koPaceScale) : null;

    function matchWinnerModel(x, y) {
      if (R) {
        var ax = R.a[x] || 0, dx = R.d[x] || 0, ay = R.a[y] || 0, dy = R.d[y] || 0;
        var lamX = R.mu0 * Math.exp(ax + dy), lamY = R.mu0 * Math.exp(ay + dx);
        var gx = poisson(rng, lamX), gy = poisson(rng, lamY);
        if (gx === gy) { gx += poisson(rng, lamX / 3); gy += poisson(rng, lamY / 3); }
        if (gx === gy) { var p = 0.5 + 0.10 * Math.tanh((ax - dx) - (ay - dy)); return rng() < p ? [x, y] : [y, x]; }
        return gx > gy ? [x, y] : [y, x];
      }
      return rng() < winA(x, y) ? [x, y] : [y, x];
    }

    function tryKoMarket(x, y, engineRi, pairIdx) {
      var orders = input.koPlayOrders, koOdds = input.koOdds;
      if (!orders || !koOdds || engineRi == null || pairIdx == null) return null;
      var row = orders[engineRi];
      if (!row) return null;
      var mno = row[pairIdx];
      if (!mno) return null;
      var ko = koOdds["k:" + mno];
      if (!ko) return null;
      if (x !== ko.home && x !== ko.away) return null;
      if (y !== ko.home && y !== ko.away) return null;
      if (ko.finished && ko.winner) return ko.winner === x ? [x, y] : [y, x];
      if (!ko.rp) return null;
      var xHome = ko.home === x;
      var pX = xHome ? ko.rp["1"] : ko.rp["2"];
      var pY = xHome ? ko.rp["2"] : ko.rp["1"];
      var pD = ko.rp["X"] || 0;
      var tot = pX + pY + pD;
      if (tot <= 0) return null;
      pX /= tot; pY /= tot; pD /= tot;
      if (ko.live && ko.oddsContext === "prematch") {
        var lead = ko.live.h - ko.live.a;
        if (xHome && lead > 0) pX = Math.min(0.98, pX + 0.08 * lead);
        if (xHome && lead < 0) pX = Math.max(0.02, pX + 0.08 * lead);
        if (!xHome && lead < 0) pX = Math.min(0.98, pX + 0.08 * (-lead));
        if (!xHome && lead > 0) pX = Math.max(0.02, pX - 0.08 * lead);
        tot = pX + pY + pD;
        pX /= tot; pY /= tot; pD /= tot;
      }
      var u = rng();
      if (u < pX) return [x, y];
      if (u < pX + pD) return matchWinnerModel(x, y);
      return [y, x];
    }

    function matchWinner(x, y, engineRi, pairIdx) {
      if (x == null) return [y, x];
      if (y == null) return [x, y];
      var mk = tryKoMarket(x, y, engineRi, pairIdx);
      if (mk) return mk;
      return matchWinnerModel(x, y);
    }

    // ---- förbered matcher per grupp -------------------------------------
    var byGroup = {}; GROUPS.forEach(function (g) { byGroup[g] = []; });
    (input.played || []).forEach(function (p) {
      byGroup[p.g].push({ kind: "fixed", i: p.i, j: p.j, gi: p.gi, gj: p.gj });
    });

    var samples = {};
    (input.oddsGames || []).forEach(function (m) {
      var h = new Int16Array(n), a = new Int16Array(n), scores = m.scores;
      // Pågående match: lås ställning. Pre-match-odds → Poisson på resterande tid;
      // inplay-odds → villkorad sampling ur marknadens score-linjer.
      if (m.live) {
        if (m.live.mode === "inplay") {
          var ch = m.live.h, ca = m.live.a;
          var allow = scores.map(function (s) { return s.h >= ch && s.a >= ca; });
          var tot = 0, k;
          for (k = 0; k < scores.length; k++) if (allow[k]) tot += scores[k].p;
          if (tot <= 0) {
            allow = scores.map(function () { return true; });
            tot = 0;
            for (k = 0; k < scores.length; k++) tot += scores[k].p;
          }
          var cum = [], acc = 0;
          for (k = 0; k < scores.length; k++) {
            if (!allow[k]) { cum.push(-1); continue; }
            acc += scores[k].p / tot; cum.push(acc);
          }
          for (var lr = 0; lr < n; lr++) {
            var u = rng(), pick = scores.length - 1;
            for (var c = 0; c < cum.length; c++) { if (cum[c] >= 0 && u <= cum[c]) { pick = c; break; } }
            h[lr] = scores[pick].h; a[lr] = scores[pick].a;
          }
        } else {
          for (var lr2 = 0; lr2 < n; lr2++) {
            h[lr2] = m.live.h + poisson(rng, m.live.lamH);
            a[lr2] = m.live.a + poisson(rng, m.live.lamA);
          }
        }
        samples[m.id] = { h: h, a: a };
        byGroup[m.g].push({ kind: "sample", sid: m.id, i: m.i, j: m.j });
        return;
      }
      var allow = scores.map(function () { return true; });
      if (m.fixed) {
        if (m.fixed[0] === "score") {
          allow = scores.map(function (s) { return s.h === m.fixed[1] && s.a === m.fixed[2]; });
        } else if (m.fixed[0] === "result") {
          var rr = m.fixed[1];
          allow = scores.map(function (s) {
            var d = s.h - s.a; return rr === "1" ? d > 0 : rr === "X" ? d === 0 : d < 0;
          });
        }
      }
      var tot = 0, k;
      for (k = 0; k < scores.length; k++) if (allow[k]) tot += scores[k].p;
      if (tot <= 0) { allow = scores.map(function () { return true; }); tot = 0; for (k = 0; k < scores.length; k++) tot += scores[k].p; }
      var cum = [], acc = 0;
      for (k = 0; k < scores.length; k++) { if (!allow[k]) { cum.push(-1); continue; } acc += scores[k].p / tot; cum.push(acc); }
      for (var r = 0; r < n; r++) {
        var u = rng(), pick = scores.length - 1;
        for (var c = 0; c < cum.length; c++) { if (cum[c] >= 0 && u <= cum[c]) { pick = c; break; } }
        h[r] = scores[pick].h; a[r] = scores[pick].a;
      }
      samples[m.id] = { h: h, a: a };
      byGroup[m.g].push({ kind: "sample", sid: m.id, i: m.i, j: m.j });
    });

    var neutralSamples = [];
    (input.neutral || []).forEach(function (g) {
      var hh = new Int16Array(n), aa = new Int16Array(n);
      for (var r = 0; r < n; r++) { hh[r] = poisson(rng, 1.25); aa[r] = poisson(rng, 1.25); }
      neutralSamples.push({ h: hh, a: aa });
      byGroup[g.g].push({ kind: "neutral", ref: neutralSamples.length - 1, i: g.i, j: g.j });
    });

    // ---- räknare --------------------------------------------------------
    var posCount = {}; ROUND_ORDER.forEach(function (rnd) {
      posCount[rnd] = []; for (var i = 0; i < ROUND_TEAMS[rnd]; i++) posCount[rnd].push({});
    });
    var bronzeCount = [{}, {}];
    var reached = {}, champ = {}, groupPos = {};
    function ensureTeam(t) {
      if (!reached[t]) { reached[t] = { r32: 0, r16: 0, qf: 0, sf: 0, final: 0 }; champ[t] = 0; groupPos[t] = { 1: 0, 2: 0, 3: 0, 4: 0 }; }
    }
    GROUPS.forEach(function (g) { names[g].forEach(ensureTeam); });

    // ---- fokuslag: motståndare i varje runda (Slutspelskalkylatorn) --------
    // För ett valt lag spårar vi, i varje simulering där laget fortfarande är
    // kvar, vilket lag det möter i resp. match (sextondel→final). Aggregerat ger
    // det "vem möter du om du tar dig hit"-fördelningen som kalkylatorn ritar.
    var focalName = input.focalTeam || null;
    var focalOpp = null, focalReach = null, focalGroup = null;
    if (focalName) {
      focalOpp = { r32: {}, r16: {}, qf: {}, sf: {}, final: {} };
      focalReach = { r32: 0, r16: 0, qf: 0, sf: 0, final: 0 };
      GROUPS.forEach(function (g) { if (names[g].indexOf(focalName) !== -1) focalGroup = g; });
    }
    function recFocal(stage, arr) {
      for (var i = 0; i < arr.length; i++) {
        if (arr[i] === focalName) {
          focalReach[stage]++;
          bump(focalOpp[stage], (i % 2 === 0) ? arr[i + 1] : arr[i - 1]);
          return;
        }
      }
    }

    var resultsBuf = {}; GROUPS.forEach(function (g) { resultsBuf[g] = []; });

    for (var run = 0; run < n; run++) {
      var standings = {};       // L -> [name x4] i sluttabellsordning
      var thirdRows = [];
      for (var gi = 0; gi < GROUPS.length; gi++) {
        var g = GROUPS[gi], games = byGroup[g], rb = resultsBuf[g]; rb.length = 0;
        for (var t = 0; t < games.length; t++) {
          var gm = games[t];
          if (gm.kind === "fixed") rb.push([gm.i, gm.j, gm.gi, gm.gj]);
          else if (gm.kind === "sample") { var sp = samples[gm.sid]; rb.push([gm.i, gm.j, sp.h[run], sp.a[run]]); }
          else { var np = neutralSamples[gm.ref]; rb.push([gm.i, gm.j, np.h[run], np.a[run]]); }
        }
        var co = computeOrder(g, rb, fifa);
        var ord = co.order, snames = new Array(4);
        for (var p = 0; p < 4; p++) {
          var idx = ord[p], nm = names[g][idx];
          snames[p] = nm;
          groupPos[nm][p + 1]++;
        }
        standings[g] = snames;
        var t3idx = ord[2], s3 = co.stats[t3idx];
        thirdRows.push({ g: g, pts: s3.pts, gd: s3.gd, gf: s3.gf, fifa: fifa[g][t3idx] });
      }

      var assignment = bestEight(thirdRows, annexC);
      var slotThird = {};
      if (assignment) for (var ai = 0; ai < assignment.length; ai++) slotThird[annexSlots[ai]] = assignment.charAt(ai);

      // fyll R32 enligt officiellt träd
      var r32 = new Array(32);
      for (var oi = 0; oi < 32; oi++) {
        var spec = order[oi], team = null;
        if (spec.kind === "dir") team = standings[spec.code.slice(1)][+spec.code.charAt(0) - 1];
        else { var tg = slotThird[spec.slot]; team = tg ? standings[tg][2] : null; }
        r32[oi] = team;
      }

      // tally + spela av
      var cur = r32;
      for (var qi = 0; qi < 32; qi++) { bump(posCount.r32[qi], cur[qi]); if (cur[qi] != null) reached[cur[qi]].r32++; }
      if (focalName) recFocal("r32", cur);
      var sfLosers = null;
      for (var ri = 1; ri < ROUND_ORDER.length; ri++) {
        var rnd = ROUND_ORDER[ri], nxt = new Array(cur.length / 2), losers = [];
        for (var m = 0; m < cur.length; m += 2) {
          var wl = matchWinner(cur[m], cur[m + 1], ri, m / 2), w = wl[0], l = wl[1];
          nxt[m / 2] = w; losers.push(l);
          bump(posCount[rnd][m / 2], w); if (w != null) reached[w][rnd]++;
        }
        if (rnd === "final") sfLosers = losers;
        cur = nxt;
        if (focalName) recFocal(rnd, cur);
      }
      // brons (förlorarna i de två semifinalerna) + mästare
      if (sfLosers) { bump(bronzeCount[0], sfLosers[0]); bump(bronzeCount[1], sfLosers[1]); }
      var ch = matchWinner(cur[0], cur[1], 5, 0)[0];
      if (ch != null) champ[ch]++;
    }

    // ---- bygg utdata ----------------------------------------------------
    var nodes = {};
    ROUND_ORDER.forEach(function (rnd) {
      nodes[rnd] = posCount[rnd].map(function (c) { return dist(c, n); });
    });
    nodes.bronze = [dist(bronzeCount[0], n), dist(bronzeCount[1], n)];

    var rounds = {}, groupPositions = {};
    Object.keys(reached).forEach(function (t) {
      rounds[t] = {
        r32: Math.round(reached[t].r32 / n * 1e4) / 1e4,
        r16: Math.round(reached[t].r16 / n * 1e4) / 1e4,
        qf: Math.round(reached[t].qf / n * 1e4) / 1e4,
        sf: Math.round(reached[t].sf / n * 1e4) / 1e4,
        final: Math.round(reached[t].final / n * 1e4) / 1e4,
        win: Math.round(champ[t] / n * 1e4) / 1e4
      };
      var gp = groupPos[t], go = {};
      for (var k = 1; k <= 4; k++) if (gp[k]) go[k] = Math.round(gp[k] / n * 1e4) / 1e4;
      groupPositions[t] = go;
    });

    var focal = null;
    if (focalName) {
      focal = { team: focalName, group: focalGroup };
      ROUND_ORDER.forEach(function (st) {
        var cnt = focalReach[st];
        focal[st] = {
          // sannolikhet att laget alls spelar den här matchen (= tar sig hit)
          reachP: Math.round(cnt / n * 1e4) / 1e4,
          // motståndarfördelning GIVET att laget tar sig hit (mest intuitivt i UI)
          opponents: cnt ? dist(focalOpp[st], cnt) : {},
          // motståndarfördelning över ALLA simuleringar (oförändrad bas)
          opponentsAbs: dist(focalOpp[st], n)
        };
      });
      focal.win = rounds[focalName] ? rounds[focalName].win : 0;
      focal.groupPositions = groupPositions[focalName] || {};
    }

    return {
      updated: input.updated || new Date().toISOString(),
      nSims: n,
      note: "Lokalt beräknad (assets/bracketengine.js) på exakt-resultatodds + FIFA 2026-tiebreakers.",
      slotLabels: { r32: labels },
      nodes: nodes,
      rounds: rounds,
      groupPositions: groupPositions,
      focal: focal
    };
  }

  // styrka ur vinnarodds: log(normaliserad implied vinstsannolikhet) (= Python)
  function strengthsFromOutrights(teams) {
    var inv = {}, z = 0;
    teams.forEach(function (r) { var v = 1 / r.avgOdds; inv[r.team] = v; z += v; });
    var out = {};
    Object.keys(inv).forEach(function (t) { out[t] = Math.log(inv[t] / z); });
    return out;
  }

  var api = { compute: compute, strengthsFromOutrights: strengthsFromOutrights };
  root.BracketEngine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : (typeof globalThis !== "undefined" ? globalThis : this));
