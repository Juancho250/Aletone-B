const router = require('express').Router();
const { db } = require('../config/db');
const auth = require('../middleware/auth');
const { scRelated, scSearch, scStreamInfo } = require('../services/soundcloud');

router.use(auth);

const fold = value => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

async function topArtists(userId) {
  return db.all(
    `SELECT artist,
            COUNT(*)::int AS plays,
            SUM(CASE WHEN completed THEN 1 ELSE 0 END)::int AS completes,
            COALESCE(SUM(listened_ms),0)::bigint AS listened_ms
     FROM history
     WHERE user_id = $1
       AND artist IS NOT NULL
       AND artist <> ''
       AND played_at > NOW() - INTERVAL '120 days'
     GROUP BY artist
     ORDER BY (COUNT(*) * 2 + SUM(CASE WHEN completed THEN 4 ELSE 0 END) + LEAST(COALESCE(SUM(listened_ms),0) / 60000.0, 30)) DESC
     LIMIT 6`,
    [userId]
  );
}

function score(track, { seedArtist, tasteArtists, origin }) {
  const artist = fold(track.artist);
  const seed = fold(seedArtist);
  let value = 10;
  if (origin === 'related') value += 48;
  if (origin === 'seed') value += 30;
  if (origin === 'taste') value += 18;
  if (seed && artist === seed) value += 24;
  const tasteIndex = tasteArtists.findIndex(item => fold(item.artist) === artist);
  if (tasteIndex >= 0) value += Math.max(5, 24 - tasteIndex * 3);
  value += Math.min(18, Math.log10(Number(track.playbackCount || 0) + 1) * 3);
  value += Math.min(10, Math.log10(Number(track.likesCount || 0) + 1) * 2);
  return value;
}

async function verify(items, limit) {
  const output = [];
  const queue = [...items];
  const workers = Array.from({ length: Math.min(8, queue.length) }, async () => {
    while (queue.length && output.length < limit) {
      const item = queue.shift();
      try {
        await scStreamInfo(item.track.id);
        output.push(item);
      } catch (_) {}
    }
  });
  await Promise.all(workers);
  return output.slice(0, limit);
}

router.get('/', async (req, res) => {
  const seedTrackId = String(req.query.seedTrackId || '').slice(0, 190);
  const seedArtist = String(req.query.seedArtist || '').trim().slice(0, 140);
  const limit = Math.min(Math.max(Number(req.query.limit) || 30, 8), 40);
  if (!seedTrackId && !seedArtist) return res.status(400).json({ error: 'Se requiere una canción o artista base' });

  try {
    const tasteArtists = await topArtists(req.user.id);
    const tasks = [];

    if (seedTrackId.startsWith('sc_')) {
      tasks.push(scRelated(seedTrackId, 35).then(rows => rows.map(track => ({ track, origin: 'related' }))));
    }
    if (seedArtist) {
      tasks.push(scSearch(seedArtist, 25).then(rows => rows.map(track => ({ track, origin: 'seed' }))));
    }
    for (const row of tasteArtists.slice(0, 4)) {
      if (fold(row.artist) === fold(seedArtist)) continue;
      tasks.push(scSearch(row.artist, 10).then(rows => rows.map(track => ({ track, origin: 'taste' }))));
    }

    const settled = await Promise.allSettled(tasks);
    const seen = new Set();
    const candidates = [];
    for (const result of settled) {
      if (result.status !== 'fulfilled') continue;
      for (const item of result.value || []) {
        const track = item.track;
        const key = `${fold(track.title)}|${fold(track.artist)}`;
        if (!track?.id || track.id === seedTrackId || seen.has(key)) continue;
        seen.add(key);
        candidates.push({
          ...item,
          radioScore: score(track, { seedArtist, tasteArtists, origin: item.origin }),
        });
      }
    }

    candidates.sort((a, b) => b.radioScore - a.radioScore);
    const verified = await verify(candidates, limit * 2);

    const perArtist = new Map();
    const tracks = [];
    for (const item of verified) {
      const artistKey = fold(item.track.artist) || 'unknown';
      if ((perArtist.get(artistKey) || 0) >= 3) continue;
      perArtist.set(artistKey, (perArtist.get(artistKey) || 0) + 1);
      tracks.push({ ...item.track, radioScore: Math.round(item.radioScore * 10) / 10 });
      if (tracks.length >= limit) break;
    }

    return res.json({
      tracks,
      seed: { trackId: seedTrackId || null, artist: seedArtist || null },
      basedOn: tasteArtists.slice(0, 5).map(item => item.artist),
      algorithm: 'aletone-radio-v1',
    });
  } catch (error) {
    console.error('[Radio]', error);
    return res.status(500).json({ error: 'No fue posible crear la radio de esta canción' });
  }
});

module.exports = router;
