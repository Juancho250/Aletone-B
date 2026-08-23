const { searchTracks: audiusSearchTracks } = require('../providers/audius');
const { searchVideos: youtubeSearchVideos, configured: youtubeConfigured } = require('../providers/youtube');
const { scSearch } = require('./soundcloud');
const { resolveSoundCloudStream } = require('./streamResolver');
const { canonicalMatch, isNoisy, fold } = require('./catalogMatcher');

const POSITIVE_TTL_MS = 20 * 60_000;
const NEGATIVE_TTL_MS = 90_000;
const cache = new Map();
const pending = new Map();

function normalizeCanonical(input = {}) {
  const title = String(input.title || input.canonicalTitle || '').trim().slice(0, 180);
  const artist = String(input.artist || '').trim().slice(0, 180);
  if (!title || !artist) {
    const error = new Error('Faltan título o artista para resolver la canción.');
    error.status = 400;
    throw error;
  }
  return {
    catalogId: String(input.catalogId || input.id || `catalog:${fold(artist)}:${fold(title)}`).slice(0, 220),
    title,
    titleShort: String(input.titleShort || title).trim().slice(0, 180),
    artist,
    album: String(input.album || '').trim().slice(0, 180),
    thumbnail: String(input.thumbnail || '').trim().slice(0, 1000),
    duration: Math.max(0, Number(input.duration || 0)),
    durationStr: String(input.durationStr || '').trim().slice(0, 20),
  };
}

function cacheKey(canonical) {
  return `${fold(canonical.catalogId)}|${fold(canonical.artist)}|${fold(canonical.titleShort || canonical.title)}|${Math.round(Number(canonical.duration || 0))}`;
}

function accepted(track, canonical, provider) {
  if (!track?.id || !track?.title) return null;
  const exactQuery = `${canonical.artist} ${canonical.titleShort || canonical.title}`;
  if (isNoisy(track, exactQuery)) return null;

  const match = canonicalMatch(track, [canonical]);
  if (!match) return null;

  const thresholds = provider === 'youtube'
    ? { score: 0.77, artist: 0.72, title: 0.82, duration: 32 }
    : provider === 'audius'
      ? { score: 0.80, artist: 0.78, title: 0.82, duration: 26 }
      : { score: 0.88, artist: 0.86, title: 0.86, duration: 18 };

  if (
    match.score < thresholds.score
    || match.artistSim < thresholds.artist
    || match.titleSim < thresholds.title
    || match.durationDelta > thresholds.duration
  ) return null;

  let score = match.score * 300;
  if (provider === 'youtube') score += 35;
  if (provider === 'audius') score += 22;
  if (/\btopic\b/i.test(String(track.uploader || ''))) score += 45;
  if (/vevo|official/i.test(String(track.uploader || ''))) score += 30;
  if (match.artistMention) score += 18;
  return { track, match, score };
}

function best(candidates, canonical, provider) {
  return (candidates || [])
    .map(track => accepted(track, canonical, provider))
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)[0] || null;
}

function decorate(track, canonical, provider, stream = null) {
  return {
    ...track,
    providerTitle: track.title,
    providerArtist: track.artist,
    canonicalTitle: canonical.title,
    title: canonical.title,
    artist: canonical.artist,
    album: canonical.album || track.album || '',
    thumbnail: canonical.thumbnail || track.thumbnail || '',
    duration: Number(canonical.duration || track.duration || 0),
    durationStr: canonical.durationStr || track.durationStr || '',
    catalogMatched: true,
    catalogId: canonical.catalogId,
    catalogAlbum: canonical.album || '',
    qualityScore: Math.round((canonicalMatch(track, [canonical])?.score || 0) * 1000) / 10,
    source: provider,
    playable: true,
    isPreview: false,
    fullStream: true,
    playbackVerified: provider === 'soundcloud' ? Boolean(stream) : true,
    streamVerified: provider === 'soundcloud' ? Boolean(stream) : true,
    playbackVerifiedAt: Date.now(),
    protocol: stream?.protocol || track.protocol || null,
    mimeType: stream?.mimeType || track.mimeType || null,
    downloadable: provider === 'audius' ? Boolean(track.downloadable) : false,
  };
}

async function resolveFresh(canonical, { allowSoundCloud = true } = {}) {
  const exact = `${canonical.artist} ${canonical.titleShort || canonical.title}`;

  const [youtubeCandidates, audiusCandidates] = await Promise.all([
    youtubeConfigured() ? youtubeSearchVideos(exact, 10).catch(() => []) : Promise.resolve([]),
    audiusSearchTracks(exact, 10).catch(() => []),
  ]);

  const youtube = best(youtubeCandidates, canonical, 'youtube');
  if (youtube) return decorate(youtube.track, canonical, 'youtube');

  const audius = best(audiusCandidates, canonical, 'audius');
  if (audius) return decorate(audius.track, canonical, 'audius');

  if (allowSoundCloud) {
    const soundcloudCandidates = await scSearch(exact, 10).catch(() => []);
    const soundcloud = best(soundcloudCandidates, canonical, 'soundcloud');
    if (soundcloud) {
      try {
        const stream = await resolveSoundCloudStream(soundcloud.track.id);
        return decorate(soundcloud.track, canonical, 'soundcloud', stream);
      } catch (_) {}
    }
  }

  return null;
}

async function resolveCatalogSource(input, options = {}) {
  const canonical = normalizeCanonical(input);
  const key = cacheKey(canonical);
  const cached = cache.get(key);
  if (cached) {
    const ttl = cached.value ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
    if (Date.now() - cached.at < ttl) return cached.value;
    cache.delete(key);
  }
  if (pending.has(key)) return pending.get(key);

  const task = resolveFresh(canonical, options)
    .then(value => {
      cache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => pending.delete(key));

  pending.set(key, task);
  return task;
}

function resolverStats() {
  return { cached: cache.size, pending: pending.size };
}

module.exports = { resolveCatalogSource, resolverStats, normalizeCanonical };
