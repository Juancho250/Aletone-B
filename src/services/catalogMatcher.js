const { searchTracks: audiusSearchTracks } = require('../providers/audius');
const { searchCatalog } = require('../providers/deezerCatalog');
const { scSearch } = require('./soundcloud');
const { resolveSoundCloudStream } = require('./streamResolver');

const SEARCH_CACHE_MS = 3 * 60_000;
const searchCache = new Map();

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
  const row = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= y.length; j += 1) {
      const previous = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (x[i - 1] === y[j - 1] ? 0 : 1));
      diagonal = previous;
    }
  }
  return row[y.length];
}

function similarity(a, b) {
  const x = fold(a);
  const y = fold(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.startsWith(y) || y.startsWith(x)) {
    return 0.86 + 0.14 * (Math.min(x.length, y.length) / Math.max(x.length, y.length));
  }
  const edit = Math.max(0, 1 - levenshtein(x, y) / Math.max(x.length, y.length));
  const xs = new Set(x.split(' ').filter(Boolean));
  const ys = new Set(y.split(' ').filter(Boolean));
  let common = 0;
  for (const token of xs) if (ys.has(token)) common += 1;
  const tokenScore = common / Math.max(xs.size, ys.size, 1);
  return Math.max(edit, tokenScore);
}

const NOISE_PATTERNS = [
  /\bdj\b/i, /\bremix\b/i, /\bbootleg\b/i, /\bmashup\b/i, /\bedit\b/i, /\bextended\b/i,
  /\bfree\s*download\b|\bdescarga\s*gratis\b/i,
  /\bsped\s*up\b|\bslowed\b|\breverb\b|\bnightcore\b/i,
  /\bcover\b|\bkaraoke\b|\binstrumental\b/i,
  /\bclub\s*mix\b|\bradio\s*edit\b|\btransition\b|\bintro\s*edit\b/i,
  /\bmegamix\b|\bfull\s*set\b|\bdj\s*set\b/i,
  /\bunofficial\b|\bfanmade\b|\bfan\s*made\b/i,
];

function queryAllowsVariants(query) {
  return NOISE_PATTERNS.some(pattern => pattern.test(String(query || '')));
}

function isNoisy(track, query) {
  if (queryAllowsVariants(query)) return false;
  const text = `${track?.title || ''} ${track?.artist || ''} ${track?.uploader || ''}`;
  if (NOISE_PATTERNS.some(pattern => pattern.test(text))) return true;
  const duration = Number(track?.duration || 0);
  return duration > 600 || (duration > 0 && duration < 70);
}

function cleanTitle(value, artist = '') {
  let title = String(value || '')
    .replace(/\[[^\]]*(official|audio|video|lyrics?|visualizer)[^\]]*\]/ig, ' ')
    .replace(/\([^)]*(official|audio|video|lyrics?|visualizer)[^)]*\)/ig, ' ')
    .replace(/\b(official\s*(music\s*)?video|official\s*audio|lyrics?|visualizer|audio)\b/ig, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const a = String(artist || '').trim();
  if (a && fold(title).startsWith(fold(a))) {
    const escaped = a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    title = title.replace(new RegExp(`^${escaped}\\s*[-–—:|]\\s*`, 'i'), '').trim();
  }
  return title;
}

function canonicalMatch(track, canonicalTracks) {
  const sourceTitle = cleanTitle(track.title, track.artist || track.uploader);
  let best = null;
  for (const canonical of canonicalTracks || []) {
    const artistSim = Math.max(similarity(track.artist, canonical.artist), similarity(track.uploader, canonical.artist));
    const titleSim = Math.max(similarity(sourceTitle, canonical.titleShort || canonical.title), similarity(sourceTitle, canonical.title));
    const sourceDuration = Number(track.duration || 0);
    const targetDuration = Number(canonical.duration || 0);
    const durationDelta = sourceDuration && targetDuration ? Math.abs(sourceDuration - targetDuration) : 0;
    const durationScore = !sourceDuration || !targetDuration ? 0.58 : durationDelta <= 3 ? 1 : durationDelta <= 8 ? 0.92 : durationDelta <= 16 ? 0.76 : durationDelta <= 25 ? 0.52 : 0.1;
    const score = artistSim * 0.47 + titleSim * 0.47 + durationScore * 0.06;
    if (!best || score > best.score) best = { score, artistSim, titleSim, durationDelta, canonical };
  }
  return best;
}

function detectArtistMode(query, canonicalTracks) {
  const q = fold(query);
  const counts = new Map();
  const names = new Map();
  for (const track of canonicalTracks || []) {
    const artist = fold(track.artist);
    if (!artist) continue;
    counts.set(artist, (counts.get(artist) || 0) + 1);
    names.set(artist, track.artist);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const exact = ranked.find(([artist]) => artist === q || similarity(artist, q) >= 0.94);
  if (exact && exact[1] >= 2) return names.get(exact[0]);
  if (ranked[0] && ranked[0][1] >= 4 && similarity(ranked[0][0], q) >= 0.82) return names.get(ranked[0][0]);
  return '';
}

function catalogRelevance(track, query, artistMode = '') {
  const q = fold(query);
  const title = fold(track.titleShort || track.title);
  const artist = fold(track.artist);
  const album = fold(track.album);
  const titleSim = similarity(title, q);
  const artistSim = similarity(artist, q);
  const albumSim = similarity(album, q);
  const rank = Math.max(0, Number(track.rank || 0));
  let score = titleSim * 260 + artistSim * 300 + albumSim * 70 + Math.log10(rank + 1) * 12;
  if (title === q) score += 180;
  if (artist === q) score += 260;
  if (artistMode && similarity(track.artist, artistMode) >= 0.94) score += 180;
  return score;
}

function orderCatalogTracks(catalogTracks, query, limit = 30) {
  const artistMode = detectArtistMode(query, catalogTracks);
  const seen = new Set();
  const ordered = [...(catalogTracks || [])]
    .map((track, index) => ({ track, index, score: catalogRelevance(track, query, artistMode) }))
    .sort((a, b) => b.score - a.score || b.track.rank - a.track.rank || a.index - b.index)
    .map(row => row.track)
    .filter(track => {
      const key = `${fold(track.titleShort || track.title)}|${fold(track.artist)}`;
      if (!track?.title || !track?.artist || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
  return { tracks: ordered, artistMode };
}

function candidateAccepted(track, canonical, provider, query) {
  if (!track?.id || !track?.title || isNoisy(track, query)) return null;
  const match = canonicalMatch(track, [canonical]);
  if (!match) return null;

  const maxDurationDelta = provider === 'soundcloud' ? 18 : 24;
  const minScore = provider === 'soundcloud' ? 0.88 : 0.82;
  const minArtist = provider === 'soundcloud' ? 0.86 : 0.80;
  const minTitle = provider === 'soundcloud' ? 0.86 : 0.82;
  if (match.score < minScore || match.artistSim < minArtist || match.titleSim < minTitle || match.durationDelta > maxDurationDelta) return null;

  let score = match.score * 300;
  if (track.verifiedUser) score += 30;
  score += Math.min(35, Math.log10(Number(track.playbackCount || 0) + 1) * 5);
  score += Math.min(15, Math.log10(Number(track.likesCount || 0) + 1) * 2.5);
  if (fold(cleanTitle(track.title, track.artist)) === fold(canonical.titleShort || canonical.title)) score += 35;
  if (similarity(track.artist, canonical.artist) >= 0.96 || similarity(track.uploader, canonical.artist) >= 0.96) score += 35;
  return { track, match, score };
}

function decorateCanonical(track, canonical, { playbackVerified = false, stream = null } = {}) {
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
    streamVerified: track.source === 'soundcloud' ? playbackVerified : true,
    playbackVerified: track.source === 'soundcloud' ? playbackVerified : true,
    playbackVerifiedAt: playbackVerified ? Date.now() : undefined,
    protocol: stream?.protocol || track.protocol || null,
    mimeType: stream?.mimeType || track.mimeType || null,
    playable: true,
  };
}

function bestCandidate(candidates, canonical, provider, query) {
  const accepted = [];
  for (const track of candidates || []) {
    const row = candidateAccepted(track, canonical, provider, query);
    if (row) accepted.push(row);
  }
  accepted.sort((a, b) => b.score - a.score);
  return accepted[0] || null;
}

async function mapWithConcurrencyOrdered(items, concurrency, worker) {
  const output = new Array(items.length).fill(null);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try { output[index] = await worker(items[index], index); }
      catch (_) { output[index] = null; }
    }
  });
  await Promise.all(runners);
  return output.filter(Boolean);
}

async function resolveCanonicalTrack(canonical, provider, query) {
  const exact = `${canonical.artist} ${canonical.titleShort || canonical.title}`;
  const candidates = provider === 'audius'
    ? await audiusSearchTracks(exact, 10).catch(() => [])
    : await scSearch(exact, 10).catch(() => []);
  const best = bestCandidate(candidates, canonical, provider, query);
  if (!best) return null;

  if (provider === 'soundcloud') {
    try {
      const stream = await resolveSoundCloudStream(best.track.id);
      return decorateCanonical(best.track, canonical, { playbackVerified: true, stream });
    } catch (_) {
      return null;
    }
  }
  return decorateCanonical(best.track, canonical);
}

function matchBroadAudiusToCatalog(candidates, catalogTracks, query) {
  const byCatalog = new Map();
  for (const candidate of candidates || []) {
    if (!candidate?.id || !candidate?.title || isNoisy(candidate, query)) continue;
    const match = canonicalMatch(candidate, catalogTracks);
    if (!match?.canonical) continue;
    const accepted = candidateAccepted(candidate, match.canonical, 'audius', query);
    if (!accepted) continue;
    const key = String(match.canonical.catalogId);
    const current = byCatalog.get(key);
    if (!current || accepted.score > current.score) byCatalog.set(key, accepted);
  }
  return byCatalog;
}

function orderPlayableByCatalog(catalogTracks, matches, limit) {
  const output = [];
  const seenIds = new Set();
  for (const canonical of catalogTracks || []) {
    const match = matches.get(String(canonical.catalogId));
    if (!match) continue;
    const track = match.track ? decorateCanonical(match.track, canonical) : match;
    if (!track?.id || seenIds.has(track.id)) continue;
    seenIds.add(track.id);
    output.push(track);
    if (output.length >= limit) break;
  }
  return output;
}

async function unifiedSearch(query, limit = 30, { includeSoundCloudFallback = true, quick = false } = {}) {
  const clean = String(query || '').trim().replace(/\s+/g, ' ').slice(0, 180);
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 40);
  const cacheKey = `${fold(clean)}|${safeLimit}|${includeSoundCloudFallback ? 1 : 0}|${quick ? 1 : 0}|canonical-first-v2`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SEARCH_CACHE_MS) return { ...cached.value, cached: true };

  const [catalog, audiusInitial] = await Promise.all([
    searchCatalog(clean, Math.min(50, Math.max(36, safeLimit + 14))).catch(() => ({ tracks: [], artists: [], albums: [] })),
    audiusSearchTracks(clean, Math.min(50, Math.max(24, safeLimit))).catch(() => []),
  ]);

  const orderedCatalog = orderCatalogTracks(catalog.tracks || [], clean, Math.min(32, safeLimit));
  const catalogTracks = orderedCatalog.tracks;
  const artistMode = orderedCatalog.artistMode;
  const matches = matchBroadAudiusToCatalog(audiusInitial, catalogTracks, clean);

  if (!quick && catalogTracks.length) {
    const unresolvedAudius = catalogTracks.filter(track => !matches.has(String(track.catalogId))).slice(0, 16);
    const exactAudius = await mapWithConcurrencyOrdered(unresolvedAudius, 6, canonical => resolveCanonicalTrack(canonical, 'audius', clean));
    for (const track of exactAudius) matches.set(String(track.catalogId), track);
  }

  if (!quick && includeSoundCloudFallback && catalogTracks.length) {
    const unresolvedSoundCloud = catalogTracks.filter(track => !matches.has(String(track.catalogId))).slice(0, 14);
    const exactSoundCloud = await mapWithConcurrencyOrdered(unresolvedSoundCloud, 5, canonical => resolveCanonicalTrack(canonical, 'soundcloud', clean));
    for (const track of exactSoundCloud) matches.set(String(track.catalogId), track);
  }

  let tracks = [];
  if (catalogTracks.length) {
    tracks = orderPlayableByCatalog(catalogTracks, matches, safeLimit);
  } else {
    // No canonical catalog hit: keep only clean Audius results strongly tied to the raw query.
    const q = fold(clean);
    tracks = (audiusInitial || [])
      .filter(track => !isNoisy(track, clean))
      .filter(track => Math.max(similarity(track.artist, q), similarity(track.title, q)) >= 0.86)
      .slice(0, safeLimit)
      .map(track => ({ ...track, playable: true, streamVerified: true, playbackVerified: true }));
  }

  const value = {
    tracks,
    artists: catalog.artists || [],
    albums: catalog.albums || [],
    catalogTracks,
    artistMode: artistMode || '',
    providers: {
      catalog: 'deezer',
      playbackPrimary: 'audius',
      playbackFallback: tracks.some(track => track.source === 'soundcloud') ? 'soundcloud-canonical-preverified' : null,
    },
    cached: false,
  };
  searchCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

module.exports = {
  fold,
  similarity,
  cleanTitle,
  isNoisy,
  canonicalMatch,
  detectArtistMode,
  orderCatalogTracks,
  unifiedSearch,
};
