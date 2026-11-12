'use strict';
/**
 * FastCarMeta sunucusu
 *  - HTTP:  GET /api/health, POST /api/score, GET /api/leaderboard, POST /api/delete (KVKK/GDPR: kullanıcının verisini siler)
 *  - WS:    /ws  (lobi, eşleşme, yarış içi konum aktarımı, sonuçlar)
 * Veri: bellekte tutulur. DATABASE_URL (Neon PostgreSQL) tanımlıysa KALICI olarak veritabanına yazılır (db.js);
 * tanımlı değilse DATA_FILE'a (varsayılan data/leaderboard.json) kaydedilir. Render ücretsiz planında disk kalıcı değildir.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data', 'leaderboard.json');
const MAX_ROOM = 8;
const MAX_CITY = 12;                                                        // şehir odası kapasitesi
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

let db = null;                      // DATABASE_URL varsa db.js nesnesi
const dbLog = (what) => (e) => console.warn('Veritabanı hatası (' + what + '):', e.message);

let saveTimer = null;
function scheduleSave() {
  if (db) return;                   // veritabanı modunda dosyaya yazılmaz
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
  if (better) {
    t[id] = { name, score, time, at: now() };
    if (db) db.upsert(track, id, t[id]).catch(dbLog('score'));
  } else if (cur.name !== name) {
    cur.name = name;
    if (db) db.updateName(track, id, name).catch(dbLog('name'));
  }
  scheduleSave();
}

// KVKK/GDPR silme hakkı: bir cihaz kimliğine ait tüm sıralama kayıtlarını siler.
function deleteById(id) {
  let removed = 0;
  for (const t of Object.values(store.tracks)) if (t[id]) { delete t[id]; removed++; }
  if (db) db.deleteById(id).catch(dbLog('delete'));      // KVKK: kalıcı depodan da silinir
  if (removed) scheduleSave();
  return removed;
}

// Saklama süresi: 365 günden eski sıralama kayıtları otomatik silinir (gizlilik politikasında yazar).
const RETENTION_MS = parseInt(process.env.RETENTION_DAYS || '365', 10) * 86400000;
function purgeOld() {
  const limit = now() - RETENTION_MS;
  let n = 0;
  for (const t of Object.values(store.tracks)) for (const [id, v] of Object.entries(t)) if ((v.at || 0) < limit) { delete t[id]; n++; }
  if (db) db.purgeOlderThan(limit).catch(dbLog('purge'));
  if (n) { scheduleSave(); console.log('Saklama süresi dolan kayıt silindi:', n); }
}
setInterval(purgeOld, 6 * 3600 * 1000).unref();

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

  if (url.pathname === '/api/health') return send(res, 200, { ok: true, rooms: rooms.size, cityRooms: [...rooms.values()].filter((r) => r.kind === 'city').length, players: players.size, uptime: Math.round(process.uptime()) });
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

  if (url.pathname === '/api/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1024) req.destroy(); });
    req.on('end', () => {
      try {
        const m = JSON.parse(body);
        if (!validId(m.id)) return send(res, 400, { error: 'bad_id' });
        const removed = deleteById(m.id);
        for (const p of players.values()) if (p.id === m.id) p.id = 'deleted-' + p.pid;   // açık bağlantı aynı kimlikle tekrar kayıt yazmasın
        return send(res, 200, { ok: true, removed });
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
  for (const r of rooms.values()) if (r.kind !== 'city' && r.state === 'lobby' && r.track === track && r.players.size < MAX_ROOM) return r;
  const r = { id: nextRoom++, kind: 'race', track, laps, state: 'lobby', players: new Map(), createdAt: now(), countdownEnd: null, solo: false, seed: 0, startAt: 0, firstFinishAt: 0 };
  rooms.set(r.id, r);
  return r;
}

// ---- Şehir odası: açık dünya. Geri sayım ve sonuç yok; oyuncu girince hemen oynar, çıkınca diğerlerinden silinir.
function openCityRoom() {
  for (const r of rooms.values()) if (r.kind === 'city' && r.players.size < MAX_CITY) return r;
  return null;
}

function joinCity(p) {
  let room = openCityRoom();
  if (!room) {
    room = { id: nextRoom++, kind: 'city', track: 'City', laps: 0, state: 'city', players: new Map(), createdAt: now(), countdownEnd: null, solo: false, seed: 1 + Math.floor(Math.random() * 1000000), startAt: 0, firstFinishAt: 0 };
    rooms.set(room.id, room);
  }
  const used = new Set([...room.players.values()].map((o) => o.slot));
  let slot = 0;
  while (used.has(slot)) slot++;
  p.slot = slot; p.finished = false; p.finishTime = -1; p.score = 0; p.lastPose = 0;
  room.players.set(p.pid, p);
  p.room = room;
  const list = roomPlayers(room).map(pinfo);
  tx(p, { t: 'go', track: 'City', city: true, laps: 0, seed: room.seed, startAt: now(), solo: false, players: list });
  const peer = JSON.stringify({ t: 'peer', player: pinfo(p) });
  for (const o of room.players.values()) if (o !== p) tx(o, peer);
  console.log(`[city ${room.id}] oyuncu #${p.pid} girdi (${room.players.size}/${MAX_CITY})`);
}

// "İkisi de" seçili oyuncu: oyuncusu olan yarış lobisi ile şehir odasından kalabalık olana gider (eşitse yarış; ikisi de boşsa yarış lobisinde bekler).
function pickForAny(track) {
  let race = null, city = null;
  for (const r of rooms.values()) {
    if (r.kind === 'city') { if (r.players.size > 0 && r.players.size < MAX_CITY && (!city || r.players.size > city.players.size)) city = r; }
    else if (r.state === 'lobby' && r.track === track && r.players.size > 0 && r.players.size < MAX_ROOM && (!race || r.players.size > race.players.size)) race = r;
  }
  if (race && city) return city.players.size > race.players.size ? 'city' : 'race';
  if (city) return 'city';
  return 'race';
}

function leaveRoom(p) {
  const room = p.room;
  if (!room) return;
  room.players.delete(p.pid);
  p.room = null;
  if (room.state === 'racing' || room.state === 'done' || room.state === 'city') {
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
        // mode: 'race' (varsayılan), 'city' veya 'any' (hangisi doluysa oraya)
        const mode = m.mode === 'city' || m.mode === 'any' ? m.mode : 'race';
        if (mode !== 'city' && !validTrack(m.track)) return tx(p, { t: 'error', err: 'bad_track' });
        if (p.room) leaveRoom(p);
        if (mode === 'city' || (mode === 'any' && pickForAny(m.track) === 'city')) { joinCity(p); break; }
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
        if (!room || (room.state !== 'racing' && room.state !== 'city')) return;
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
  if (db) process.exit(0);          // veriler zaten veritabanında
  try { fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true }); fs.writeFileSync(DATA_FILE, JSON.stringify(store)); } catch (e) { /* yoksay */ }
  process.exit(0);
});

// Açılış: DATABASE_URL varsa önce veritabanından yükle, sonra dinlemeye başla.
async function start() {
  if (process.env.DATABASE_URL) {
    try {
      db = await require('./db').open(process.env.DATABASE_URL);
      store.tracks = await db.loadAll();
      console.log('Veritabanı bağlandı (Neon/PostgreSQL), kayıtlı pist sayısı:', Object.keys(store.tracks).length);
    } catch (e) {
      console.error('Veritabanına bağlanılamadı, dosya moduna dönülüyor:', e.message);
      db = null;
    }
  } else {
    console.log('DATABASE_URL yok: veriler dosyaya yazılacak (Render ücretsiz planda kalıcı değildir).');
  }
  purgeOld();
  server.listen(PORT, () => console.log(`FastCarMeta sunucusu ${PORT} portunda`));
}
start();
module.exports = { server };
