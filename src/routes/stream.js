const fs = require('fs');
const path = require('path');
const router = require('express').Router();
const { resolveSoundCloudStream, getStreamResolverStats } = require('../services/streamResolver');
const { deezerTrackUrl } = require('../services/deezer');
const { pipeAudio, downloadAudio } = require('../services/ffmpeg');
const { sanitize } = require('../utils/helpers');

const DOWNLOADS_DIR = path.join(__dirname, '../../downloads');
const TRACK_ID_RE = /^(?:sc|dz)_[A-Za-z0-9_-]{1,180}$/;
const ONE_DAY_MS = 86_400_000;
const cleanupTimer = setInterval(cleanOldDownloads, 3_600_000);
cleanupTimer.unref?.();

if (!fs.existsSync(DOWNLOADS_DIR)) fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });

function assertTrackId(trackId) {
  if (!TRACK_ID_RE.test(String(trackId || ''))) {
    const error = new Error('ID de pista inválido');
    error.status = 400;
    throw error;
  }
  return trackId;
}

function cleanOldDownloads() {
  try {
    const now = Date.now();
    fs.readdirSync(DOWNLOADS_DIR).forEach(filename => {
      const filepath = path.join(DOWNLOADS_DIR, filename);
      if (now - fs.statSync(filepath).mtimeMs > ONE_DAY_MS) fs.unlinkSync(filepath);
    });
  } catch (error) {
    console.warn('[downloads] Limpieza omitida:', error.message);
  }
}

async function resolveAudioSource(trackId) {
  assertTrackId(trackId);

  if (trackId.startsWith('sc_')) {
    const info = await resolveSoundCloudStream(trackId);
    return { ...info, source: 'soundcloud' };
  }

  // Deezer público entrega preview. Se conserva para compatibilidad histórica,
  // pero nunca se presenta como canción completa.
  const url = await deezerTrackUrl(trackId);
  return {
    url,
    source: 'deezer',
    protocol: 'progressive',
    mimeType: 'audio/mpeg',
    proxyRequired: false,
    isPreview: true,
  };
}

function buildDownloadName(trackId, title) {
  const safeTitle = sanitize(title || 'aletone').slice(0, 90) || 'aletone';
  const safeId = sanitize(trackId).slice(0, 80) || 'track';
  return `${safeTitle}-${safeId}.mp3`;
}

// Resolución ligera. Gracias al streamResolver, si la búsqueda ya precalentó
// esta canción, esta ruta responde desde memoria sin volver a consultar SoundCloud.
router.get('/url/:trackId', async (req, res) => {
  res.setHeader('Cache-Control', 'private, max-age=30');
  try {
    const trackId = assertTrackId(req.params.trackId);
    const audio = await resolveAudioSource(trackId);

    return res.json({
      url: audio.proxyRequired ? `/api/stream/${encodeURIComponent(trackId)}` : audio.url,
      mode: audio.proxyRequired ? 'proxy' : 'direct',
      source: audio.source,
      isPreview: Boolean(audio.isPreview),
      mimeType: audio.mimeType || null,
      protocol: audio.protocol || null,
      warmed: true,
    });
  } catch (error) {
    return res.status(error.status || 503).json({ error: error.message });
  }
});

router.get('/resolver/stats', (_req, res) => {
  res.json(getStreamResolverStats());
});

router.post('/download', async (req, res) => {
  const { videoId, title } = req.body || {};

  try {
    assertTrackId(videoId);
    const filename = buildDownloadName(videoId, title);
    const filepath = path.join(DOWNLOADS_DIR, filename);

    if (fs.existsSync(filepath)) {
      return res.json({
        success: true,
        filename,
        url: `/downloads/${encodeURIComponent(filename)}`,
        cached: true,
      });
    }

    const audio = await resolveAudioSource(videoId);
    if (audio.isPreview) {
      return res.status(409).json({
        error: 'Esta fuente solo ofrece un preview y no puede guardarse como canción offline.',
      });
    }

    await downloadAudio(audio.url, filepath);

    return res.json({
      success: true,
      filename,
      url: `/downloads/${encodeURIComponent(filename)}`,
      cached: false,
    });
  } catch (error) {
    console.error('[download]', error.message);
    return res.status(error.status || 500).json({
      error: error.status === 400 ? error.message : 'No fue posible preparar la descarga',
    });
  }
});

router.get('/:trackId', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const audio = await resolveAudioSource(req.params.trackId);
    return pipeAudio(audio.url, res, req);
  } catch (error) {
    console.error('[stream]', error.message);
    if (!res.headersSent) return res.status(error.status || 503).json({ error: error.message });
    return undefined;
  }
});

module.exports = router;
