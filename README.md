# F1 Race Display (Docker)

LED-matrix race display voor de iPad, bediend met de iPhone.

## Starten

**Portainer (aanbevolen):** Stacks > Add stack > Repository, URL `https://github.com/BennieHillmen/F1Racescreen`, compose path `docker-compose.yml`. Of plak `portainer-stack.yml` in de Web editor. Er wordt niets gebouwd: de container gebruikt `node:22-alpine` en haalt bij elke start de nieuwste code uit deze repository. Updaten = container herstarten.

**Zelf bouwen met Docker:**

```bash
docker compose -f docker-compose.build.yml up -d --build
```

Open daarna op je thuisnetwerk (vervang het IP-adres door dat van de computer waarop Docker draait):

- iPad (display): `http://192.168.1.50:8082/#display`
- iPhone (afstandsbediening): `http://192.168.1.50:8082/#remote`

Tip voor de iPad: Safari > Deel > *Zet op beginscherm*, en zet Instellingen > Scherm > Automatisch vergrendelen op *Nooit*.

## Wat het doet

- Haalt elke 10 minuten de kalender, de standen en de laatste uitslag op bij de Jolpica F1 API (opvolger van Ergast).
- De iPhone stuurt schermkeuze, alerts (safety car, vlaggen, inhaalacties, pitstops, berichten) en helderheid naar de iPad via de server (Server-Sent Events).
- De laatste instellingen en gegevens worden bewaard in het volume `f1data`.

## Live data van F1.com (optioneel)

Open `http://IP-VAN-SERVER:8082/settings.html` (ook via de knop onderaan de afstandsbediening).
Log op een computer in op formula1.com, kopieer de waarde van de cookie `login-session` en plak die op de instellingenpagina.
Daarna verbindt de server rond elke sessie met F1 live timing: het display toont dan automatisch het live klassement
(posities, gaten, banden, ronde, race control) en zet zelf meldingen neer (safety car, VSC, rode/groene vlag, start, finish, inhaalacties).
Na de sessie komt de uitslag (ook van trainingen en kwalificatie) op het uitslagscherm.
Zonder gekoppeld account, of als de sessie verlopen is (meestal na ongeveer een week), blijft alles werken zoals hiervoor.

## Instellingen (omgevingsvariabelen)

| Variabele | Standaard | Uitleg |
|---|---|---|
| `PORT` | `8080` | Poort in de container |
| `REFRESH_MINUTES` | `10` | Hoe vaak F1-gegevens worden opgehaald |
| `JOLPICA_URL` | `https://api.jolpi.ca/ergast/f1` | Bron voor de F1-gegevens |
| `DATA_DIR` | `/data` | Map voor opgeslagen status |
| `SETTINGS_PIN` | – | Pincode voor koppelen/ontkoppelen op de instellingenpagina |

Direct verversen: `curl -X POST http://localhost:8082/api/refresh`

## Let op

- Er is geen login: iedereen op je netwerk kan het display bedienen. Zet de poort niet open naar internet.
- Live timing (posities per ronde, automatische safety car) zit er niet in; die alerts geef je zelf vanaf de iPhone.
