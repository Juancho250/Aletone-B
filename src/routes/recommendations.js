const router = require('express').Router();
const { db } = require('../config/db');
const auth = require('../middleware/auth');
const { scSearch, scRelated, scStreamInfo } = require('../services/soundcloud');

router.use(auth);

const playabilityCache = new Map();
const PLAYABILITY_TTL_MS = 10 * 60_000;

const norm = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

function deterministicNoise(id) {
  const text = String(id || 'aletone');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 1000) / 1000;
}

function popularity(track) {
  const plays = Math.max(0, Number(track.playbackCount || 0));
  const likes = Math.max(0, Number(track.likesCount || 0));
  return Math.min(18, Math.log10(plays + 1) * 2.4 + Math.log10(likes + 1) * 1.7);
}

function trackKey(track) {
  return `${norm(track.title)}|${norm(track.artist)}`;
}

async function verifyPlayable(track) {
  if (!track?.id) return null;
  const cached = playabilityCache.get(track.id);
  if (cached && Date.now() - cached.at < PLAYABILITY_TTL_MS) {
    return cached.ok ? { ...track, streamVerified: true, fullStream: true, isPreview: false } : null;
  }

  try {
    await scStreamInfo(track.id);
    playabilityCache.set(track.id, { at: Date.now(), ok: true });
    return { ...track, streamVerified: true, fullStream: true, streamable: true, isPreview: false };
  } catch (_) {
    playabilityCache.set(track.id, { at: Date.now(), ok: false });
    return null;
  }
}

async function verifyPool(pool) {
  const output = [];
  const queue = [...pool];
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) {
      const candidate = queue.shift();
      const track = await verifyPlayable(candidate.track);
      if (track) output.push({ ...candidate, track });
    }
  });
  await Promise.all(workers);
  return output;
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
       ORDER BY
         (COUNT(*) * 2
          + SUM(CASE WHEN completed THEN 4 ELSE 0 END)
          + LEAST(COALESCE(SUM(listened_ms),0) / 60000.0, 30)) DESC
       LIMIT 12`,
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
    const key = norm(row.artist);
    if (!key) return;
    const recencyDays = Math.max(0, (Date.now() - new Date(row.last_played).getTime()) / 86_400_000);
    const recency = Math.max(0, 16 - recencyDays * 0.25);
    const weight =
      Math.min(28, Number(row.plays || 0) * 2.2)
      + Math.min(22, Number(row.completes || 0) * 4)
      + Math.min(16, Number(row.listened_ms || 0) / 240_000)
      + recency
      + Math.max(0, 8 - index * 0.5);
    artistWeights.set(key, Math.max(artistWeights.get(key) || 0, weight));
  });

  playlistArtists.forEach(row => {
    const key = norm(row.artist);
    if (!key) return;
    artistWeights.set(key, (artistWeights.get(key) || 0) + Math.min(18, Number(row.n || 0) * 3));
  });

  saved.forEach(row => {
    const key = norm(row.artist);
    if (!key) return;
    artistWeights.set(key, (artistWeights.get(key) || 0) + 12);
  });

  return {
    artists,
    artistWeights,
    recent: new Map(recent.map(row => [row.track_id, new Date(row.last_played).getTime()])),
    trackSignals: new Map(trackSignals.map(row => [row.track_id, row])),
    savedIds: new Set(saved.map(row => row.track_id)),
  };
}

async function buildCandidatePool(seedTrackId, seedArtist, profile, limit) {
  const tasks = [];

  if (seedTrackId?.startsWith('sc_')) {
    tasks.push(
      scRelated(seedTrackId, Math.max(24, limit * 2))
        .then(items => items.map(track => ({ track, origin: 'related' })))
    );
  }

  if (seedArtist) {
    tasks.push(
      scSearch(seedArtist, Math.max(12, Math.ceil(limit * 1.2)))
        .then(items => items.map(track => ({ track, origin: 'seed-artist' })))
    );
  }

  const topArtists = [...profile.artistWeights.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([artistKey]) => profile.artists.find(row => norm(row.artist) === artistKey)?.artist || artistKey);

  for (const artist of topArtists) {
    tasks.push(
      scSearch(artist, 9)
        .then(items => items.map(track => ({ track, origin: 'taste-artist' })))
    );
  }

  if (!tasks.length) {
    tasks.push(
      scSearch('latin urbano hits', Math.max(limit * 2, 24))
        .then(items => items.map(track => ({ track, origin: 'fallback' })))
    );
  }

  const settled = await Promise.allSettled(tasks);
  const candidates = settled.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  return verifyPool(candidates);
}

function scoreCandidate(candidate, context) {
  const { track, origin } = candidate;
  const artistKey = norm(track.artist);
  const seedArtistKey = norm(context.seedArtist);
  let score = 10;

  if (origin === 'related') score += 38;
  if (origin === 'seed-artist') score += 26;
  if (origin === 'taste-artist') score += 18;

  if (seedArtistKey && artistKey === seedArtistKey) score += 30;

  const taste = context.profile.artistWeights.get(artistKey) || 0;
  score += Math.min(44, taste * 0.72);
  score += popularity(track);

  if (context.profile.savedIds.has(track.id)) score += 34;

  const signal = context.profile.trackSignals.get(track.id);
  if (signal) {
    const plays = Number(signal.plays || 0);
    const completes = Number(signal.completes || 0);
    const listened = Number(signal.listened_ms || 0);
    const completionRatio = plays ? completes / plays : 0;

    if (completionRatio >= 0.5) score += Math.min(18, plays * 2.5);
    if (plays >= 2 && completionRatio === 0 && listened / plays < 25_000) score -= 38;
  }

  const lastPlayed = context.profile.recent.get(track.id);
  if (lastPlayed) {
    const ageDays = (Date.now() - lastPlayed) / 86_400_000;
    if (ageDays < 1) score -= 55;
    else if (ageDays < 3) score -= 26;
    else if (ageDays < 10) score -= 10;
  }

  score += (deterministicNoise(track.id) - 0.5) * 5;
  return score;
}

function diversify(scored, limit) {
  const picked = [];
  const perArtist = new Map();
  const seenTracks = new Set();
  const seenKeys = new Set();

  for (const item of scored) {
    const track = item.track;
    const artist = norm(track.artist) || 'unknown';
    const key = trackKey(track);
    if (seenTracks.has(track.id) || seenKeys.has(key)) continue;
    if ((perArtist.get(artist) || 0) >= 2) continue;

    picked.push({ ...track, recommendationScore: Math.round(item.score * 10) / 10 });
    seenTracks.add(track.id);
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
    const pool = await buildCandidatePool(seedTrackId, seedArtist, profile, limit);

    const scored = pool
      .filter(({ track }) => track?.id && track.streamVerified === true && track.id !== seedTrackId)
      .map(candidate => ({
        ...candidate,
        score: scoreCandidate(candidate, { seedArtist, profile }),
      }))
      .sort((a, b) => b.score - a.score);

    const recommendations = diversify(scored, limit);

    return res.json({
      recommendations,
      basedOn: [...profile.artistWeights.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([key]) => profile.artists.find(row => norm(row.artist) === key)?.artist || key),
      seed: { trackId: seedTrackId || null, artist: seedArtist || null },
      algorithm: 'aletone-taste-graph-v1.1',
      verifiedPlayback: true,
      personalized: profile.artistWeights.size > 0,
    });
  } catch (error) {
    console.error('[Recommendations]', error);
    return res.status(500).json({ error: 'No fue posible construir Aletone Flow' });
  }
});

module.exports = router;
