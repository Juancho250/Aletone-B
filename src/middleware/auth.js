const jwt = require('jsonwebtoken');

/**
 * Middleware que verifica el JWT en el header Authorization.
 * Si es válido adjunta req.user = { id, username }.
 */
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer '))
    return res.status(401).json({ error: 'Token requerido' });
  try {
    req.user = jwt.verify(header.slice(7), process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

module.exports = auth;