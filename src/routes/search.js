const router = require('express').Router();
const { scSearch } = require('../services/soundcloud');
const { deezerSearch } = require('../services/deezer');

// GET /api/search?q=...&limit=20
router.get('/', async (req, res) => {
  const { q, limit = 20 } = req.query;
  if (!q) return res.status(400).json({ error: 'Falta el parámetro q' });

  console.log(`[Search] "${q}"`);

  const [scR, dzR] = await Promise.allSettled([
    scSearch(q, Math.ceil(Number(limit) * 0.7)),   // ~70% SoundCloud (canciones completas)
    deezerSearch(q, Math.ceil(Number(limit) * 0.5)), // ~50% Deezer de relleno
  ]);

  const sc = scR.status === 'fulfilled' ? scR.value : [];
  const dz = dzR.status === 'fulfilled' ? dzR.value : [];

  if (scR.status === 'rejected') console.warn('[SC search]', scR.reason?.message);
  if (dzR.status === 'rejected') console.warn('[DZ search]', dzR.reason?.message);

  // Evitar duplicados por título+artista
  const scKeys = new Set(sc.map((s) => s.title.toLowerCase() + s.artist.toLowerCase()));
  const dzFiltered = dz.filter((d) => !scKeys.has(d.title.toLowerCase() + d.artist.toLowerCase()));

  const results = [...sc, ...dzFiltered].slice(0, Number(limit));

  if (results.length === 0)
    return res.status(503).json({ error: 'Sin resultados. Verifica la conexión del servidor.' });

  console.log(`[Search] SC:${sc.length} DZ:${dzFiltered.length} total:${results.length}`);
  res.json({ results, source: sc.length > 0 ? 'soundcloud+deezer' : 'deezer' });
});

module.exports = router;