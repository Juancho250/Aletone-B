const router = require('express').Router();
const { db } = require('../config/db');
const auth = require('../middleware/auth');
const { searchTracks: audiusSearch, recommendedTracks: audiusRecommended } = require('../providers/audius');
const { unifiedSearch, fold } = require('../services/catalogMatcher');

router.use(auth);

async function topArtists(userId) {
  return db.all(
    `SELECT artist,
            COUNT(*)::int AS plays,
            SUM(CASE WHEN completed THEN 1 ELSE 0 END)::int AS completes,
            COALESCE(SUM(listened_ms),0)::bigint AS listened_ms,
            MAX(played_at) AS last_played
     FROM history
     WHERE user_id = $1
       AND artist IS NOT NULL
       AND artist <> ''
       AND played_at > NOW() - INTERVAL '120 days'
     GROUP BY artist
     ORDER BY (
       COUNT(*) * 2
       + SUM(CASE WHEN completed THEN 4 ELSE 0 END)
       + LEAST(COALESCE(SUM(listened_ms),0) / 60000.0, 30)
     ) DESC
     LIMIT 8`,
    [userId]
  );
}

function popularity(track) {
  return Math.min(22,
    Math.log10(Number(track.playbackCount || 0) + 1) * 3.2
    + Math.log10(Number(track.likesCount || 0) + 1) * 2.1
  );
}

function score(track, { seedArtist, tasteArtists, origin }) {
  const artist = fold(track.artist);
  const seed = fold(seedArtist);
  let value = 10 + popularity(track);
  if (track.source === 'audius') value += 18;
  if (track.catalogMatched) value += 18;
  if (origin === 'seed') value += 42;
  if (origin === 'recommended') value += 30;
  if (origin === 'taste') value += 24;
  if (origin === 'canonical-fallback') value += 12;
  if (seed && artist === seed) value += 20;
  const tasteIndex = tasteArtists.findIndex(item => fold(item.artist) === artist);
  if (tasteIndex >= 0) value += Math.max(6, 28 - tasteIndex * 3);
  return value;
}

function diversify(candidates, seedTrackId, limit) {
  const seenIds = new Set(seedTrackId ? [seedTrackId] : []);
  const seenKeys = new Set();
  const perArtist = new Map();
  const output = [];

  for (const item of candidates.sort((a, b) => b.radioScore - a.radioScore)) {
    const track = item.track;
    if (!track?.id || seenIds.has(track.id)) continue;
    const key = `${fold(track.canonicalTitle || track.title)}|${fold(track.artist)}`;
    if (seenKeys.has(key)) continue;
    const artistKey = fold(track.artist) || 'unknown';
    if ((perArtist.get(artistKey) || 0) >= 2) continue;

    seenIds.add(track.id);
    seenKeys.add(key);
    perArtist.set(artistKey, (perArtist.get(artistKey) || 0) + 1);
    output.push({ ...track, radioScore: Math.round(item.radioScore * 10) / 10 });
    if (output.length >= limit) break;
  }
  return output;
}

router.get('/', async (req, res) => {
  const seedTrackId = String(req.query.seedTrackId || '').slice(0, 190);
  const seedArtist = String(req.query.seedArtist || '').trim().slice(0, 140);
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 8), 40);
  if (!seedTrackId && !seedArtist) return res.status(400).json({ error: 'Se requiere una canción o artista base' });

  try {
    const tasteArtists = await topArtists(req.user.id);
    const tasks = [];

    if (seedArtist) {
      tasks.push(audiusSearch(seedArtist, 28).then(rows => rows.map(track => ({ track, origin: 'seed' }))));
    }
    tasks.push(audiusRecommended(30).then(rows => rows.map(track => ({ track, origin: 'recommended' }))));

    for (const row of tasteArtists.slice(0, 5)) {
      if (fold(row.artist) === fold(seedArtist)) continue;
      tasks.push(audiusSearch(row.artist, 10).then(rows => rows.map(track => ({ track, origin: 'taste' }))));
    }

    const settled = await Promise.allSettled(tasks);
    const candidates = [];
    const seen = new Set();
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue;
      for (const item of result.value || []) {
        const track = item.track;
        const key = `${fold(track.title)}|${fold(track.artist)}`;
        if (!track?.id || seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          ...item,
          radioScore: score(track, { seedArtist, tasteArtists, origin: item.origin }),
        });
      }
    }

    if (candidates.length < Math.max(12, limit / 2) && seedArtist) {
      const fallback = await unifiedSearch(seedArtist, 30, { includeSoundCloudFallback: true }).catch(() => ({ tracks: [] }));
      for (const track of fallback.tracks || []) {
        const key = `${fold(track.title)}|${fold(track.artist)}`;
        if (!track?.id || seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          track,
          origin: 'canonical-fallback',
          radioScore: score(track, { seedArtist, tasteArtists, origin: 'canonical-fallback' }),
        });
      }
    }

    const tracks = diversify(candidates, seedTrackId, limit);
    return res.json({
      tracks,
      seed: { trackId: seedTrackId || null, artist: seedArtist || null },
      basedOn: tasteArtists.slice(0, 5).map(item => item.artist),
      algorithm: 'aleon-radio-v2',
      playbackPrimary: 'audius',
      personalized: tasteArtists.length > 0,
    });
  } catch (error) {
    console.error('[ALEON Radio]', error);
    return res.status(500).json({ error: 'No fue posible crear ALEON Radio' });
  }
});

module.exports = router;