const BASE = 'https://www.googleapis.com/youtube/v3';
const DEFAULT_REGION = String(process.env.YOUTUBE_REGION_CODE || 'CO').trim().toUpperCase() || 'CO';
const REQUEST_TIMEOUT_MS = 6500;
const CACHE_TTL_MS = 30 * 60_000;
const cache = new Map();

function apiKey() {
  return String(process.env.YOUTUBE_API_KEY || '').trim();
}

function configured() {
  return Boolean(apiKey());
}

function fold(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseDuration(value) {
  const match = String(value || '').match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!match) return 0;
  return (Number(match[1] || 0) * 86400)
    + (Number(match[2] || 0) * 3600)
    + (Number(match[3] || 0) * 60)
    + Number(match[4] || 0);
}

function fmt(seconds) {
  const total = Math.max(0, Math.round(Number(seconds || 0)));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function cleanChannelName(value) {
  return String(value || '')
    .replace(/\s*-\s*Topic\s*$/i, '')
    .replace(/VEVO\s*$/i, '')
    .replace(/\s+Official\s*$/i, '')
    .trim();
}

function thumbnailFrom(snippet = {}) {
  const thumbs = snippet.thumbnails || {};
  return thumbs.maxres?.url || thumbs.standard?.url || thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || '';
}

function isAvailableInRegion(item, regionCode = DEFAULT_REGION) {
  const restriction = item?.contentDetails?.regionRestriction || {};
  const region = String(regionCode || DEFAULT_REGION).toUpperCase();
  if (Array.isArray(restriction.blocked) && restriction.blocked.includes(region)) return false;
  if (Array.isArray(restriction.allowed) && restriction.allowed.length && !restriction.allowed.includes(region)) return false;
  return true;
}

function normalizeVideo(item, regionCode = DEFAULT_REGION) {
  const videoId = String(item?.id || '').trim();
  if (!videoId || item?.status?.privacyStatus !== 'public' || item?.status?.embeddable !== true) return null;
  if (!isAvailableInRegion(item, regionCode)) return null;

  const snippet = item.snippet || {};
  const duration = parseDuration(item?.contentDetails?.duration);
  if (!duration) return null;
  const channelTitle = snippet.channelTitle || '';
  const artist = cleanChannelName(channelTitle);

  return {
    id: `yt_${videoId}`,
    externalId: videoId,
    youtubeVideoId: videoId,
    title: snippet.title || '',
    artist: artist || channelTitle,
    uploader: channelTitle,
    channelId: snippet.channelId || '',
    album: '',
    thumbnail: thumbnailFrom(snippet),
    duration,
    durationStr: fmt(duration),
    source: 'youtube',
    providerMode: 'youtube-iframe',
    permalink: `https://www.youtube.com/watch?v=${videoId}`,
    embeddable: true,
    streamable: false,
    fullStream: true,
    streamVerified: true,
    playbackVerified: true,
    isPreview: false,
    downloadable: false,
    publishedAt: snippet.publishedAt || null,
  };
}

async function requestJSON(path, params = {}, { timeout = REQUEST_TIMEOUT_MS } = {}) {
  const key = apiKey();
  if (!key) return null;
  const url = new URL(`${BASE}${path}`);
  for (const [name, value] of Object.entries({ ...params, key })) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(name, String(value));
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload?.error?.message || `YouTube HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function searchExpression(query) {
  const clean = String(query || '').trim().replace(/\s+/g, ' ').slice(0, 160);
  if (!clean) return '';
  return `${clean} official audio -remix -cover -karaoke -slowed -sped -nightcore`;
}

async function hydrateVideos(ids, regionCode = DEFAULT_REGION) {
  const unique = [...new Set((ids || []).filter(Boolean))].slice(0, 50);
  if (!unique.length) return [];
  const details = await requestJSON('/videos', {
    part: 'snippet,contentDetails,status',
    id: unique.join(','),
    maxResults: unique.length,
    regionCode,
  });
  const order = new Map(unique.map((id, index) => [id, index]));
  return (details?.items || [])
    .map(item => normalizeVideo(item, regionCode))
    .filter(Boolean)
    .sort((a, b) => (order.get(a.externalId) ?? 999) - (order.get(b.externalId) ?? 999));
}

async function searchVideos(query, limit = 24, { regionCode = DEFAULT_REGION } = {}) {
  if (!configured()) return [];
  const clean = String(query || '').trim();
  if (!clean) return [];
  const safeLimit = Math.min(Math.max(Number(limit) || 24, 1), 50);
  const cacheKey = `search|${fold(clean)}|${safeLimit}|${regionCode}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const search = await requestJSON('/search', {
    part: 'snippet',
    q: searchExpression(clean),
    type: 'video',
    maxResults: safeLimit,
    order: 'relevance',
    videoEmbeddable: 'true',
    videoSyndicated: 'true',
    videoCategoryId: '10',
    regionCode,
    safeSearch: 'none',
  });
  const ids = (search?.items || []).map(item => item?.id?.videoId).filter(Boolean);
  const value = await hydrateVideos(ids, regionCode);
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}

function channelScore(channel, artistName) {
  const title = String(channel?.snippet?.title || '');
  const cleaned = fold(cleanChannelName(title));
  const target = fold(artistName);
  let score = 0;
  if (cleaned === target) score += 120;
  else if (cleaned.startsWith(target) || target.startsWith(cleaned)) score += 85;
  else if (cleaned.includes(target) || target.includes(cleaned)) score += 55;
  if (/\btopic\b/i.test(title)) score += 55;
  if (/vevo|official/i.test(title)) score += 25;
  return score;
}

async function searchArtistCatalog(artistName, limit = 50, { regionCode = DEFAULT_REGION } = {}) {
  if (!configured()) return [];
  const clean = String(artistName || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (!clean) return [];
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 50);
  const cacheKey = `artist|${fold(clean)}|${safeLimit}|${regionCode}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const channelSearch = await requestJSON('/search', {
    part: 'snippet',
    q: `${clean} Topic`,
    type: 'channel',
    maxResults: 8,
    order: 'relevance',
    regionCode,
    safeSearch: 'none',
  }).catch(() => null);

  const channelIds = (channelSearch?.items || []).map(item => item?.id?.channelId).filter(Boolean);
  if (!channelIds.length) {
    const fallback = await searchVideos(clean, safeLimit, { regionCode });
    cache.set(cacheKey, { at: Date.now(), value: fallback });
    return fallback;
  }

  const channels = await requestJSON('/channels', {
    part: 'snippet,contentDetails',
    id: channelIds.join(','),
    maxResults: channelIds.length,
  }).catch(() => null);

  const chosen = [...(channels?.items || [])]
    .map(channel => ({ channel, score: channelScore(channel, clean) }))
    .sort((a, b) => b.score - a.score)[0]?.channel;

  const uploadsPlaylist = chosen?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylist) {
    const fallback = await searchVideos(clean, safeLimit, { regionCode });
    cache.set(cacheKey, { at: Date.now(), value: fallback });
    return fallback;
  }

  const playlist = await requestJSON('/playlistItems', {
    part: 'contentDetails',
    playlistId: uploadsPlaylist,
    maxResults: safeLimit,
  }).catch(() => null);
  const ids = (playlist?.items || []).map(item => item?.contentDetails?.videoId).filter(Boolean);
  const value = await hydrateVideos(ids, regionCode);
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}

function providerStatus() {
  return {
    ok: true,
    configured: configured(),
    mode: configured() ? 'data-api+iframe' : 'disabled-no-key',
    regionCode: DEFAULT_REGION,
  };
}

module.exports = {
  BASE,
  configured,
  providerStatus,
  searchVideos,
  searchArtistCatalog,
  normalizeVideo,
  parseDuration,
};
