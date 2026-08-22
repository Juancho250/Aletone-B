const router = require('express').Router();
const { db } = require('../config/db');
const { scSearch } = require('../services/soundcloud');

const memoryCache = new Map();
const CACHE_TTL_MS = 90_000;
const DB_FAST_HIT = 8;
const CATALOG_VERSION = 'sc-playable-v2';

function normalizeQuery(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 120);
}

function fromDb(row) {
  const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
  const verified = metadata.catalogVersion === CATALOG_VERSION && metadata.streamVerified === true;

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
    access: metadata.access || 'playable',
    streamable: verified,
    fullStream: verified,
    streamVerified: verified,
    isPreview: false,
    providerMode: metadata.providerMode || 'unknown',
  };
}

async function saveTracks(tracks) {
  const verifiedTracks = (tracks || []).filter(track => track?.fullStream && track?.streamVerified !== false);
  if (!verifiedTracks.length) return;

  await Promise.allSettled(verifiedTracks.map(track => db.query(
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
        access: track.access || 'playable',
        providerMode: track.providerMode || 'unknown',
        fullStream: true,
        streamVerified: true,
        catalogVersion: CATALOG_VERSION,
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
       AND metadata->>'catalogVersion' = $2
       AND metadata->>'streamVerified' = 'true'
       AND (
         LOWER(title) LIKE $1 OR
         LOWER(COALESCE(artist, '')) LIKE $1 OR
         LOWER(COALESCE(album, '')) LIKE $1
       )
     ORDER BY
       CASE
         WHEN LOWER(title) = LOWER($3) THEN 0
         WHEN LOWER(COALESCE(artist, '')) = LOWER($3) THEN 1
         WHEN LOWER(title) LIKE LOWER($3) || '%' THEN 2
         ELSE 3
       END,
       updated_at DESC
     LIMIT $4`,
    [pattern, CATALOG_VERSION, q, limit]
  );
  return rows.map(fromDb).filter(track => track.fullStream);
}

async function providerSearch(q, limit) {
  // En modo público hay mucho contenido preview entre los primeros resultados.
  // Pedimos una ventana más amplia y solo conservamos pistas verificadas como full.
  const candidateLimit = Math.min(Math.max(limit * 3, 30), 50);
  const tracks = await scSearch(q, candidateLimit);
  const deduped = [];
  const seen = new Set();

  for (const track of tracks) {
    const key = `${track.title}`.trim().toLowerCase() + '|' + `${track.artist}`.trim().toLowerCase();
    if (!track.fullStream || track.streamVerified === false || seen.has(key)) continue;
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
        error: 'SoundCloud no devolvió versiones completas reproducibles fuera de su plataforma para esta búsqueda.',
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
