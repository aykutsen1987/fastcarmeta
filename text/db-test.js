'use strict';
// Neon/PostgreSQL katmanı testi (bellek içi sahte PostgreSQL: pg-mem). Gerçek veritabanı gerekmez.
const assert = require('assert');
const { newDb } = require('pg-mem');
const dbmod = require('../db');

(async () => {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const db = await dbmod.open('postgres://test', Pool);

  await db.upsert('Track01', 'aaaaaaaa-1111', { name: 'Ali', score: 100, time: 55.5, at: Date.now() });
  await db.upsert('Track01', 'bbbbbbbb-2222', { name: 'Veli', score: 80, time: 60, at: Date.now() });
  await db.upsert('Track02', 'aaaaaaaa-1111', { name: 'Ali', score: 90, time: 50, at: Date.now() });
  await db.upsert('Track01', 'aaaaaaaa-1111', { name: 'Ali', score: 120, time: 54, at: Date.now() });   // aynı kayıt güncellenir
  await db.updateName('Track01', 'bbbbbbbb-2222', 'Veli2');

  let all = await db.loadAll();
  assert.strictEqual(all.Track01['aaaaaaaa-1111'].score, 120, 'güncelleme');
  assert.strictEqual(all.Track01['bbbbbbbb-2222'].name, 'Veli2', 'ad güncelleme');
  assert.strictEqual(Object.keys(all.Track01).length, 2);
  console.log('db yükleme/yazma OK');

  assert.strictEqual(await db.deleteById('aaaaaaaa-1111'), 2, 'iki pistten silinmeli');
  all = await db.loadAll();
  assert(!all.Track01['aaaaaaaa-1111'] && !all.Track02, 'silme');
  console.log('db silme OK');

  await db.upsert('Track03', 'cccccccc-3333', { name: 'Eski', score: 10, time: 1, at: Date.now() - 400 * 86400000 });
  assert.strictEqual(await db.purgeOlderThan(Date.now() - 365 * 86400000), 1, 'eski kayıt silinmeli');
  all = await db.loadAll();
  assert(!all.Track03, 'saklama süresi');
  console.log('db saklama süresi OK');
  console.log('veritabanı testleri geçti');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
