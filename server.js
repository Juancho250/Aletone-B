const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');

const YTDLP_PATH = path.join(__dirname, 'yt-dlp');
const COOKIES_SOURCE = '/etc/secrets/cookies.txt';
const COOKIES_FILE = path.join(__dirname, 'yt-cookies.txt');

// Instancias públicas de Invidious (reemplazo de Piped que cerró)
const INVIDIOUS = [
  'https://inv.nadeko.net',
  'https://invidious.fdn.fr',
  'https://yt.drgnz.club',
  'https://iv.datura.network',
  'https://invidious.privacydev.net',
];
let invIdx = 0;
const getInv = () => INVIDIOUS[invIdx % INVIDIOUS.length];

if (fs.existsSync(COOKIES_SOURCE)) {
  try { fs.copyFileSync(COOKIES_SOURCE, COOKIES_FILE); console.log('Cookies ✓'); }
  catch (e) { console.warn('Cookies no copiadas:', e.message); }
}

try {
  if (!fs.existsSync(YTDLP_PATH)) {
    console.log('Instalando yt-dlp...');
    execSync(`curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "${YTDLP_PATH}"`, { stdio: 'inherit' });
  }
  execSync(`chmod a+rx "${YTDLP_PATH}"`, { stdio: 'inherit' });
  console.log('yt-dlp:', execSync(`"${YTDLP_PATH}" --version`).toString().trim());
} catch (e) { console.error('yt-dlp error:', e.message); }

const ffmpegBin = require('ffmpeg-static');
process.env.PATH = `${__dirname}:${path.dirname(ffmpegBin)}:${process.env.PATH}`;

const app = express();
const PORT = process.env.PORT || 3000;
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

app.use(cors());
app.use(express.json());
app.use('/downloads', express.static(DOWNLOADS_DIR));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function formatDuration(s) {
  if (!s) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
function sanitizeFilename(n) {
  return n.replace(/[^a-z0-9\-_. ]/gi, '_').substring(0, 100);
}
async function fetchJSON(url, ms = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'Aletone/1.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ─── Invidious API ────────────────────────────────────────────────────────────
async function invSearch(q, limit = 15) {
  const base = getInv();
  const fields = 'videoId,title,author,lengthSeconds,videoThumbnails';
  const data = await fetchJSON(
    `${base}/api/v1/search?q=${encodeURIComponent(q)}&type=video&fields=${fields}&page=1`
  );
  return (Array.isArray(data) ? data : [])
    .slice(0, limit)
    .map(v => ({
      id: v.videoId,
      title: v.title || '',
      artist: v.author || '',
      duration: v.lengthSeconds || 0,
      durationStr: formatDuration(v.lengthSeconds),
      thumbnail: v.videoThumbnails?.[0]?.url ||
        `https://img.youtube.com/vi/${v.videoId}/mqdefault.jpg`,
      url: `https://www.youtube.com/watch?v=${v.videoId}`,
    }))
    .filter(v => v.id?.length === 11);
}

async function invAudioUrl(videoId) {
  const base = getInv();
  const data = await fetchJSON(`${base}/api/v1/videos/${videoId}?fields=adaptiveFormats`);
  const streams = (data.adaptiveFormats || [])
    .filter(f => f.type?.startsWith('audio/') && f.url)
    .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));
  if (!streams.length) throw new Error('Sin streams en Invidious');
  return streams[0].url;
}

// ─── yt-dlp fallback ──────────────────────────────────────────────────────────
function ytdlp(args) {
  const cookieFlag = fs.existsSync(COOKIES_FILE) ? `--cookies "${COOKIES_FILE}"` : '';
  const flags = `${cookieFlag} --extractor-args "youtube:player_client=ios,web" --no-warnings --no-check-certificates`;
  return new Promise((resolve, reject) => {
    exec(`"${YTDLP_PATH}" ${flags} ${args}`, { maxBuffer: 1024 * 1024 * 10 },
      (err, stdout, stderr) => err ? reject(stderr || err.message) : resolve(stdout.trim()));
  });
}
async function ytdlpSearch(q, limit = 15) {
  const raw = await ytdlp(`"ytsearch${limit}:${q}" --dump-json --flat-playlist`);
  return raw.split('\n').filter(Boolean).map(line => {
    try {
      const d = JSON.parse(line);
      if (!d.id || d.id.length !== 11) return null;
      return {
        id: d.id, title: d.title, artist: d.uploader || d.channel || '',
        duration: d.duration || 0, durationStr: formatDuration(d.duration),
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
  if (!url) throw new Error('yt-dlp sin URL');
  return url;
}

// ─── getAudioUrl con rotación de instancias ────────────────────────────────
async function getAudioUrl(videoId) {
  // Probar todas las instancias de Invidious antes de caer a yt-dlp
  for (let i = 0; i < INVIDIOUS.length; i++) {
    try {
      return await invAudioUrl(videoId);
    } catch (e) {
      console.warn(`[Invidious ${getInv()}] fallo: ${e.message}`);
      invIdx++;
    }
  }
  console.warn('[Invidious] todas fallaron, usando yt-dlp');
  return await ytdlpAudioUrl(videoId);
}

// ─── Rutas ────────────────────────────────────────────────────────────────────
app.get('/', (_req, res) =>
  res.json({ status: 'ok', message: 'Aletone API', invidious: getInv() }));

app.get('/api/search', async (req, res) => {
  const { q, limit = 15 } = req.query;
  if (!q) return res.status(400).json({ error: 'Falta q' });
  // Intentar Invidious con rotación
  for (let i = 0; i < INVIDIOUS.length; i++) {
    try {
      const results = await invSearch(q, Number(limit));
      return res.json({ results, source: `invidious:${getInv()}` });
    } catch (e) {
      console.warn(`[Invidious search ${getInv()}] fallo: ${e.message}`);
      invIdx++;
    }
  }
  // Fallback yt-dlp
  try {
    const results = await ytdlpSearch(q, Number(limit));
    return res.json({ results, source: 'ytdlp' });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Error al buscar', detail: String(err) });
  }
});

app.get('/api/url/:videoId', async (req, res) => {
  try {
    const url = await getAudioUrl(req.params.videoId);
    res.json({ url });
  } catch (err) {
    console.error('URL error:', err);
    res.json({ url: null, fallback: true });
  }
});

app.get('/api/stream/:videoId', async (req, res) => {
  let audioUrl;
  try {
    audioUrl = await getAudioUrl(req.params.videoId);
  } catch (err) {
    console.error('Stream error:', err);
    return res.status(500).json({ error: 'No se pudo obtener audio', detail: String(err) });
  }
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Access-Control-Allow-Origin', '*');
  const ff = spawn(ffmpegBin, [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    '-i', audioUrl,
    '-vn', '-ar', '44100', '-ac', '2', '-b:a', '128k', '-f', 'mp3', 'pipe:1',
  ]);
  ff.stdout.pipe(res);
  ff.stderr.on('data', () => {});
  req.on('close', () => ff.kill('SIGKILL'));
  ff.on('error', () => { if (!res.headersSent) res.status(500).end(); });
});

app.post('/api/download', async (req, res) => {
  const { videoId, title } = req.body;
  if (!videoId) return res.status(400).json({ error: 'Falta videoId' });
  const filename = sanitizeFilename(title || videoId) + '.mp3';
  const filepath = path.join(DOWNLOADS_DIR, filename);
  if (fs.existsSync(filepath))
    return res.json({ success: true, filename, url: `/downloads/${encodeURIComponent(filename)}` });
  // Invidious + ffmpeg
  try {
    const audioUrl = await invAudioUrl(videoId);
    await new Promise((resolve, reject) => {
      const ff = spawn(ffmpegBin, [
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        '-i', audioUrl, '-vn', '-ar', '44100', '-ac', '2', '-b:a', '192k', filepath,
      ]);
      ff.stderr.on('data', () => {});
      ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code}`)));
      ff.on('error', reject);
    });
    return res.json({ success: true, filename, url: `/downloads/${encodeURIComponent(filename)}` });
  } catch (e) { console.warn('[Download] Invidious+ffmpeg falló:', e.message); }
  // yt-dlp fallback
  try {
    await ytdlp(`"https://www.youtube.com/watch?v=${videoId}" -x --audio-format mp3 --audio-quality 0 -o "${filepath}"`);
    res.json({ success: true, filename, url: `/downloads/${encodeURIComponent(filename)}` });
  } catch (err) {
    res.status(500).json({ error: 'Error al descargar', detail: String(err) });
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

app.listen(PORT, () => console.log(`Aletone API corriendo en puerto ${PORT}`));