const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');

// ─── yt-dlp ──────────────────────────────────────────────────────────────────
const YTDLP_PATH = path.join(__dirname, 'yt-dlp');
// ─── Cookies de YouTube ───────────────────────────────────────────────────────
const COOKIES_FILE = path.join(__dirname, 'cookies.txt');
if (process.env.YT_COOKIES) {
  fs.writeFileSync(COOKIES_FILE, process.env.YT_COOKIES);
  console.log('Cookies de YouTube cargadas ✓');
}

try {
  if (!fs.existsSync(YTDLP_PATH)) {
    console.log('Instalando yt-dlp...');
    execSync(`curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o "${YTDLP_PATH}"`, { stdio: 'inherit' });
  } else {
    console.log('Actualizando yt-dlp...');
    execSync(`"${YTDLP_PATH}" -U`, { stdio: 'inherit' });
  }
  execSync(`chmod a+rx "${YTDLP_PATH}"`, { stdio: 'inherit' });
  console.log('yt-dlp version:', execSync(`"${YTDLP_PATH}" --version`).toString().trim());
} catch(e) {
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

// ─── Utilidades ───────────────────────────────────────────────────────────────
function ytdlp(args) {
  const cookieFlag = fs.existsSync(COOKIES_FILE)
    ? `--cookies "${COOKIES_FILE}"`
    : '';
  const flags = `${cookieFlag} --extractor-args "youtube:player_client=ios" --no-warnings --no-check-certificates`;

  return new Promise((resolve, reject) => {
    exec(`"${YTDLP_PATH}" ${flags} ${args}`, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
      if (err) return reject(stderr || err.message);
      resolve(stdout.trim());
    });
  });
}

function formatDuration(seconds) {
  if (!seconds) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function sanitizeFilename(name) {
  return name.replace(/[^a-z0-9\-_. ]/gi, '_').substring(0, 100);
}

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: 'ok', message: 'Aletone API' }));

// ─── Buscar ───────────────────────────────────────────────────────────────────
app.get('/api/search', async (req, res) => {
  const { q, limit = 15 } = req.query;
  if (!q) return res.status(400).json({ error: 'Falta el parámetro q' });
  try {
    const raw = await ytdlp(
      `"ytsearch${limit}:${q}" --dump-json --flat-playlist`
    );
    const results = raw.split('\n').filter(Boolean).map(line => {
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
    res.json({ results });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Error al buscar', detail: String(err) });
  }
});

// ─── Obtener URL directa ──────────────────────────────────────────────────────
app.get('/api/url/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    const audioUrl = await ytdlp(
      `"https://www.youtube.com/watch?v=${videoId}" -f "bestaudio[ext=m4a]/bestaudio" --get-url`
    );
    if (!audioUrl) return res.status(404).json({ error: 'No encontrado' });
    res.json({ url: audioUrl });
  } catch (err) {
    console.error('URL error:', err);
    // Si falla URL directa, redirigir al stream
    res.json({ url: null, fallback: true });
  }
});

// ─── Stream con ffmpeg ────────────────────────────────────────────────────────
app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  try {
    const audioUrl = await ytdlp(
      `"https://www.youtube.com/watch?v=${videoId}" -f "bestaudio[ext=m4a]/bestaudio" --get-url`
    );
    if (!audioUrl) return res.status(404).json({ error: 'No se encontró audio' });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const ff = spawn(ffmpegBin, [
      '-reconnect', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5',
      '-i', audioUrl,
      '-vn', '-ar', '44100', '-ac', '2', '-b:a', '128k',
      '-f', 'mp3', 'pipe:1'
    ]);

    ff.stdout.pipe(res);
    ff.stderr.on('data', () => {});
    req.on('close', () => ff.kill('SIGKILL'));
    ff.on('error', () => {
      if (!res.headersSent) res.status(500).json({ error: 'Error en stream' });
    });
  } catch (err) {
    console.error('Stream error:', err);
    res.status(500).json({ error: 'Error al obtener stream', detail: String(err) });
  }
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
    fs.readdirSync(DOWNLOADS_DIR).forEach(f => {
      const fp = path.join(DOWNLOADS_DIR, f);
      if (now - fs.statSync(fp).mtimeMs > 24 * 60 * 60 * 1000) fs.unlinkSync(fp);
    });
  } catch(e) {}
}, 60 * 60 * 1000);

app.listen(PORT, () => console.log(`Aletone API corriendo en puerto ${PORT}`));