const router = require('express').Router();
const { db } = require('../config/db');
const auth = require('../middleware/auth');

router.use(auth);

function text(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

async function upsertTrack(track) {
  const id = text(track.id || track.track_id, 220);
  if (!id) throw new Error('track_id es requerido');
  const source = text(track.source || (id.startsWith('sc_') ? 'soundcloud' : id.startsWith('dz_') ? 'deezer' : 'unknown'), 40);
  const externalId = id.includes('_') ? id.slice(id.indexOf('_') + 1) : null;
  const duration = Number.isFinite(Number(track.duration)) ? Math.max(0, Math.round(Number(track.duration))) : null;

  await db.query(
    `INSERT INTO tracks (id, source, external_id, title, artist, album, thumbnail, duration, metadata, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,NOW())
     ON CONFLICT (id) DO UPDATE SET
       title = COALESCE(NULLIF(EXCLUDED.title,''), tracks.title),
       artist = COALESCE(NULLIF(EXCLUDED.artist,''), tracks.artist),
       album = COALESCE(NULLIF(EXCLUDED.album,''), tracks.album),
       thumbnail = COALESCE(NULLIF(EXCLUDED.thumbnail,''), tracks.thumbnail),
       duration = COALESCE(EXCLUDED.duration, tracks.duration),
       metadata = tracks.metadata || EXCLUDED.metadata,
       updated_at = NOW()`,
    [
      id,
      source,
      externalId,
      text(track.title, 500) || 'Sin título',
      text(track.artist, 300) || null,
      text(track.album, 300) || null,
      text(track.thumbnail, 2000) || null,
      duration,
      JSON.stringify({ genre: track.genre || '', permalink: track.permalink || '' }),
    ]
  );
  return id;
}

router.get('/', async (req, res) => {
  const trackId = text(req.query.trackId, 220);
  if (trackId) {
    const saved = await db.one(
      'SELECT 1 AS saved FROM saved_tracks WHERE user_id = $1 AND track_id = $2',
      [req.user.id, trackId]
    );
    return res.json({ saved: Boolean(saved) });
  }

  const tracks = await db.all(
    `SELECT t.id, t.title, t.artist, t.album, t.thumbnail, t.duration, t.source, t.metadata, st.created_at
     FROM saved_tracks st
     JOIN tracks t ON t.id = st.track_id
     WHERE st.user_id = $1
     ORDER BY st.created_at DESC
     LIMIT 500`,
    [req.user.id]
  );
  return res.json({ tracks });
});

router.post('/', async (req, res) => {
  try {
    const trackId = await upsertTrack(req.body || {});
    await db.query(
      `INSERT INTO saved_tracks (user_id, track_id)
       VALUES ($1,$2)
       ON CONFLICT (user_id, track_id) DO NOTHING`,
      [req.user.id, trackId]
    );
    return res.status(201).json({ saved: true, trackId });
  } catch (error) {
    console.error('[Saved add]', error.message);
    return res.status(400).json({ error: error.message || 'No se pudo guardar la canción' });
  }
});

router.delete('/:trackId', async (req, res) => {
  const trackId = text(req.params.trackId, 220);
  await db.query(
    'DELETE FROM saved_tracks WHERE user_id = $1 AND track_id = $2',
    [req.user.id, trackId]
  );
  return res.json({ saved: false, trackId });
});

module.exports = router;
