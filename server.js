const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');

const ffmpegBin = require('ffmpeg-static');

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['*'] }));
app.options('*', cors());
app.use(express.json());
app.use('/downloads', express.static(DOWNLOADS_DIR));

// ─── Utils ────────────────────────────────────────────────────────────────────
function fmt(s) {
  if (!s) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
function sanitize(n) {
  return (n || 'track').replace(/[^a-z0-9\-_. ]/gi, '_').substring(0, 100);
}

async function fetchJSON(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || 12000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        ...(opts.headers || {}),
      },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status} — ${url}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ─── SoundCloud client_id ─────────────────────────────────────────────────────
// SoundCloud no requiere registro — el client_id se extrae dinámicamente
// de sus propios scripts públicos. Se rota cada semanas pero se obtiene solo.
let scClientId = null;
let scClientIdFetchedAt = 0;

async function getSCClientId() {
  const CACHE_MS = 60 * 60 * 1000; // re-fetch cada 1h
  if (scClientId && Date.now() - scClientIdFetchedAt < CACHE_MS) return scClientId;

  console.log('[SC] Obteniendo client_id...');
  try {
    const html = await (await fetch('https://soundcloud.com', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36' },
    })).text();

    // Encuentra las URLs de los scripts del bundle
    const scriptUrls = [...html.matchAll(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js/g)]
      .map(m => m[0]);

    for (const scriptUrl of scriptUrls.slice(-5)) {
      try {
        const js = await (await fetch(scriptUrl)).text();
        const match = js.match(/client_id\s*:\s*"([a-zA-Z0-9]{32})"/);
        if (match) {
          scClientId = match[1];
          scClientIdFetchedAt = Date.now();
          console.log('[SC] client_id ok:', scClientId.substring(0, 8) + '...');
          return scClientId;
        }
      } catch (_) {}
    }
    throw new Error('client_id no encontrado en scripts');
  } catch (e) {
    console.error('[SC] Error obteniendo client_id:', e.message);
    throw e;
  }
}

// ─── SoundCloud ───────────────────────────────────────────────────────────────
async function scSearch(q, limit = 15) {
  const cid = await getSCClientId();
  const data = await fetchJSON(
    `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&client_id=${cid}&limit=${limit}&app_locale=en`
  );
  return (data.collection || []).map(t => ({
    id: `sc_${t.id}`,
    title: t.title || '',
    artist: t.user?.username || '',
    duration: Math.floor((t.duration || 0) / 1000),
    durationStr: fmt(Math.floor((t.duration || 0) / 1000)),
    thumbnail: (t.artwork_url || t.user?.avatar_url || '').replace('large', 't300x300'),
    source: 'soundcloud',
    permalink: t.permalink_url,
    // streamable indica si tiene stream completo disponible
    streamable: t.streamable !== false,
  })).filter(t => t.streamable);
}

async function scStreamUrl(trackId) {
  const cid = await getSCClientId();
  const rawId = trackId.replace('sc_', '');

  // Obtiene los formatos de stream disponibles
  const data = await fetchJSON(
    `https://api-v2.soundcloud.com/tracks/${rawId}/streams?client_id=${cid}`
  );

  // Preferimos progressive (MP3 directo) sobre HLS
  const progressive = data?.http_mp3_128_url || data?.preview_mp3_128_url;
  if (progressive) return progressive;

  // Fallback: HLS → pedir la URL de la playlist y resolver
  const hlsTranscode = data?.hls_mp3_128_url;
  if (hlsTranscode) {
    const res = await fetchJSON(`${hlsTranscode}&client_id=${cid}`);
    return res?.url || null;
  }

  throw new Error('SoundCloud: no stream URL disponible');
}

// ─── Deezer ───────────────────────────────────────────────────────────────────
// Deezer API es 100% pública para búsqueda, sin registro ni key.
// Los previews de 30s son URLs directas de MP3.
// Para canciones completas se necesita cuenta premium (no disponible aquí),
// así que Deezer actúa como fuente de búsqueda y fallback de preview.

async function deezerSearch(q, limit = 15) {
  const data = await fetchJSON(
    `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=${limit}&output=json`
  );
  return (data.data || []).map(t => ({
    id: `dz_${t.id}`,
    title: t.title || '',
    artist: t.artist?.name || '',
    duration: t.duration || 0,
    durationStr: fmt(t.duration),
    thumbnail: t.album?.cover_medium || t.album?.cover || '',
    source: 'deezer',
    // preview es una URL directa de MP3 de 30 segundos, siempre disponible
    previewUrl: t.preview || null,
    streamable: !!(t.preview),
    isPreview: true, // avisa al frontend que son 30s
  })).filter(t => t.streamable);
}

// ─── ffmpeg pipe ──────────────────────────────────────────────────────────────
function pipeAudio(audioUrl, res, req, isHls = false) {
  const args = [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', audioUrl,
    '-vn', '-ar', '44100', '-ac', '2', '-b:a', '128k', '-f', 'mp3', 'pipe:1',
  ];
  const ff = spawn(ffmpegBin, args);
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  ff.stdout.pipe(res);
  ff.stderr.on('data', () => {});
  req.on('close', () => { try { ff.kill('SIGKILL'); } catch (_) {} });
  ff.on('error', () => { if (!res.headersSent) res.status(500).end(); });
  ff.on('close', code => { if (code !== 0 && !res.headersSent) res.status(500).end(); });
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', async (_req, res) => {
  let scOk = false;
  try { await getSCClientId(); scOk = true; } catch (_) {}
  res.json({ status: 'ok', message: 'Aletone API v9 — SC+Deezer', soundcloud: scOk });
});

// BÚSQUEDA — SoundCloud primero (canciones completas), Deezer de complemento
app.get('/api/search', async (req, res) => {
  const { q, limit = 20 } = req.query;
  if (!q) return res.status(400).json({ error: 'Falta q' });
  console.log(`[Search] "${q}"`);

  const [scR, dzR] = await Promise.allSettled([
    scSearch(q, Math.ceil(Number(limit) * 0.7)),   // ~70% SoundCloud
    deezerSearch(q, Math.ceil(Number(limit) * 0.5)), // ~50% Deezer de relleno
  ]);

  const sc = scR.status === 'fulfilled' ? scR.value : [];
  const dz = dzR.status === 'fulfilled' ? dzR.value : [];

  if (scR.status === 'rejected') console.warn('[SC search]', scR.reason?.message);
  if (dzR.status === 'rejected') console.warn('[DZ search]', dzR.reason?.message);

  // Combina: SC primero (completas), luego Deezer para rellenar
  const scIds = new Set(sc.map(s => s.title.toLowerCase() + s.artist.toLowerCase()));
  const dzFiltered = dz.filter(d =>
    !scIds.has(d.title.toLowerCase() + d.artist.toLowerCase())
  );

  const results = [...sc, ...dzFiltered].slice(0, Number(limit));

  if (results.length === 0) {
    return res.status(503).json({ error: 'Sin resultados. Verifica la conexión del servidor.' });
  }

  console.log(`[Search] SC:${sc.length} DZ:${dzFiltered.length} total:${results.length}`);
  res.json({ results, source: sc.length > 0 ? 'soundcloud+deezer' : 'deezer' });
});

// STREAM — proxy de audio para evitar CORS
// SoundCloud y Deezer bloquean requests directas desde navegador en algunos casos
app.get('/api/stream/:trackId', async (req, res) => {
  const { trackId } = req.params;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  try {
    let audioUrl;

    if (trackId.startsWith('sc_')) {
      audioUrl = await scStreamUrl(trackId);
      console.log('[Stream] SoundCloud ok');
    } else if (trackId.startsWith('dz_')) {
      // Deezer: stream el preview de 30s
      const rawId = trackId.replace('dz_', '');
      const data = await fetchJSON(`https://api.deezer.com/track/${rawId}`);
      audioUrl = data?.preview;
      if (!audioUrl) throw new Error('Deezer: sin preview URL');
      console.log('[Stream] Deezer preview ok');
    } else {
      return res.status(400).json({ error: 'ID inválido. Usa sc_ o dz_' });
    }

    pipeAudio(audioUrl, res, req);
  } catch (e) {
    console.error('[Stream] Error:', e.message);
    if (!res.headersSent) res.status(503).json({ error: e.message });
  }
});

// STREAM-URL — devuelve la URL directa (el cliente la usa sin pasar por el servidor)
app.get('/api/stream-url/:trackId', async (req, res) => {
  const { trackId } = req.params;
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    let url;
    if (trackId.startsWith('sc_')) {
      url = await scStreamUrl(trackId);
    } else if (trackId.startsWith('dz_')) {
      const data = await fetchJSON(`https://api.deezer.com/track/${trackId.replace('dz_', '')}`);
      url = data?.preview;
    } else {
      return res.status(400).json({ error: 'ID inválido' });
    }
    if (!url) throw new Error('Sin URL disponible');
    res.json({ url });
  } catch (e) {
    res.status(503).json({ error: e.message });
  }
});

// HEALTH
app.get('/api/health', async (_req, res) => {
  const [sc, dz] = await Promise.allSettled([
    getSCClientId().then(id => ({ ok: true, clientId: id.substring(0, 8) + '...' })),
    fetchJSON('https://api.deezer.com/search?q=test&limit=1').then(d => ({ ok: true, results: d.data?.length })),
  ]);
  res.json({
    soundcloud: sc.status === 'fulfilled' ? sc.value : { ok: false, error: sc.reason?.message },
    deezer: dz.status === 'fulfilled' ? dz.value : { ok: false, error: dz.reason?.message },
    ts: new Date().toISOString(),
  });
});

// DOWNLOAD
app.post('/api/download', async (req, res) => {
  const { videoId, title, streamUrl: directUrl } = req.body;
  if (!videoId) return res.status(400).json({ error: 'Falta videoId' });

  const filename = sanitize(title || videoId) + '.mp3';
  const filepath = path.join(DOWNLOADS_DIR, filename);
  if (fs.existsSync(filepath))
    return res.json({ success: true, filename, url: `/downloads/${encodeURIComponent(filename)}` });

  try {
    let audioUrl = directUrl;
    if (!audioUrl) {
      if (videoId.startsWith('sc_')) audioUrl = await scStreamUrl(videoId);
      else if (videoId.startsWith('dz_')) {
        const data = await fetchJSON(`https://api.deezer.com/track/${videoId.replace('dz_', '')}`);
        audioUrl = data?.preview;
      }
    }
    if (!audioUrl) throw new Error('Sin URL de audio');

    await new Promise((resolve, reject) => {
      const ff = spawn(ffmpegBin, [
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        '-i', audioUrl, '-vn', '-ar', '44100', '-ac', '2', '-b:a', '192k', filepath,
      ]);
      ff.stderr.on('data', () => {});
      ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`)));
      ff.on('error', reject);
    });
    res.json({ success: true, filename, url: `/downloads/${encodeURIComponent(filename)}` });
  } catch (err) {
    res.status(500).json({ error: 'Download failed', detail: String(err).substring(0, 200) });
  }
});

setInterval(() => {
  try {
    const now = Date.now();
    fs.readdirSync(DOWNLOADS_DIR).forEach(f => {
      const fp = path.join(DOWNLOADS_DIR, f);
      if (now - fs.statSync(fp).mtimeMs > 86400000) fs.unlinkSync(fp);
    });
  } catch (_) {}
}, 3600000);

// Precarga el client_id de SoundCloud al iniciar
getSCClientId().catch(e => console.warn('[SC] Precarga client_id falló:', e.message));

app.listen(PORT, () => console.log(`Aletone API v9 — SoundCloud + Deezer en puerto ${PORT}`));