# VM 2026 – Grupper, slutspel & kalender

Statisk webbapp för att följa fotbolls-VM 2026 (USA, Mexiko, Kanada): grupptabeller, tvåsidigt slutspelsträd, kalender, lagsök och live-demo.

## Öppna lokalt

Dubbelklicka på `index.html` eller öppna filen i webbläsaren. Ingen server eller installation krävs.

## Publicera på GitHub Pages

1. Ladda upp repot till GitHub.
2. Gå till **Settings → Pages** i repot.
3. Under **Build and deployment**: branch `main`, mapp **/ (root)**.
4. Sidan finns på **https://tomaslaino.github.io/VM2026/**

### Egen domän (gravaguld.se)

Lägg **inte** till Custom domain förrän DNS är aktiv (testa på [whatsmydns.net](https://www.whatsmydns.net/#A/gravaguld.se)).
Annars omdirigeras github.io-adressen till en domän som inte svarar än.

### Omdirigering till gravaguld.se som inte fungerar

Om `tomaslaino.github.io/VM2026` skickar dig till `gravaguld.se` trots att domänen inte svarar:

1. Öppna **https://github.com/tomaslaino/VM2026/settings/pages**
2. Under **Custom domain** – om `gravaguld.se` står kvar, klicka **Remove**
3. Vänta 1–2 minuter
4. Testa i **inkognitofönster**: **https://tomaslaino.github.io/VM2026/**

`CNAME`-filen i repot är redan borttagen – men **GitHub-inställningen** måste också tas bort manuellt, annars fortsätter omdirigeringen.
