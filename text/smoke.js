'use strict';
// Uçtan uca duman testi: sunucuyu kısa zamanlayıcılarla başlatır, iki oyuncu bağlar, yarışı oynatır, sıralamayı doğrular.
process.env.PORT = '3919';
process.env.LOBBY_COUNTDOWN = '2';
process.env.GO_DELAY_MS = '500';
process.env.MIN_RACE_SECONDS = '1';
process.env.DATA_FILE = require('path').join(require('os').tmpdir(), 'fcm-test-' + Date.now() + '.json');
const { server } = require('../server');
const WebSocket = require('ws');
const assert = require('assert');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function client(name, id) {
  const ws = new WebSocket('ws://localhost:3919/ws');
  const c = { ws, msgs: [], name };
  ws.on('message', (d) => c.msgs.push(JSON.parse(d.toString())));
  c.open = new Promise((r) => ws.on('open', r));
  c.send = (o) => ws.send(JSON.stringify(o));
  c.last = (t) => [...c.msgs].reverse().find((m) => m.t === t);
  c.id = id;
  return c;
}

(async () => {
  await wait(300);
  const a = client('Ahmet', 'aaaaaaaa-1111'), b = client('Elif', 'bbbbbbbb-2222');
  await a.open; await b.open;
  a.send({ t: 'hello', id: a.id, name: 'Ahmet', car: 'sedan' });
  b.send({ t: 'hello', id: b.id, name: 'Elif', car: 'taxi' });
  await wait(200);
  assert(a.last('welcome') && b.last('welcome'), 'welcome gelmedi');
  assert.notStrictEqual(a.last('welcome').pid, b.last('welcome').pid);
  a.send({ t: 'join', track: 'Track02', laps: 3 });
  b.send({ t: 'join', track: 'Track02', laps: 3 });
  await wait(3500);
  const goA = a.last('go'), goB = b.last('go');
  assert(goA && goB, 'go gelmedi');
  assert.strictEqual(goA.players.length, 2);
  assert.notStrictEqual(goA.players[0].slot, goA.players[1].slot, 'slotlar farklı olmalı');
  assert.strictEqual(goA.seed, goB.seed, 'tohum ortak olmalı');
  console.log('go OK: tohum', goA.seed, 'slotlar', goA.players.map((p) => p.slot));

  a.send({ t: 'pose', x: 1, y: 2, z: 3, qw: 1, vx: 4, vz: 5, sp: 80, sc: 120 });
  await wait(200);
  const pose = b.last('pose');
  assert(pose && pose.x === 1 && pose.sc === 120, 'pose iletilmedi');
  console.log('pose OK');

  a.send({ t: 'finish', time: 100.5, sc: 300 });
  await wait(100);
  assert(b.last('finished'), 'finished yayını yok');
  b.send({ t: 'finish', time: 110.2, sc: 250 });
  await wait(300);
  const res = a.last('results');
  assert(res && res.results.length === 2 && res.results[0].name === 'Ahmet', 'sonuçlar hatalı');
  console.log('sonuçlar OK:', res.results.map((r) => r.name + ' ' + r.time));

  // REST sıralama
  const http = require('http');
  const get = (p) => new Promise((r) => http.get('http://localhost:3919' + p, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => r(JSON.parse(d))); }));
  const lb = await get('/api/leaderboard?track=Track02&id=' + b.id);
  assert.strictEqual(lb.count, 2);
  assert.strictEqual(lb.list[0].name, 'Ahmet');
  assert.strictEqual(lb.rank, 2);
  console.log('sıralama OK: sıra', lb.rank, '/', lb.count);


  // ---- şehir odası ve "ikisi de" eşleşmesi
  const c1 = client('Can', 'dddddddd-4444'), c2 = client('Deniz', 'eeeeeeee-5555'), c3 = client('Esra', 'ffffffff-6666');
  await c1.open; await c2.open; await c3.open;
  for (const c of [c1, c2, c3]) c.send({ t: 'hello', id: c.id, name: c.name, car: 'sedan' });
  await wait(200);
  c1.send({ t: 'join', mode: 'city', track: 'Track04', laps: 3 });
  await wait(200);
  const g1 = c1.last('go');
  assert(g1 && g1.city === true && g1.track === 'City' && g1.players.length === 1, 'şehir go hatalı');
  c2.send({ t: 'join', mode: 'city' });
  await wait(200);
  const g2 = c2.last('go');
  assert(g2 && g2.city && g2.players.length === 2, 'ikinci oyuncu şehre girmedi');
  const peer = c1.last('peer');
  assert(peer && peer.player.name === 'Deniz', 'peer bildirimi yok');
  assert.notStrictEqual(g2.players[0].slot, g2.players[1].slot, 'şehirde slotlar farklı olmalı');
  c2.send({ t: 'pose', x: 7, y: 1, z: 9, qw: 1, vx: 0, vz: 0, sp: 10, sc: 0 });
  await wait(200);
  assert(c1.last('pose') && c1.last('pose').x === 7, 'şehirde pose iletilmedi');
  console.log('şehir odası OK');

  c3.send({ t: 'join', mode: 'any', track: 'Track05', laps: 3 });      // şehirde 2 kişi var, yarış lobisi boş: şehre gitmeli
  await wait(200);
  const g3 = c3.last('go');
  assert(g3 && g3.city && g3.players.length === 3, 'any: şehre yönlenmedi');
  console.log('any > şehir OK');

  c2.send({ t: 'leave' });
  await wait(200);
  assert(c1.last('left') && c1.last('left').pid === c2.last('welcome').pid, 'şehirde left yayını yok');
  console.log('şehirden çıkış OK');

  const r1 = client('Rana', '11111111-7777'), r2 = client('Reha', '22222222-8888');
  await r1.open; await r2.open;
  r1.send({ t: 'hello', id: r1.id, name: 'Rana', car: 'sedan' }); r2.send({ t: 'hello', id: r2.id, name: 'Reha', car: 'sedan' });
  await wait(200);
  r1.send({ t: 'join', mode: 'race', track: 'Track06', laps: 3 });
  await wait(200);
  r2.send({ t: 'join', mode: 'any', track: 'Track06', laps: 3 });      // yarış lobisinde 1 kişi, şehirde 3 kişi: kalabalık olan şehir
  await wait(200);
  assert(r2.last('go') && r2.last('go').city, 'any: kalabalık şehir seçilmedi');
  console.log('any (kalabalık olan) OK');


  // ---- KVKK/GDPR: silme hakkı ve saklama
  const post = (p, obj) => new Promise((r) => { const body = JSON.stringify(obj); const q = http.request({ host: 'localhost', port: 3919, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => r({ code: res.statusCode, body: JSON.parse(d) })); }); q.write(body); q.end(); });
  const delId = 'del-test-0000-1111';
  assert.strictEqual((await post('/api/score', { track: 'Track03', id: delId, name: 'Silinecek', score: 500, time: 60 })).code, 200);
  assert.strictEqual((await get('/api/leaderboard?track=Track03&id=' + delId)).rank, 1, 'skor yazılmadı');
  const dr = await post('/api/delete', { id: delId });
  assert(dr.code === 200 && dr.body.removed === 1, 'silme çalışmadı');
  assert.strictEqual((await get('/api/leaderboard?track=Track03&id=' + delId)).rank, 0, 'kayıt silinmedi');
  assert.strictEqual((await post('/api/delete', { id: '../x' })).code, 400, 'kötü kimlik reddedilmeli');
  console.log('veri silme OK');

  // tek başına yarış (yapay zekâ dolgusu)
  const s = client('Solo', 'cccccccc-3333');
  await s.open;
  s.send({ t: 'hello', id: s.id, name: 'Solo', car: 'sedan' });
  s.send({ t: 'join', track: 'Track03', laps: 3 });
  console.log('tüm testler geçti');
  process.exit(0);
})().catch((e) => { console.error('TEST HATASI:', e.message); process.exit(1); });
