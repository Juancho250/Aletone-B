const router = require('express').Router();
const { db } = require('../config/db');
const auth = require('../middleware/auth');
const { cacheLyrics } = require('../services/lyrics');

router.use(auth);

const PLAYABLE_CATALOG_VERSION = 'sc-playable-v3';

function nonNegativeInt(value, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.round(n));
}

async function upsertTrack(track) {
  const id = String(track.track_id || '').trim();
  if (!id) return;

  const source = String(track.source || (id.startsWith('sc_') ? 'soundcloud' : id.startsWith('dz_') ? 'deezer' : 'unknown'));
  const externalId = id.includes('_') ? id.slice(id.indexOf('_') + 1) : null;
  const duration = nonNegativeInt(track.duration, 0) || null;

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
      String(track.title || 'Sin título').slice(0, 500),
      String(track.artist || '').slice(0, 300) || null,
      String(track.album || '').slice(0, 300) || null,
      String(track.thumbnail || '').slice(0, 2000) || null,
      duration,
      JSON.stringify({ genre: track.genre || '', permalink: track.permalink || '' }),
    ]
  );
}

router.post('/', async (req, res) => {
  const {
    track_id, title, artist, album, thumbnail, source, duration,
    device_id, context_type, context_id,
  } = req.body || {};

  if (!track_id) return res.status(400).json({ error: 'track_id es requerido' });

  try {
    await upsertTrack(req.body || {});

    const event = await db.one(
      `INSERT INTO history (
         user_id, track_id, title, artist, thumbnail, source, device_id,
         progress_ms, listened_ms, completed, context_type, context_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,0,0,FALSE,$8,$9)
       RETURNING id, played_at`,
      [
        req.user.id,
        String(track_id).slice(0, 220),
        String(title || '').slice(0, 500) || null,
        String(artist || '').slice(0, 300) || null,
        String(thumbnail || '').slice(0, 2000) || null,
        String(source || '').slice(0, 40) || null,
        Number.isSafeInteger(Number(device_id)) ? Number(device_id) : null,
        String(context_type || '').slice(0, 60) || null,
        String(context_id || '').slice(0, 220) || null,
      ]
    );

    if (String(source || '').toLowerCase() === 'soundcloud' && title && artist) {
      cacheLyrics({
        id: String(track_id),
        title: String(title),
        artist: String(artist),
        album: String(album || ''),
        duration: nonNegativeInt(duration, 0),
      }).catch(() => {});
    }

    db.query(
      `DELETE FROM history
       WHERE user_id = $1
         AND id NOT IN (
           SELECT id FROM history WHERE user_id = $1 ORDER BY played_at DESC LIMIT 2000
         )`,
      [req.user.id]
    ).catch(() => {});

    return res.status(201).json({ success: true, historyId: event.id, playedAt: event.played_at, duration });
  } catch (error) {
    console.error('[History create]', error.message);
    return res.status(500).json({ error: 'No se pudo registrar la reproducción' });
  }
});

router.patch('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'history id inválido' });

  const progressMs = nonNegativeInt(req.body?.progress_ms, 0);
  const listenedMs = nonNegativeInt(req.body?.listened_ms, 0);
  const completed = Boolean(req.body?.completed);

  try {
    const updated = await db.one(
      `UPDATE history
       SET progress_ms = GREATEST(progress_ms, $3),
           listened_ms = GREATEST(listened_ms, $4),
           completed = completed OR $5
       WHERE id = $1 AND user_id = $2
       RETURNING id, progress_ms, listened_ms, completed`,
      [id, req.user.id, progressMs, listenedMs, completed]
    );
    if (!updated) return res.status(404).json({ error: 'Evento de reproducción no encontrado' });
    return res.json({ event: updated });
  } catch (error) {
    console.error('[History update]', error.message);
    return res.status(500).json({ error: 'No se pudo actualizar la reproducción' });
  }
});

router.get('/', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const tracks = await db.all(
    `SELECT * FROM (
       SELECT DISTINCT ON (h.track_id)
         h.track_id,
         COALESCE(t.title, h.title) AS title,
         COALESCE(t.artist, h.artist) AS artist,
         COALESCE(t.thumbnail, h.thumbnail) AS thumbnail,
         COALESCE(t.source, h.source) AS source,
         t.album,
         t.duration,
         h.played_at AS last_played,
         h.progress_ms,
         h.listened_ms,
         h.completed,
         COALESCE((t.metadata->>'streamVerified')::boolean, FALSE) AS stream_verified
       FROM history h
       LEFT JOIN tracks t ON t.id = h.track_id
       WHERE h.user_id = $1
         AND (
           COALESCE(t.source, h.source) <> 'soundcloud'
           OR (
             t.metadata->>'catalogVersion' = $3
             AND t.metadata->>'streamVerified' = 'true'
           )
         )
       ORDER BY h.track_id, h.played_at DESC
     ) recent
     ORDER BY last_played DESC
     LIMIT $2`,
    [req.user.id, limit, PLAYABLE_CATALOG_VERSION]
  );
  return res.json({ tracks, catalogVersion: PLAYABLE_CATALOG_VERSION });
});

module.exports = router;
