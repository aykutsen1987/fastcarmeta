'use strict';
/**
 * Kalıcı veri: Neon (PostgreSQL). DATABASE_URL tanımlıysa kullanılır; yoksa sunucu JSON dosyasına yazar.
 * Tablo ilk açılışta kendiliğinden oluşur. Veri küçük olduğu için açılışta belleğe yüklenir, yazma/silme veritabanına da yansır.
 */
async function open(url, PoolClass) {
  const Pool = PoolClass || require('pg').Pool;
  const pool = new Pool({
    connectionString: url,
    ssl: PoolClass ? undefined : { rejectUnauthorized: false },   // Neon SSL ister
    max: 3,
    idleTimeoutMillis: 20000,
    connectionTimeoutMillis: 15000,
  });
  pool.on('error', (e) => console.warn('Veritabanı bağlantı hatası (yeniden denenecek):', e.message));   // Neon boşta bağlantıyı kapatabilir

  await pool.query(`CREATE TABLE IF NOT EXISTS scores (
    track TEXT NOT NULL,
    id    TEXT NOT NULL,
    name  TEXT NOT NULL,
    score INTEGER NOT NULL,
    time  DOUBLE PRECISION NOT NULL,
    at    BIGINT NOT NULL,
    PRIMARY KEY (track, id)
  )`);

  return {
    async loadAll() {
      const r = await pool.query('SELECT track, id, name, score, time, at FROM scores');
      const tracks = {};
      for (const row of r.rows) {
        (tracks[row.track] = tracks[row.track] || {})[row.id] = { name: row.name, score: Number(row.score), time: Number(row.time), at: Number(row.at) };
      }
      return tracks;
    },
    upsert(track, id, v) {
      return pool.query(
        `INSERT INTO scores (track, id, name, score, time, at) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (track, id) DO UPDATE SET name = EXCLUDED.name, score = EXCLUDED.score, time = EXCLUDED.time, at = EXCLUDED.at`,
        [track, id, v.name, v.score, v.time, v.at]);
    },
    updateName(track, id, name) { return pool.query('UPDATE scores SET name = $3 WHERE track = $1 AND id = $2', [track, id, name]); },
    async deleteById(id) { const r = await pool.query('DELETE FROM scores WHERE id = $1', [id]); return r.rowCount; },
    async purgeOlderThan(ms) { const r = await pool.query('DELETE FROM scores WHERE at < $1', [ms]); return r.rowCount; },
    close() { return pool.end(); },
  };
}

module.exports = { open };
