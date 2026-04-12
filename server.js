const { execSync, exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');

const YTDLP_PATH = path.join(__dirname, 'yt-dlp');
const COOKIES_SOURCE = '/etc/secrets/cookies.txt';
const COOKIES_FILE = path.join(__dirname, 'yt-cookies.txt');

if (fs.existsSync(COOKIES_SOURCE)) {
  try { fs.copyFileSync(COOKIES_SOURCE, COOKIES_FILE); } catch (e) {}
}

try {
  if (!fs.existsSync(YTDLP_PATH)) {
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

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['*'] }));
app.options('*', cors());
app.use(express.json());
app.use('/downloads', express.static(DOWNLOADS_DIR));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function fmt(s) {
  if (!s) return '0:00';
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}
function sanitize(n) {
  return (n || 'track').replace(/[^a-z0-9\-_. ]/gi, '_').substring(0, 100);
}
async function fetchJSON(url, timeoutMs = 12000, extraHeaders = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0', ...extraHeaders },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

// ─── JioSaavn ─────────────────────────────────────────────────────────────────
async function jiosaavnSearch(q, limit = 15) {
  try {
    const data = await fetchJSON(
      `https://saavn.dev/api/search/songs?query=${encodeURIComponent(q)}&page=1&limit=${limit}`
    );
    return (data?.data?.results || []).map(s => ({
      id: `jsv_${s.id}`,
      title: s.name || '',
      artist: (s.artists?.primary || []).map(a => a.name).join(', ') || '',
      duration: s.duration || 0,
      durationStr: fmt(s.duration),
      thumbnail: s.image?.[2]?.url || s.image?.[1]?.url || '',
      source: 'jiosaavn',
    })).filter(s => s.id);
  } catch (e) {
    console.warn('[JioSaavn search]', e.message);
    return [];
  }
}

async function jiosaavnStreamUrl(trackId) {
  const realId = trackId.replace('jsv_', '');
  const data = await fetchJSON(`https://saavn.dev/api/songs/${realId}`);
  const song = data?.data?.[0];
  const urls = song?.downloadUrl || [];
  // highest quality first
  const url = [...urls].reverse().find(u => u?.url)?.url;
  if (!url) throw new Error('JioSaavn: no stream URL');
  return url;
}

// ─── YouTube search via multiple Invidious instances ─────────────────────────
const INVIDIOUS = [
  'https://inv.nadeko.net',
  'https://invidious.privacydev.net',
  'https://yt.drgnz.club',
  'https://iv.datura.network',
  'https://invidious.fdn.fr',
];
let invIdx = 0;

async function ytSearch(q, limit = 15) {
  for (let attempt = 0; attempt < INVIDIOUS.length; attempt++) {
    const base = INVIDIOUS[invIdx % INVIDIOUS.length];
    invIdx++;
    try {
      const data = await fetchJSON(
        `${base}/api/v1/search?q=${encodeURIComponent(q)}&type=video&page=1`,
        8000
      );
      const results = (Array.isArray(data) ? data : []).slice(0, limit).map(v => ({
        id: v.videoId,
        title: v.title || '',
        artist: v.author || '',
        duration: v.lengthSeconds || 0,
        durationStr: fmt(v.lengthSeconds),
        thumbnail: `https://img.youtube.com/vi/${v.videoId}/mqdefault.jpg`,
        source: 'youtube',
      })).filter(v => v.id?.length === 11);
      if (results.length > 0) return results;
    } catch (e) {
      console.warn(`[Invidious ${base}]`, e.message);
    }
  }
  return [];
}

// ─── YouTube audio via yt-dlp (with multiple strategies) ─────────────────────
function ytdlpExec(args, timeoutMs = 60000) {
  const hasCookies = fs.existsSync(COOKIES_FILE) && fs.statSync(COOKIES_FILE).size > 100;
  const cookieFlag = hasCookies ? `--cookies "${COOKIES_FILE}"` : '';
  const flags = `${cookieFlag} --extractor-args "youtube:player_client=ios,mweb,tv_embedded" --no-warnings --no-check-certificates`;
  return new Promise((resolve, reject) => {
    exec(`"${YTDLP_PATH}" ${flags} ${args}`, { maxBuffer: 1024 * 1024 * 20, timeout: timeoutMs },
      (err, stdout, stderr) => err ? reject(stderr || err.message) : resolve(stdout.trim()));
  });
}

async function ytGetAudioUrl(videoId) {
  const out = await ytdlpExec(
    `"https://www.youtube.com/watch?v=${videoId}" -f "bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio" --get-url`,
    45000
  );
  const url = out.split('\n')[0].trim();
  if (!url.startsWith('http')) throw new Error('yt-dlp returned no URL');
  return url;
}

// ─── YouTube audio via Invidious stream (no yt-dlp needed) ───────────────────
async function invAudioUrl(videoId) {
  for (let attempt = 0; attempt < INVIDIOUS.length; attempt++) {
    const base = INVIDIOUS[invIdx % INVIDIOUS.length];
    invIdx++;
    try {
      const data = await fetchJSON(
        `${base}/api/v1/videos/${videoId}?fields=adaptiveFormats`,
        10000
      );
      const streams = (data.adaptiveFormats || [])
        .filter(f => f.type?.startsWith('audio/') && f.url)
        .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0));
      if (streams.length > 0) {
        console.log(`[Invidious audio] ${base} ok`);
        return streams[0].url;
      }
    } catch (e) {
      console.warn(`[Invidious audio ${base}]`, e.message);
    }
  }
  throw new Error('All Invidious instances failed for audio');
}

// ─── ffmpeg pipe ──────────────────────────────────────────────────────────────
function pipeAudio(audioUrl, res, req, extraArgs = []) {
  const ff = spawn(ffmpegBin, [
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
    ...extraArgs,
    '-i', audioUrl,
    '-vn', '-ar', '44100', '-ac', '2', '-b:a', '128k', '-f', 'mp3', 'pipe:1',
  ]);
  ff.stdout.pipe(res);
  ff.stderr.on('data', () => {});
  req.on('close', () => { try { ff.kill('SIGKILL'); } catch (_) {} });
  ff.on('error', () => { if (!res.headersSent) res.status(500).end(); });
  ff.on('close', code => { if (code !== 0 && !res.headersSent) res.status(500).end(); });
}

// ─── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({
  status: 'ok',
  message: 'Aletone API v4',
  cookiesLoaded: fs.existsSync(COOKIES_FILE),
  cookieBytes: fs.existsSync(COOKIES_FILE) ? fs.statSync(COOKIES_FILE).size : 0,
}));

// Search — JioSaavn first, then YouTube
app.get('/api/search', async (req, res) => {
  const { q, limit = 15 } = req.query;
  if (!q) return res.status(400).json({ error: 'Falta q' });

  // Run both searches in parallel for speed
  const [jsvResults, ytResults] = await Promise.allSettled([
    jiosaavnSearch(q, Number(limit)),
    ytSearch(q, Number(limit)),
  ]);

  const jsv = jsvResults.status === 'fulfilled' ? jsvResults.value : [];
  const yt  = ytResults.status  === 'fulfilled' ? ytResults.value  : [];

  // Merge: JioSaavn first (reliable stream), then YouTube to fill remainder
  const combined = [...jsv];
  const needed = Number(limit) - combined.length;
  if (needed > 0) combined.push(...yt.slice(0, needed));

  if (combined.length > 0) {
    return res.json({ results: combined, source: jsv.length > 0 ? 'mixed' : 'youtube' });
  }

  // Last resort: yt-dlp search
  try {
    const raw = await ytdlpExec(`"ytsearch${limit}:${q}" --dump-json --flat-playlist --no-playlist`, 30000);
    const results = raw.split('\n').filter(Boolean).map(line => {
      try {
        const d = JSON.parse(line);
        if (!d.id || d.id.length !== 11) return null;
        return {
          id: d.id, title: d.title || '', artist: d.uploader || d.channel || '',
          duration: d.duration || 0, durationStr: fmt(d.duration),
          thumbnail: d.thumbnail || `https://img.youtube.com/vi/${d.id}/mqdefault.jpg`,
          source: 'youtube',
        };
      } catch { return null; }
    }).filter(Boolean);
    return res.json({ results, source: 'ytdlp' });
  } catch (err) {
    res.status(500).json({ error: 'No se pudo buscar', detail: String(err) });
  }
});

// Stream
app.get('/api/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  res.setHeader('Content-Type', 'audio/mpeg');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache');

  // JioSaavn — direct, reliable
  if (videoId.startsWith('jsv_')) {
    try {
      const audioUrl = await jiosaavnStreamUrl(videoId);
      console.log('[Stream] JioSaavn ok');
      pipeAudio(audioUrl, res, req);
    } catch (e) {
      console.error('[JioSaavn stream]', e.message);
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
    return;
  }

  // YouTube — try Invidious first (no bot check), then yt-dlp
  console.log('[Stream] YouTube:', videoId);
  try {
    const audioUrl = await invAudioUrl(videoId);
    console.log('[Stream] Invidious audio ok');
    pipeAudio(audioUrl, res, req);
    return;
  } catch (e) {
    console.warn('[Stream] Invidious audio failed, trying yt-dlp:', e.message);
  }

  try {
    const audioUrl = await ytGetAudioUrl(videoId);
    console.log('[Stream] yt-dlp ok');
    pipeAudio(audioUrl, res, req, [
      '-user_agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
    ]);
  } catch (err) {
    console.error('[Stream] all methods failed:', String(err).substring(0, 200));
    if (!res.headersSent) res.status(500).json({ error: 'Stream failed', detail: String(err) });
  }
});

// Download
app.post('/api/download', async (req, res) => {
  const { videoId, title } = req.body;
  if (!videoId) return res.status(400).json({ error: 'Falta videoId' });

  const filename = sanitize(title || videoId) + '.mp3';
  const filepath = path.join(DOWNLOADS_DIR, filename);

  if (fs.existsSync(filepath))
    return res.json({ success: true, filename, url: `/downloads/${encodeURIComponent(filename)}` });

  try {
    let audioUrl;
    if (videoId.startsWith('jsv_')) {
      audioUrl = await jiosaavnStreamUrl(videoId);
    } else {
      try { audioUrl = await invAudioUrl(videoId); }
      catch { audioUrl = await ytGetAudioUrl(videoId); }
    }

    await new Promise((resolve, reject) => {
      const ff = spawn(ffmpegBin, [
        '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
        '-i', audioUrl, '-vn', '-ar', '44100', '-ac', '2', '-b:a', '192k', filepath,
      ]);
      ff.stderr.on('data', () => {});
      ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)));
      ff.on('error', reject);
    });

    res.json({ success: true, filename, url: `/downloads/${encodeURIComponent(filename)}` });
  } catch (err) {
    // yt-dlp direct download as last resort
    if (!videoId.startsWith('jsv_')) {
      try {
        await ytdlpExec(
          `"https://www.youtube.com/watch?v=${videoId}" -x --audio-format mp3 --audio-quality 0 -o "${filepath}"`,
          120000
        );
        return res.json({ success: true, filename, url: `/downloads/${encodeURIComponent(filename)}` });
      } catch (e2) {
        return res.status(500).json({ error: 'Download failed', detail: String(e2) });
      }
    }
    res.status(500).json({ error: 'Download failed', detail: String(err) });
  }
});

// Cleanup
setInterval(() => {
  try {
    const now = Date.now();
    fs.readdirSync(DOWNLOADS_DIR).forEach(f => {
      const fp = path.join(DOWNLOADS_DIR, f);
      if (now - fs.statSync(fp).mtimeMs > 86400000) fs.unlinkSync(fp);
    });
  } catch (_) {}
}, 3600000);

app.listen(PORT, () => console.log(`Aletone API v4 en puerto ${PORT}`));