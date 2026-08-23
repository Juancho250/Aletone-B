const router = require('express').Router();
const { scSearch } = require('../services/soundcloud');
const { resolveSoundCloudStream } = require('../services/streamResolver');
const { searchLyrics } = require('../services/lyrics');

const DEEZER_SEARCH = 'https://api.deezer.com/search';
const FAST_CACHE_MS = 60_000;
const DEEP_CACHE_MS = 5 * 60_000;
const fastCache = new Map();
const deepCache = new Map();

function normalize(value) {
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

function tokenSimilarity(a, b) {
  const x = fold(a);
  const y = fold(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.startsWith(y) || y.startsWith(x)) return 0.92;
  if (x.includes(y) || y.includes(x)) return 0.86;
  const xs = new Set(x.split(' ').filter(Boolean));
  const ys = new Set(y.split(' ').filter(Boolean));
  let common = 0;
  for (const token of xs) if (ys.has(token)) common += 1;
  return common / Math.max(xs.size, ys.size, 1);
}

const HARD_NOISE = [
  /\bremix\b/i,
  /\bdj\b/i,
  /\bedit\b/i,
  /\bextended\b/i,
  /\bbootleg\b/i,
  /\bmashup\b/i,
  /\bfree\s*download\b/i,
  /\bdescarga\s*gratis\b/i,
  /\bcover\b/i,
  /\bkaraoke\b/i,
  /\binstrumental\b/i,
  /\bsped\s*up\b/i,
  /\bslowed\b/i,
  /\breverb\b/i,
  /\bnightcore\b/i,
  /\bclub\s*mix\b/i,
  /\bradio\s*edit\b/i,
  /\btransition\b/i,
  /\bintro\s*edit\b/i,
];

function queryRequestsVariant(q) {
  const value = fold(q);
  return /\b(remix|dj|edit|extended|bootleg|mashup|cover|karaoke|instrumental|sped up|slowed|reverb|nightcore|live)\b/i.test(value);
}

function hasHardNoise(track, q) {
  if (queryRequestsVariant(q)) return false;
  const value = `${track?.title || ''} ${track?.artist || ''} ${track?.uploader || ''}`;
  return HARD_NOISE.some(pattern => pattern.test(value));
}

function cleanTitle(value, artist = '') {
  let text = String(value || '')
    .replace(/\[[^\]]*(official|audio|video|lyrics?|visualizer)[^\]]*\]/gi, ' ')
    .replace(/\([^)]*(official|audio|video|lyrics?|visualizer)[^)]*\)/gi, ' ')
    .replace(/\b(official\s*(audio|video)?|audio\s*oficial|video\s*oficial|lyrics?|visualizer)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const a = String(artist || '').trim();
  if (a && fold(text).startsWith(fold(a))) {
    const escaped = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`^${escaped}\\s*[-–—:|]\\s*`, 'i'), '').trim();
  }
  return text;
}

async function canonicalSearch(q, limit = 25) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 1300);
  try {
    const response = await fetch(`${DEEZER_SEARCH}?q=${encodeURIComponent(q)}&limit=${Math.min(limit, 25)}&output=json`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return [];
    const data = await response.json().catch(() => ({}));
    return (data.data || []).map(item => ({
      title: item.title || '',
      titleShort: item.title_short || item.title || '',
      artist: item.artist?.name || '',
      album: item.album?.title || '',
      duration: Number(item.duration || 0),
      rank: Number(item.rank || 0),
    }));
  } catch (_) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function dominantArtist(canonical, q) {
  const query = fold(q);
  const counts = new Map();
  for (const item of canonical || []) {
    const artist = String(item.artist || '').trim();
    if (!artist) continue;
    const score = tokenSimilarity(artist, q);
    if (score < 0.76 && !fold(artist).includes(query) && !query.includes(fold(artist))) continue;
    const key = fold(artist);
    const current = counts.get(key) || { artist, count: 0, score: 0 };
    current.count += 1;
    current.score = Math.max(current.score, score);
    counts.set(key, current);
  }
  const best = [...counts.values()].sort((a, b) => (b.count - a.count) || (b.score - a.score))[0];
  return best && (best.count >= 2 || best.score >= 0.92) ? best.artist : null;
}

function canonicalMatch(track, item) {
  const trackArtist = track.publisherArtist || track.artist || track.uploader || '';
  const uploader = track.uploader || '';
  const artistScore = Math.max(tokenSimilarity(trackArtist, item.artist), tokenSimilarity(uploader, item.artist));
  const cleaned = cleanTitle(track.title, trackArtist || item.artist);
  const titleScore = Math.max(tokenSimilarity(cleaned, item.titleShort), tokenSimilarity(cleaned, item.title));
  const durationDelta = track.duration && item.duration ? Math.abs(Number(track.duration) - Number(item.duration)) : 0;
  const durationOk = !durationDelta || durationDelta <= 18;
  return {
    ok: artistScore >= 0.72 && titleScore >= 0.82 && durationOk,
    artistScore,
    titleScore,
    durationDelta,
  };
}

function strictFilter(tracks, canonical, q) {
  const artistQuery = dominantArtist(canonical, q);
  const canonicalPool = artistQuery
    ? canonical.filter(item => tokenSimilarity(item.artist, artistQuery) >= 0.9)
    : canonical;

  const output = [];
  const seen = new Set();
  for (const track of tracks || []) {
    if (!track?.id || hasHardNoise(track, q)) continue;
    if (track.duration > 430 || (track.duration > 0 && track.duration < 90)) continue;

    let best = null;
    for (const item of canonicalPool) {
      const match = canonicalMatch(track, item);
      if (!match.ok) continue;
      const score = match.artistScore * 120 + match.titleScore * 180 - Math.min(match.durationDelta, 20);
      if (!best || score > best.score) best = { item, score };
    }

    // Para búsquedas de artista no aceptamos material que no exista en el catálogo
    // canónico. Esta es la barrera que elimina DJ edits, bootlegs y uploads basura.
    if (canonicalPool.length && !best) continue;

    // Si Deezer no respondió, mantenemos un fallback muy estricto para no dejar la
    // búsqueda vacía por una caída temporal del catálogo canónico.
    if (!canonicalPool.length) {
      const a = track.publisherArtist || track.artist || track.uploader || '';
      if (tokenSimilarity(a, q) < 0.88 && tokenSimilarity(track.title, q) < 0.9) continue;
    }

    const canonicalTitle = best?.item?.titleShort || best?.item?.title || track.title;
    const canonicalArtist = best?.item?.artist || track.artist;
    const key = `${fold(canonicalTitle)}|${fold(canonicalArtist)}`;
    if (seen.has(key)) continue;
    seen.add(key);

    output.push({
      ...track,
      title: canonicalTitle || track.title,
      artist: canonicalArtist || track.artist,
      album: best?.item?.album || track.album || '',
      duration: best?.item?.duration || track.duration,
      canonical: Boolean(best),
      canonicalScore: best?.score || 0,
    });
  }

  return output.sort((a, b) => {
    if (Boolean(b.canonical) !== Boolean(a.canonical)) return Number(b.canonical) - Number(a.canonical);
    if ((b.canonicalScore || 0) !== (a.canonicalScore || 0)) return (b.canonicalScore || 0) - (a.canonicalScore || 0);
    return Number(b.playbackCount || 0) - Number(a.playbackCount || 0);
  });
}

async function gatherStrict(q, limit, { deep = false } = {}) {
  const canonical = await canonicalSearch(q, 25);
  const artistQuery = dominantArtist(canonical, q);
  const main = await scSearch(q, deep ? 50 : 40).catch(() => []);
  let clean = strictFilter(main, canonical, q);

  if (deep && clean.length < Math.min(limit, 12) && canonical.length) {
    const wanted = (artistQuery
      ? canonical.filter(item => tokenSimilarity(item.artist, artistQuery) >= 0.9)
      : canonical
    ).slice(0, 12);

    const batches = await Promise.allSettled(wanted.map(async item => {
      const exactQuery = `${item.artist} ${item.titleShort || item.title}`;
      const candidates = await scSearch(exactQuery, 10);
      return strictFilter(candidates, [item], exactQuery);
    }));

    const seen = new Set(clean.map(item => `${fold(item.title)}|${fold(item.artist)}`));
    for (const batch of batches) {
      if (batch.status !== 'fulfilled') continue;
      for (const item of batch.value || []) {
        const key = `${fold(item.title)}|${fold(item.artist)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        clean.push(item);
      }
    }
  }

  return { results: clean.slice(0, limit), canonical, artistQuery };
}

async function verifyPlayable(tracks, limit) {
  const queue = [...(tracks || [])];
  const output = [];
  const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
    while (queue.length && output.length < limit) {
      const item = queue.shift();
      try {
        const stream = await resolveSoundCloudStream(item.id);
        output.push({
          ...item,
          streamVerified: true,
          fullStream: true,
          provisional: false,
          providerMode: stream.providerMode || item.providerMode,
        });
      } catch (_) {}
    }
  });
  await Promise.all(workers);
  return output.slice(0, limit);
}

function cacheGet(cache, key, ttl) {
  const hit = cache.get(key);
  return hit && Date.now() - hit.at < ttl ? hit.value : null;
}

router.get('/fast', async (req, res) => {
  const q = normalize(req.query.q);
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 40);
  if (!q) return res.status(400).json({ error: 'Falta el parámetro q' });

  const key = fold(q);
  const cached = cacheGet(fastCache, key, FAST_CACHE_MS) || cacheGet(deepCache, key, DEEP_CACHE_MS);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const data = await gatherStrict(q, limit, { deep: false });
    const correction = data.artistQuery && fold(data.artistQuery) !== fold(q) && tokenSimilarity(data.artistQuery, q) >= 0.78
      ? data.artistQuery
      : null;
    const value = {
      results: data.results.map(item => ({ ...item, provisional: true })),
      source: 'canonical-fast',
      cached: false,
      provisional: true,
      correction,
      interpretedQuery: correction || q,
      searchMode: 'canonical-first',
    };
    fastCache.set(key, { at: Date.now(), value });
    return res.json(value);
  } catch (error) {
    console.warn('[Search strict fast]', error.message);
    return res.status(503).json({ error: 'No fue posible consultar el catálogo en este momento.' });
  }
});

router.get('/', async (req, res, next) => {
  const q = normalize(req.query.q);
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 40);
  if (!q) return res.status(400).json({ error: 'Falta el parámetro q' });

  // Las búsquedas por fragmentos de letra siguen usando el motor especializado.
  if (q.split(/\s+/).length >= 6) {
    try {
      const lyricMatches = await searchLyrics(q, Math.min(limit, 12));
      if (lyricMatches.length) {
        return res.json({
          results: lyricMatches,
          source: 'lyrics-index',
          cached: true,
          correction: null,
          interpretedQuery: q,
          lyricMatches: lyricMatches.length,
          searchMode: 'lyrics',
        });
      }
    } catch (_) {}
  }

  const key = fold(q);
  const cached = cacheGet(deepCache, key, DEEP_CACHE_MS);
  if (cached) return res.json({ ...cached, cached: true });

  try {
    const data = await gatherStrict(q, limit, { deep: true });
    const verified = await verifyPlayable(data.results, limit);
    if (!verified.length) return next();

    const correction = data.artistQuery && fold(data.artistQuery) !== fold(q) && tokenSimilarity(data.artistQuery, q) >= 0.78
      ? data.artistQuery
      : null;
    const value = {
      results: verified,
      source: 'canonical-verified',
      cached: false,
      correction,
      interpretedQuery: correction || q,
      lyricMatches: 0,
      searchMode: 'canonical-verified',
    };
    deepCache.set(key, { at: Date.now(), value });
    fastCache.set(key, { at: Date.now(), value: { ...value, provisional: false } });
    return res.json(value);
  } catch (error) {
    console.warn('[Search strict]', error.message);
    return next();
  }
});

module.exports = router;
