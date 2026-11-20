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
const { LiveClient, parseToken, tokenInfo, summarize } = require('./live');
const PIN = process.env.SETTINGS_PIN || '';
fs.mkdirSync(DATA_DIR, { recursive: true });

const STATE_FILE = path.join(DATA_DIR, 'state.json');
const CACHE_FILE = path.join(DATA_DIR, 'f1data.json');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
let state = readJson(STATE_FILE, null);
let f1 = readJson(CACHE_FILE, null);
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const LIVERES_FILE = path.join(DATA_DIR, 'liveresult.json');
let config = readJson(CONFIG_FILE, {});
let liveResult = readJson(LIVERES_FILE, null);
const saveConfig = () => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config));

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
  if (result) { data.result = result; data.resultAt = Date.parse(`${race.date}T${race.time || '12:00:00Z'}`) + 2 * 3600000; }
  f1 = data;
  fs.writeFileSync(CACHE_FILE, JSON.stringify(f1));
  broadcast('data', pubData());
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


/* ---------- F1.com live timing (alleen met ingesteld account) ---------- */
const AUTO_DEF = { sc: true, vsc: true, red: true, green: true, yellow: false, start: true, finish: true, overtake: true, pit: true, fastest: true, knockout: true };
const DURS = { FP1: 60, FP2: 60, FP3: 60, SQ: 44, SPR: 60, Q: 60, R: 120 };
const delayMs = () => Math.min(300, Math.max(0, +((state || {}).delay) || 0)) * 1000;
const live = new LiveClient(onLive, console.log, delayMs);
const sumNow = () => summarize(live.st, f1 && f1.drv, delayMs());
let liveSum = null, sumTimer = null, connecting = false, lastAttempt = 0;
let prevTrack = null, prevStatus = null, prevPos = null, lastOT = 0, lastFav = 0, prevStints = null, lastFL = 0, koBuf = [], koT = null;
const pitLane = num => { const p = ((live.st.PitLaneTimeCollection || {}).PitTimes || {})[num]; return p && p.Duration ? String(p.Duration) : ''; };

function pubData() {
  if (!f1) return null;
  if (liveResult && liveResult.at > (f1.resultAt || 0)) return { ...f1, result: liveResult, drv: { ...(liveResult.drv || {}), ...f1.drv } };
  return f1;
}
const tokenOk = () => !!(config.token && (!config.exp || config.exp > Date.now()));
function sessionWindow(now) {
  if (!f1) return null;
  for (const r of f1.races) {
    const codes = r[6] === 'S' ? ['FP1', 'SQ', 'SPR', 'Q', 'R'] : ['FP1', 'FP2', 'FP3', 'Q', 'R'];
    const times = r[7].split(' ');
    for (let i = 0; i < times.length; i++) {
      const t = times[i], start = Date.parse((t.length > 11 ? t : f1.season + '-' + t) + ':00Z'), end = start + DURS[codes[i]] * 60000;
      if (now >= start - 20 * 60000 && now <= end + (codes[i] === 'R' ? 120 : 45) * 60000) return { race: r, code: codes[i], start, end };
    }
  }
  return null;
}
async function liveTick() {
  const want = tokenOk() && (process.env.LIVE_ALWAYS === '1' || sessionWindow(Date.now()));
  if (!want) {
    if (live.ws) { live.close(); console.log('[live] geen sessie bezig, verbinding gesloten'); }
    if (liveSum) { liveSum = null; broadcast('live', null); }
    return;
  }
  if (live.ws || connecting || Date.now() - lastAttempt < 20000) return;
  connecting = true; lastAttempt = Date.now();
  try { await live.connect(config.token); console.log('[live] verbonden met F1 live timing'); }
  catch (e) { live.error = e.message; console.error('[live] verbinden mislukt:', e.message); }
  connecting = false;
}
setInterval(liveTick, 15000);
setTimeout(liveTick, 3000);

function autoAlert(kind, a) {
  const auto = { ...AUTO_DEF, ...(config.auto || {}) };
  if (!auto[kind]) return;
  const lap = +((live.st.LapCount || {}).CurrentLap) || null;
  state = { ...(state || {}), alert: { lap, ...a, ts: Date.now(), auto: true } };
  fs.writeFile(STATE_FILE, JSON.stringify(state), () => {});
  broadcast('state', state);
  console.log('[live] automatische melding:', a.type);
}
function favAlert(a) {
  if (!state || !state.fav || state.favAlerts === false) return;
  const lap = +((live.st.LapCount || {}).CurrentLap) || null;
  state = { ...state, alert: { lap, ...a, ts: Date.now(), auto: true, fav: true } };
  fs.writeFile(STATE_FILE, JSON.stringify(state), () => {});
  broadcast('state', state);
  console.log('[live] melding favoriet:', a.type, a.driver);
}
function storeLiveResult(sum) {
  if (!sum || !sum.rows.length) return;
  const lines = (live.st.TimingData || {}).Lines || {}, dl = live.st.DriverList || {};
  const maxLaps = Math.max(0, ...sum.rows.map(r => r[8]));
  const rows = sum.rows.map(r => {
    const num = Object.keys(dl).find(n => dl[n].Tla === r[1]) || '', l = lines[num] || {};
    let gap = sum.mode === 'race' ? (l.GapToLeader || '') : r[5];
    if (/^\+?\d+L$/.test(gap)) gap = '';
    const out = l.Retired || l.Stopped;
    return [r[1], sum.mode === 'race' ? (r[4] != null ? r[0] + r[4] : 0) : 0, sum.mode === 'race' ? r[8] : maxLaps, gap === 'OUT' || gap === 'PIT' ? '' : gap, 0, 0, out ? 'DNF' : ''];
  });
  const extra = {}; for (const r of sum.rows) if (!(f1 && f1.drv && f1.drv[r[1]])) extra[r[1]] = [r[9], r[3], ''];
  liveResult = { gp: sum.gp, sess: sum.sess, round: 0, laps: maxLaps, rows, drv: extra, at: Date.now() };
  fs.writeFile(LIVERES_FILE, JSON.stringify(liveResult), () => {});
  broadcast('data', pubData());
  console.log(`[live] uitslag ${sum.sess} opgeslagen`);
}
function onLive(topic, data) {
  const st = live.st;
  if (topic === 'init') {
    prevTrack = String((st.TrackStatus || {}).Status || ''); prevStatus = (st.SessionStatus || {}).Status || '';
    prevPos = {}; prevStints = {}; for (const r of sumNow().rows) { prevPos[r[1]] = r; prevStints[r[1]] = r[10]; }
  } else if (topic === 'TrackStatus') {
    const c = String((st.TrackStatus || {}).Status || '');
    if (c !== prevTrack) {
      const was = prevTrack; prevTrack = c;
      if (c === '4') autoAlert('sc', { type: 'sc', dur: 15 });
      else if (c === '6') autoAlert('vsc', { type: 'vsc', dur: 15 });
      else if (c === '5') autoAlert('red', { type: 'red', dur: 20 });
      else if (c === '2') autoAlert('yellow', { type: 'yellow', dur: 8 });
      else if (c === '1' && ['4', '5', '6', '7'].includes(was)) autoAlert('green', { type: 'green', dur: 10 });
    }
  } else if (topic === 'SessionStatus') {
    const s = (st.SessionStatus || {}).Status || '', sum = sumNow();
    if (s !== prevStatus) {
      if (s === 'Started' && sum.mode === 'race' && prevStatus !== 'Aborted') autoAlert('start', { type: 'start', dur: 9 });
      if (s === 'Finished') { autoAlert('finish', { type: 'chequered', dur: 20 }); storeLiveResult(sum); }
      if (s === 'Finalised' || s === 'Ends') storeLiveResult(sum);
      prevStatus = s;
    }
  } else if (topic === 'TimingAppData') {
    const fav = state && state.fav, sum = sumNow();
    if (sum.mode === 'race' && prevStints) {
      for (const r of sum.rows) {
        if (prevStints[r[1]] == null || !(r[10] > prevStints[r[1]]) || r[10] < 2) continue;
        const isFav = r[1] === fav;
        if (!isFav && r[0] > 10) continue;
        setTimeout(() => { const s2 = sumNow(), r2 = s2.rows.find(x => x[1] === r[1]) || r;
          const a = { type: 'pit', driver: r2[1], name: r2[9], tyre: r2[6] || '', stops: r2[10] - 1, pos: r2[0], pitlane: pitLane(r2[13]), colour: r2[2], dur: 8 };
          if (isFav && state && state.favAlerts !== false) favAlert(a); else autoAlert('pit', a); }, 3000);
      }
      for (const x of sum.rows) prevStints[x[1]] = x[10];
    }
  } else if (topic === 'TimingData') {
    const sum = sumNow(), lines = (st.TimingData || {}).Lines || {};
    for (const [num, dl] of Object.entries((data && data.Lines) || {})) {
      const full = lines[num] || {}, r = sum.rows.find(x => x[13] === num);
      if (!r) continue;
      if (dl.LastLapTime && dl.LastLapTime.OverallFastest === true && full.LastLapTime && full.LastLapTime.Value) {
        if (sum.mode === 'race' && sum.lap[0] >= 3 && Date.now() - lastFL > 8000) { lastFL = Date.now(); autoAlert('fastest', { type: 'fastest', driver: r[1], name: r[9], time: full.LastLapTime.Value, colour: r[2], dur: 7 }); }
        else if (sum.mode === 'quali' && sum.part >= 3 && Date.now() - lastFL > 4000) { lastFL = Date.now(); autoAlert('fastest', { type: 'pole', driver: r[1], name: r[9], time: full.LastLapTime.Value, colour: r[2], dur: 8 }); }
      }
      if (dl.KnockedOut === true && sum.mode === 'quali' && !koBuf.includes(r[1])) {
        koBuf.push(r[1]); clearTimeout(koT);
        koT = setTimeout(() => { const s2 = sumNow(), order = s2.rows.filter(x => koBuf.includes(x[1])).map(x => x[1]);
          autoAlert('knockout', { type: 'ko', drivers: order.length ? order : koBuf.slice(), part: Math.max(1, (s2.part || 2) - 1), dur: 12 }); koBuf = []; }, 5000);
      }
    }
    if (sum.mode === 'race' && sum.rows.length) {
      const pos = {}; for (const r of sum.rows) pos[r[1]] = r;
      const fav = state && state.fav, F = fav && pos[fav], PF = fav && prevPos && prevPos[fav];
      if (F && PF && F[0] !== PF[0] && (st.SessionStatus || {}).Status === 'Started' && ['1', '2'].includes(prevTrack)
        && F[5] !== 'PIT' && PF[5] !== 'PIT' && F[5] !== 'OUT' && sum.lap[0] >= 1 && Date.now() - lastFav > 5000) {
        lastFav = Date.now(); lastOT = Date.now();
        if (F[0] < PF[0]) {
          const o = sum.rows.find(x => x[0] === F[0] + 1 && prevPos[x[1]] && prevPos[x[1]][0] === F[0]);
          favAlert({ type: 'overtake', driver: fav, name: F[9], pos: F[0], passed: o ? o[1] : null, passedName: o ? o[9] : '', colour: F[2], dur: 7 });
        } else {
          const o = sum.rows.find(x => x[0] === PF[0] && x[1] !== fav);
          favAlert({ type: 'lost', driver: fav, name: F[9], pos: F[0], by: o ? o[1] : null, byName: o ? o[9] : '', colour: F[2], dur: 7 });
        }
      }
      if (prevPos && (st.SessionStatus || {}).Status === 'Started' && prevTrack === '1' && sum.lap[0] >= 2 && Date.now() - lastOT > 12000) {
        for (const r of sum.rows) {
          const was = prevPos[r[1]];
          if (!was || r[0] > 10 || was[0] !== r[0] + 1 || r[5] === 'PIT' || was[5] === 'PIT') continue;
          const other = sum.rows.find(o => o[0] === r[0] + 1 && prevPos[o[1]] && prevPos[o[1]][0] === r[0]);
          if (!other || other[5] === 'PIT' || other[5] === 'OUT') continue;
          lastOT = Date.now();
          autoAlert('overtake', { type: 'overtake', driver: r[1], name: r[9], pos: r[0], passed: other[1], passedName: other[9], colour: r[2], dur: 7 });
          break;
        }
      }
      prevPos = pos;
    }
  }
  if (!sumTimer) sumTimer = setTimeout(() => { sumTimer = null; publishLive(); }, 1000);
}
function publishLive() {
  if (!live.connected) { if (liveSum) { liveSum = null; broadcast('live', null); } return; }
  const sum = sumNow();
  sum.delay = delayMs() / 1000;
  sum.active = sum.rows.length > 0 && ['Started', 'Aborted', 'Finished', 'Suspended'].includes(sum.status);
  sum.at = Date.now();
  liveSum = sum; broadcast('live', sum);
}
setInterval(() => { if (live.connected) publishLive(); }, 5000);

function liveStatus() {
  const w = sessionWindow(Date.now());
  let next = null;
  if (f1) for (const r of f1.races) { const t = r[7].split(' '); for (const x of t) { const s = Date.parse((x.length > 11 ? x : f1.season + '-' + x) + ':00Z'); if (s > Date.now()) { next = { gp: r[1], start: s }; break; } } if (next) break; }
  return { configured: !!config.token, valid: tokenOk(), exp: config.exp || null, product: config.product || '', subStatus: config.subStatus || '',
    savedAt: config.savedAt || null, auto: { ...AUTO_DEF, ...(config.auto || {}) }, pinRequired: !!PIN,
    live: { connected: live.connected, inWindow: !!w, session: liveSum ? `${liveSum.sess} ${liveSum.gp}` : '', status: liveSum ? liveSum.status : '',
      lastMsg: live.lastMsg || null, error: live.error || '' }, next };
}
function readBody(req) {
  return new Promise((res, rej) => { let b = ''; req.on('data', c => { b += c; if (b.length > 50000) req.destroy(); }); req.on('end', () => { try { res(b ? JSON.parse(b) : {}); } catch (e) { rej(e); } }); });
}
const sendJson = (res, code, obj) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(obj));
async function settingsApi(req, res, p) {
  if (p === '/api/f1/status' && req.method === 'GET') return sendJson(res, 200, liveStatus());
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'POST verwacht' });
  let body; try { body = await readBody(req); } catch { return sendJson(res, 400, { error: 'Ongeldige invoer' }); }
  if (PIN && String(body.pin || req.headers['x-pin'] || '') !== PIN) return sendJson(res, 403, { error: 'Onjuiste pincode' });
  if (p === '/api/f1/login') {
    try {
      const { token, info } = parseToken(body.value);
      if (info.exp && info.exp < Date.now()) return sendJson(res, 400, { error: 'Deze sessie is al verlopen. Log opnieuw in op formula1.com en kopieer de cookie opnieuw.' });
      config = { ...config, token, exp: info.exp, product: info.product, subStatus: info.status, savedAt: Date.now() }; saveConfig();
      lastAttempt = 0; live.close(); liveTick();
      return sendJson(res, 200, liveStatus());
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  if (p === '/api/f1/logout') { live.close(); liveSum = null; broadcast('live', null); const { auto } = config; config = { auto }; saveConfig(); return sendJson(res, 200, liveStatus()); }
  if (p === '/api/f1/auto') { const a = {}; for (const k of Object.keys(AUTO_DEF)) if (k in (body.auto || {})) a[k] = !!body.auto[k]; config.auto = { ...(config.auto || {}), ...a }; saveConfig(); return sendJson(res, 200, liveStatus()); }
  if (p === '/api/f1/test') {
    if (!config.token) return sendJson(res, 400, { error: 'Nog geen F1-account gekoppeld.' });
    if (live.connected) return sendJson(res, 200, { ok: true, msg: 'Verbonden: live timing loopt al.' });
    const t = new LiveClient(() => {}, () => {});
    try { await t.connect(config.token); const n = t.initTopics; t.close(); return sendJson(res, 200, { ok: true, msg: `Verbinding gelukt, ${n} datastromen ontvangen.` }); }
    catch (e) { t.close(); return sendJson(res, 502, { error: 'Verbinding mislukt: ' + e.message }); }
  }
  return sendJson(res, 404, { error: 'onbekend' });
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    if (state) res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
    if (f1) res.write(`event: data\ndata: ${JSON.stringify(pubData())}\n\n`);
    if (liveSum) res.write(`event: live\ndata: ${JSON.stringify(liveSum)}\n\n`);
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
  if (url.pathname === '/api/data') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(pubData() || {})); return; }
  if (url.pathname.startsWith('/api/f1/')) { settingsApi(req, res, url.pathname).catch(e => sendJson(res, 500, { error: e.message })); return; }
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
