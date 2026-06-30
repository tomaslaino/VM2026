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

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function bars(rows, labelFn, max) {
  if (!rows.length) return '<p class="empty">Ingen data än.</p>';
  const top = max || Math.max(...rows.map((r) => r.views), 1);
  return rows.map((r) => {
    const pct = Math.round((r.views / top) * 100);
    return `<div class="bar-row"><span class="bar-label">${esc(labelFn(r))}</span>` +
      `<span class="bar-track"><span class="bar-fill" style="width:${pct}%"></span></span>` +
      `<span class="bar-val">${r.views}</span></div>`;
  }).join("");
}

function dayChart(byDay) {
  if (!byDay.length) return '<p class="empty">Ingen data än.</p>';
  const max = Math.max(...byDay.map((d) => d.views), 1);
  const cols = byDay.map((d) => {
    const h = Math.max(2, Math.round((d.views / max) * 140));
    const hv = Math.max(0, Math.round((d.visitors / max) * 140));
    const label = d.day.slice(5); // MM-DD
    return `<div class="day" title="${esc(d.day)}: ${d.views} visningar, ${d.visitors} besökare">` +
      `<span class="day-bars"><span class="db views" style="height:${h}px"></span>` +
      `<span class="db visitors" style="height:${hv}px"></span></span>` +
      `<span class="day-label">${esc(label)}</span></div>`;
  }).join("");
  return `<div class="daychart">${cols}</div>`;
}

export function renderStatsPage(s) {
  return `<!doctype html><html lang="sv"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Trafik · VM 2026</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0a1628; color: #e8eef7; font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; padding: 24px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #8aa0bd; font-size: 13px; margin: 0 0 24px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 14px; margin-bottom: 28px; }
  .card { background: #122138; border: 1px solid #1e324d; border-radius: 12px; padding: 16px 18px; }
  .card .num { font-size: 30px; font-weight: 800; letter-spacing: -.02em; }
  .card .cap { color: #8aa0bd; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
  section { background: #0f1c30; border: 1px solid #1e324d; border-radius: 12px; padding: 18px 20px; margin-bottom: 22px; }
  section h2 { font-size: 15px; margin: 0 0 14px; color: #cdddf2; }
  .bar-row { display: grid; grid-template-columns: 130px 1fr 48px; align-items: center; gap: 10px; margin: 7px 0; }
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
  .legend { display: flex; gap: 16px; font-size: 12px; color: #8aa0bd; margin-bottom: 12px; }
  .legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
  .empty { color: #7e93b0; font-style: italic; }
  footer { color: #6b8099; font-size: 12px; margin-top: 24px; }
</style></head><body>
  <h1>Trafik · VM 2026</h1>
  <p class="sub">Datakälla: ${esc(s.source)} · uppdaterad ${new Date().toLocaleString("sv-SE", { timeZone: "Europe/Stockholm" })}</p>

  <div class="cards">
    <div class="card"><div class="num">${s.today.views}</div><div class="cap">Visningar idag</div></div>
    <div class="card"><div class="num">${s.today.visitors}</div><div class="cap">Besökare idag</div></div>
    <div class="card"><div class="num">${s.totals.views}</div><div class="cap">Visningar totalt</div></div>
    <div class="card"><div class="num">${s.totals.visitors}</div><div class="cap">Besökare totalt</div></div>
  </div>

  <section>
    <h2>Senaste 30 dagarna</h2>
    <div class="legend"><span><i style="background:#3b82f6"></i>Sidvisningar</span><span><i style="background:#34d399"></i>Unika besökare</span></div>
    ${dayChart(s.byDay)}
  </section>

  <section>
    <h2>Populäraste vyer</h2>
    ${bars(s.byView, (r) => VIEW_LABELS[r.view] || r.view)}
  </section>

  <section>
    <h2>Trafikkällor</h2>
    ${bars(s.byReferrer, (r) => r.referrer)}
  </section>

  <section>
    <h2>Enheter</h2>
    ${bars(s.byDevice, (r) => r.device)}
  </section>

  <footer>Sidan är inte indexerad. Inga cookies, ingen IP lagras – besökare räknas via ett slumpat förstaparts-id.</footer>
</body></html>`;
}
