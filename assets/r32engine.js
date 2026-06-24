/* R32-motor: Monte Carlo-simulering av vilket lag man möter i sextondelsfinalen.
 *
 * Portad från det lokala Python-verktyget (gris.zip) till ren, beroendefri JS som
 * kör både i en Web Worker och på huvudtråden. För varje simulering samplas de
 * återstående gruppmatcherna ur sina exakta resultat-odds, alla 12 grupptabeller
 * räknas om med FIFA:s tiebreakers, de 8 bästa treorna placeras enligt Annex C och
 * det valda lagets motståndare i R32 läses av. Aggregerat över tusentals körningar
 * ger det, per möjlig motståndare, sannolikhet + implicita odds, samt hur mycket
 * varje återstående match påverkar chansen att slippa de tunga lagen.
 *
 * Determinism: samma indata ger samma utdata (seedad RNG) så att resultat kan
 * cachas och UI:t inte hoppar mellan identiska körningar.
 */
(function (root) {
  "use strict";

  // R32-routing från det officiella 2026-trädet (matcherna 73–88), verifierad mot
  // WC.knockout. "third" = gruppens etta möter en bästa trea (löses via Annex C).
  var WINNER_ROUTE = {
    A: ["third", null], B: ["third", null], D: ["third", null], E: ["third", null],
    G: ["third", null], I: ["third", null], K: ["third", null], L: ["third", null],
    C: ["runner", "F"], F: ["runner", "C"], H: ["runner", "J"], J: ["runner", "H"]
  };
  var RUNNER_ROUTE = {
    A: ["runner", "B"], B: ["runner", "A"], C: ["winner", "F"], F: ["winner", "C"],
    D: ["runner", "G"], G: ["runner", "D"], E: ["runner", "I"], I: ["runner", "E"],
    H: ["winner", "J"], J: ["winner", "H"], K: ["runner", "L"], L: ["runner", "K"]
  };
  var GROUPS = "ABCDEFGHIJKL".split("");

  // ---- seedad RNG (mulberry32) -------------------------------------------
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

  // ---- tabellberäkning med FIFA:s tiebreakers ----------------------------
  // results: lista av [i, j, gi, gj] (mål attribueras till lagindex, ej hemma/borta).
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

  // ---- en fullständig turnering -> motståndare ---------------------------
  function bestEight(tables, annexC) {
    var thirds = GROUPS.map(function (g) {
      var t = tables[g].rows[2];
      return { g: g, pts: t.pts, gd: t.gd, gf: t.gf, fifa: t.fifa };
    });
    thirds.sort(function (a, b) {
      return (b.pts - a.pts) || (b.gd - a.gd) || (b.gf - a.gf) || (a.fifa - b.fifa);
    });
    var g8 = thirds.slice(0, 8).map(function (t) { return t.g; }).sort();
    return { key: g8.join(""), assignment: annexC[g8.join("")] || null };
  }

  // returnerar { pos, label } – good/bad avgörs efter slingan utifrån avoid-mängden
  function resolveOpponent(tables, tg, ti, ctx) {
    var trow = null;
    for (var k = 0; k < 4; k++) if (tables[tg].rows[k].idx === ti) { trow = tables[tg].rows[k]; break; }
    var pos = trow.position;
    if (pos === 4) return { pos: 4, label: "Eliminated" };

    var winners = ctx.winners, runners = ctx.runners, names = ctx.names, annexSlots = ctx.annexSlots;
    function out(oppG, oppIdx) {
      if (oppG == null || oppIdx == null) return { pos: pos, label: "Eliminated" };
      return { pos: pos, label: names[oppG][oppIdx] };
    }

    if (pos === 1 || pos === 2) {
      var route = (pos === 1 ? WINNER_ROUTE : RUNNER_ROUTE)[tg];
      var kind = route[0], og = route[1];
      if (kind === "winner") return out(og, winners[og]);
      if (kind === "runner") return out(og, runners[og]);
      // kind === "third": gruppens etta möter den trea som tilldelats dess slot
      var be = bestEight(tables, ctx.annexC);
      if (!be.assignment) return out(null, null);
      var slotI = annexSlots.indexOf(tg);
      var thirdG = be.assignment.charAt(slotI);
      return out(thirdG, tables[thirdG].rows[2].idx);
    }

    // pos === 3
    var be2 = bestEight(tables, ctx.annexC);
    if (be2.key.indexOf(tg) === -1 || !be2.assignment) return { pos: 3, label: "Eliminated" };
    var slotIndex = be2.assignment.indexOf(tg);
    var wg = ctx.annexSlots[slotIndex];
    return out(wg, winners[wg]);
  }

  // ---- huvudfunktion ------------------------------------------------------
  function simulate(input) {
    var n = input.n || 12000;
    var seed = input.seed || 0x9e3779b9;
    var rng = mulberry32(seed);
    var names = input.groups;            // { L: [name x4] }
    var fifa = input.fifa;               // { L: [rank x4] }
    var annexC = input.annexC, annexSlots = input.annexSlots;
    var tg = input.teamG, ti = input.teamIdx;

    // bygg per-grupp listor av matcher att räkna in i tabellen
    // varje post: { kind:'fixed'|'sample', i, j, gi?,gj? , sid? }
    var byGroup = {}; GROUPS.forEach(function (g) { byGroup[g] = []; });
    (input.played || []).forEach(function (p) {
      byGroup[p.g].push({ kind: "fixed", i: p.i, j: p.j, gi: p.gi, gj: p.gj });
    });

    // sampla odds-matcher (de redigerbara, ospelade) en gång till en batch
    var samples = {};   // sid -> { h:Int16Array, a:Int16Array, i, j }
    var oddsMeta = [];  // för känslighetsanalys
    (input.oddsGames || []).forEach(function (m) {
      var h = new Int16Array(n), a = new Int16Array(n);
      var scores = m.scores;
      // bygg (ev. villkorad) sannolikhetsfördelning
      var allow = scores.map(function () { return true; });
      if (m.fixed) {
        if (m.fixed[0] === "score") {
          allow = scores.map(function (s) { return s.h === m.fixed[1] && s.a === m.fixed[2]; });
        } else if (m.fixed[0] === "result") {
          var rr = m.fixed[1];
          allow = scores.map(function (s) {
            var d = s.h - s.a;
            return rr === "1" ? d > 0 : rr === "X" ? d === 0 : d < 0;
          });
        }
      }
      var cum = [], tot = 0;
      for (var k = 0; k < scores.length; k++) { if (allow[k]) tot += scores[k].p; }
      if (tot <= 0) { allow = scores.map(function () { return true; }); tot = 0; for (var z = 0; z < scores.length; z++) tot += scores[z].p; }
      var acc = 0;
      for (var k2 = 0; k2 < scores.length; k2++) {
        if (!allow[k2]) { cum.push(-1); continue; }
        acc += scores[k2].p / tot; cum.push(acc);
      }
      for (var r = 0; r < n; r++) {
        var u = rng(), pick = scores.length - 1;
        for (var c = 0; c < cum.length; c++) { if (cum[c] >= 0 && u <= cum[c]) { pick = c; break; } }
        h[r] = scores[pick].h; a[r] = scores[pick].a;
      }
      samples[m.id] = { h: h, a: a, i: m.i, j: m.j };
      byGroup[m.g].push({ kind: "sample", sid: m.id, i: m.i, j: m.j });
      oddsMeta.push(m);
    });

    // ospelade matcher utan odds: neutral modell (sällsynt)
    var neutralSamples = [];
    (input.neutral || []).forEach(function (g, gi2) {
      var hh = new Int16Array(n), aa = new Int16Array(n);
      for (var r = 0; r < n; r++) { hh[r] = poisson(rng, 1.25); aa[r] = poisson(rng, 1.25); }
      var rec = { h: hh, a: aa, i: g.i, j: g.j };
      neutralSamples.push(rec);
      byGroup[g.g].push({ kind: "neutral", ref: neutralSamples.length - 1, i: g.i, j: g.j });
    });

    // ---- körslingan ----
    var labels = new Array(n);
    var posArr = new Int8Array(n);
    var resultsBuf = {};                 // återanvändbara listor per grupp
    GROUPS.forEach(function (g) { resultsBuf[g] = []; });

    for (var run = 0; run < n; run++) {
      var tables = {};
      var winners = {}, runners = {};
      for (var gi = 0; gi < GROUPS.length; gi++) {
        var g = GROUPS[gi];
        var games = byGroup[g];
        var rb = resultsBuf[g]; rb.length = 0;
        for (var t = 0; t < games.length; t++) {
          var gm = games[t];
          if (gm.kind === "fixed") rb.push([gm.i, gm.j, gm.gi, gm.gj]);
          else if (gm.kind === "sample") { var sp = samples[gm.sid]; rb.push([gm.i, gm.j, sp.h[run], sp.a[run]]); }
          else { var np = neutralSamples[gm.ref]; rb.push([gm.i, gm.j, np.h[run], np.a[run]]); }
        }
        var co = computeOrder(g, rb, fifa);
        var rows = new Array(4);
        for (var p = 0; p < 4; p++) {
          var idx = co.order[p], st = co.stats[idx];
          rows[p] = { idx: idx, position: p + 1, pts: st.pts, gd: st.gd, gf: st.gf, fifa: fifa[g][idx] };
        }
        tables[g] = { rows: rows };
        winners[g] = co.order[0]; runners[g] = co.order[1];
      }
      var res = resolveOpponent(tables, tg, ti, {
        winners: winners, runners: runners, names: names,
        annexC: annexC, annexSlots: annexSlots
      });
      labels[run] = res.label;
      posArr[run] = res.pos;
    }

    // ---- aggregera utfall ----
    var counts = {};
    for (var x = 0; x < n; x++) counts[labels[x]] = (counts[labels[x]] || 0) + 1;

    // bestäm avoid-mängden: de hårdaste lagen man faktiskt kan möta.
    // autoAvoidTop = K → välj de K högst FIFA-rankade bland möjliga motståndare.
    var nameRank = {};
    GROUPS.forEach(function (g) { for (var i = 0; i < 4; i++) nameRank[names[g][i]] = fifa[g][i]; });
    var avoid = {};
    if (input.autoAvoidTop) {
      var minP = (input.autoAvoidMinProb != null ? input.autoAvoidMinProb : 0.01) * n;
      var cand = Object.keys(counts).filter(function (l) { return l !== "Eliminated" && counts[l] >= minP; });
      if (cand.length < input.autoAvoidTop) cand = Object.keys(counts).filter(function (l) { return l !== "Eliminated"; });
      cand.sort(function (a, b) { return nameRank[a] - nameRank[b]; })
        .slice(0, input.autoAvoidTop)
        .forEach(function (l) { avoid[l] = true; });
    } else {
      (input.avoidNames || []).forEach(function (nm) { avoid[nm] = true; });
    }
    var avoidNamesOut = Object.keys(avoid);

    var goodFlags = new Int8Array(n);   // 1 bra, 0 dåligt, -1 utslagen
    for (var gf2 = 0; gf2 < n; gf2++) {
      goodFlags[gf2] = labels[gf2] === "Eliminated" ? -1 : (avoid[labels[gf2]] ? 0 : 1);
    }

    var outcomes = Object.keys(counts).map(function (label) {
      var cnt = counts[label], pr = cnt / n;
      return {
        label: label, count: cnt, prob: pr,
        odds: pr > 0 ? 1 / pr : null,
        good: label === "Eliminated" ? null : !avoid[label]
      };
    }).sort(function (a, b) { return b.count - a.count; });

    var order = outcomes.map(function (o) { return o.label; });
    var labId = {}; order.forEach(function (l, i) { labId[l] = i; });
    var L = order.length;
    var baseP = outcomes.map(function (o) { return o.prob; });
    var goodOf = outcomes.map(function (o) { return o.good; });
    var labelsInt = new Int32Array(n);
    for (var y = 0; y < n; y++) labelsInt[y] = labId[labels[y]];

    var goodMean = 0, badMean = 0, outMean = 0;
    for (var f = 0; f < n; f++) { if (goodFlags[f] === 1) goodMean++; else if (goodFlags[f] === 0) badMean++; else outMean++; }
    var summary = { good: goodMean / n, bad: badMean / n, eliminated: outMean / n };

    // ---- känslighet per match ----
    var sens = sensitivity(samples, oddsMeta, goodFlags, labelsInt, L, baseP, order, goodOf, n, summary.good);
    opponentMeta(outcomes, labId, labelsInt, posArr, sens.gameOppp, sens.games);

    // vinst% mot varje motståndare (FIFA-ranking-estimat)
    var teamRank = fifa[tg][ti];
    outcomes.forEach(function (o) {
      o.win = o.label === "Eliminated" ? null : winProb(teamRank, nameRank[o.label] || 50);
    });

    return {
      n: n, teamG: tg, teamIdx: ti, teamName: names[tg][ti], group: tg,
      avoidNames: avoidNamesOut,
      summary: summary, outcomes: outcomes, games: sens.games
    };
  }

  function winProb(rankTeam, rankOpp) {
    var r = function (x) { return 1500 - 130 * Math.log(x); };
    return 1 / (1 + Math.pow(10, (r(rankOpp) - r(rankTeam)) / 400));
  }

  function ci95(p, m) { return m > 0 ? 1.96 * Math.sqrt(p * (1 - p) / m) : null; }

  function bucket(maskIdxFn, mask, goodFlags, labelsInt, L, baseP, order, goodOf, total) {
    var cnt = 0, goodC = 0, badC = 0, outC = 0;
    var dist = new Float64Array(L);
    for (var r = 0; r < total; r++) {
      if (!mask[r]) continue;
      cnt++;
      var g = goodFlags[r];
      if (g === 1) goodC++; else if (g === 0) badC++; else outC++;
      dist[labelsInt[r]]++;
    }
    if (cnt === 0) return { stat: { n: 0, good: null, bad: null, out: null, ci: null, changes: [] }, dist: null };
    var pg = goodC / cnt;
    var changes = [];
    for (var i = 0; i < L; i++) {
      var d = dist[i] / cnt - baseP[i];
      if (Math.abs(d) > 0.005) changes.push({ label: order[i], delta: d, good: goodOf[i] });
    }
    changes.sort(function (a, b) { return Math.abs(b.delta) - Math.abs(a.delta); });
    changes = changes.slice(0, 5);
    return {
      stat: { n: cnt, good: pg, bad: badC / cnt, out: outC / cnt, ci: ci95(pg, cnt), changes: changes },
      dist: dist, distN: cnt
    };
  }

  function sensitivity(samples, oddsMeta, goodFlags, labelsInt, L, baseP, order, goodOf, n, baseGood) {
    var K = 200;
    var games = [], gameOppp = {};
    oddsMeta.forEach(function (m) {
      var sp = samples[m.id], hg = sp.h, ag = sp.a;
      var m1 = new Uint8Array(n), mX = new Uint8Array(n), m2 = new Uint8Array(n);
      for (var r = 0; r < n; r++) { var d = hg[r] - ag[r]; if (d > 0) m1[r] = 1; else if (d === 0) mX[r] = 1; else m2[r] = 1; }
      var b1 = bucket(null, m1, goodFlags, labelsInt, L, baseP, order, goodOf, n);
      var bX = bucket(null, mX, goodFlags, labelsInt, L, baseP, order, goodOf, n);
      var b2 = bucket(null, m2, goodFlags, labelsInt, L, baseP, order, goodOf, n);
      var results = { "1": b1.stat, "X": bX.stat, "2": b2.stat };
      gameOppp[m.id] = {
        "1": b1.dist ? scaleDist(b1.dist, b1.distN) : null,
        "X": bX.dist ? scaleDist(bX.dist, bX.distN) : null,
        "2": b2.dist ? scaleDist(b2.dist, b2.distN) : null
      };

      // exakta resultat
      var scores = [];
      m.scores.forEach(function (sc) {
        var mask = new Uint8Array(n), c = 0;
        for (var r2 = 0; r2 < n; r2++) { if (hg[r2] === sc.h && ag[r2] === sc.a) { mask[r2] = 1; c++; } }
        var bs = bucket(null, mask, goodFlags, labelsInt, L, baseP, order, goodOf, n).stat;
        bs.h = sc.h; bs.a = sc.a; bs.p_occur = sc.p;
        var rkey = sc.h > sc.a ? "1" : (sc.h === sc.a ? "X" : "2");
        var rg = results[rkey].good;
        bs.good_shrunk = (bs.good != null && rg != null) ? (bs.n * bs.good + K * rg) / (bs.n + K) : bs.good;
        scores.push(bs);
      });

      var gv = ["1", "X", "2"].map(function (r) { return results[r].good; }).filter(function (v) { return v != null; });
      var importance = gv.length > 1 ? (Math.max.apply(null, gv) - Math.min.apply(null, gv)) : 0;
      var scoreFlags = { "1": marginMatters(scores, "1"), "X": marginMatters(scores, "X"), "2": marginMatters(scores, "2") };
      var scoreMatters = scoreFlags["1"] || scoreFlags["X"] || scoreFlags["2"];

      games.push({
        id: m.id, group: m.g, home: m.home, away: m.away, i: m.i, j: m.j,
        result_probs: m.rp, scores_occ: m.scores,
        importance: importance, base_good: baseGood,
        results: results, scores: scores,
        score_flags: scoreFlags, score_matters: scoreMatters,
        message: headline(results, importance, m, scoreMatters)
      });
    });
    return { games: games, gameOppp: gameOppp };
  }

  function scaleDist(dist, cnt) {
    var out = new Float64Array(dist.length);
    for (var i = 0; i < dist.length; i++) out[i] = dist[i] / cnt;
    return out;
  }

  function opponentMeta(outcomes, labId, labelsInt, posArr, gameOppp, games) {
    var POS = { 1: "Gruppvinnare (1:a)", 2: "Tvåa i gruppen", 3: "Bästa trea (3:a)", 4: "Fyra" };
    var gmeta = {}; games.forEach(function (g) { gmeta[g.id] = g; });
    outcomes.forEach(function (o) {
      var lid = labId[o.label];
      var posCount = {}, total = 0;
      for (var r = 0; r < labelsInt.length; r++) { if (labelsInt[r] === lid) { posCount[posArr[r]] = (posCount[posArr[r]] || 0) + 1; total++; } }
      if (total === 0) { o.sweden_pos = null; o.key_games = []; return; }
      var dom = 1, best = -1;
      Object.keys(posCount).forEach(function (p) { if (posCount[p] > best) { best = posCount[p]; dom = +p; } });
      o.sweden_pos = o.label === "Eliminated" ? "Utslagen" : POS[dom];
      if (o.label === "Eliminated") { o.key_games = []; return; }
      var ranked = [];
      Object.keys(gameOppp).forEach(function (gid) {
        var oppp = gameOppp[gid];
        var vals = [];
        ["1", "X", "2"].forEach(function (rk) { if (oppp[rk]) vals.push([oppp[rk][lid], rk]); });
        if (vals.length < 2) return;
        vals.sort(function (a, b) { return b[0] - a[0]; });
        var swing = vals[0][0] - vals[vals.length - 1][0];
        if (swing > 0.03) {
          var g = gmeta[gid];
          var cheer = { "1": g.home, "X": "oavgjort", "2": g.away }[vals[0][1]];
          ranked.push({ swing: swing, match: g.home + " – " + g.away, cheer: cheer });
        }
      });
      ranked.sort(function (a, b) { return b.swing - a.swing; });
      o.key_games = ranked.slice(0, 3);
    });
  }

  function marginMatters(scores, r) {
    var inR = scores.filter(function (s) {
      if (s.good == null) return false;
      return r === "1" ? s.h > s.a : r === "X" ? s.h === s.a : s.h < s.a;
    });
    if (inR.length < 2) return false;
    var keyFn = r === "X" ? function (s) { return s.h + s.a; } : function (s) { return Math.abs(s.h - s.a); };
    var lowval = Math.min.apply(null, inR.map(keyFn));
    var low = inR.filter(function (s) { return keyFn(s) === lowval; });
    var high = inR.filter(function (s) { return keyFn(s) > lowval; });
    var nl = low.reduce(function (a, s) { return a + s.n; }, 0);
    var nh = high.reduce(function (a, s) { return a + s.n; }, 0);
    if (nl < 150 || nh < 150) return false;
    var fields = ["good", "bad", "out"];
    for (var f = 0; f < fields.length; f++) {
      var fld = fields[f];
      var pl = low.reduce(function (a, s) { return a + s[fld] * s.n; }, 0) / nl;
      var ph = high.reduce(function (a, s) { return a + s[fld] * s.n; }, 0) / nh;
      var se = Math.sqrt(pl * (1 - pl) / nl + ph * (1 - ph) / nh);
      if (Math.abs(pl - ph) > 0.08 && Math.abs(pl - ph) > 2 * se) return true;
    }
    return false;
  }

  function headline(results, importance, m, scoreMatters) {
    var valid = {};
    ["1", "X", "2"].forEach(function (r) { if (results[r].good != null) valid[r] = results[r].good; });
    if (importance < 0.035 && !scoreMatters) return "påverkar minimalt";
    var best = null, bestV = -1;
    Object.keys(valid).forEach(function (r) { if (valid[r] > bestV) { bestV = valid[r]; best = r; } });
    if (best == null) return "";
    var cheer = { "1": m.home, "X": "oavgjort", "2": m.away }[best];
    return "bäst: heja " + cheer + (scoreMatters ? " — och målskillnaden spelar roll" : "");
  }

  root.R32Engine = { simulate: simulate, GROUPS: GROUPS };
})(typeof self !== "undefined" ? self : this);
