// Live timing van F1.com (livetiming.formula1.com, SignalR Core, JSON-protocol)
// Wordt alleen gebruikt als er een F1-account (login-session cookie) is ingesteld.
'use strict';
const LT = (process.env.F1_LIVE_URL || 'https://livetiming.formula1.com/signalrcore').replace(/\/$/, '');
const TOPICS = ['Heartbeat', 'SessionInfo', 'SessionStatus', 'TrackStatus', 'LapCount', 'TimingData', 'TimingAppData',
  'DriverList', 'RaceControlMessages', 'WeatherData', 'ExtrapolatedClock', 'PitLaneTimeCollection'];
const RS = '\x1e';

/* ---------- token uit cookie of los ---------- */
function parseToken(input) {
  let v = String(input || '').trim().replace(/^login-session=/, '').replace(/^"|"$/g, '');
  if (!v) throw new Error('Leeg veld.');
  let token = null;
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(v)) token = v;
  else {
    for (let i = 0; i < 3 && /%[0-9A-F]{2}/i.test(v); i++) { try { v = decodeURIComponent(v); } catch { break; } }
    try {
      const j = JSON.parse(v);
      token = (j.data && (j.data.subscriptionToken || j.data.SubscriptionToken)) || j.subscriptionToken || j.SubscriptionToken || null;
    } catch {
      const m = v.match(/eyJ[\w-]+\.[\w-]+\.[\w-]+/); if (m) token = m[0];
    }
  }
  if (!token) throw new Error('Geen subscriptionToken gevonden. Kopieer de volledige waarde van de cookie "login-session".');
  const info = tokenInfo(token);
  if (!info) throw new Error('Token kon niet gelezen worden.');
  return { token, info };
}
function tokenInfo(token) {
  try {
    const p = JSON.parse(Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return { exp: p.exp ? p.exp * 1000 : null, product: p.SubscribedProduct || p.subscribedProduct || '', status: p.SubscriptionStatus || p.subscriptionStatus || '' };
  } catch { return null; }
}

/* ---------- delta's samenvoegen ---------- */
function merge(t, d) {
  if (d === null || typeof d !== 'object' || Array.isArray(d)) return d;
  if (Array.isArray(t)) { const a = t.slice(); for (const k of Object.keys(d)) { if (k === '_kf') continue; a[+k] = merge(a[+k], d[k]); } return a; }
  const o = (t && typeof t === 'object') ? { ...t } : {};
  for (const k of Object.keys(d)) { if (k === '_kf') continue; o[k] = merge(o[k], d[k]); }
  return o;
}

class LiveClient {
  constructor(onUpdate, log = console.log, getDelay = () => 0) {
    this.onUpdate = onUpdate; this.log = log; this.getDelay = getDelay;
    this.ws = null; this.st = {}; this.connected = false; this.lastMsg = 0; this.error = ''; this.pingT = null; this.token = null;
    this.q = []; this.initTopics = 0; this.flushT = null;
  }
  // Berichten worden pas verwerkt na de ingestelde vertraging (zodat het display gelijk loopt met je stream)
  flush() {
    const lim = Date.now() - Math.max(0, +this.getDelay() || 0);
    while (this.q.length && this.q[0][0] <= lim) {
      const [, topic, data] = this.q.shift();
      if (topic === '__init') { this.st = {}; for (const [k, v] of Object.entries(data || {})) this.st[k.replace(/\.z$/, '')] = v; this.onUpdate('init'); }
      else { this.st[topic] = merge(this.st[topic], data); this.onUpdate(topic, data); }
    }
  }
  pending() { return this.q.length; }
  async connect(token) {
    this.close(); this.token = token; this.st = {}; this.error = ''; this.q = [];
    clearInterval(this.flushT); this.flushT = setInterval(() => this.flush(), 200);
    const h = { 'User-Agent': 'BestHTTP', Accept: '*/*' };
    if (token) h.Authorization = 'Bearer ' + token;
    const r = await fetch(LT + '/negotiate?negotiateVersion=1', { method: 'POST', headers: h, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('negotiate HTTP ' + r.status);
    const neg = await r.json();
    const cookies = (r.headers.getSetCookie ? r.headers.getSetCookie() : []).map(c => c.split(';')[0]).join('; ');
    let url = LT.replace(/^http/, 'ws') + '?id=' + encodeURIComponent(neg.connectionToken || neg.connectionId);
    if (token) url += '&access_token=' + encodeURIComponent(token);
    const wh = { ...h }; if (cookies) wh.Cookie = cookies;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: wh });
      this.ws = ws; let hand = false, done = false;
      const fin = (e) => { if (done) return; done = true; clearTimeout(to); e ? reject(e) : resolve(); };
      const to = setTimeout(() => { fin(new Error('Geen antwoord van F1 live timing (timeout).')); this.close(); }, 15000);
      ws.onopen = () => ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS);
      ws.onerror = () => { this.error = 'WebSocket-fout'; fin(new Error('WebSocket-fout')); };
      ws.onclose = (ev) => { this.connected = false; clearInterval(this.pingT); if (this.ws === ws) this.ws = null; this.log(`[live] verbinding gesloten (${ev.code})`); fin(new Error('Verbinding gesloten (' + ev.code + ')')); this.onUpdate('close'); };
      ws.onmessage = async (ev) => {
        const txt = typeof ev.data === 'string' ? ev.data : (ev.data && ev.data.text ? await ev.data.text() : Buffer.from(ev.data).toString('utf8'));
        for (const part of txt.split(RS)) {
          if (!part) continue;
          let m; try { m = JSON.parse(part); } catch { continue; }
          if (!hand) {
            hand = true;
            if (m.error) { this.error = m.error; fin(new Error(m.error)); return; }
            ws.send(JSON.stringify({ type: 1, invocationId: '1', target: 'Subscribe', arguments: [TOPICS] }) + RS);
            this.pingT = setInterval(() => { try { ws.send(JSON.stringify({ type: 6 }) + RS); } catch {} }, 15000);
            continue;
          }
          this.lastMsg = Date.now();
          if (m.type === 3 && m.invocationId === '1') {
            if (m.error) { this.error = m.error; fin(new Error(m.error)); continue; }
            this.connected = true; this.initTopics = Object.keys(m.result || {}).length;
            this.q.push([Date.now(), '__init', m.result || {}]);
            fin();
          } else if (m.type === 1 && m.target === 'feed') {
            const [topic, data] = m.arguments || [];
            if (topic) this.q.push([Date.now(), topic, data]);
          } else if (m.type === 7) { this.error = m.error || 'Server sloot de verbinding'; }
        }
      };
    });
  }
  close() { clearInterval(this.pingT); clearInterval(this.flushT); this.q = []; if (this.ws) { const w = this.ws; this.ws = null; try { w.close(); } catch {} } this.connected = false; }
}

/* ---------- samenvatting voor het display ---------- */
const up = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
const SESS = { 'Practice 1': 'FP1', 'Practice 2': 'FP2', 'Practice 3': 'FP3', Qualifying: 'QUALI', 'Sprint Qualifying': 'SPRINT Q', 'Sprint Shootout': 'SPRINT Q', Sprint: 'SPRINT', Race: 'RACE' };
const vals = x => Array.isArray(x) ? x.filter(Boolean) : x && typeof x === 'object' ? Object.keys(x).sort((a, b) => a - b).map(k => x[k]).filter(Boolean) : [];
const val = x => x && typeof x === 'object' ? (x.Value || '') : (x || '');

function summarize(st, drvMap = {}, delayMs = 0) {
  const si = st.SessionInfo || {}, lines = (st.TimingData || {}).Lines || {}, app = (st.TimingAppData || {}).Lines || {}, dl = st.DriverList || {};
  const name = si.Name || '', type = si.Type || '';
  const mode = /Race|^Sprint$/.test(type) && !/Qualifying|Shootout/.test(name) ? 'race' : /Qualifying|Shootout/.test(name + type) ? 'quali' : 'practice';
  const rows = [];
  for (const [num, l] of Object.entries(lines)) {
    const pos = +l.Position || +l.Line; if (!pos) continue;
    const d = dl[num] || {}, a = app[num] || {};
    const code = d.Tla || num;
    const stints = vals(a.Stints), last = stints[stints.length - 1] || {};
    let gap = '';
    if (mode === 'race') gap = pos === 1 ? 'LEADER' : (val(l.IntervalToPositionAhead) || l.GapToLeader || '');
    else if (mode === 'quali') { const b = vals(l.BestLapTimes).map(val).filter(Boolean); gap = b[b.length - 1] || val(l.BestLapTime); }
    else gap = pos === 1 ? val(l.BestLapTime) : (val(l.TimeDiffToFastest) || val(l.BestLapTime));
    if (/^\d+L$/.test(gap)) gap = '+' + gap.replace('L', ' LAP');
    const grid = +a.GridPos || 0;
    const flag = d.CountryCode || (drvMap[code] && drvMap[code][1]) || '';
    rows.push([pos, code, d.TeamColour ? '#' + d.TeamColour : '', flag, mode === 'race' && grid ? grid - pos : null,
      l.Retired || l.Stopped ? 'OUT' : l.InPit ? 'PIT' : gap, (last.Compound || '').charAt(0), +last.TotalLaps || 0, +l.NumberOfLaps || 0,
      up(d.LastName || (drvMap[code] || [])[0] || code), stints.length, +l.NumberOfPitStops || 0, !!l.KnockedOut, num]);
  }
  rows.sort((a, b) => a[0] - b[0]);
  const tdAll = st.TimingData || {}, part = +tdAll.SessionPart || 0, ne = vals(tdAll.NoEntries).length ? (Array.isArray(tdAll.NoEntries) ? tdAll.NoEntries : vals(tdAll.NoEntries)) : [];
  const cutoff = mode === 'quali' && part && ne[part] ? +ne[part] : 0;
  const rc = vals((st.RaceControlMessages || {}).Messages), lastRc = rc[rc.length - 1];
  const lc = st.LapCount || {}, w = st.WeatherData || {}, ts = st.TrackStatus || {}, ss = st.SessionStatus || {}, clk = st.ExtrapolatedClock || {};
  let remaining = clk.Remaining || '';
  if (clk.Extrapolating && clk.Utc && remaining) {
    const [h, m, s] = remaining.split(':').map(Number), left = Math.max(0, (h * 3600 + m * 60 + s) * 1000 - (Date.now() - delayMs - Date.parse(clk.Utc)));
    const t = Math.floor(left / 1000); remaining = [Math.floor(t / 3600), Math.floor(t % 3600 / 60), t % 60].map(n => String(n).padStart(2, '0')).join(':');
  }
  return {
    gp: up((si.Meeting || {}).Name || '').replace('GRAND PRIX', 'GP'), sess: SESS[name] || up(name), mode, status: ss.Status || '',
    track: { code: String(ts.Status || ''), msg: ts.Message || '' }, lap: [+lc.CurrentLap || 0, +lc.TotalLaps || 0], remaining,
    weather: { air: w.AirTemp || '', track: w.TrackTemp || '', rain: w.Rainfall === '1' || w.Rainfall === 1 },
    rcm: lastRc ? { text: up(lastRc.Message || ''), utc: lastRc.Utc || '' } : null, rows, part, cutoff,
  };
}

module.exports = { LiveClient, parseToken, tokenInfo, summarize, merge, TOPICS };
