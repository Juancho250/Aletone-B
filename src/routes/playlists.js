const router = require('express').Router();
const { db } = require('../config/db');
const auth = require('../middleware/auth');

// Todas las rutas de playlists requieren auth
router.use(auth);

// GET /api/playlists
router.get('/', async (req, res) => {
  const playlists = await db.all(
    `SELECT p.*, COUNT(pt.id)::int AS track_count
     FROM playlists p
     LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
     WHERE p.user_id = $1
     GROUP BY p.id
     ORDER BY p.created_at DESC`,
    [req.user.id]
  );
  res.json({ playlists });
});

// POST /api/playlists
router.post('/', async (req, res) => {
  const { name, cover } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'El nombre es requerido' });
  const playlist = await db.one(
    'INSERT INTO playlists (user_id, name, cover) VALUES ($1, $2, $3) RETURNING *',
    [req.user.id, name.trim(), cover || null]
  );
  res.status(201).json({ playlist });
});

// PUT /api/playlists/:id
router.put('/:id', async (req, res) => {
  const { name, cover } = req.body;
  const playlist = await db.one(
    'SELECT * FROM playlists WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );
  if (!playlist) return res.status(404).json({ error: 'Playlist no encontrada' });

  const updated = await db.one(
    'UPDATE playlists SET name = $1, cover = $2 WHERE id = $3 RETURNING *',
    [name || playlist.name, cover ?? playlist.cover, playlist.id]
  );
  res.json({ playlist: updated });
});

// DELETE /api/playlists/:id
router.delete('/:id', async (req, res) => {
  const playlist = await db.one(
    'SELECT id FROM playlists WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );
  if (!playlist) return res.status(404).json({ error: 'Playlist no encontrada' });
  await db.query('DELETE FROM playlists WHERE id = $1', [playlist.id]);
  res.json({ success: true });
});

// GET /api/playlists/:id/tracks
router.get('/:id/tracks', async (req, res) => {
  const playlist = await db.one(
    'SELECT * FROM playlists WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );
  if (!playlist) return res.status(404).json({ error: 'Playlist no encontrada' });
  const tracks = await db.all(
    'SELECT * FROM playlist_tracks WHERE playlist_id = $1 ORDER BY added_at ASC',
    [playlist.id]
  );
  res.json({ playlist, tracks });
});

// POST /api/playlists/:id/tracks
router.post('/:id/tracks', async (req, res) => {
  const { track_id, title, artist, thumbnail, source, duration } = req.body;
  if (!track_id) return res.status(400).json({ error: 'track_id es requerido' });

  const playlist = await db.one(
    'SELECT id FROM playlists WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );
  if (!playlist) return res.status(404).json({ error: 'Playlist no encontrada' });

  try {
    await db.query(
      `INSERT INTO playlist_tracks (playlist_id, track_id, title, artist, thumbnail, source, duration)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [playlist.id, track_id, title, artist, thumbnail, source, duration]
    );
    res.status(201).json({ success: true });
  } catch (e) {
    if (e.code === '23505')
      return res.status(409).json({ error: 'La canción ya está en la playlist' });
    res.status(500).json({ error: 'Error al agregar canción' });
  }
});

// DELETE /api/playlists/:id/tracks/:trackId
router.delete('/:id/tracks/:trackId', async (req, res) => {
  const playlist = await db.one(
    'SELECT id FROM playlists WHERE id = $1 AND user_id = $2',
    [req.params.id, req.user.id]
  );
  if (!playlist) return res.status(404).json({ error: 'Playlist no encontrada' });
  await db.query(
    'DELETE FROM playlist_tracks WHERE playlist_id = $1 AND track_id = $2',
    [playlist.id, req.params.trackId]
  );
  res.json({ success: true });
});

module.exports = router;