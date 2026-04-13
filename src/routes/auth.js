const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { db } = require('../config/db');
const auth = require('../middleware/auth');

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password)
    return res.status(400).json({ error: 'username, email y password son requeridos' });
  if (password.length < 6)
    return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const user = await db.one(
      'INSERT INTO users (username, email, password) VALUES ($1, $2, $3) RETURNING id, username, email',
      [username.trim(), email.trim().toLowerCase(), hash]
    );
    const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, {
      expiresIn: '30d',
    });
    res.status(201).json({ token, user });
  } catch (e) {
    if (e.code === '23505')
      return res.status(409).json({ error: 'El usuario o email ya existe' });
    console.error('[register]', e.message);
    res.status(500).json({ error: 'Error al registrar' });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.status(400).json({ error: 'email y password son requeridos' });

  try {
    const user = await db.one('SELECT * FROM users WHERE email = $1', [email.trim().toLowerCase()]);
    if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ error: 'Credenciales inválidas' });

    const token = jwt.sign({ id: user.id, username: user.username }, process.env.JWT_SECRET, {
      expiresIn: '30d',
    });
    res.json({ token, user: { id: user.id, username: user.username, email: user.email } });
  } catch (e) {
    console.error('[login]', e.message);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

// GET /api/auth/me
router.get('/me', auth, async (req, res) => {
  const user = await db.one(
    'SELECT id, username, email, created_at FROM users WHERE id = $1',
    [req.user.id]
  );
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.json({ user });
});

module.exports = router;