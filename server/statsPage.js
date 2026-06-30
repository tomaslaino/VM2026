/* Renderar en självständig HTML-sida för besöksstatistiken (admin). */

const VIEW_LABELS = {
  home: "Hem",
  groups: "Gruppspel",
  bracket: "Slutspel",
  r32: "Kalkylator",
  "legacy-r32": "Motståndare",
  players: "Statistik",
  calendar: "Kalender",
  "okänd": "Okänd",
};

const KIND_LABELS = {
  view: "Vy-byte",
  match: "Match öppnad",
  team: "Lag öppnat",
  search: "Spelare sökt",
};

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function fmtDur(sec) {
  const s = parseInt(sec, 10);
  if (!Number.isFinite(s) || s <= 0) return "–";
  if (s < 60) return s + " s";
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r ? m + " min " + r + " s" : m + " min";
}

function bars(rows, labelFn, valKey, max) {
  if (!rows.length) return '<p class="empty">Ingen data än.</p>';
  const key = valKey || "views";
  const top = max || Math.max(...rows.map((r) => r[key]), 1);
  return rows.map((r) => {
    const n = r[key];
    const pct = Math.round((n / top) * 100);
    return `<div class="bar-row"><span class="bar-label">${esc(labelFn(r))}</span>` +
      `<span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>` +
      `<span class="bar-val">${n}</span></div>`;
  }).join("");
}

function dayChart(byDay) {
  if (!byDay.length) return '<p class="empty">Ingen data än.</p>';
  const max = Math.max(...byDay.map((d) => d.views), 1);
  const cols = byDay.map((d) => {
    const h = Math.max(2, Math.round((d.views / max) * 140));
    const hv = Math.max(0, Math.round((d.visitors / max) * 140));
    const label = d.day.slice(5);
    return `<div class="day" title="${esc(d.day)}: ${d.views} visningar, ${d.visitors} besökare">` +
      `<span class="day-bars"><span class="db views" style="height:${h}px"></span>` +
      `<span class="db visitors" style="height:${hv}px"></span></span>` +
      `<span class="day-label">${esc(label)}</span></div>`;
  }).join("");
  return `<div class="daychart">${cols}</div>`;
}

function hourChart(byHour) {
  if (!byHour.length) return '<p class="empty">Ingen trafik idag än.</p>';
  const max = Math.max(...byHour.map((h) => h.views), 1);
  const slots = [];
  for (let i = 0; i < 24; i++) slots.push({ hour: i, views: 0, visitors: 0 });
  for (const h of byHour) slots[h.hour] = h;
  return slots.map((h) => {
    const barH = Math.max(h.views ? 2 : 1, Math.round((h.views / max) * 100));
    return `<div class="hour" title="${h.hour}:00 – ${h.views} visningar, ${h.visitors} besökare">` +
      `<span class="hour-bar" style="height:${barH}px"></span>` +
      `<span class="hour-label">${h.hour}</span></div>`;
  }).join("");
}

function durationTable(rows) {
  if (!rows.length) return '<p class="empty">Ingen tid-data än (kräver vy-byten).</p>';
  return '<table class="tbl"><thead><tr><th>Vy</th><th>Snitt tid</th><th>Antal</th></tr></thead><tbody>' +
    rows.map((r) => `<tr><td>${esc(VIEW_LABELS[r.view] || r.view)}</td>` +
      `<td>${esc(fmtDur(r.avg_sec))}</td><td>${r.samples}</td></tr>`).join("") +
    "</tbody></table>";
}

export function renderStatsPage(s) {
  const avg = s.engagement?.avg_views_per_visitor ?? 0;
  const split = s.visitorSplit || { new_today: 0, returning_today: 0 };

  return `<!doctype html><html lang="sv"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<meta http-equiv="refresh" content="60">
<title>Trafik · VM 2026</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0a1628; color: #e8eef7; font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding: 24px; max-width: 960px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #8aa0bd; font-size: 13px; margin: 0 0 24px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px; margin-bottom: 28px; }
  .card { background: #122138; border: 1px solid #1e324d; border-radius: 12px; padding: 14px 16px; }
  .card .num { font-size: 26px; font-weight: 800; letter-spacing: -.02em; }
  .card .cap { color: #8aa0bd; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; margin-top: 2px; }
  .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 18px; margin-bottom: 22px; }
  section { background: #0f1c30; border: 1px solid #1e324d; border-radius: 12px; padding: 18px 20px; margin-bottom: 22px; }
  section h2 { font-size: 15px; margin: 0 0 14px; color: #cdddf2; }
  .bar-row { display: grid; grid-template-columns: minmax(90px, 130px) 1fr 48px; align-items: center; gap: 10px; margin: 7px 0; }
  .bar-label { color: #b9c9de; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar-track { background: #1a2c45; border-radius: 6px; height: 14px; overflow: hidden; }
  .bar-fill { display: block; height: 100%; background: linear-gradient(90deg,#3b82f6,#60a5fa); }
  .bar-val { text-align: right; font-variant-numeric: tabular-nums; color: #e8eef7; font-size: 13px; }
  .daychart { display: flex; align-items: flex-end; gap: 4px; overflow-x: auto; padding-bottom: 4px; min-height: 170px; }
  .day { display: flex; flex-direction: column; align-items: center; gap: 6px; flex: 0 0 auto; }
  .day-bars { display: flex; align-items: flex-end; gap: 2px; height: 140px; }
  .db { width: 9px; border-radius: 3px 3px 0 0; }
  .db.views { background: #3b82f6; }
  .db.visitors { background: #34d399; }
  .day-label { font-size: 10px; color: #7e93b0; transform: rotate(-45deg); transform-origin: center; white-space: nowrap; }
  .hourchart { display: flex; align-items: flex-end; gap: 3px; min-height: 120px; overflow-x: auto; }
  .hour { display: flex; flex-direction: column; align-items: center; gap: 4px; flex: 1; min-width: 20px; }
  .hour-bar { display: block; width: 100%; max-width: 22px; background: #3b82f6; border-radius: 3px 3px 0 0; min-height: 1px; }
  .hour-label { font-size: 9px; color: #7e93b0; }
  .legend { display: flex; gap: 16px; font-size: 12px; color: #8aa0bd; margin-bottom: 12px; flex-wrap: wrap; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
  .tbl { width: 100%; border-collapse: collapse; font-size: 13px; }
  .tbl th, .tbl td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #1e324d; }
  .tbl th { color: #8aa0bd; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; }
  .empty { color: #7e93b0; font-style: italic; margin: 0; }
  footer { color: #6b8099; font-size: 12px; margin-top: 24px; line-height: 1.6; }
</style></head><body>
  <h1>Trafik · VM 2026</h1>
  <p class="sub">Datakälla: ${esc(s.source)} · uppdaterad ${new Date().toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" })} · uppdateras var 60:e sekund</p>

  <div class="cards">
    <div class="card"><div class="num">${s.today.views}</div><div class="cap">Vyvisningar idag</div></div>
    <div class="card"><div class="num">${s.today.visitors}</div><div class="cap">Besökare idag</div></div>
    <div class="card"><div class="num">${s.today.sessions ?? "–"}</div><div class="cap">Sessioner idag</div></div>
    <div class="card"><div class="num">${split.new_today}</div><div class="cap">Nya idag</div></div>
    <div class="card"><div class="num">${split.returning_today}</div><div class="cap">Återkommande idag</div></div>
    <div class="card"><div class="num">${avg}</div><div class="cap">Snitt vyer/besökare</div></div>
    <div class="card"><div class="num">${s.totals.views}</div><div class="cap">Vyvisningar totalt</div></div>
    <div class="card"><div class="num">${s.totals.visitors}</div><div class="cap">Besökare totalt</div></div>
  </div>

  <section>
    <h2>Idag per timme (svensk tid)</h2>
    <div class="hourchart">${hourChart(s.byHour || [])}</div>
  </section>

  <section>
    <h2>Senaste 30 dagarna</h2>
    <div class="legend"><span><i style="background:#3b82f6"></i>Vyvisningar</span><span><i style="background:#34d399"></i>Unika besökare</span></div>
    ${dayChart(s.byDay)}
  </section>

  <div class="grid2">
    <section>
      <h2>Populäraste vyer</h2>
      ${bars(s.byView, (r) => VIEW_LABELS[r.view] || r.view)}
    </section>
    <section>
      <h2>Snitt tid per vy</h2>
      ${durationTable(s.avgDuration || [])}
    </section>
  </div>

  <div class="grid2">
    <section>
      <h2>Mest öppnade matcher</h2>
      ${bars(s.topMatches || [], (r) => r.detail, "clicks")}
    </section>
    <section>
      <h2>Mest sökta/öppnade lag</h2>
      ${bars(s.topTeams || [], (r) => r.detail, "clicks")}
    </section>
  </div>

  <section>
    <h2>Mest sökta spelare</h2>
    ${bars(s.topSearches || [], (r) => r.detail, "clicks")}
  </section>

  <div class="grid2">
    <section>
      <h2>Trafikkällor</h2>
      ${bars(s.byReferrer, (r) => r.referrer)}
    </section>
    <section>
      <h2>Enheter & webbläsare</h2>
      ${bars(s.byDevice, (r) => r.device)}
      <div style="height:14px"></div>
      ${bars(s.byBrowser || [], (r) => r.browser)}
    </section>
  </div>

  <section>
    <h2>Händelsetyper (totalt)</h2>
    ${bars(s.byKind || [], (r) => KIND_LABELS[r.kind] || r.kind, "count")}
  </section>

  <footer>Ingen IP lagras. Besökare identifieras via slumpat förstaparts-id i localStorage.
    Sessioner = ett besök tills fliken stängs. Match- och sökdata är aggregerade etiketter, inte personuppgifter.</footer>
</body></html>`;
}
