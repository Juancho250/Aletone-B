const { fmt, fetchJSON } = require('../utils/helpers');

const OFFICIAL_API = 'https://api.soundcloud.com';
const OAUTH_URL = 'https://secure.soundcloud.com/oauth/token';
const DEEZER_SEARCH = 'https://api.deezer.com/search';
const LEGACY_CLIENT_CACHE_MS = 60 * 60 * 1000;
const TOKEN_SKEW_MS = 120_000;
const CANONICAL_CACHE_MS = 10 * 60 * 1000;

let scClientId = null;
let scClientIdFetchedAt = 0;
let oauthState = {
  accessToken: null,
  refreshToken: null,
  expiresAt: 0,
};
const canonicalCache = new Map();

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

function fold(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function similarity(a, b) {
  const x = fold(a);
  const y = fold(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.88;
  const xs = new Set(x.split(' ').filter(Boolean));
  const ys = new Set(y.split(' ').filter(Boolean));
  let common = 0;
  for (const token of xs) if (ys.has(token)) common += 1;
  return common / Math.max(xs.size, ys.size, 1);
}

function stripArtistPrefix(title, artist) {
  const rawTitle = String(title || '').trim();
  const rawArtist = String(artist || '').trim();
  if (!rawArtist) return rawTitle;
  const titleFold = fold(rawTitle);
  const artistFold = fold(rawArtist);
  if (!titleFold.startsWith(artistFold)) return rawTitle;
  return rawTitle.replace(new RegExp(`^${rawArtist.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[-–—:|]\\s*`, 'i'), '').trim();
}

const NOISE_RULES = [
  [/\bfree\s*download\b|\bdescarga\s*gratis\b/i, 180],
  [/\bbootleg\b|\bmashup\b/i, 155],
  [/\bdj\s+set\b|\bfull\s+set\b|\bmegamix\b/i, 150],
  [/\bremix\b/i, 125],
  [/\bedit\b|\bextended\b/i, 95],
  [/\bsped\s*up\b|\bslowed\b|\breverb\b|\bnightcore\b/i, 130],
  [/\bcover\b|\bkaraoke\b|\binstrumental\b/i, 100],
  [/\bunofficial\b|\bfanmade\b|\bfan\s*made\b/i, 145],
];

function queryAllowsNoise(q, pattern) {
  return pattern.test(String(q || ''));
}

function noisePenalty(track, q) {
  const text = `${track.title || ''} ${track.artist || ''} ${track.uploader || ''}`;
  let penalty = 0;
  for (const [pattern, amount] of NOISE_RULES) {
    if (pattern.test(text) && !queryAllowsNoise(q, pattern)) penalty += amount;
  }
  if (track.duration > 900) penalty += 180;
  else if (track.duration > 540) penalty += 90;
  else if (track.duration > 420) penalty += 35;
  if (track.duration > 0 && track.duration < 95) penalty += 70;
  return penalty;
}

async function canonicalSearch(q, limit = 20) {
  const key = fold(q);
  const cached = canonicalCache.get(key);
  if (cached && Date.now() - cached.at < CANONICAL_CACHE_MS) return cached.value;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 900);
  try {
    const response = await fetch(`${DEEZER_SEARCH}?q=${encodeURIComponent(q)}&limit=${Math.min(limit, 25)}&output=json`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return [];
    const data = await response.json().catch(() => ({}));
    const value = (data.data || []).map(item => ({
      title: item.title || '',
      titleShort: item.title_short || item.title || '',
      artist: item.artist?.name || '',
      album: item.album?.title || '',
      rank: Number(item.rank || 0),
      duration: Number(item.duration || 0),
    }));
    canonicalCache.set(key, { at: Date.now(), value });
    return value;
  } catch (_) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function canonicalBoost(track, canonical, q) {
  if (!canonical?.length) return 0;
  const cleanedTitle = stripArtistPrefix(track.title, track.artist || track.uploader);
  let best = 0;
  for (const item of canonical) {
    const artistSim = Math.max(similarity(track.artist, item.artist), similarity(track.uploader, item.artist));
    const titleSim = Math.max(similarity(cleanedTitle, item.titleShort), similarity(cleanedTitle, item.title));
    if (artistSim >= 0.72 && titleSim >= 0.86) best = Math.max(best, 180 + Math.min(30, Math.log10(item.rank + 1) * 6));
    else if (artistSim >= 0.72 && titleSim >= 0.68) best = Math.max(best, 95);
  }
  const exactArtist = canonical.some(item => fold(item.artist) === fold(q));
  if (exactArtist && (fold(track.artist) === fold(q) || fold(track.uploader) === fold(q))) best += 40;
  return best;
}

function qualityScore(track, q, canonical = []) {
  const query = fold(q);
  const title = fold(track.title);
  const artist = fold(track.artist);
  const uploader = fold(track.uploader);
  let score = 0;

  if (artist === query) score += 145;
  else if (artist.startsWith(query)) score += 90;
  else if (artist.includes(query)) score += 55;

  if (uploader === query) score += 120;
  else if (uploader.startsWith(query)) score += 65;

  if (title === query) score += 130;
  else if (title.startsWith(query)) score += 75;
  else if (title.includes(query)) score += 45;

  if (track.publisherArtist && similarity(track.publisherArtist, track.artist) >= 0.85) score += 28;
  if (track.verifiedUser) score += 25;
  if (track.duration >= 120 && track.duration <= 360) score += 22;
  score += Math.min(36, Math.log10(Number(track.playbackCount || 0) + 1) * 5);
  score += Math.min(18, Math.log10(Number(track.likesCount || 0) + 1) * 3);
  score += canonicalBoost(track, canonical, q);
  score -= noisePenalty(track, q);
  return score;
}

function cleanRankedTracks(tracks, q, canonical, limit) {
  const ranked = [...(tracks || [])]
    .map(track => ({ ...track, qualityScore: qualityScore(track, q, canonical) }))
    .sort((a, b) => b.qualityScore - a.qualityScore);

  const clean = ranked.filter(track => noisePenalty(track, q) < 150 && track.duration <= 900);
  const source = clean.length >= Math.min(8, limit) ? clean : ranked;
  return source.slice(0, limit);
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

  // Para reproducción interactiva preferimos un stream progresivo completo cuando
  // existe: el navegador empieza sin arrancar FFmpeg/proxy. HLS/AAC sigue como fallback.
  if (protocol === 'progressive' && mime.startsWith('audio/')) return 200;
  if (protocol === 'hls' && (preset.includes('aac_160') || mime.includes('aac') || mime.includes('mp4'))) return 160;
  if (protocol === 'hls' && preset.includes('aac_96')) return 150;
  if (protocol === 'hls' && mime.startsWith('audio/')) return 135;
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
    uploader: t.user?.username || '',
    publisherArtist: publisher.artist || t.metadata_artist || '',
    publisherLabel: publisher.p_line || publisher.release_title || '',
    verifiedUser: Boolean(t.user?.verified || t.user?.verified_pro || t.user?.creator_subscription?.product?.id),
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

async function officialSearchRaw(q, limit) {
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

async function legacySearchRaw(q, limit) {
  const cid = await getSCClientId();
  const data = await fetchJSON(
    `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&client_id=${cid}&limit=${limit}&linked_partitioning=1&app_locale=en`
  );

  return collectionFrom(data)
    .map((track) => normalizeTrack(track))
    .filter((track) => track.fullStream);
}

async function scSearch(q, limit = 15) {
  const safeLimit = Math.min(Math.max(Number(limit) || 15, 1), 50);
  const fetchLimit = Math.min(50, Math.max(safeLimit + 15, 30));

  const [tracks, canonical] = await Promise.all([
    hasOfficialCredentials() ? officialSearchRaw(q, fetchLimit) : legacySearchRaw(q, fetchLimit),
    canonicalSearch(q, 20),
  ]);

  return cleanRankedTracks(tracks, q, canonical, safeLimit);
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
    // Si existe el MP3 progresivo completo lo preferimos para reducir drásticamente
    // el tiempo entre click y primer audio. AAC/HLS queda como fallback de calidad.
    ['http_mp3_128_url', 'progressive', 'audio/mpeg', 'mp3_128'],
    ['hls_aac_160_url', 'hls', 'audio/mp4', 'aac_160'],
    ['hls_aac_96_url', 'hls', 'audio/mp4', 'aac_96'],
    ['hls_mp3_128_url', 'hls', 'audio/mpeg', 'mp3_128'],
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