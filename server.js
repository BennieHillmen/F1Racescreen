// F1 Race Display – kleine server zonder externe packages (Node 20+)
// - serveert de pagina (iPad = #display, iPhone = #remote)
// - houdt de afstandsbediening-status bij en stuurt die live door (Server-Sent Events)
// - haalt kalender, standen en laatste uitslag op bij de Jolpica F1 API
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = +process.env.PORT || 8080;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const API = (process.env.JOLPICA_URL || 'https://api.jolpi.ca/ergast/f1').replace(/\/$/, '');
const REFRESH_MIN = Math.max(2, +process.env.REFRESH_MINUTES || 10);
const PUB = path.join(__dirname, 'public');
fs.mkdirSync(DATA_DIR, { recursive: true });

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const CACHE_FILE = path.join(DATA_DIR, 'f1data.json');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
let state = readJson(STATE_FILE, null);
let f1 = readJson(CACHE_FILE, null);

/* ---------- vertaaltabellen ---------- */
const NAT = { Italian: 'ITA', Dutch: 'NED', British: 'GBR', Monegasque: 'MON', Australian: 'AUS', French: 'FRA', 'New Zealander': 'NZL',
  Argentine: 'ARG', Argentinian: 'ARG', Brazilian: 'BRA', German: 'GER', Spanish: 'ESP', Thai: 'THA', Japanese: 'JPN', Canadian: 'CAN',
  Finnish: 'FIN', Mexican: 'MEX', American: 'USA', Chinese: 'CHN', Danish: 'DEN', Belgian: 'BEL', Austrian: 'AUT' };
const COUNTRY = { Australia: 'AUS', China: 'CHN', Japan: 'JPN', USA: 'USA', 'United States': 'USA', Canada: 'CAN', Monaco: 'MON', Spain: 'ESP',
  Austria: 'AUT', UK: 'GBR', 'United Kingdom': 'GBR', Belgium: 'BEL', Hungary: 'HUN', Netherlands: 'NED', Italy: 'ITA', Azerbaijan: 'AZE',
  Malaysia: 'MYS', Singapore: 'SGP', Mexico: 'MEX', Brazil: 'BRA', Qatar: 'QAT', UAE: 'UAE', 'Saudi Arabia': 'KSA', Bahrain: 'BHR' };
// circuitId -> [korte GP-naam, circuitnaam op het display, aantal ronden]
const CIRC = { albert_park: ['AUSTRALIAN GP', 'ALBERT PARK', 58], shanghai: ['CHINESE GP', 'SHANGHAI', 56], suzuka: ['JAPANESE GP', 'SUZUKA', 53],
  miami: ['MIAMI GP', 'MIAMI', 57], villeneuve: ['CANADIAN GP', 'MONTREAL', 70], monaco: ['MONACO GP', 'MONACO', 78],
  catalunya: [null, 'CATALUNYA', 66], red_bull_ring: ['AUSTRIAN GP', 'RED BULL RING', 71], silverstone: ['BRITISH GP', 'SILVERSTONE', 52],
  spa: ['BELGIAN GP', 'SPA', 44], hungaroring: ['HUNGARIAN GP', 'HUNGARORING', 70], zandvoort: ['DUTCH GP', 'ZANDVOORT', 72],
  monza: ['ITALIAN GP', 'MONZA', 53], madring: [null, 'MADRING', 0], baku: ['AZERBAIJAN GP', 'BAKU', 51], sepang: [null, 'SEPANG', 56],
  marina_bay: ['SINGAPORE GP', 'MARINA BAY', 62], americas: ['UNITED STATES GP', 'COTA AUSTIN', 56], rodriguez: ['MEXICO CITY GP', 'HERMANOS RODRIGUEZ', 71],
  interlagos: ['SAO PAULO GP', 'INTERLAGOS', 71], vegas: ['LAS VEGAS GP', 'LAS VEGAS STRIP', 50], losail: ['QATAR GP', 'LUSAIL', 57],
  yas_marina: ['ABU DHABI GP', 'YAS MARINA', 58], jeddah: ['SAUDI ARABIAN GP', 'JEDDAH', 50], bahrain: ['BAHRAIN GP', 'SAKHIR', 57], imola: ['EMILIA ROMAGNA GP', 'IMOLA', 63] };
const RECORDS = { vegas: '1:33.365 VER 2025' };

const up = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const iso = o => o && o.date ? `${o.date}T${(o.time || '00:00:00').slice(0, 5)}` : null;
const gpName = (race) => (CIRC[race.Circuit.circuitId] || [])[0] || up(race.raceName).replace('GRAND PRIX', 'GP');

async function get(p) {
  const r = await fetch(API + p, { headers: { 'User-Agent': 'f1-race-display/1.0' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
  return (await r.json()).MRData;
}

async function refresh() {
  const sched = await get('/current.json?limit=100');
  const season = +sched.RaceTable.season;
  const races = sched.RaceTable.Races.map(r => {
    const sprint = !!r.Sprint;
    const times = sprint
      ? [iso(r.FirstPractice), iso(r.SprintQualifying || r.SprintShootout), iso(r.Sprint), iso(r.Qualifying), iso(r)]
      : [iso(r.FirstPractice), iso(r.SecondPractice), iso(r.ThirdPractice), iso(r.Qualifying), iso(r)];
    const c = CIRC[r.Circuit.circuitId] || [];
    const fallback = iso(r);
    return [+r.round, gpName(r), c[1] || up(r.Circuit.circuitName), COUNTRY[r.Circuit.Location.country] || '', r.Circuit.circuitId,
      c[2] || 0, sprint ? 'S' : 'N', times.map(t => t || fallback).join(' ')];
  });

  const ds = await get('/current/driverStandings.json?limit=100');
  const dl = ds.StandingsTable.StandingsLists[0];
  const drv = {}, drivers = [];
  if (dl) for (const s of dl.DriverStandings) {
    const d = s.Driver, cons = s.Constructors[s.Constructors.length - 1];
    const code = d.code || up(d.familyName).slice(0, 3);
    drv[code] = [up(d.familyName), NAT[d.nationality] || '', cons ? cons.constructorId : ''];
    drivers.push([code, +s.points, +s.wins]);
  }
  const cs = await get('/current/constructorStandings.json?limit=100');
  const cl = cs.StandingsTable.StandingsLists[0];
  const teams = cl ? cl.ConstructorStandings.map(s => [s.Constructor.constructorId, +s.points, +s.wins]) : [];

  const lr = await get('/current/last/results.json?limit=100');
  const race = lr.RaceTable.Races[0];
  let result = null, grid = [];
  if (race) {
    const res = race.Results;
    const maxLaps = Math.max(...res.map(x => +x.laps));
    result = { gp: gpName(race), sess: 'RACE', round: +race.round, laps: maxLaps, rows: res.map(x => {
      const code = x.Driver.code || up(x.Driver.familyName).slice(0, 3);
      drv[code] = drv[code] || [up(x.Driver.familyName), NAT[x.Driver.nationality] || '', x.Constructor.constructorId];
      drv[code][2] = x.Constructor.constructorId;
      const finished = /^(Finished|Lapped|\+\d+ Laps?)$/.test(x.status);
      return [code, +x.grid, +x.laps, x.Time ? x.Time.time : '', +x.points, x.FastestLap && x.FastestLap.rank === '1' ? 1 : 0, finished ? '' : 'DNF'];
    }) };
    grid = res.map(x => x.Driver.code).filter(Boolean);
  }
  for (const [c] of drivers) if (!grid.includes(c)) grid.push(c);

  const data = { updated: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC', season, standRound: dl ? +dl.round : 0,
    races, drivers: drivers.slice(0, 20), teams, drv, grid, records: RECORDS };
  if (result) data.result = result;
  f1 = data;
  fs.writeFileSync(CACHE_FILE, JSON.stringify(f1));
  broadcast('data', f1);
  console.log(`[f1] bijgewerkt: seizoen ${season}, ${races.length} races, stand na ronde ${data.standRound}`);
}
async function refreshLoop() {
  try { await refresh(); } catch (e) { console.error('[f1] ophalen mislukt:', e.message); }
  setTimeout(refreshLoop, REFRESH_MIN * 60000);
}

/* ---------- live koppeling ---------- */
const clients = new Set();
function broadcast(ev, obj) { const msg = `event: ${ev}\ndata: ${JSON.stringify(obj)}\n\n`; for (const c of clients) c.write(msg); }
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000);

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    if (state) res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
    if (f1) res.write(`event: data\ndata: ${JSON.stringify(f1)}\n\n`);
    clients.add(res); req.on('close', () => clients.delete(res));
    return;
  }
  if (url.pathname === '/api/state' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', () => {
      try { const s = JSON.parse(body); if (!s || typeof s !== 'object' || Array.isArray(s)) throw 0;
        state = s; fs.writeFile(STATE_FILE, JSON.stringify(s), () => {}); broadcast('state', s);
        res.writeHead(204).end();
      } catch { res.writeHead(400).end('bad json'); }
    });
    return;
  }
  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    refresh().then(() => res.writeHead(204).end(), e => res.writeHead(502).end(e.message)); return;
  }
  if (url.pathname === '/api/data') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(f1 || {})); return; }
  if (url.pathname === '/health') { res.writeHead(200).end('ok'); return; }
  let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  if (!p) p = 'index.html';
  const file = path.join(PUB, p);
  if (!file.startsWith(PUB)) { res.writeHead(403).end(); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404).end('niet gevonden'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }).end(buf);
  });
}).listen(PORT, () => { console.log(`F1 Race Display draait op poort ${PORT}`); refreshLoop(); });
