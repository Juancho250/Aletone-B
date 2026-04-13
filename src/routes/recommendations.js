const router = require('express').Router();
const { db } = require('../config/db');
const auth = require('../middleware/auth');
const { scSearch } = require('../services/soundcloud');
const { deezerSearch } = require('../services/deezer');

router.use(auth);

// GET /api/recommendations
router.get('/', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 40);

  // 1. Top 5 artistas más escuchados
  const topArtists = await db.all(
    `SELECT artist, COUNT(*) AS plays
     FROM history
     WHERE user_id = $1 AND artist IS NOT NULL AND artist != ''
     GROUP BY artist ORDER BY plays DESC LIMIT 5`,
    [req.user.id]
  );

  // 2. IDs ya escuchados para no repetir
  const listenedRows = await db.all(
    'SELECT DISTINCT track_id FROM history WHERE user_id = $1',
    [req.user.id]
  );
  const listenedIds = new Set(listenedRows.map((r) => r.track_id));

  // 3. Sin historial → tendencias genéricas
  if (topArtists.length === 0) {
    const [sc, dz] = await Promise.allSettled([
      scSearch('trending music 2024', Math.ceil(limit * 0.6)),
      deezerSearch('pop hits', Math.ceil(limit * 0.4)),
    ]);
    return res.json({
      recommendations: [
        ...(sc.status === 'fulfilled' ? sc.value : []),
        ...(dz.status === 'fulfilled' ? dz.value : []),
      ].slice(0, limit),
      basedOn: [],
      isFallback: true,
    });
  }

  // 4. Buscar en paralelo por cada artista top
  const searches = await Promise.allSettled(
    topArtists.map(({ artist }) =>
      Promise.allSettled([scSearch(artist, 6), deezerSearch(artist, 4)]).then(([sc, dz]) => [
        ...(sc.status === 'fulfilled' ? sc.value : []),
        ...(dz.status === 'fulfilled' ? dz.value : []),
      ])
    )
  );

  // 5. Deduplicar, filtrar escuchadas y mezclar
  const seen = new Set();
  const recommendations = searches
    .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .filter((t) => {
      if (listenedIds.has(t.id) || seen.has(t.id)) return false;
      seen.add(t.id);
      return true;
    })
    .sort(() => Math.random() - 0.5)
    .slice(0, limit);

  res.json({
    recommendations,
    basedOn: topArtists.map((a) => a.artist),
    isFallback: false,
  });
});

module.exports = router;