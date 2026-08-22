const router = require('express').Router();
const { db } = require('../config/db');
const auth = require('../middleware/auth');

router.use(auth);

const COMMANDS = new Set(['transfer', 'play', 'pause', 'next', 'prev', 'seek']);
const ACTIVE_WINDOW_SECONDS = 45;

function text(value, max = 120) {
  return String(value || '').trim().slice(0, max);
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

router.post('/register', async (req, res) => {
  const deviceKey = text(req.body.deviceKey, 160);
  const name = text(req.body.name, 80) || 'Aletone Device';
  const deviceType = text(req.body.deviceType, 40) || 'browser';
  const capabilities = object(req.body.capabilities);
  const state = object(req.body.state);

  if (!deviceKey) return res.status(400).json({ error: 'deviceKey es requerido' });

  try {
    const device = await db.one(
      `INSERT INTO devices (user_id, device_key, name, device_type, capabilities, state, last_seen)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,NOW())
       ON CONFLICT (user_id, device_key)
       DO UPDATE SET
         name = EXCLUDED.name,
         device_type = EXCLUDED.device_type,
         capabilities = EXCLUDED.capabilities,
         state = EXCLUDED.state,
         last_seen = NOW()
       RETURNING id, device_key, name, device_type, capabilities, state, last_seen`,
      [req.user.id, deviceKey, name, deviceType, JSON.stringify(capabilities), JSON.stringify(state)]
    );

    db.query(`DELETE FROM device_commands WHERE created_at < NOW() - INTERVAL '1 day'`).catch(() => {});
    res.json({ device });
  } catch (error) {
    console.error('[Aletone Connect register]', error.message);
    res.status(500).json({ error: 'No se pudo registrar el dispositivo' });
  }
});

router.post('/heartbeat', async (req, res) => {
  const deviceKey = text(req.body.deviceKey, 160);
  const state = object(req.body.state);
  if (!deviceKey) return res.status(400).json({ error: 'deviceKey es requerido' });

  try {
    const device = await db.one(
      `UPDATE devices
       SET last_seen = NOW(), state = $3::jsonb
       WHERE user_id = $1 AND device_key = $2
       RETURNING id, device_key, name, device_type, capabilities, state, last_seen`,
      [req.user.id, deviceKey, JSON.stringify(state)]
    );
    if (!device) return res.status(404).json({ error: 'Dispositivo no registrado' });
    res.json({ device });
  } catch (error) {
    console.error('[Aletone Connect heartbeat]', error.message);
    res.status(500).json({ error: 'No se pudo actualizar el dispositivo' });
  }
});

router.get('/', async (req, res) => {
  const currentKey = text(req.query.deviceKey, 160);
  try {
    const devices = await db.all(
      `SELECT id, device_key, name, device_type, capabilities, state, last_seen,
              (last_seen > NOW() - ($2 * INTERVAL '1 second')) AS online
       FROM devices
       WHERE user_id = $1
         AND ($3 = '' OR device_key <> $3)
       ORDER BY online DESC, last_seen DESC
       LIMIT 30`,
      [req.user.id, ACTIVE_WINDOW_SECONDS, currentKey]
    );
    res.json({ devices, activeWindowSeconds: ACTIVE_WINDOW_SECONDS });
  } catch (error) {
    console.error('[Aletone Connect list]', error.message);
    res.status(500).json({ error: 'No se pudieron cargar los dispositivos' });
  }
});

router.post('/:deviceId/commands', async (req, res) => {
  const deviceId = Number(req.params.deviceId);
  const command = text(req.body.command, 24);
  const senderKey = text(req.body.senderDeviceKey, 160);
  const payload = object(req.body.payload);

  if (!Number.isSafeInteger(deviceId) || deviceId <= 0) return res.status(400).json({ error: 'deviceId inválido' });
  if (!COMMANDS.has(command)) return res.status(400).json({ error: 'Comando no permitido' });

  try {
    const target = await db.one('SELECT id FROM devices WHERE id = $1 AND user_id = $2', [deviceId, req.user.id]);
    if (!target) return res.status(404).json({ error: 'Dispositivo no encontrado' });

    const sender = senderKey
      ? await db.one('SELECT id FROM devices WHERE user_id = $1 AND device_key = $2', [req.user.id, senderKey])
      : null;

    const queued = await db.one(
      `INSERT INTO device_commands (user_id, target_device_id, sender_device_id, command, payload)
       VALUES ($1,$2,$3,$4,$5::jsonb)
       RETURNING id, command, created_at`,
      [req.user.id, target.id, sender?.id || null, command, JSON.stringify(payload)]
    );
    res.status(201).json({ queued });
  } catch (error) {
    console.error('[Aletone Connect command]', error.message);
    res.status(500).json({ error: 'No se pudo enviar el comando' });
  }
});

router.get('/commands/pending', async (req, res) => {
  const deviceKey = text(req.query.deviceKey, 160);
  if (!deviceKey) return res.status(400).json({ error: 'deviceKey es requerido' });

  try {
    const commands = await db.all(
      `WITH target AS (
         SELECT id FROM devices WHERE user_id = $1 AND device_key = $2
       ), picked AS (
         SELECT dc.id
         FROM device_commands dc
         JOIN target t ON t.id = dc.target_device_id
         WHERE dc.consumed_at IS NULL
           AND dc.created_at > NOW() - INTERVAL '5 minutes'
         ORDER BY dc.created_at ASC
         LIMIT 20
         FOR UPDATE SKIP LOCKED
       ), claimed AS (
         UPDATE device_commands dc
         SET consumed_at = NOW()
         FROM picked
         WHERE dc.id = picked.id
         RETURNING dc.id, dc.command, dc.payload, dc.created_at, dc.sender_device_id
       )
       SELECT c.id, c.command, c.payload, c.created_at,
              sender.name AS sender_name, sender.device_type AS sender_type
       FROM claimed c
       LEFT JOIN devices sender ON sender.id = c.sender_device_id
       ORDER BY c.created_at ASC`,
      [req.user.id, deviceKey]
    );
    res.json({ commands });
  } catch (error) {
    console.error('[Aletone Connect pending]', error.message);
    res.status(500).json({ error: 'No se pudieron leer los comandos' });
  }
});

module.exports = router;
