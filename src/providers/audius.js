const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const fs = require('fs');

const BASE = 'https://api.audius.co/v1';
const DEFAULT_TIMEOUT_MS = 6500;

function apiHeaders(extra = {}) {
  // Audius direct REST access uses the app Bearer Token server-side. Read-only
  // calls still work without credentials; never expose the bearer token in frontend code.
  const token = String(process.env.AUDIUS_BEARER_TOKEN || '').trim();
  return {
    Accept: 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

function withCommonParams(params = {}) {
  return { app_name: 'ALEON', ...params };
}

async function requestJSON(path, params = {}, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const url = new URL(`${BASE}${path}`);
  for (const [key, value] of Object.entries(withCommonParams(params))) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: apiHeaders(), redirect: 'follow' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.message || payload?.error || `Audius HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload?.data ?? payload;
  } finally {
    clearTimeout(timer);
  }
}

function artworkFrom(track) {
  const art = track?.artwork || track?.coverArt || track?.cover_art || {};
  return art?._1000x1000 || art?._480x480 || art?._150x150 || art?.['1000x1000'] || art?.['480x480'] || art?.['150x150'] || '';
}

function normalizeTrack(track) {
  if (!track?.id) return null;
  const user = track.user || {};
  const duration = Math.max(0, Math.round(Number(track.duration || 0)));
  const artist = user.name || track.artistName || track.artist_name || user.handle || track.artist || '';
  const isStreamable = track.isStreamable !== false && track.is_streamable !== false;
  if (!isStreamable) return null;

  return {
    id: `au_${track.id}`,
    externalId: String(track.id),
    title: track.title || '',
    artist,
    uploader: user.handle || artist,
    artistId: user.id ? String(user.id) : '',
    album: track.albumName || track.album_name || track.album || '',
    genre: track.genre || '',
    mood: track.mood || '',
    tags: Array.isArray(track.tags) ? track.tags : [],
    duration,
    durationStr: duration ? `${Math.floor(duration / 60)}:${String(duration % 60).padStart(2, '0')}` : '',
    thumbnail: artworkFrom(track),
    source: 'audius',
    permalink: track.permalink || track.permalinkUrl || track.permalink_url || '',
    releaseDate: track.releaseDate || track.release_date || track.createdAt || track.created_at || null,
    playbackCount: Number(track.playCount || track.play_count || track.playbackCount || track.playback_count || 0),
    likesCount: Number(track.favoriteCount || track.favorite_count || track.likesCount || track.likes_count || 0),
    repostsCount: Number(track.repostCount || track.repost_count || track.repostsCount || track.reposts_count || 0),
    verifiedUser: Boolean(user.isVerified || user.is_verified || user.verified),
    downloadable: Boolean(track.downloadable),
    streamable: true,
    fullStream: true,
    streamVerified: true,
    isPreview: false,
    providerMode: 'audius',
  };
}

function normalizeTracks(value) {
  const rows = Array.isArray(value) ? value : Array.isArray(value?.tracks) ? value.tracks : [];
  return rows.map(normalizeTrack).filter(Boolean);
}

async function searchTracks(query, limit = 30) {
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 50);
  const data = await requestJSON('/tracks/search', { query, limit: safeLimit, sort_method: 'relevant' });
  return normalizeTracks(data);
}

async function trendingTracks(limit = 30) {
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 50);
  const data = await requestJSON('/tracks/trending', { limit: safeLimit });
  return normalizeTracks(data);
}

async function recommendedTracks(limit = 30) {
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 50);
  try {
    const data = await requestJSON('/tracks/recommended', { limit: safeLimit });
    return normalizeTracks(data);
  } catch (_) {
    return trendingTracks(safeLimit);
  }
}

async function getTrack(trackId) {
  const rawId = String(trackId || '').replace(/^au_/, '');
  if (!rawId) throw Object.assign(new Error('Audius: ID inválido'), { status: 400 });
  const data = await requestJSON(`/tracks/${encodeURIComponent(rawId)}`);
  const value = Array.isArray(data) ? data[0] : data;
  return normalizeTrack(value);
}

function normalizeAutocompleteItem(item, fallbackType = '') {
  const type = String(item?.type || fallbackType || '').toLowerCase();
  const value = item?.name || item?.title || item?.handle || item?.playlistName || item?.playlist_name || item?.albumName || item?.album_name || '';
  if (!value) return null;
  const user = item?.user || {};
  const subtitle = type.includes('user') || type === 'artist'
    ? 'Artista'
    : type.includes('playlist')
      ? 'Playlist'
      : type.includes('album')
        ? 'Álbum'
        : (user.name || item?.artistName || item?.artist_name || 'Canción');
  return {
    type: type.includes('user') ? 'artist' : type.includes('playlist') ? 'playlist' : type.includes('album') ? 'album' : 'track',
    value,
    subtitle,
    thumbnail: artworkFrom(item) || artworkFrom(user),
  };
}

async function autocomplete(query, limit = 8) {
  const safeLimit = Math.min(Math.max(Number(limit) || 8, 1), 12);
  try {
    const data = await requestJSON('/search/autocomplete', { query, limit: safeLimit });
    const output = [];
    const seen = new Set();
    const push = (item, type) => {
      const normalized = normalizeAutocompleteItem(item, type);
      if (!normalized) return;
      const key = `${normalized.type}|${normalized.value.toLowerCase()}`;
      if (seen.has(key)) return;
      seen.add(key);
      output.push(normalized);
    };

    if (Array.isArray(data)) data.forEach(item => push(item));
    else if (data && typeof data === 'object') {
      for (const [key, rows] of Object.entries(data)) {
        if (Array.isArray(rows)) rows.forEach(item => push(item, key));
      }
    }
    return output.slice(0, safeLimit);
  } catch (_) {
    const tracks = await searchTracks(query, safeLimit).catch(() => []);
    return tracks.slice(0, safeLimit).map(track => ({ type: 'track', value: track.title, subtitle: track.artist || 'Canción', thumbnail: track.thumbnail || '' }));
  }
}

function rawTrackId(trackId) {
  const raw = String(trackId || '').replace(/^au_/, '');
  if (!raw || raw.length > 180) throw Object.assign(new Error('Audius: ID inválido'), { status: 400 });
  return raw;
}

async function fetchStreamResponse(trackId, { range = '', signal } = {}) {
  const rawId = rawTrackId(trackId);
  const url = new URL(`${BASE}/tracks/${encodeURIComponent(rawId)}/stream`);
  url.searchParams.set('app_name', 'ALEON');
  const headers = apiHeaders(range ? { Range: range } : {});
  const response = await fetch(url, { headers, redirect: 'follow', signal });
  if (!response.ok && response.status !== 206) {
    const error = new Error(`Audius stream HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response;
}

async function proxyTrackStream(trackId, req, res) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.on('aborted', abort);

  try {
    const upstream = await fetchStreamResponse(trackId, { range: req.headers.range || '', signal: controller.signal });
    res.status(upstream.status === 206 ? 206 : 200);
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const value = upstream.headers.get(header);
      if (value) res.setHeader(header, value);
    }
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'private, max-age=900');
    res.setHeader('X-Accel-Buffering', 'no');
    if (!upstream.body) return res.end();

    const stream = Readable.fromWeb(upstream.body);
    req.on('close', () => { try { stream.destroy(); } catch (_) {} });
    stream.on('error', () => { if (!res.destroyed) res.destroy(); });
    stream.pipe(res);
    return undefined;
  } finally {
    req.off('aborted', abort);
  }
}

async function downloadTrackToFile(trackId, outputPath) {
  const upstream = await fetchStreamResponse(trackId);
  if (!upstream.body) throw new Error('Audius no devolvió contenido de audio');
  await pipeline(Readable.fromWeb(upstream.body), fs.createWriteStream(outputPath));
}

function providerStatus() {
  return { ok: true, mode: process.env.AUDIUS_BEARER_TOKEN ? 'bearer-token' : 'public-read', base: BASE };
}

module.exports = {
  BASE,
  normalizeTrack,
  searchTracks,
  trendingTracks,
  recommendedTracks,
  getTrack,
  autocomplete,
  proxyTrackStream,
  downloadTrackToFile,
  providerStatus,
};