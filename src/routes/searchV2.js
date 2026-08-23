const router = require('express').Router();
const { db } = require('../config/db');
const { unifiedSearch, fold, similarity, isNoisy } = require('../services/catalogMatcher');
const { autocomplete: audiusAutocomplete } = require('../providers/audius');
const { searchSuggestions: deezerSuggestions } = require('../providers/deezerCatalog');
const { searchLyrics, warmLyrics } = require('../services/lyrics');

const responseCache = new Map();
const suggestionCache = new Map();
const CACHE_MS = 90_000;
const SUGGEST_MS = 5 * 60_000;
const CATALOG_VERSION = 'aleon-unified-v3';

function normalizeQuery(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, 180);
}

function isSearchPlayable(track) {
  if (!track?.id) return false;
  const id = String(track.id);
  const source = String(track.source || '').toLowerCase();
  if (id.startsWith('au_') || source === 'audius') return true;
  return (id.startsWith('sc_') || source === 'soundcloud') && track.playbackVerified === true && track.streamVerified === true;
}

function dedupe(items, limit = 30) {
  const seenIds = new Set();
  const seenKeys = new Set();
  const output = [];
  for (const item of items || []) {
    if (!item?.id || !item?.title || !isSearchPlayable(item)) continue;
    const key = `${fold(item.canonicalTitle || item.title)}|${fold(item.artist)}`;
    if (seenIds.has(item.id) || seenKeys.has(key)) continue;
    seenIds.add(item.id);
    seenKeys.add(key);
    output.push(item);
    if (output.length >= limit) break;
  }
  return output;
}

async function saveTracks(tracks) {
  const valid = (tracks || []).filter(track => track?.id && track?.title && !track.isPreview && isSearchPlayable(track));
  if (!valid.length) return;
  await Promise.allSettled(valid.map(track => db.query(
    `INSERT INTO tracks (
       id, source, external_id, title, artist, album, thumbnail, duration, metadata, updated_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,NOW())
     ON CONFLICT (id) DO UPDATE SET
       source = EXCLUDED.source,
       external_id = COALESCE(EXCLUDED.external_id, tracks.external_id),
       title = EXCLUDED.title,
       artist = EXCLUDED.artist,
       album = EXCLUDED.album,
       thumbnail = EXCLUDED.thumbnail,
       duration = EXCLUDED.duration,
       metadata = tracks.metadata || EXCLUDED.metadata,
       updated_at = NOW()`,
    [
      track.id,
      track.source,
      track.externalId || null,
      track.canonicalTitle || track.title,
      track.artist || null,
      track.catalogAlbum || track.album || null,
      track.thumbnail || null,
      Number(track.duration || 0) || null,
      JSON.stringify({
        durationStr: track.durationStr || '',
        genre: track.genre || '',
        mood: track.mood || '',
        permalink: track.permalink || '',
        releaseDate: track.releaseDate || null,
        playbackCount: Number(track.playbackCount || 0),
        likesCount: Number(track.likesCount || 0),
        repostsCount: Number(track.repostsCount || 0),
        providerMode: track.providerMode || track.source,
        streamVerified: true,
        playbackVerified: track.source === 'soundcloud' ? track.playbackVerified === true : true,
        fullStream: true,
        catalogVersion: CATALOG_VERSION,
        catalogMatched: Boolean(track.catalogMatched),
        catalogId: track.catalogId || null,
        qualityScore: Number(track.qualityScore || 0),
      }),
    ]
  )));
}

async function suggestionsFor(q) {
  const key = fold(q);
  const cached = suggestionCache.get(key);
  if (cached && Date.now() - cached.at < SUGGEST_MS) return cached.value;

  const [audius, deezer] = await Promise.all([
    audiusAutocomplete(q, 8).catch(() => []),
    deezerSuggestions(q, 8).catch(() => []),
  ]);
  const seen = new Set();
  const suggestions = [];
  for (const item of [...deezer, ...audius]) {
    if (!item?.value) continue;
    const skey = `${item.type}|${fold(item.value)}`;
    if (seen.has(skey)) continue;
    seen.add(skey);
    suggestions.push(item);
    if (suggestions.length >= 10) break;
  }

  const artist = suggestions.find(item => item.type === 'artist');
  let correction = null;
  if (artist && fold(artist.value) !== key && similarity(q, artist.value) >= 0.58) correction = artist.value;

  const value = { suggestions, correction };
  suggestionCache.set(key, { at: Date.now(), value });
  return value;
}

router.get('/suggest', async (req, res) => {
  const q = normalizeQuery(req.query.q);
  if (q.length < 2) return res.json({ suggestions: [], correction: null });
  try {
    return res.json(await suggestionsFor(q));
  } catch (error) {
    console.warn('[ALEON suggest]', error.message);
    return res.json({ suggestions: [], correction: null });
  }
});

router.get('/fast', async (req, res) => {
  const q = normalizeQuery(req.query.q);
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 40);
  if (!q) return res.status(400).json({ error: 'Falta el parámetro q' });

  try {
    const result = await unifiedSearch(q, limit, { includeSoundCloudFallback: false });
    const playable = dedupe(result.tracks, limit);
    saveTracks(playable).then(() => warmLyrics(playable, 3)).catch(() => {});
    return res.json({
      results: playable,
      artists: result.artists,
      albums: result.albums,
      catalogTracks: result.catalogTracks.slice(0, 24),
      artistMode: result.artistMode || null,
      providers: { ...result.providers, playbackPrimary: 'audius', playbackFallback: null },
      cached: result.cached,
      provisional: true,
      interpretedQuery: q,
      searchMode: 'aleon-fast-audius',
    });
  } catch (error) {
    console.warn('[ALEON search fast]', error.message);
    return res.status(503).json({ error: 'No fue posible consultar el catálogo en este momento.' });
  }
});

router.get('/', async (req, res) => {
  const q = normalizeQuery(req.query.q);
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 1), 40);
  if (!q) return res.status(400).json({ error: 'Falta el parámetro q' });

  const key = `${fold(q)}|${limit}|verified-fallback-v3`;
  const cached = responseCache.get(key);
  if (cached && Date.now() - cached.at < CACHE_MS) return res.json({ ...cached.value, cached: true });

  try {
    const [suggestionData, result] = await Promise.all([
      suggestionsFor(q).catch(() => ({ suggestions: [], correction: null })),
      unifiedSearch(q, limit, { includeSoundCloudFallback: true }),
    ]);

    let lyricResults = [];
    if (q.split(/\s+/).length >= 3) {
      lyricResults = await searchLyrics(q, Math.min(8, limit)).catch(() => []);
      lyricResults = lyricResults.filter(track => !isNoisy(track, q) && isSearchPlayable(track));
    }

    const results = dedupe([...result.tracks, ...lyricResults], limit);
    saveTracks(results).then(() => warmLyrics(results, 5)).catch(error => console.warn('[ALEON catalog cache]', error.message));

    const value = {
      results,
      artists: result.artists,
      albums: result.albums,
      catalogTracks: result.catalogTracks.slice(0, 30),
      artistMode: result.artistMode || null,
      providers: result.providers,
      correction: suggestionData.correction,
      suggestions: suggestionData.suggestions,
      interpretedQuery: suggestionData.correction || q,
      lyricMatches: lyricResults.length,
      cached: result.cached,
      searchMode: lyricResults.length ? 'aleon-verified-hybrid+lyrics' : 'aleon-verified-hybrid',
      availability: {
        playable: results.length,
        catalog: result.catalogTracks.length,
        audius: results.filter(track => track.source === 'audius').length,
        soundcloudVerified: results.filter(track => track.source === 'soundcloud' && track.playbackVerified === true).length,
      },
    };
    responseCache.set(key, { at: Date.now(), value });
    console.log(`[ALEON Search] "${q}" playable:${results.length} catalog:${result.catalogTracks.length} AU:${value.availability.audius} SCv:${value.availability.soundcloudVerified}`);
    return res.json(value);
  } catch (error) {
    console.error('[ALEON Search]', error);
    return res.status(503).json({ error: 'No fue posible consultar el catálogo en este momento.' });
  }
});

module.exports = router;
