'use strict';
/**
 * FastCarMeta sunucusu
 *  - HTTP:  GET /api/health, POST /api/score, GET /api/leaderboard
 *  - WS:    /ws  (lobi, eşleşme, yarış içi konum aktarımı, sonuçlar)
 * Veri: bellekte; DATA_FILE'a (varsayılan data/leaderboard.json) kaydedilir.
 * Render ücretsiz planında disk kalıcı değildir: yeniden dağıtımda sıralama sıfırlanabilir (README'ye bak).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'leaderboard.json');
const MAX_ROOM = 8;
const LOBBY_COUNTDOWN = parseFloat(process.env.LOBBY_COUNTDOWN || '12');   // 2. oyuncudan sonra (sn)
const LOBBY_SOLO_WAIT = parseFloat(process.env.LOBBY_SOLO_WAIT || '25');   // tek kişi bekleme (sn)
const GO_DELAY_MS = parseInt(process.env.GO_DELAY_MS || '9000', 10);       // "go" ile gerçek başlangıç arası
const FINISH_GRACE_MS = parseInt(process.env.FINISH_GRACE_MS || '30000', 10);
const MIN_RACE_SECONDS = parseFloat(process.env.MIN_RACE_SECONDS || '30'); // bundan kısa süre kabul edilmez

// ------------------------------------------------------------------ yardımcılar
const now = () => Date.now();
const clean = (s, max = 14, def = 'Player') => {
  s = String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, max);
  return s || def;
};
const num = (v, def = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : def);
const validTrack = (t) => typeof t === 'string' && /^[A-Za-z0-9_\-]{1,32}$/.test(t);
const validId = (t) => typeof t === 'string' && /^[A-Za-z0-9\-]{8,64}$/.test(t);

// ------------------------------------------------------------------ sıralama deposu
let store = { tracks: {} };
try {
  if (fs.existsSync(DATA_FILE)) store = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (!store.tracks) store.tracks = {};
} catch (e) { console.warn('Veri okunamadı, boş başlatılıyor:', e.message); }

let saveTimer = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(store));
      fs.renameSync(tmp, DATA_FILE);
    } catch (e) { console.warn('Veri yazılamadı:', e.message); }
  }, 5000);
}

function submitScore(track, id, name, score, time) {
  const t = (store.tracks[track] = store.tracks[track] || {});
  const cur = t[id];
  const better = !cur || score > cur.score || (score === cur.score && time >= 0 && (cur.time < 0 || time < cur.time));
  if (better) t[id] = { name, score, time, at: now() };
  else cur.name = name;
  scheduleSave();
}

function board(track, limit, id) {
  const t = store.tracks[track] || {};
  const all = Object.entries(t).map(([pid, v]) => ({ id: pid, name: v.name, score: v.score, time: v.time }));
  all.sort((a, b) => b.score - a.score || (a.time < 0 ? 1e9 : a.time) - (b.time < 0 ? 1e9 : b.time));
  const idx = all.findIndex((e) => e.id === id);
  return {
    list: all.slice(0, limit).map((e) => ({ name: e.name, score: e.score, time: e.time, mine: e.id === id })),
    rank: idx >= 0 ? idx + 1 : 0,
    count: all.length,
  };
}

// ------------------------------------------------------------------ HTTP
const buckets = new Map();           // basit IP sınırı: dakikada 60 istek
function limited(ip) {
  const m = Math.floor(now() / 60000);
  const b = buckets.get(ip);
  if (!b || b.m !== m) { buckets.set(ip, { m, n: 1 }); return false; }
  return ++b.n > 60;
}
setInterval(() => { const m = Math.floor(now() / 60000); for (const [k, v] of buckets) if (v.m < m - 1) buckets.delete(k); }, 120000).unref();

function send(res, code, obj) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': typeof obj === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  if (req.method === 'OPTIONS') return send(res, 204, '');
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/health') return send(res, 200, { ok: true, rooms: rooms.size, players: players.size, uptime: Math.round(process.uptime()) });
  if (url.pathname === '/') return send(res, 200, 'FastCarMeta server OK');
  if (limited(ip)) return send(res, 429, { error: 'too_many_requests' });

  if (url.pathname === '/api/leaderboard' && req.method === 'GET') {
    const track = url.searchParams.get('track');
    if (!validTrack(track)) return send(res, 400, { error: 'bad_track' });
    const limit = Math.max(1, Math.min(50, parseInt(url.searchParams.get('limit') || '20', 10)));
    const id = url.searchParams.get('id') || '';
    return send(res, 200, board(track, limit, id));
  }

  if (url.pathname === '/api/score' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2048) req.destroy(); });
    req.on('end', () => {
      try {
        const m = JSON.parse(body);
        const score = Math.round(num(m.score, -1)), time = num(m.time, -1);
        if (!validTrack(m.track) || !validId(m.id) || score < 0 || score > 20000) return send(res, 400, { error: 'bad_request' });
        if (time >= 0 && time < MIN_RACE_SECONDS) return send(res, 400, { error: 'bad_time' });
        submitScore(m.track, m.id, clean(m.name), score, time >= 0 ? time : -1);
        return send(res, 200, board(m.track, 1, m.id));
      } catch (e) { return send(res, 400, { error: 'bad_json' }); }
    });
    return;
  }
  send(res, 404, { error: 'not_found' });
});

// ------------------------------------------------------------------ WebSocket: oyuncular ve odalar
const players = new Map();   // pid -> player
const rooms = new Map();     // roomId -> room
let nextPid = 1, nextRoom = 1;

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });

function tx(p, obj) { if (p.ws.readyState === 1) p.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); }
function roomPlayers(room) { return [...room.players.values()]; }
function pinfo(p) { return { pid: p.pid, name: p.name, car: p.car, slot: p.slot || 0 }; }

function broadcastRoom(room) {
  const left = room.countdownEnd ? Math.max(0, (room.countdownEnd - now()) / 1000) : -1;
  const msg = JSON.stringify({ t: 'room', track: room.track, laps: room.laps, startIn: left, players: roomPlayers(room).map(pinfo) });
  for (const p of room.players.values()) tx(p, msg);
}

function findOrCreateRoom(track, laps) {
  for (const r of rooms.values()) if (r.state === 'lobby' && r.track === track && r.players.size < MAX_ROOM) return r;
  const r = { id: nextRoom++, track, laps, state: 'lobby', players: new Map(), createdAt: now(), countdownEnd: null, solo: false, seed: 0, startAt: 0, firstFinishAt: 0 };
  rooms.set(r.id, r);
  return r;
}

function leaveRoom(p) {
  const room = p.room;
  if (!room) return;
  room.players.delete(p.pid);
  p.room = null;
  if (room.state === 'racing' || room.state === 'done') {
    const msg = JSON.stringify({ t: 'left', pid: p.pid });
    for (const o of room.players.values()) tx(o, msg);
    if (room.state === 'racing') checkResults(room);
  } else broadcastRoom(room);
  if (room.players.size === 0) rooms.delete(room.id);
}

function startRace(room) {
  room.state = 'racing';
  room.seed = 1 + Math.floor(Math.random() * 1000000);
  room.startAt = now() + GO_DELAY_MS;
  const slots = [0, 1, 2, 3, 4, 5, 6, 7].sort(() => Math.random() - 0.5);
  let i = 0;
  for (const p of room.players.values()) { p.slot = slots[i++]; p.finished = false; p.finishTime = -1; p.score = 0; p.lastPose = 0; }
  const msg = JSON.stringify({ t: 'go', track: room.track, laps: room.laps, seed: room.seed, startAt: room.startAt, solo: room.solo, players: roomPlayers(room).map(pinfo) });
  for (const p of room.players.values()) tx(p, msg);
  console.log(`[room ${room.id}] başladı: ${room.track}, ${room.players.size} oyuncu`);
}

function checkResults(room) {
  if (room.state !== 'racing') return;
  const ps = roomPlayers(room);
  const finished = ps.filter((p) => p.finished);
  const allDone = ps.length > 0 && finished.length === ps.length;
  const timeout = room.firstFinishAt && now() - room.firstFinishAt > FINISH_GRACE_MS;
  if (!allDone && !timeout) return;
  room.state = 'done';
  const list = finished.sort((a, b) => a.finishTime - b.finishTime).map((p) => ({ pid: p.pid, name: p.name, time: p.finishTime, score: p.score }));
  const msg = JSON.stringify({ t: 'results', results: list });
  for (const p of ps) tx(p, msg);
  for (const p of finished) submitScore(room.track, p.id, p.name, p.score, p.finishTime);
  setTimeout(() => { for (const p of room.players.values()) p.room = null; rooms.delete(room.id); }, 60000).unref();
}

// 1 sn'lik döngü: lobi geri sayımı ve bitiş zaman aşımı
setInterval(() => {
  const t = now();
  for (const room of rooms.values()) {
    if (room.state === 'lobby') {
      const n = room.players.size;
      if (n >= 2 && !room.countdownEnd) room.countdownEnd = t + LOBBY_COUNTDOWN * 1000;
      if (n === MAX_ROOM && room.countdownEnd && room.countdownEnd - t > 5000) room.countdownEnd = t + 5000;
      if (n === 1 && !room.countdownEnd && t - room.createdAt > LOBBY_SOLO_WAIT * 1000) { room.countdownEnd = t + 3000; room.solo = true; }
      if (n < 2 && room.countdownEnd && !room.solo) room.countdownEnd = null;
      if (room.countdownEnd && t >= room.countdownEnd) { startRace(room); continue; }
      broadcastRoom(room);
    } else if (room.state === 'racing') checkResults(room);
  }
}, 1000);

wss.on('connection', (ws, req) => {
  const p = { pid: nextPid++, ws, id: '', name: 'Player', car: '', room: null, alive: true, slot: 0, finished: false, finishTime: -1, score: 0, lastPose: 0, hello: false };
  players.set(p.pid, p);
  ws.on('pong', () => { p.alive = true; });

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch (e) { return; }
    if (!m || typeof m.t !== 'string') return;

    switch (m.t) {
      case 'hello':
        p.id = validId(m.id) ? m.id : 'anon-' + p.pid + '-' + Math.random().toString(16).slice(2, 10);
        p.name = clean(m.name);
        p.car = clean(m.car, 24, 'sedan');
        p.hello = true;
        tx(p, { t: 'welcome', pid: p.pid, now: now() });
        break;

      case 'ping':
        tx(p, { t: 'pong', c: num(m.c), now: now() });
        break;

      case 'join': {
        if (!p.hello) return tx(p, { t: 'error', err: 'hello_first' });
        if (!validTrack(m.track)) return tx(p, { t: 'error', err: 'bad_track' });
        if (p.room) leaveRoom(p);
        const room = findOrCreateRoom(m.track, Math.max(1, Math.min(10, Math.round(num(m.laps, 3)))));
        room.players.set(p.pid, p);
        p.room = room;
        broadcastRoom(room);
        break;
      }

      case 'leave':
        leaveRoom(p);
        break;

      case 'pose': {
        const room = p.room;
        if (!room || room.state !== 'racing') return;
        const t = now();
        if (t - p.lastPose < 40) return;                      // en çok 25 Hz
        p.lastPose = t;
        p.score = Math.max(0, Math.min(20000, Math.round(num(m.sc))));
        const out = JSON.stringify({
          t: 'pose', pid: p.pid,
          x: num(m.x), y: num(m.y), z: num(m.z),
          qx: num(m.qx), qy: num(m.qy), qz: num(m.qz), qw: num(m.qw, 1),
          vx: num(m.vx), vz: num(m.vz), sp: num(m.sp), sc: p.score,
        });
        for (const o of room.players.values()) if (o !== p) tx(o, out);
        break;
      }

      case 'finish': {
        const room = p.room;
        if (!room || room.state !== 'racing' || p.finished) return;
        const time = num(m.time, -1);
        if (time < MIN_RACE_SECONDS) return;                   // imkânsız süre: yok say
        p.finished = true; p.finishTime = time;
        p.score = Math.max(0, Math.min(20000, Math.round(num(m.sc, p.score))));
        if (!room.firstFinishAt) room.firstFinishAt = now();
        const out = JSON.stringify({ t: 'finished', pid: p.pid, time, sc: p.score });
        for (const o of room.players.values()) tx(o, out);
        checkResults(room);
        break;
      }
    }
  });

  const gone = () => { leaveRoom(p); players.delete(p.pid); };
  ws.on('close', gone);
  ws.on('error', gone);
});

// ölü bağlantıları temizle
setInterval(() => {
  for (const p of players.values()) {
    if (!p.alive) { try { p.ws.terminate(); } catch (e) { /* yoksay */ } continue; }
    p.alive = false;
    try { p.ws.ping(); } catch (e) { /* yoksay */ }
  }
}, 20000).unref();

process.on('SIGTERM', () => {
  try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(store)); } catch (e) { /* yoksay */ }
  process.exit(0);
});

server.listen(PORT, () => console.log(`FastCarMeta sunucusu ${PORT} portunda`));
module.exports = { server };
