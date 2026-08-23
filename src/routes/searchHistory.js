const router = require('express').Router();
const { db } = require('../config/db');
const auth = require('../middleware/auth');

router.use(auth);

function normalize(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

router.get('/', async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 50);
  try {
    const items = await db.all(
      `SELECT id, query, result_type, updated_at
       FROM search_history
       WHERE user_id = $1
       ORDER BY updated_at DESC
       LIMIT $2`,
      [req.user.id, limit]
    );
    return res.json({ items });
  } catch (error) {
    console.error('[Search history list]', error.message);
    return res.status(500).json({ error: 'No se pudo cargar el historial de búsqueda' });
  }
});

router.post('/', async (req, res) => {
  const query = String(req.body?.query || '').trim().replace(/\s+/g, ' ').slice(0, 180);
  const normalized = normalize(query);
  const resultType = String(req.body?.result_type || 'search').slice(0, 40);
  if (normalized.length < 2) return res.status(400).json({ error: 'Consulta inválida' });

  try {
    const item = await db.one(
      `INSERT INTO search_history (user_id, query, normalized, result_type, updated_at)
       VALUES ($1,$2,$3,$4,NOW())
       ON CONFLICT (user_id, normalized)
       DO UPDATE SET query = EXCLUDED.query, result_type = EXCLUDED.result_type, updated_at = NOW()
       RETURNING id, query, result_type, updated_at`,
      [req.user.id, query, normalized, resultType]
    );

    db.query(
      `DELETE FROM search_history
       WHERE user_id = $1
         AND id NOT IN (
           SELECT id FROM search_history WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 60
         )`,
      [req.user.id]
    ).catch(() => {});

    return res.status(201).json({ item });
  } catch (error) {
    console.error('[Search history save]', error.message);
    return res.status(500).json({ error: 'No se pudo guardar la búsqueda' });
  }
});

router.delete('/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'ID inválido' });
  try {
    await db.query('DELETE FROM search_history WHERE id = $1 AND user_id = $2', [id, req.user.id]);
    return res.json({ success: true });
  } catch (error) {
    console.error('[Search history delete]', error.message);
    return res.status(500).json({ error: 'No se pudo eliminar la búsqueda' });
  }
});

router.delete('/', async (req, res) => {
  try {
    await db.query('DELETE FROM search_history WHERE user_id = $1', [req.user.id]);
    return res.json({ success: true });
  } catch (error) {
    console.error('[Search history clear]', error.message);
    return res.status(500).json({ error: 'No se pudo limpiar el historial de búsqueda' });
  }
});

module.exports = router;
