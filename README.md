# VM 2026 – Grupper, slutspel & kalender

Webbapp för att följa fotbolls-VM 2026 (USA, Mexiko, Kanada): grupptabeller, slutspelsträd, kalender och **automatiskt uppdaterade resultat** via [football-data.org](https://www.football-data.org/).

Grupptabellerna och slutspelsträdet räknas ut från matchresultat i realtid – samma logik som vid manuell inmatning, men resultaten hämtas automatiskt från API:t.

## Snabbstart (lokalt med auto-uppdatering)

Förutsätter [Node.js](https://nodejs.org/) 18+.

```bash
npm install
copy .env.example .env   # PowerShell/CMD – eller cp på mac/linux
# Fyll i FOOTBALL_DATA_TOKEN i .env
npm start
```

Öppna **http://localhost:3000**. Badgen **Auto** i topbaren visar att resultat synkas. Grupper, tabeller och slutspel uppdateras automatiskt.

### football-data.org (primär datakälla)

Gratis token: [football-data.org/client/register](https://www.football-data.org/client/register)

```
FOOTBALL_DATA_TOKEN=din_token
FD_COMPETITION=WC
FD_SEASON=2026
```

På gratisplanen är resultat **fördröjda** (inte live under match). Under VM kan du uppgradera till deras live-plan (~€12/mån) om du vill ha mål i realtid. Appen pollar ändå smart:

| Läge | Intervall (standard) |
|------|----------------------|
| Live-matcher pågår | 120 s |
| Turnering pågår (11 jun – 19 jul 2026) | 300 s |
| Utanför turneringen | 900 s |

Justera i `.env`: `FD_POLL_LIVE_SECONDS`, `FD_POLL_MATCHDAY_SECONDS`, `FD_POLL_IDLE_SECONDS`.

Manuell synk:

```bash
npm run sync
```

### API-Football (valfritt – spelarstatistik)

Kräver betald plan för VM 2026. Utan nyckel fungerar resultat-synken ändå.

```
API_FOOTBALL_KEY=din_nyckel
```

```bash
npm run squads   # hämtar trupper (nattligt via schemaläggaren)
```

## Hur det fungerar

```
football-data.org  →  sync-jobb (scheduler)  →  results store  →  /api/results + WebSocket
                                                                        ↓
                                                              app.js (tabeller, träd, kalender)
```

- **Resultat** mappas till samma nycklar som manuell inmatning (`g:A:0`, `k:73` …).
- **Tabeller** beräknas i webbläsaren från resultaten (`computeTable`) – ingen separat standings-API behövs.
- **WebSocket** (`/ws`) skickar `results:updated` så sidan uppdateras direkt efter varje sync.
- **Lager:** `server/data/results.json` lokalt, eller **Neon Postgres** med `DATABASE_URL`.

### Neon (valfritt, rekommenderat i drift)

1. Skapa databas på [neon.tech](https://neon.tech).
2. Kopiera connection string till `.env`:

```
DATABASE_URL=postgresql://user:pass@ep-xxx.neon.tech/neondb?sslmode=require
```

Tabellen `vm_results` skapas automatiskt vid första sync. Utan `DATABASE_URL` sparas allt i JSON-fil (fungerar på Render men försvinner vid redeploy på free tier).

## Bara frontend (utan backend)

Dubbelklicka på `index.html` – då fyller du i resultat manuellt och allt sparas i `localStorage`. Ingen **Auto**-badge.

## Deploya backend

GitHub Pages kan **inte** köra Node. Använd t.ex. [Render](https://render.com/) (gratis tier räcker för VM):

1. Pusha repot till GitHub.
2. Render → **New Web Service** → koppla repot (eller använd `render.yaml` i roten).
3. Miljövariabler:
   - `FOOTBALL_DATA_TOKEN` (obligatorisk)
   - `DATABASE_URL` (rekommenderad – Neon)
   - `API_FOOTBALL_KEY` (valfritt)
4. Start command: `npm start`
5. Öppna din Render-URL – sidan och API:t serveras från samma host.

**Frontend på GitHub Pages + backend på Render:** sätt backend-URL i `index.html`:

```html
<script>window.VM_CONFIG = { backend: "https://din-app.onrender.com" };</script>
```

## Publicera på GitHub Pages

1. Ladda upp repot till GitHub.
2. **Settings → Pages** → branch `main`, mapp **/ (root)**.
3. Sidan: **https://tomaslaino.github.io/VM2026/**

Utan `VM_CONFIG.backend` pekar sidan på samma host – fungerar bara om du kör `npm start`, inte på ren GitHub Pages.

### Egen domän (gravaguld.se)

Lägg **inte** till Custom domain förrän DNS är aktiv. Om `github.io` omdirigerar till en domän som inte svarar: ta bort Custom domain under **Settings → Pages**.
