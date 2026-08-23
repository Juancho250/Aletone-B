const router = require('express').Router();
const { db } = require('../config/db');
const { scSearch, scStreamInfo } = require('../services/soundcloud');

const memoryCache = new Map();
const verificationCache = new Map();
const suggestionCache = new Map();
const CACHE_TTL_MS = 90_000;
const VERIFY_TTL_MS = 10 * 60_000;
const SUGGEST_TTL_MS = 5 * 60_000;
const DB_FAST_HIT = 10;
const CATALOG_VERSION = 'sc-playable-v3';

function normalizeQuery(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 160);
}

function fold(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const x = fold(a);
  const y = fold(b);
  if (x === y) return 0;
  if (!x) return y.length;
  if (!y) return x.length;

  const previous = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= y.length; j += 1) {
      const old = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (x[i - 1] === y[j - 1] ? 0 : 1)
      );
      diagonal = old;
    }
  }
  return previous[y.length];
}

function textSimilarity(a, b) {
  const x = fold(a);
  const y = fold(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.startsWith(y) || y.startsWith(x)) {
    return 0.88 + (Math.min(x.length, y.length) / Math.max(x.length, y.length)) * 0.12;
  }
  const distance = levenshtein(x, y);
  return Math.max(0, 1 - distance / Math.max(x.length, y.length));
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
  const verifiedTracks = (tracks || []).filter(track => track?.fullStream && track?.streamVerified === true);
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
  const pattern = `%${fold(q)}%`;
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
         WHEN LOWER(COALESCE(artist, '')) LIKE LOWER($3) || '%' THEN 3
         ELSE 4
       END,
       updated_at DESC
     LIMIT $4`,
    [pattern, CATALOG_VERSION, q, limit]
  );
  return rows.map(fromDb).filter(track => track.fullStream);
}

async function recentVocabulary() {
  const rows = await db.all(
    `SELECT artist, title, thumbnail, MAX(updated_at) AS updated_at
     FROM tracks
     WHERE source = 'soundcloud'
       AND updated_at > NOW() - INTERVAL '365 days'
       AND (artist IS NOT NULL OR title IS NOT NULL)
     GROUP BY artist, title, thumbnail
     ORDER BY updated_at DESC
     LIMIT 300`
  );
  return rows;
}

function rankSuggestion(query, value, type) {
  const q = fold(query);
  const v = fold(value);
  if (!q || !v) return 0;
  let score = textSimilarity(q, v) * 100;
  if (v.startsWith(q)) score += 30;
  if (v.includes(q)) score += 15;
  if (type === 'artist') score += 7;
  return score;
}

async function buildSuggestions(q) {
  const cacheKey = fold(q);
  const cached = suggestionCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SUGGEST_TTL_MS) return cached.value;

  const suggestions = [];
  const seen = new Set();

  try {
    const rows = await recentVocabulary();
    for (const row of rows) {
      for (const item of [
        { type: 'artist', value: row.artist, subtitle: 'Artista', thumbnail: row.thumbnail || '' },
        { type: 'track', value: row.title, subtitle: row.artist || 'Canción', thumbnail: row.thumbnail || '' },
      ]) {
        if (!item.value) continue;
        const score = rankSuggestion(q, item.value, item.type);
        if (score < 52) continue;
        const key = `${item.type}|${fold(item.value)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        suggestions.push({ ...item, score });
      }
    }
  } catch (_) {}

  try {
    // SoundCloud ya hace búsqueda sobre título, usuario y descripción. Usamos esa
    // señal para predecir nombres aunque el usuario escriba parcialmente o con error.
    const provider = await scSearch(q, 20);
    for (const track of provider) {
      const candidates = [
        { type: 'artist', value: track.artist, subtitle: 'Artista', thumbnail: track.thumbnail || '' },
        { type: 'track', value: track.title, subtitle: track.artist || 'Canción', thumbnail: track.thumbnail || '' },
      ];
      for (const item of candidates) {
        if (!item.value) continue;
        const key = `${item.type}|${fold(item.value)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        suggestions.push({ ...item, score: rankSuggestion(q, item.value, item.type) + 6 });
      }
    }
  } catch (_) {}

  suggestions.sort((a, b) => b.score - a.score);
  const trimmed = suggestions.slice(0, 8).map(({ score, ...item }) => item);

  let correction = null;
  const artistCandidate = suggestions
    .filter(item => item.type === 'artist')
    .sort((a, b) => b.score - a.score)[0];
  if (artistCandidate) {
    const qFold = fold(q);
    const candidateFold = fold(artistCandidate.value);
    const similarity = textSimilarity(qFold, candidateFold);
    if (candidateFold !== qFold && (candidateFold.startsWith(qFold) || similarity >= 0.62)) {
      correction = artistCandidate.value;
    }
  }

  const value = { suggestions: trimmed, correction };
  suggestionCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

async function verifyTrack(track) {
  if (!track?.id) return null;
  const cached = verificationCache.get(track.id);
  if (cached && Date.now() - cached.at < VERIFY_TTL_MS) {
    return cached.ok ? { ...track, ...cached.meta, streamVerified: true, fullStream: true, isPreview: false } : null;
  }

  try {
    const info = await scStreamInfo(track.id);
    const verified = {
      ...track,
      streamVerified: true,
      fullStream: true,
      streamable: true,
      isPreview: false,
      providerMode: info.providerMode || track.providerMode || 'unknown',
    };
    verificationCache.set(track.id, { at: Date.now(), ok: true, meta: { providerMode: verified.providerMode } });
    return verified;
  } catch (error) {
    verificationCache.set(track.id, { at: Date.now(), ok: false, status: error.status || 503 });
    return null;
  }
}

async function verifyTracks(tracks, limit) {
  const output = [];
  const queue = [...tracks];
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length && output.length < limit) {
      const track = queue.shift();
      const verified = await verifyTrack(track);
      if (verified) output.push(verified);
    }
  });
  await Promise.all(workers);
  return output.slice(0, limit);
}

function relevance(track, query, correction) {
  const q = fold(correction || query);
  const title = fold(track.title);
  const artist = fold(track.artist);
  let score = 0;
  if (artist === q) score += 100;
  if (title === q) score += 95;
  if (artist.startsWith(q)) score += 70;
  if (title.startsWith(q)) score += 65;
  if (artist.includes(q)) score += 50;
  if (title.includes(q)) score += 45;
  score += Math.min(22, Math.log10(Number(track.playbackCount || 0) + 1) * 4);
  score += Math.min(12, Math.log10(Number(track.likesCount || 0) + 1) * 3);
  return score;
}

async function providerSearch(q, limit, correction = null) {
  const variants = [];
  const pushVariant = value => {
    const clean = normalizeQuery(value);
    if (clean && !variants.some(existing => fold(existing) === fold(clean))) variants.push(clean);
  };

  pushVariant(q);
  if (correction) pushVariant(correction);

  // En legacy-public una gran parte del catálogo comercial es preview. Buscamos
  // variantes razonables para encontrar uploads reproducibles sin degradar relevancia.
  const base = correction || q;
  if (base.split(' ').length <= 3) {
    pushVariant(`${base} official`);
    pushVariant(`${base} audio`);
    pushVariant(`${base} remix`);
  }

  const settled = await Promise.allSettled(
    variants.slice(0, 4).map(query => scSearch(query, 30))
  );

  const candidates = [];
  const seen = new Set();
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue;
    for (const track of result.value || []) {
      const key = `${fold(track.title)}|${fold(track.artist)}`;
      if (!track?.id || seen.has(key)) continue;
      seen.add(key);
      candidates.push(track);
    }
  }

  candidates.sort((a, b) => relevance(b, q, correction) - relevance(a, q, correction));
  const verified = await verifyTracks(candidates, limit);
  verified.sort((a, b) => relevance(b, q, correction) - relevance(a, q, correction));

  memoryCache.set(fold(q), { at: Date.now(), results: verified, correction });
  saveTracks(verified).catch(error => console.warn('[Search cache]', error.message));
  return verified;
}

router.get('/suggest', async (req, res) => {
  const q = normalizeQuery(req.query.q);
  if (q.length < 2) return res.json({ suggestions: [], correction: null });
  try {
    return res.json(await buildSuggestions(q));
  } catch (error) {
    console.warn('[Search suggest]', error.message);
    return res.json({ suggestions: [], correction: null });
  }
});

router.get('/', async (req, res) => {
  const q = normalizeQuery(req.query.q);
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 40);
  if (!q) return res.status(400).json({ error: 'Falta el parámetro q' });

  const cacheKey = fold(q);
  const cached = memoryCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return res.json({
      results: cached.results.slice(0, limit),
      source: 'aletone-cache',
      cached: true,
      correction: cached.correction || null,
      interpretedQuery: cached.correction || q,
    });
  }

  let suggestionData = { suggestions: [], correction: null };
  try { suggestionData = await buildSuggestions(q); } catch (_) {}
  const interpretedQuery = suggestionData.correction || q;

  try {
    const local = await localSearch(interpretedQuery, limit);
    if (local.length >= Math.min(DB_FAST_HIT, limit)) {
      providerSearch(q, limit, suggestionData.correction).catch(error => console.warn('[Search refresh]', error.message));
      return res.json({
        results: local.slice(0, limit),
        source: 'aletone-index',
        cached: true,
        refreshing: true,
        correction: suggestionData.correction,
        interpretedQuery,
      });
    }
  } catch (error) {
    console.warn('[Search local]', error.message);
  }

  try {
    const results = await providerSearch(q, limit, suggestionData.correction);
    if (!results.length) {
      return res.status(404).json({
        error: 'No encontramos una versión completa reproducible para esta búsqueda.',
        correction: suggestionData.correction,
        suggestions: suggestionData.suggestions,
      });
    }
    console.log(`[Search] "${q}" -> "${interpretedQuery}" verified:${results.length}`);
    return res.json({
      results,
      source: 'soundcloud-verified',
      cached: false,
      correction: suggestionData.correction,
      interpretedQuery,
      suggestions: suggestionData.suggestions,
      searchMode: 'smart-metadata',
    });
  } catch (error) {
    console.warn('[SC search]', error.message);
    try {
      const local = await localSearch(interpretedQuery, limit);
      if (local.length) {
        return res.json({
          results: local,
          source: 'aletone-index',
          cached: true,
          stale: true,
          correction: suggestionData.correction,
          interpretedQuery,
        });
      }
    } catch (_) {}
    return res.status(503).json({ error: 'No fue posible consultar el catálogo en este momento.' });
  }
});

module.exports = router;
