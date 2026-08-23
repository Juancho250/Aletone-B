const { db } = require('../config/db');

const LRCLIB_BASE = 'https://lrclib.net/api';
const CACHE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function requestJSON(url, timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Aletone/1.0 (music search; contact via project repository)',
      },
    });
    if (response.status === 404) return null;
    if (response.status === 429) {
      const error = new Error('LRCLIB rate limit');
      error.status = 429;
      throw error;
    }
    if (!response.ok) throw new Error(`LRCLIB HTTP ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function usableTrack(track) {
  return Boolean(track?.id && track?.title && track?.artist);
}

async function getCached(trackId) {
  return db.one(
    `SELECT track_id, title, artist, plain_lyrics, synced_lyrics, provider, fetched_at
     FROM lyrics_cache
     WHERE track_id = $1`,
    [trackId]
  );
}

async function fetchLyrics(track) {
  if (!usableTrack(track)) return null;
  const params = new URLSearchParams({
    track_name: String(track.title).slice(0, 300),
    artist_name: String(track.artist).slice(0, 220),
  });
  if (track.album) params.set('album_name', String(track.album).slice(0, 220));
  if (Number(track.duration) > 0) params.set('duration', String(Math.round(Number(track.duration))));

  return requestJSON(`${LRCLIB_BASE}/get?${params.toString()}`);
}

async function cacheLyrics(track, { force = false } = {}) {
  if (!usableTrack(track)) return null;

  const existing = await getCached(track.id).catch(() => null);
  if (!force && existing?.fetched_at) {
    const age = Date.now() - new Date(existing.fetched_at).getTime();
    if (age < CACHE_MAX_AGE_MS) return existing;
  }

  const data = await fetchLyrics(track);
  if (!data || (!data.plainLyrics && !data.syncedLyrics)) return null;

  return db.one(
    `INSERT INTO lyrics_cache (
       track_id, title, artist, plain_lyrics, synced_lyrics, provider, fetched_at
     ) VALUES ($1,$2,$3,$4,$5,'lrclib',NOW())
     ON CONFLICT (track_id) DO UPDATE SET
       title = EXCLUDED.title,
       artist = EXCLUDED.artist,
       plain_lyrics = EXCLUDED.plain_lyrics,
       synced_lyrics = EXCLUDED.synced_lyrics,
       provider = EXCLUDED.provider,
       fetched_at = NOW()
     RETURNING track_id, title, artist, plain_lyrics, synced_lyrics, provider, fetched_at`,
    [
      track.id,
      String(track.title).slice(0, 500),
      String(track.artist || '').slice(0, 300) || null,
      data.plainLyrics || null,
      data.syncedLyrics || null,
    ]
  );
}

async function warmLyrics(tracks, maxTracks = 4) {
  const queue = (tracks || []).filter(usableTrack).slice(0, Math.max(0, maxTracks));
  for (let i = 0; i < queue.length; i += 1) {
    try {
      await cacheLyrics(queue[i]);
    } catch (error) {
      if (error?.status === 429) break;
    }
    if (i < queue.length - 1) await sleep(260);
  }
}

async function searchLyrics(query, limit = 10) {
  const q = String(query || '').trim().replace(/\s+/g, ' ').slice(0, 220);
  if (q.length < 5) return [];

  const safeLimit = Math.min(Math.max(Number(limit) || 10, 1), 20);
  const rows = await db.all(
    `SELECT
       t.id,
       t.source,
       t.external_id,
       t.title,
       t.artist,
       t.album,
       t.thumbnail,
       t.duration,
       t.metadata,
       ts_rank_cd(
         to_tsvector('simple', COALESCE(l.plain_lyrics, '')),
         websearch_to_tsquery('simple', $1)
       ) AS lyric_rank
     FROM lyrics_cache l
     JOIN tracks t ON t.id = l.track_id
     WHERE t.source = 'soundcloud'
       AND t.metadata->>'catalogVersion' = 'sc-playable-v3'
       AND t.metadata->>'streamVerified' = 'true'
       AND (
         to_tsvector('simple', COALESCE(l.plain_lyrics, '')) @@ websearch_to_tsquery('simple', $1)
         OR LOWER(COALESCE(l.plain_lyrics, '')) LIKE LOWER($2)
       )
     ORDER BY lyric_rank DESC, l.fetched_at DESC
     LIMIT $3`,
    [q, `%${q}%`, safeLimit]
  );

  return rows.map(row => {
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
      access: metadata.access || 'playable',
      streamable: true,
      fullStream: true,
      streamVerified: true,
      isPreview: false,
      providerMode: metadata.providerMode || 'unknown',
      matchReason: 'lyrics',
      lyricRank: Number(row.lyric_rank || 0),
    };
  });
}

module.exports = { cacheLyrics, warmLyrics, searchLyrics };
