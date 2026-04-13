/**
 * Formatea segundos como "m:ss"
 */
function fmt(s) {
  if (!s) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

/**
 * Sanitiza un nombre para usarlo como nombre de archivo
 */
function sanitize(n) {
  return (n || 'track').replace(/[^a-z0-9\-_. ]/gi, '_').substring(0, 100);
}

/**
 * fetch con timeout y headers de browser para evitar bloqueos
 */
async function fetchJSON(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 12000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        Accept: 'application/json',
        ...(opts.headers || {}),
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} — ${url}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

module.exports = { fmt, sanitize, fetchJSON };