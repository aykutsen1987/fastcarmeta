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

  // tek başına yarış (yapay zekâ dolgusu)
  const s = client('Solo', 'cccccccc-3333');
  await s.open;
  s.send({ t: 'hello', id: s.id, name: 'Solo', car: 'sedan' });
  s.send({ t: 'join', track: 'Track03', laps: 3 });
  console.log('tüm testler geçti');
  process.exit(0);
})().catch((e) => { console.error('TEST HATASI:', e.message); process.exit(1); });
