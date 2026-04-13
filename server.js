require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { initDB } = require('./src/config/db');
const { getSCClientId } = require('./src/services/soundcloud');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middlewares globales ──────────────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], allowedHeaders: ['*'] }));
app.options('*', cors());
app.use(express.json());
app.use('/downloads', express.static(path.join(__dirname, 'downloads')));

// ─── Rutas ─────────────────────────────────────────────────────────────────────
app.use('/api/auth',            require('./src/routes/auth'));
app.use('/api/playlists',       require('./src/routes/playlists'));
app.use('/api/history',         require('./src/routes/history'));
app.use('/api/recommendations', require('./src/routes/recommendations'));
app.use('/api/search',          require('./src/routes/search'));
app.use('/api/stream',          require('./src/routes/stream'));

// ─── Health ────────────────────────────────────────────────────────────────────
app.get('/', (_req, res) =>
  res.json({ status: 'ok', version: 'Aletone API v10 · Postgres + Neon' })
);

app.get('/api/health', async (_req, res) => {
  const { db } = require('./src/config/db');
  const { fetchJSON } = require('./src/utils/helpers');
  const [sc, dz, dbCheck] = await Promise.allSettled([
    getSCClientId().then((id) => ({ ok: true, clientId: id.substring(0, 8) + '...' })),
    fetchJSON('https://api.deezer.com/search?q=test&limit=1').then((d) => ({ ok: true, results: d.data?.length })),
    db.one('SELECT COUNT(*)::int AS n FROM users').then((r) => ({ ok: true, users: r.n })),
  ]);
  res.json({
    soundcloud: sc.status === 'fulfilled' ? sc.value : { ok: false, error: sc.reason?.message },
    deezer:     dz.status === 'fulfilled' ? dz.value : { ok: false, error: dz.reason?.message },
    database:   dbCheck.status === 'fulfilled' ? dbCheck.value : { ok: false, error: dbCheck.reason?.message },
    ts: new Date().toISOString(),
  });
});

// ─── Arrancar ──────────────────────────────────────────────────────────────────
initDB()
  .then(() => getSCClientId().catch((e) => console.warn('[SC] Precarga falló:', e.message)))
  .then(() => app.listen(PORT, () => console.log(`Aletone API v10 corriendo en puerto ${PORT}`)))
  .catch((e) => {
    console.error('[FATAL] No se pudo conectar a la DB:', e.message);
    process.exit(1);
  });