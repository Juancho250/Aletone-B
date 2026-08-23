const { searchTracks: audiusSearchTracks } = require('../providers/audius');
const { searchCatalog } = require('../providers/deezerCatalog');
const { scSearch } = require('./soundcloud');

const SEARCH_CACHE_MS = 90_000;
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
    const durationScore = !sourceDuration || !targetDuration ? 0.6 : durationDelta <= 3 ? 1 : durationDelta <= 8 ? 0.9 : durationDelta <= 18 ? 0.72 : 0.25;
    const score = artistSim * 0.46 + titleSim * 0.46 + durationScore * 0.08;
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

function providerScore(track, query, canonicalTracks, artistMode) {
  if (isNoisy(track, query)) return { accepted: false, score: -999, match: null };
  const match = canonicalMatch(track, canonicalTracks);
  const q = fold(query);
  const title = fold(cleanTitle(track.title, track.artist));
  const artist = fold(track.artist);
  const uploader = fold(track.uploader);
  const artistTarget = fold(artistMode);
  const artistQuerySimilarity = Math.max(similarity(artist, q), similarity(uploader, q));
  const artistModeSimilarity = artistTarget ? Math.max(similarity(artist, artistTarget), similarity(uploader, artistTarget)) : 0;

  let score = track.source === 'audius' ? 80 : 35;
  if (track.verifiedUser) score += 28;
  if (artist === q || uploader === q) score += 100;
  else if (artistQuerySimilarity >= 0.9) score += 75;
  if (title === q) score += 100;
  else if (title.includes(q) || q.includes(title)) score += 40;
  if (match) score += match.score * 220;
  if (match?.score >= 0.88) score += 80;
  if (artistModeSimilarity >= 0.93) score += 60;
  if (Number(track.duration || 0) >= 100 && Number(track.duration || 0) <= 390) score += 18;
  score += Math.min(32, Math.log10(Number(track.playbackCount || 0) + 1) * 4.5);
  score += Math.min(14, Math.log10(Number(track.likesCount || 0) + 1) * 2.3);

  let accepted;
  if (track.source === 'soundcloud') {
    accepted = Boolean(match && match.score >= 0.82 && match.artistSim >= 0.78 && match.titleSim >= 0.78);
  } else if (artistMode) {
    accepted = artistModeSimilarity >= 0.9 || Boolean(match && match.score >= 0.78);
  } else {
    accepted = Boolean(match && match.score >= 0.72) || artistQuerySimilarity >= 0.88 || similarity(title, q) >= 0.88;
  }
  return { accepted, score, match };
}

function dedupeAndRank(candidates, query, canonicalTracks, limit) {
  const artistMode = detectArtistMode(query, canonicalTracks);
  const scored = [];
  for (const track of candidates || []) {
    if (!track?.id || !track?.title) continue;
    const result = providerScore(track, query, canonicalTracks, artistMode);
    if (!result.accepted) continue;
    scored.push({
      ...track,
      qualityScore: Math.round(result.score * 10) / 10,
      catalogMatched: Boolean(result.match && result.match.score >= 0.72),
      catalogId: result.match?.canonical?.catalogId || null,
      catalogAlbum: result.match?.canonical?.album || track.album || '',
      canonicalTitle: result.match?.canonical?.title || track.title,
    });
  }
  scored.sort((a, b) => b.qualityScore - a.qualityScore);

  const seen = new Set();
  const output = [];
  for (const track of scored) {
    const key = `${fold(track.canonicalTitle || track.title)}|${fold(track.artist)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(track);
    if (output.length >= limit) break;
  }
  return { tracks: output, artistMode };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const queue = [...items];
  const output = [];
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      try {
        const value = await worker(item);
        if (Array.isArray(value)) output.push(...value);
      } catch (_) {}
    }
  });
  await Promise.all(runners);
  return output;
}

function canonicalSeeds(catalogTracks, max = 8) {
  const seen = new Set();
  return [...(catalogTracks || [])]
    .sort((a, b) => Number(b.rank || 0) - Number(a.rank || 0))
    .filter(track => {
      const key = `${fold(track.titleShort || track.title)}|${fold(track.artist)}`;
      if (!track.title || !track.artist || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, max);
}

async function resolveCanonicalSeeds(catalogTracks, provider) {
  const seeds = canonicalSeeds(catalogTracks, 8);
  if (!seeds.length) return [];
  return mapWithConcurrency(seeds, 4, async seed => {
    const exact = `${seed.artist} ${seed.titleShort || seed.title}`;
    if (provider === 'audius') return audiusSearchTracks(exact, 8);
    return scSearch(exact, 8);
  });
}

async function unifiedSearch(query, limit = 30, { includeSoundCloudFallback = true } = {}) {
  const clean = String(query || '').trim().replace(/\s+/g, ' ').slice(0, 180);
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 40);
  const cacheKey = `${fold(clean)}|${safeLimit}|${includeSoundCloudFallback ? 1 : 0}`;
  const cached = searchCache.get(cacheKey);
  if (cached && Date.now() - cached.at < SEARCH_CACHE_MS) return { ...cached.value, cached: true };

  const [catalog, audiusInitial] = await Promise.all([
    searchCatalog(clean, Math.min(50, Math.max(30, safeLimit + 15))).catch(() => ({ tracks: [], artists: [], albums: [] })),
    audiusSearchTracks(clean, Math.min(50, Math.max(30, safeLimit + 15))).catch(() => []),
  ]);

  let audius = audiusInitial;
  let ranked = dedupeAndRank(audius, clean, catalog.tracks, safeLimit);

  // Keep expanding with exact Deezer-canonical titles even when SoundCloud is disabled.
  // This preserves breadth on Audius without reintroducing unstable SoundCloud results.
  if (ranked.tracks.length < Math.min(16, safeLimit) && catalog.tracks.length) {
    const exactAudius = await resolveCanonicalSeeds(catalog.tracks, 'audius');
    audius = [...audius, ...exactAudius];
    ranked = dedupeAndRank(audius, clean, catalog.tracks, safeLimit);
  }

  let soundcloud = [];
  if (includeSoundCloudFallback && ranked.tracks.length < Math.min(14, safeLimit) && catalog.tracks.length) {
    const [broadSc, exactSc] = await Promise.all([
      scSearch(clean, Math.min(50, Math.max(30, safeLimit + 15))).catch(() => []),
      resolveCanonicalSeeds(catalog.tracks, 'soundcloud').catch(() => []),
    ]);
    soundcloud = [...broadSc, ...exactSc];
    ranked = dedupeAndRank([...audius, ...soundcloud], clean, catalog.tracks, safeLimit);
  }

  const value = {
    tracks: ranked.tracks,
    artists: catalog.artists || [],
    albums: catalog.albums || [],
    catalogTracks: catalog.tracks || [],
    artistMode: ranked.artistMode || '',
    providers: {
      catalog: 'deezer',
      playbackPrimary: 'audius',
      playbackFallback: soundcloud.length ? 'soundcloud' : null,
    },
    cached: false,
  };
  searchCache.set(cacheKey, { at: Date.now(), value });
  return value;
}

module.exports = { fold, similarity, cleanTitle, isNoisy, canonicalMatch, detectArtistMode, unifiedSearch };
