# VM2026 – Projektöversikt för Claude

## Vad är det här?
Webbapp för att följa fotbolls-VM 2026 (USA, Mexiko, Kanada). Visar grupptabeller, slutspelsträd, kalender och live-matchstatistik. Publicerad på **gravergrav.se** via GitHub Pages.

## Arkitektur

### Två driftlägen
1. **GitHub Pages (standard)** – ren statisk frontend. GitHub Actions kör `npm run sync:static` var 3:e minut och uppdaterar `data/results.json` + `data/matchdetails.json`. Ingen server behövs.
2. **Med backend (Render)** – Node.js-server med WebSocket, pollar ESPN-API och pushar uppdateringar till klienten i realtid. Valfri Neon Postgres-databas.

### Datakällor
- **ESPN öppet API** – resultat, livehändelser (mål/kort/byten), matchstatistik. Ingen API-nyckel.
- **API-Football** (valfritt, betald) – spelarstatistik via `API_FOOTBALL_KEY` i `.env`.

### Nyckelkommandon
```bash
npm start          # starta server (http://localhost:3000)
npm run dev        # starta med --watch (auto-restart)
npm run sync       # synka resultat till server/data/results.json
npm run sync:static # synka till data/results.json + data/matchdetails.json (GitHub Pages)
```

## Viktiga filer
| Fil/mapp | Roll |
|---|---|
| `index.html` | Ingångspunkt, innehåller `window.VM_CONFIG` |
| `assets/app.js` | Huvudlogik: tabeller, slutspelsträd, kalender |
| `assets/matchinfo.js` | Matchmodal med detaljer/statistik |
| `assets/r32engine.js` | Monte Carlo-motor: simulerar vem man möter i R32 utifrån odds (delas av huvudtråd + worker) |
| `assets/r32worker.js` | Web Worker som kör `r32engine.js` utanför huvudtråden |
| `data/odds.json` | Exakta resultat-odds för de återstående gruppmatcherna (indata till R32-motorn) |
| `assets/playerstats.js` | Spelarstatistik |
| `assets/styles.css` | All CSS |
| `server/index.js` | Express-server + WebSocket |
| `server/espnSync.js` | ESPN API-synk |
| `server/mapResults.js` | Mappar ESPN-data till interna nycklar |
| `data/results.json` | Statisk resultatfil (uppdateras av Actions) |
| `data/matchdetails.json` | Statisk matchdetaljer (uppdateras av Actions) |
| `data/bracket_probs.json` | Sannolikheter för slutspelet |
| `scripts/prob/` | Sannolikhetsberäkningar (odds, bracket) |
| `.github/workflows/` | GitHub Actions-workflows |
| `render.yaml` | Deploy-config för Render |

## Miljövariabler (.env)
```
DATABASE_URL=          # Neon Postgres (valfritt)
API_FOOTBALL_KEY=      # Spelarstatistik (valfritt)
FD_POLL_LIVE_SECONDS=  # Pollintervall live (default 120)
FD_POLL_MATCHDAY_SECONDS= # Pollintervall matchdag (default 300)
FD_POLL_IDLE_SECONDS=  # Pollintervall vila (default 900)
```

## Deploy
- **Frontend:** GitHub Pages, branch `main`, rot `/`. Domän: `gravergrav.se` (CNAME i reporoten).
- **Backend:** Render, start command `npm start`.
- **GitHub Actions:** Synkar ESPN-data automatiskt, committar ändringar till repot.
