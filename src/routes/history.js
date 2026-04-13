const router = require('express').Router();
const { db } = require('../config/db');
const auth = require('../middleware/auth');

router.use(auth);

// POST /api/history — registrar reproducción
router.post('/', async (req, res) => {
  const { track_id, title, artist, thumbnail, source } = req.body;
  if (!track_id) return res.status(400).json({ error: 'track_id es requerido' });

  await db.query(
    'INSERT INTO history (user_id, track_id, title, artist, thumbnail, source) VALUES ($1,$2,$3,$4,$5,$6)',
    [req.user.id, track_id, title, artist, thumbnail, source]
  );

  // Mantener solo las últimas 500 reproducciones por usuario
  await db.query(
    `DELETE FROM history
     WHERE user_id = $1
       AND id NOT IN (
         SELECT id FROM history WHERE user_id = $1 ORDER BY played_at DESC LIMIT 500
       )`,
    [req.user.id]
  );

  res.status(201).json({ success: true });
});

// GET /api/history — últimas reproducciones únicas
router.get('/', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const tracks = await db.all(
    `SELECT DISTINCT ON (track_id)
       track_id, title, artist, thumbnail, source, played_at AS last_played
     FROM history
     WHERE user_id = $1
     ORDER BY track_id, played_at DESC
     LIMIT $2`,
    [req.user.id, limit]
  );
  res.json({ tracks });
});

module.exports = router;