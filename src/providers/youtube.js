const BASE = 'https://www.googleapis.com/youtube/v3';
const DEFAULT_REGION = String(process.env.YOUTUBE_REGION_CODE || 'CO').trim().toUpperCase() || 'CO';
const REQUEST_TIMEOUT_MS = 6500;

function apiKey() {
  return String(process.env.YOUTUBE_API_KEY || '').trim();
}

function configured() {
  return Boolean(apiKey());
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
  return `${clean} official -remix -cover -karaoke -slowed -sped -nightcore`;
}

async function searchVideos(query, limit = 24, { regionCode = DEFAULT_REGION } = {}) {
  if (!configured()) return [];
  const clean = String(query || '').trim();
  if (!clean) return [];
  const safeLimit = Math.min(Math.max(Number(limit) || 24, 1), 40);
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
  if (!ids.length) return [];

  const details = await requestJSON('/videos', {
    part: 'snippet,contentDetails,status',
    id: ids.join(','),
    maxResults: safeLimit,
    regionCode,
  });
  const order = new Map(ids.map((id, index) => [id, index]));
  return (details?.items || [])
    .map(item => normalizeVideo(item, regionCode))
    .filter(Boolean)
    .sort((a, b) => (order.get(a.externalId) ?? 999) - (order.get(b.externalId) ?? 999));
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
  normalizeVideo,
  parseDuration,
};
