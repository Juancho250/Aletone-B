const router = require('express').Router();
const { db } = require('../config/db');
const { scSearch } = require('../services/soundcloud');

const memoryCache = new Map();
const CACHE_TTL_MS = 90_000;
const DB_FAST_HIT = 8;

function normalizeQuery(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 120);
}

function fromDb(row) {
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  return {
    id: row.id,
    externalId: row.external_id || metadata.externalId || '',
    title: row.title || '',
    artist: row.artist || '',
    album: row.album || '',
    thumbnail: row.thumbnail || '',
    duration: Number(row.duration || 0),
    durationStr: metadata.durationStr || '',
    source: row.source,
    genre: metadata.genre || '',
    permalink: metadata.permalink || '',
    releaseDate: metadata.releaseDate || null,
    playbackCount: Number(metadata.playbackCount || 0),
    likesCount: Number(metadata.likesCount || 0),
    repostsCount: Number(metadata.repostsCount || 0),
    access: 'playable',
    streamable: true,
    fullStream: true,
    isPreview: false,
  };
}

async function saveTracks(tracks) {
  if (!tracks?.length) return;
  await Promise.allSettled(tracks.map(track => db.query(
    `INSERT INTO tracks (
       id, source, external_id, title, artist, album, thumbnail, duration, metadata, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,NOW())
     ON CONFLICT (id) DO UPDATE SET
       source = EXCLUDED.source,
       external_id = COALESCE(EXCLUDED.external_id, tracks.external_id),
       title = EXCLUDED.title,
       artist = EXCLUDED.artist,
       album = EXCLUDED.album,
       thumbnail = EXCLUDED.thumbnail,
       duration = EXCLUDED.duration,
       metadata = tracks.metadata || EXCLUDED.metadata,
       updated_at = NOW()`,
    [
      track.id,
      track.source,
      track.externalId || null,
      track.title,
      track.artist || null,
      track.album || null,
      track.thumbnail || null,
      track.duration || null,
      JSON.stringify({
        durationStr: track.durationStr || '',
        genre: track.genre || '',
        permalink: track.permalink || '',
        releaseDate: track.releaseDate || null,
        playbackCount: track.playbackCount || 0,
        likesCount: track.likesCount || 0,
        repostsCount: track.repostsCount || 0,
        fullStream: true,
      }),
    ]
  )));
}

async function localSearch(q, limit) {
  const pattern = `%${q.toLowerCase()}%`;
  const rows = await db.all(
    `SELECT id, source, external_id, title, artist, album, thumbnail, duration, metadata
     FROM tracks
     WHERE source = 'soundcloud'
       AND (
         LOWER(title) LIKE $1 OR
         LOWER(COALESCE(artist, '')) LIKE $1 OR
         LOWER(COALESCE(album, '')) LIKE $1
       )
     ORDER BY
       CASE
         WHEN LOWER(title) = LOWER($2) THEN 0
         WHEN LOWER(COALESCE(artist, '')) = LOWER($2) THEN 1
         WHEN LOWER(title) LIKE LOWER($2) || '%' THEN 2
         ELSE 3
       END,
       updated_at DESC
     LIMIT $3`,
    [pattern, q, limit]
  );
  return rows.map(fromDb);
}

async function providerSearch(q, limit) {
  const tracks = await scSearch(q, Math.min(Math.max(limit + 8, 15), 40));
  const deduped = [];
  const seen = new Set();

  for (const track of tracks) {
    const key = `${track.title}`.trim().toLowerCase() + '|' + `${track.artist}`.trim().toLowerCase();
    if (!track.fullStream || seen.has(key)) continue;
    seen.add(key);
    deduped.push(track);
    if (deduped.length >= limit) break;
  }

  memoryCache.set(q.toLowerCase(), { at: Date.now(), results: deduped });
  saveTracks(deduped).catch(error => console.warn('[Search cache]', error.message));
  return deduped;
}

router.get('/', async (req, res) => {
  const q = normalizeQuery(req.query.q);
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 30);
  if (!q) return res.status(400).json({ error: 'Falta el parámetro q' });

  const cacheKey = q.toLowerCase();
  const cached = memoryCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return res.json({ results: cached.results.slice(0, limit), source: 'aletone-cache', cached: true });
  }

  try {
    // Tracks que Aletone ya conoce salen desde Neon en milisegundos. En paralelo
    // renovamos el catálogo sin bloquear al usuario.
    const local = await localSearch(q, limit);
    if (local.length >= Math.min(DB_FAST_HIT, limit)) {
      providerSearch(q, limit).catch(error => console.warn('[Search refresh]', error.message));
      return res.json({ results: local.slice(0, limit), source: 'aletone-index', cached: true, refreshing: true });
    }
  } catch (error) {
    console.warn('[Search local]', error.message);
  }

  try {
    const results = await providerSearch(q, limit);
    if (!results.length) {
      return res.status(404).json({
        error: 'No encontramos una versión completa reproducible de esta búsqueda.',
      });
    }
    console.log(`[Search] "${q}" full:${results.length}`);
    return res.json({ results, source: 'soundcloud-full', cached: false });
  } catch (error) {
    console.warn('[SC search]', error.message);
    try {
      const local = await localSearch(q, limit);
      if (local.length) return res.json({ results: local, source: 'aletone-index', cached: true, stale: true });
    } catch (_) {}
    return res.status(503).json({ error: 'No fue posible consultar el catálogo completo en este momento.' });
  }
});

module.exports = router;
