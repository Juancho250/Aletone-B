const { fmt, fetchJSON } = require('../utils/helpers');

const OFFICIAL_API = 'https://api.soundcloud.com';
const OAUTH_URL = 'https://secure.soundcloud.com/oauth/token';
const LEGACY_CLIENT_CACHE_MS = 60 * 60 * 1000;
const TOKEN_SKEW_MS = 120_000;

let scClientId = null;
let scClientIdFetchedAt = 0;
let oauthState = {
  accessToken: null,
  refreshToken: null,
  expiresAt: 0,
};

function hasOfficialCredentials() {
  return Boolean(process.env.SOUNDCLOUD_CLIENT_ID && process.env.SOUNDCLOUD_CLIENT_SECRET);
}

function soundCloudMode() {
  return hasOfficialCredentials() ? 'official-oauth' : 'legacy-public';
}

async function requestJSON(url, options = {}) {
  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), options.timeout || 12_000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: ctrl.signal,
      headers: {
        Accept: 'application/json',
        ...(options.headers || {}),
      },
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data?.error || data?.message || `SoundCloud HTTP ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

function storeOAuthToken(data) {
  oauthState = {
    accessToken: data?.access_token || null,
    refreshToken: data?.refresh_token || null,
    expiresAt: Date.now() + Math.max(60, Number(data?.expires_in || 3600)) * 1000,
  };
  return oauthState.accessToken;
}

async function exchangeClientCredentials() {
  const clientId = process.env.SOUNDCLOUD_CLIENT_ID;
  const clientSecret = process.env.SOUNDCLOUD_CLIENT_SECRET;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const data = await requestJSON(OAUTH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' }),
  });

  return storeOAuthToken(data);
}

async function refreshOfficialToken() {
  if (!oauthState.refreshToken) return null;

  const data = await requestJSON(OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.SOUNDCLOUD_CLIENT_ID,
      client_secret: process.env.SOUNDCLOUD_CLIENT_SECRET,
      refresh_token: oauthState.refreshToken,
    }),
  });

  return storeOAuthToken(data);
}

async function getOfficialToken() {
  if (!hasOfficialCredentials()) {
    const error = new Error('SoundCloud OAuth no está configurado');
    error.status = 503;
    throw error;
  }

  if (oauthState.accessToken && Date.now() < oauthState.expiresAt - TOKEN_SKEW_MS) {
    return oauthState.accessToken;
  }

  if (oauthState.refreshToken) {
    try {
      return await refreshOfficialToken();
    } catch (error) {
      console.warn('[SC OAuth] refresh falló, renovando sesión:', error.message);
      oauthState = { accessToken: null, refreshToken: null, expiresAt: 0 };
    }
  }

  return exchangeClientCredentials();
}

async function officialJSON(path) {
  const token = await getOfficialToken();
  return requestJSON(`${OFFICIAL_API}${path}`, {
    headers: { Authorization: `OAuth ${token}` },
  });
}

async function getSCClientId() {
  if (scClientId && Date.now() - scClientIdFetchedAt < LEGACY_CLIENT_CACHE_MS) return scClientId;

  console.log('[SC] Obteniendo client_id público de compatibilidad...');
  const html = await (
    await fetch('https://soundcloud.com', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      },
    })
  ).text();

  const scriptUrls = [
    ...html.matchAll(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js/g),
  ].map((m) => m[0]);

  for (const scriptUrl of scriptUrls.slice(-10)) {
    try {
      const js = await (await fetch(scriptUrl)).text();
      const match = js.match(/client_id\s*:\s*"([a-zA-Z0-9]{32})"/);
      if (match) {
        scClientId = match[1];
        scClientIdFetchedAt = Date.now();
        console.log('[SC] client_id compatibilidad ok:', scClientId.substring(0, 8) + '...');
        return scClientId;
      }
    } catch (_) {}
  }
  throw new Error('SoundCloud: client_id público no encontrado');
}

function artwork(value = '') {
  return String(value || '')
    .replace('-large.', '-t500x500.')
    .replace('large', 't500x500');
}

function isPreviewTranscoding(transcoding) {
  const descriptor = [
    transcoding?.preset,
    transcoding?.quality,
    transcoding?.format?.protocol,
    transcoding?.format?.mime_type,
    transcoding?.url,
  ].filter(Boolean).join(' ').toLowerCase();

  return descriptor.includes('preview') || descriptor.includes('/preview/');
}

function transcodingScore(transcoding) {
  if (!transcoding || isPreviewTranscoding(transcoding)) return -1;
  const protocol = String(transcoding.format?.protocol || '').toLowerCase();
  const mime = String(transcoding.format?.mime_type || '').toLowerCase();
  const preset = String(transcoding.preset || '').toLowerCase();

  if (protocol === 'hls' && (preset.includes('aac_160') || mime.includes('aac') || mime.includes('mp4'))) return 120;
  if (protocol === 'hls' && preset.includes('aac_96')) return 115;
  if (protocol === 'hls' && mime.startsWith('audio/')) return 100;
  if (protocol === 'progressive' && mime.startsWith('audio/')) return 50;
  return 5;
}

function hasVerifiedLegacyFullStream(track) {
  const transcodings = track?.media?.transcodings || [];
  return transcodings.some((item) => transcodingScore(item) >= 0);
}

function normalizeTrack(t, { trustedPlayable = false } = {}) {
  const publisher = t.publisher_metadata || {};
  const duration = Math.max(0, Math.floor((Number(t.duration) || 0) / 1000));
  const access = t.access || null;
  const verifiedByMedia = hasVerifiedLegacyFullStream(t);
  const fullStream = Boolean(
    t.streamable !== false &&
    access !== 'blocked' &&
    access !== 'preview' &&
    (trustedPlayable || access === 'playable' || verifiedByMedia)
  );

  return {
    id: `sc_${t.id}`,
    externalId: String(t.id || ''),
    urn: t.urn || (t.id ? `soundcloud:tracks:${t.id}` : ''),
    title: t.title || '',
    artist: publisher.artist || t.metadata_artist || t.user?.username || '',
    album: publisher.album_title || '',
    genre: t.genre || '',
    duration,
    durationStr: fmt(duration),
    thumbnail: artwork(t.artwork_url || t.user?.avatar_url || ''),
    source: 'soundcloud',
    permalink: t.permalink_url || '',
    releaseDate: t.release_date || t.created_at || null,
    playbackCount: Number(t.playback_count || 0),
    likesCount: Number(t.likes_count || t.favoritings_count || 0),
    repostsCount: Number(t.reposts_count || 0),
    access: access || (fullStream ? 'playable' : 'unknown'),
    streamable: fullStream,
    fullStream,
    isPreview: access === 'preview' || !fullStream,
    streamVerified: fullStream,
    providerMode: soundCloudMode(),
  };
}

function collectionFrom(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.collection)) return data.collection;
  return [];
}

async function officialSearch(q, limit) {
  const params = new URLSearchParams({
    q,
    access: 'playable',
    limit: String(limit),
    linked_partitioning: 'true',
  });
  const data = await officialJSON(`/tracks?${params.toString()}`);
  return collectionFrom(data)
    .map((track) => normalizeTrack(track, { trustedPlayable: true }))
    .filter((track) => track.fullStream);
}

async function legacySearch(q, limit) {
  const cid = await getSCClientId();
  const data = await fetchJSON(
    `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&client_id=${cid}&limit=${limit}&linked_partitioning=1&app_locale=en`
  );

  return collectionFrom(data)
    .map((track) => normalizeTrack(track))
    // Nunca asumir que "streamable" significa canción completa. En el API web
    // muchos masters comerciales son previews de 30 s y no traen un full stream.
    .filter((track) => track.fullStream);
}

async function scSearch(q, limit = 15) {
  const safeLimit = Math.min(Math.max(Number(limit) || 15, 1), 50);
  if (hasOfficialCredentials()) return officialSearch(q, safeLimit);
  return legacySearch(q, safeLimit);
}

async function officialRelated(trackId, limit) {
  const rawId = String(trackId || '').replace('sc_', '');
  if (!/^\d+$/.test(rawId)) return [];

  const params = new URLSearchParams({
    access: 'playable',
    limit: String(limit),
    linked_partitioning: 'true',
  });
  const urn = encodeURIComponent(`soundcloud:tracks:${rawId}`);
  const data = await officialJSON(`/tracks/${urn}/related?${params.toString()}`);
  return collectionFrom(data)
    .map((track) => normalizeTrack(track, { trustedPlayable: true }))
    .filter((track) => track.fullStream);
}

async function legacyRelated(trackId, limit) {
  const cid = await getSCClientId();
  const rawId = String(trackId || '').replace('sc_', '');
  if (!/^\d+$/.test(rawId)) return [];

  const data = await fetchJSON(
    `https://api-v2.soundcloud.com/tracks/${rawId}/related?client_id=${cid}&limit=${limit}&linked_partitioning=1&app_locale=en`
  );

  return collectionFrom(data)
    .map((track) => normalizeTrack(track))
    .filter((track) => track.fullStream);
}

async function scRelated(trackId, limit = 20) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
  if (hasOfficialCredentials()) return officialRelated(trackId, safeLimit);
  return legacyRelated(trackId, safeLimit);
}

function officialStreamCandidate(streams) {
  const candidates = [
    ['hls_aac_160_url', 'hls', 'audio/mp4', 'aac_160'],
    ['hls_aac_96_url', 'hls', 'audio/mp4', 'aac_96'],
    // Compatibilidad mientras SoundCloud aún devuelva alguno de los formatos
    // antiguos. AAC/HLS sigue siendo la ruta preferida.
    ['hls_mp3_128_url', 'hls', 'audio/mpeg', 'mp3_128'],
    ['http_mp3_128_url', 'progressive', 'audio/mpeg', 'mp3_128'],
  ];

  for (const [field, protocol, mimeType, preset] of candidates) {
    if (streams?.[field]) {
      return { url: streams[field], protocol, mimeType, preset };
    }
  }
  return null;
}

async function officialStreamInfo(trackId) {
  const rawId = String(trackId || '').replace('sc_', '');
  if (!/^\d+$/.test(rawId)) throw new Error('SoundCloud: ID inválido');

  const urn = encodeURIComponent(`soundcloud:tracks:${rawId}`);
  const track = await officialJSON(`/tracks/${urn}`);
  if (track?.access === 'preview') {
    const error = new Error('SoundCloud: esta pista solo permite preview fuera de SoundCloud');
    error.status = 409;
    throw error;
  }
  if (track?.access === 'blocked' || track?.streamable === false) {
    const error = new Error('SoundCloud: esta pista no permite reproducción externa');
    error.status = 409;
    throw error;
  }

  const streams = await officialJSON(`/tracks/${urn}/streams`);
  const selected = officialStreamCandidate(streams);
  if (!selected) {
    const hasPreview = Boolean(streams?.preview_mp3_128_url);
    const error = new Error(
      hasPreview
        ? 'SoundCloud: esta pista solo ofrece preview de 30 segundos para esta integración'
        : 'SoundCloud: no devolvió un stream reproducible para esta pista'
    );
    error.status = hasPreview ? 409 : 503;
    throw error;
  }

  return {
    ...selected,
    proxyRequired: selected.protocol === 'hls',
    isPreview: false,
    providerMode: 'official-oauth',
  };
}

async function legacyStreamInfo(trackId) {
  const cid = await getSCClientId();
  const rawId = String(trackId || '').replace('sc_', '');
  if (!/^\d+$/.test(rawId)) throw new Error('SoundCloud: ID inválido');

  const data = await fetchJSON(
    `https://api-v2.soundcloud.com/tracks/${rawId}?client_id=${cid}`
  );

  if (data?.access === 'preview') {
    const error = new Error('SoundCloud: esta pista solo permite preview de 30 segundos');
    error.status = 409;
    throw error;
  }
  if (data?.access === 'blocked' || data?.streamable === false) {
    const error = new Error('SoundCloud: esta pista no permite reproducción externa');
    error.status = 409;
    throw error;
  }

  const transcodings = (data?.media?.transcodings || [])
    .map((item) => ({ item, score: transcodingScore(item) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score);

  const transcoding = transcodings[0]?.item;
  if (!transcoding?.url) {
    const error = new Error('SoundCloud: la sesión pública solo recibió un preview; se requiere una pista playable o credenciales OAuth');
    error.status = 409;
    throw error;
  }

  const separator = transcoding.url.includes('?') ? '&' : '?';
  const resolved = await fetchJSON(`${transcoding.url}${separator}client_id=${cid}`);
  if (!resolved?.url) throw new Error('SoundCloud: URL de audio no resuelta');

  return {
    url: resolved.url,
    protocol: String(transcoding.format?.protocol || '').toLowerCase(),
    mimeType: transcoding.format?.mime_type || '',
    preset: transcoding.preset || '',
    proxyRequired: String(transcoding.format?.protocol || '').toLowerCase() === 'hls',
    isPreview: false,
    providerMode: 'legacy-public',
  };
}

async function scStreamInfo(trackId) {
  if (hasOfficialCredentials()) return officialStreamInfo(trackId);
  return legacyStreamInfo(trackId);
}

async function scStreamUrl(trackId) {
  return (await scStreamInfo(trackId)).url;
}

async function warmSoundCloud() {
  if (hasOfficialCredentials()) {
    await getOfficialToken();
    return { mode: 'official-oauth', ok: true };
  }
  await getSCClientId();
  return { mode: 'legacy-public', ok: true };
}

module.exports = {
  getSCClientId,
  getOfficialToken,
  hasOfficialCredentials,
  soundCloudMode,
  warmSoundCloud,
  scSearch,
  scRelated,
  scStreamInfo,
  scStreamUrl,
};
