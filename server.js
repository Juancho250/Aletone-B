const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');

// ─── Constantes ───────────────────────────────────────────────────────────────
const YTDLP_PATH = path.join(__dirname, 'yt-dlp');
const COOKIES_SOURCE = '/etc/secrets/cookies.txt';
const COOKIES_FILE = path.join(__dirname, 'yt-cookies.txt');

// Lista de instancias públicas de Piped (si una falla, se prueba la siguiente)
const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://piped-api.garudalinux.org',
  'https://api.piped.projectsegfau.lt',
  'https://pipedapi.adminforge.de',
];
let pipedIdx = 0;
const getPiped = () => PIPED_INSTANCES[pipedIdx % PIPED_INSTANCES.length];

// ─── Cookies ──────────────────────────────────────────────────────────────────
if (fs.existsSync(COOKIES_SOURCE)) {
  try {
    fs.copyFileSync(COOKIES_SOURCE, COOKIES_FILE);
    console.log('Cookies de YouTube cargadas ✓');
  } catch (e) {
    console.warn('No se pudieron copiar cookies:', e.message);
  }
}

// ─── yt-dlp (solo fallback) ───────────────────────────────────────────────────
try {
  if (!fs.existsSync(YTDLP_PATH)) {
    console.log('Instalando yt-dlp...');
    execSync(
      `curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "${YTDLP_PATH}"`,
      { stdio: 'inherit' }
    );
  }
  execSync(`chmod a+rx "${YTDLP_PATH}"`, { stdio: 'inherit' });
  console.log('yt-dlp version:', execSync(`"${YTDLP_PATH}" --version`).toString().trim());
} catch (e) {
  console.error('Error con yt-dlp:', e.message);
}

const ffmpegBin = require('ffmpeg-static');
process.env.PATH = `${__dirname}:${path.dirname(ffmpegBin)}:${process.env.PATH}`;

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

app.use(cors());
app.use(express.json());
app.use('/downloads', express.static(DOWNLOADS_DIR));

// ─── Helpers generales ────────────────────────────────────────────────────────
function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function sanitizeFilename(name) {
  return name.replace(/[^a-z0-9\-_. ]/gi, '_').substring(0, 100);
}

async function fetchJSON(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Aletone/1.0' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ─── Piped API ────────────────────────────────────────────────────────────────
async function pipedSearch(q, limit = 15) {
  const url = `${getPiped()}/search?q=${encodeURIComponent(q)}&filter=music_songs`;
  const data = await fetchJSON(url);
  return (data.items || [])
    .slice(0, limit)
    .map((item) => {
      const id = (item.url || '').replace('/watch?v=', '');
      if (!id || id.length !== 11) return null;
      return {
        id,
        title: item.title || '',
        artist: item.uploaderName || '',
        duration: item.duration || 0,
        durationStr: formatDuration(item.duration),
        thumbnail: item.thumbnail || `https://img.youtube.com/vi/${id}/mqdefault.jpg`,
        url: `https://www.youtube.com/watch?v=${id}`,
      };
    })
    .filter(Boolean);
}

async function pipedAudioUrl(videoId) {
  const url = `${getPiped()}/streams/${videoId}`;
  const data = await fetchJSON(url);
  const streams = (data.audioStreams || [])
    .filter((s) => s.url && s.mimeType?.includes('audio'))
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  if (!streams.length) throw new Error('Sin streams de audio en Piped');
  return streams[0].url;
}

// ─── yt-dlp fallback ──────────────────────────────────────────────────────────
function ytdlp(args) {
  const cookieFlag = fs.existsSync(COOKIES_FILE) ? `--cookies "${COOKIES_FILE}"` : '';
  const flags = `${cookieFlag} --extractor-args "youtube:player_client=ios,web" --no-warnings --no-check-certificates`;
  return new Promise((resolve, reject) => {
    exec(`"${YTDLP_PATH}" ${flags} ${args}`, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      resolve(stdout.trim());
    });
  });
}

async function ytdlpSearch(q, limit = 15) {
  const raw = await ytdlp(`"ytsearch${limit}:${q}" --dump-json --flat-playlist`);
  return raw.split('\n').filter(Boolean).map((line) => {
    try {
      const d = JSON.parse(line);
      if (!d.id || d.id.length !== 11) return null;
      return {
        id: d.id,
        title: d.title,
        artist: d.uploader || d.channel || '',
        duration: d.duration || 0,
        durationStr: formatDuration(d.duration),
        thumbnail: d.thumbnail || `https://img.youtube.com/vi/${d.id}/mqdefault.jpg`,
        url: `https://www.youtube.com/watch?v=${d.id}`,
      };
    } catch { return null; }
  }).filter(Boolean);
}

async function ytdlpAudioUrl(videoId) {
  const url = await ytdlp(
    `"https://www.youtube.com/watch?v=${videoId}" -f "bestaudio[ext=m4a]/bestaudio" --get-url`
  );
  if (!url) throw new Error('yt-dlp no devolvió URL');
  return url;
}

// ─── Obtener URL de audio (Piped → yt-dlp) ───────────────────────────────────
async function getAudioUrl(videoId) {
  try {
    return await pipedAudioUrl(videoId);
  } catch (e) {
    console.warn(`[Piped] fallo para ${videoId}: ${e.message}`);
    pipedIdx++; // Rotar instancia
  }
  return await ytdlpAudioUrl(videoId);
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (_req, res) =>
  res.json({ status: 'ok', message: 'Aletone API', piped: getPiped() })
);

// ─── Buscar ───────────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q, limit = 15 } = req.query;
  if (!q) return res.status(400).json({ error: 'Falta el parámetro q' });

  try {
    const results = await pipedSearch(q, Number(limit));
    return res.json({ results, source: 'piped' });
  } catch (e) {
    console.warn('[Piped] búsqueda fallida:', e.message);
    pipedIdx++;
  }

  try {
    const results = await ytdlpSearch(q, Number(limit));
    return res.json({ results, source: 'ytdlp' });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Error al buscar', detail: String(err) });
  }
});

// ─── Obtener URL directa ──────────────────────────────────────────────────────
app.get('/api/url/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    const url = await getAudioUrl(videoId);
    res.json({ url });
  } catch (err) {
    console.error('URL error:', err);
    res.json({ url: null, fallback: true });
  }
});

// ─── Stream con ffmpeg ────────────────────────────────────────────────────────
app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  let audioUrl;
  try {
    audioUrl = await getAudioUrl(videoId);
  } catch (err) {
    console.error('Stream error:', err);
    return res.status(500).json({ error: 'No se pudo obtener el audio', detail: String(err) });
  }

  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Access-Control-Allow-Origin', '*');

  const ff = spawn(ffmpegBin, [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', audioUrl,
    '-vn', '-ar', '44100', '-ac', '2', '-b:a', '128k',
    '-f', 'mp3', 'pipe:1',
  ]);

  ff.stdout.pipe(res);
  ff.stderr.on('data', () => {});
  req.on('close', () => ff.kill('SIGKILL'));
  ff.on('error', () => {
    if (!res.headersSent) res.status(500).json({ error: 'Error en stream' });
  });
});

// ─── Descargar MP3 ────────────────────────────────────────────────────────────
app.post('/api/download', async (req, res) => {
  const { videoId, title } = req.body;
  if (!videoId) return res.status(400).json({ error: 'Falta videoId' });

  const filename = sanitizeFilename(title || videoId) + '.mp3';
  const filepath = path.join(DOWNLOADS_DIR, filename);

  if (fs.existsSync(filepath)) {
    return res.json({ success: true, filename, url: `/downloads/${encodeURIComponent(filename)}` });
  }

  // Intentar con Piped + ffmpeg (sin necesitar yt-dlp)
  try {
    const audioUrl = await pipedAudioUrl(videoId);
    await new Promise((resolve, reject) => {
      const ff = spawn(ffmpegBin, [
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        '-i', audioUrl,
        '-vn', '-ar', '44100', '-ac', '2', '-b:a', '192k',
        filepath,
      ]);
      ff.stderr.on('data', () => {});
      ff.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg código ${code}`)));
      ff.on('error', reject);
    });
    return res.json({ success: true, filename, url: `/downloads/${encodeURIComponent(filename)}` });
  } catch (e) {
    console.warn('[Download] Piped+ffmpeg falló, probando yt-dlp:', e.message);
  }

  // Fallback con yt-dlp
  try {
    await ytdlp(
      `"https://www.youtube.com/watch?v=${videoId}" -x --audio-format mp3 --audio-quality 0 -o "${filepath}"`
    );
    res.json({ success: true, filename, url: `/downloads/${encodeURIComponent(filename)}` });
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Error al descargar', detail: String(err) });
  }
});

// ─── Limpieza cada hora ───────────────────────────────────────────────────────
setInterval(() => {
  try {
    const now = Date.now();
    fs.readdirSync(DOWNLOADS_DIR).forEach((f) => {
      const fp = path.join(DOWNLOADS_DIR, f);
      if (now - fs.statSync(fp).mtimeMs > 24 * 60 * 60 * 1000) fs.unlinkSync(fp);
    });
  } catch (_) {}
}, 60 * 60 * 1000);

app.listen(PORT, () => console.log(`Aletone API corriendo en puerto ${PORT}`));