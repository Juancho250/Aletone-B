const router = require('express').Router();
const { db } = require('../config/db');
const auth = require('../middleware/auth');
const { searchTracks: audiusSearch, recommendedTracks: audiusRecommended } = require('../providers/audius');
const { unifiedSearch, fold } = require('../services/catalogMatcher');

router.use(auth);

function deterministicNoise(id) {
  const text = String(id || 'aleon');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1000) / 1000;
}

function popularity(track) {
  return Math.min(20,
    Math.log10(Number(track.playbackCount || 0) + 1) * 2.8
    + Math.log10(Number(track.likesCount || 0) + 1) * 1.8
  );
}

async function loadTasteProfile(userId) {
  const [artists, recent, trackSignals, saved, playlistArtists] = await Promise.all([
    db.all(
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
       LIMIT 14`,
      [userId]
    ),
    db.all(
      `SELECT track_id, MAX(played_at) AS last_played
       FROM history
       WHERE user_id = $1 AND played_at > NOW() - INTERVAL '30 days'
       GROUP BY track_id`,
      [userId]
    ),
    db.all(
      `SELECT track_id,
              COUNT(*)::int AS plays,
              SUM(CASE WHEN completed THEN 1 ELSE 0 END)::int AS completes,
              COALESCE(SUM(listened_ms),0)::bigint AS listened_ms
       FROM history
       WHERE user_id = $1
       GROUP BY track_id`,
      [userId]
    ),
    db.all(
      `SELECT st.track_id, t.artist
       FROM saved_tracks st
       LEFT JOIN tracks t ON t.id = st.track_id
       WHERE st.user_id = $1`,
      [userId]
    ),
    db.all(
      `SELECT COALESCE(t.artist, pt.artist) AS artist, COUNT(*)::int AS n
       FROM playlists p
       JOIN playlist_tracks pt ON pt.playlist_id = p.id
       LEFT JOIN tracks t ON t.id = pt.track_id
       WHERE p.user_id = $1
         AND COALESCE(t.artist, pt.artist) IS NOT NULL
       GROUP BY COALESCE(t.artist, pt.artist)
       ORDER BY n DESC
       LIMIT 20`,
      [userId]
    ),
  ]);

  const artistWeights = new Map();
  artists.forEach((row, index) => {
    const key = fold(row.artist);
    if (!key) return;
    const recencyDays = Math.max(0, (Date.now() - new Date(row.last_played).getTime()) / 86_400_000);
    const recency = Math.max(0, 16 - recencyDays * 0.25);
    const weight =
      Math.min(30, Number(row.plays || 0) * 2.2)
      + Math.min(24, Number(row.completes || 0) * 4)
      + Math.min(18, Number(row.listened_ms || 0) / 240_000)
      + recency
      + Math.max(0, 9 - index * 0.5);
    artistWeights.set(key, Math.max(artistWeights.get(key) || 0, weight));
  });

  playlistArtists.forEach(row => {
    const key = fold(row.artist);
    if (key) artistWeights.set(key, (artistWeights.get(key) || 0) + Math.min(18, Number(row.n || 0) * 3));
  });
  saved.forEach(row => {
    const key = fold(row.artist);
    if (key) artistWeights.set(key, (artistWeights.get(key) || 0) + 12);
  });

  return {
    artists,
    artistWeights,
    recent: new Map(recent.map(row => [row.track_id, new Date(row.last_played).getTime()])),
    trackSignals: new Map(trackSignals.map(row => [row.track_id, row])),
    savedIds: new Set(saved.map(row => row.track_id)),
  };
}

function topArtistNames(profile) {
  return [...profile.artistWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 7)
    .map(([artistKey]) => profile.artists.find(row => fold(row.artist) === artistKey)?.artist || artistKey);
}

async function buildPool(seedArtist, profile, limit) {
  const tasks = [audiusRecommended(Math.max(24, limit * 2)).then(items => items.map(track => ({ track, origin: 'audius-recommended' })))];

  if (seedArtist) {
    tasks.push(audiusSearch(seedArtist, Math.max(18, limit)).then(items => items.map(track => ({ track, origin: 'seed' }))));
  }

  for (const artist of topArtistNames(profile)) {
    if (fold(artist) === fold(seedArtist)) continue;
    tasks.push(audiusSearch(artist, 10).then(items => items.map(track => ({ track, origin: 'taste' }))));
  }

  const settled = await Promise.allSettled(tasks);
  const pool = settled.flatMap(result => result.status === 'fulfilled' ? result.value : []);

  if (pool.length < Math.max(18, limit) && seedArtist) {
    const fallback = await unifiedSearch(seedArtist, Math.max(20, limit), { includeSoundCloudFallback: true }).catch(() => ({ tracks: [] }));
    pool.push(...(fallback.tracks || []).map(track => ({ track, origin: 'canonical-fallback' })));
  }
  return pool;
}

function scoreCandidate(candidate, { seedArtist, profile }) {
  const { track, origin } = candidate;
  const artistKey = fold(track.artist);
  const seedKey = fold(seedArtist);
  let score = 12 + popularity(track);

  if (track.source === 'audius') score += 18;
  if (track.catalogMatched) score += 16;
  if (origin === 'audius-recommended') score += 28;
  if (origin === 'seed') score += 34;
  if (origin === 'taste') score += 24;
  if (origin === 'canonical-fallback') score += 12;
  if (seedKey && artistKey === seedKey) score += 28;

  score += Math.min(46, (profile.artistWeights.get(artistKey) || 0) * 0.74);
  if (profile.savedIds.has(track.id)) score += 34;

  const signal = profile.trackSignals.get(track.id);
  if (signal) {
    const plays = Number(signal.plays || 0);
    const completes = Number(signal.completes || 0);
    const listened = Number(signal.listened_ms || 0);
    const completionRatio = plays ? completes / plays : 0;
    if (completionRatio >= 0.5) score += Math.min(20, plays * 2.6);
    if (plays >= 2 && completionRatio === 0 && listened / plays < 25_000) score -= 42;
  }

  const lastPlayed = profile.recent.get(track.id);
  if (lastPlayed) {
    const ageDays = (Date.now() - lastPlayed) / 86_400_000;
    if (ageDays < 1) score -= 58;
    else if (ageDays < 3) score -= 28;
    else if (ageDays < 10) score -= 11;
  }

  score += (deterministicNoise(track.id) - 0.5) * 4;
  return score;
}

function diversify(scored, seedTrackId, limit) {
  const picked = [];
  const perArtist = new Map();
  const seenIds = new Set(seedTrackId ? [seedTrackId] : []);
  const seenKeys = new Set();

  for (const item of scored) {
    const track = item.track;
    if (!track?.id || seenIds.has(track.id)) continue;
    const key = `${fold(track.canonicalTitle || track.title)}|${fold(track.artist)}`;
    if (seenKeys.has(key)) continue;
    const artist = fold(track.artist) || 'unknown';
    if ((perArtist.get(artist) || 0) >= 2) continue;

    picked.push({ ...track, recommendationScore: Math.round(item.score * 10) / 10 });
    seenIds.add(track.id);
    seenKeys.add(key);
    perArtist.set(artist, (perArtist.get(artist) || 0) + 1);
    if (picked.length >= limit) break;
  }
  return picked;
}

router.get('/', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 40);
  const seedTrackId = String(req.query.seedTrackId || '').slice(0, 190);
  const seedArtist = String(req.query.seedArtist || '').trim().slice(0, 140);

  try {
    const profile = await loadTasteProfile(req.user.id);
    const pool = await buildPool(seedArtist, profile, limit);
    const scored = pool
      .filter(({ track }) => track?.id && !track.isPreview && track.id !== seedTrackId)
      .map(candidate => ({ ...candidate, score: scoreCandidate(candidate, { seedArtist, profile }) }))
      .sort((a, b) => b.score - a.score);
    const recommendations = diversify(scored, seedTrackId, limit);

    return res.json({
      recommendations,
      basedOn: topArtistNames(profile).slice(0, 5),
      seed: { trackId: seedTrackId || null, artist: seedArtist || null },
      algorithm: 'aleon-taste-graph-v2',
      playbackPrimary: 'audius',
      personalized: profile.artistWeights.size > 0,
    });
  } catch (error) {
    console.error('[ALEON Recommendations]', error);
    return res.status(500).json({ error: 'No fue posible construir ALEON Flow' });
  }
});

module.exports = router;