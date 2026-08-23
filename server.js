require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const { initDB } = require('./src/config/db');
const { warmSoundCloud, soundCloudMode } = require('./src/services/soundcloud');
const { providerStatus: audiusStatus, trendingTracks: audiusTrending } = require('./src/providers/audius');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.disable('x-powered-by');
app.set('trust proxy', 1);

function getAllowedOrigins() {
  return String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean);
}

const allowedOrigins = getAllowedOrigins();
const corsOptions = {
  origin(origin, callback) {
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('Origen no permitido por CORS'));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Range'],
  exposedHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges'],
  maxAge: 86400,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json({ limit: '256kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), microphone=()');
  next();
});

app.use('/downloads', express.static(path.join(__dirname, 'downloads'), {
  fallthrough: true,
  maxAge: '1h',
  setHeaders(res) {
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Accept-Ranges', 'bytes');
  },
}));

app.use('/api/auth',            require('./src/routes/auth'));
app.use('/api/playlists',       require('./src/routes/playlists'));
app.use('/api/history',         require('./src/routes/history'));
app.use('/api/recommendations', require('./src/routes/recommendationsV2'));
app.use('/api/radio',           require('./src/routes/radioV2'));
app.use('/api/saved',           require('./src/routes/saved'));
app.use('/api/search-history',  require('./src/routes/searchHistory'));
app.use('/api/search',          require('./src/routes/searchV2'));
app.use('/api/stream',          require('./src/routes/stream'));
app.use('/api/devices',         require('./src/routes/devices'));

app.get('/healthz', (_req, res) => {
  res.status(200).json({ ok: true, service: 'aleon-api', version: '20' });
});

app.get('/', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'aleon-api',
    version: '20',
    brand: 'ALEON',
    connect: true,
    tasteGraph: 'v2',
    radio: 'v2',
    search: 'unified-catalog-v1',
    playback: 'audius-range-v1',
    providers: {
      catalog: 'deezer',
      playbackPrimary: 'audius',
      playbackFallback: 'soundcloud-canonical-only',
    },
  });
});

app.get('/api/health', async (_req, res) => {
  const { db } = require('./src/config/db');
  const { fetchJSON } = require('./src/utils/helpers');
  const { getStreamResolverStats } = require('./src/services/streamResolver');

  const [audius, deezer, dbCheck] = await Promise.allSettled([
    audiusTrending(1).then(rows => ({ ...audiusStatus(), results: rows.length })),
    fetchJSON('https://api.deezer.com/search?q=test&limit=1').then(data => ({ ok: true, results: data.data?.length || 0 })),
    db.one('SELECT COUNT(*)::int AS n FROM users').then(row => ({ ok: true, users: row?.n || 0 })),
  ]);

  res.json({
    ok: true,
    version: '20',
    brand: 'ALEON',
    connect: true,
    tasteGraph: 'v2',
    radio: 'v2',
    search: 'unified-catalog-v1',
    playback: 'audius-range-v1',
    audius: audius.status === 'fulfilled' ? audius.value : { ok: false, error: audius.reason?.message },
    deezer: deezer.status === 'fulfilled' ? deezer.value : { ok: false, error: deezer.reason?.message },
    soundcloudFallback: { mode: soundCloudMode(), resolver: getStreamResolverStats() },
    database: dbCheck.status === 'fulfilled' ? dbCheck.value : { ok: false, error: dbCheck.reason?.message },
    ts: new Date().toISOString(),
  });
});

app.use((err, _req, res, next) => {
  if (res.headersSent) return next(err);
  if (err?.message === 'Origen no permitido por CORS') return res.status(403).json({ error: 'Origen no permitido' });
  console.error('[HTTP]', err);
  return res.status(500).json({ error: 'Error interno del servidor' });
});

let server;
initDB()
  .then(() => {
    server = app.listen(PORT, () => {
      console.log(`ALEON API v20 corriendo en puerto ${PORT} · Audius primary · Deezer catalog`);
    });
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;

    // SoundCloud is now a canonical-only fallback. Warming it must never delay startup.
    warmSoundCloud().catch(error => console.warn('[SC fallback] Precarga omitida:', error.message));
  })
  .catch(error => {
    console.error('[FATAL] No se pudo conectar a la DB:', error.message);
    process.exit(1);
  });

function shutdown(signal) {
  console.log(`[${signal}] Cerrando ALEON API…`);
  if (!server) process.exit(0);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
