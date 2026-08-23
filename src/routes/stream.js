const fs = require('fs');
const path = require('path');
const router = require('express').Router();
const { resolveSoundCloudStream, getStreamResolverStats } = require('../services/streamResolver');
const { deezerTrackUrl } = require('../services/deezer');
const {
  proxyTrackStream: proxyAudiusStream,
  downloadTrackToFile: downloadAudiusTrack,
  getTrack: getAudiusTrack,
} = require('../providers/audius');
const { pipeAudio, downloadAudio } = require('../services/ffmpeg');
const { sanitize } = require('../utils/helpers');

const DOWNLOADS_DIR = path.join(__dirname, '../../downloads');
const TRACK_ID_RE = /^(?:au|sc|dz|yt)_[A-Za-z0-9_-]{1,180}$/;
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

  if (trackId.startsWith('yt_')) {
    const error = new Error('YouTube se reproduce con el reproductor embebido, no como stream de audio.');
    error.status = 409;
    error.code = 'YOUTUBE_IFRAME_REQUIRED';
    throw error;
  }

  if (trackId.startsWith('au_')) {
    return {
      source: 'audius',
      protocol: 'progressive',
      mimeType: 'audio/mpeg',
      proxyRequired: true,
      nativeProxy: true,
      isPreview: false,
    };
  }

  if (trackId.startsWith('sc_')) {
    const info = await resolveSoundCloudStream(trackId);
    return { ...info, source: 'soundcloud', nativeProxy: false };
  }

  const url = await deezerTrackUrl(trackId);
  return {
    url,
    source: 'deezer',
    protocol: 'progressive',
    mimeType: 'audio/mpeg',
    proxyRequired: false,
    nativeProxy: false,
    isPreview: true,
  };
}

function buildDownloadName(trackId, title) {
  const safeTitle = sanitize(title || 'aleon').slice(0, 90) || 'aleon';
  const safeId = sanitize(trackId).slice(0, 80) || 'track';
  return `${safeTitle}-${safeId}.mp3`;
}

router.get('/url/:trackId', async (req, res) => {
  res.setHeader('Cache-Control', 'private, max-age=60');
  try {
    const trackId = assertTrackId(req.params.trackId);

    if (trackId.startsWith('yt_')) {
      return res.json({
        url: null,
        mode: 'youtube-iframe',
        source: 'youtube',
        videoId: trackId.slice(3),
        isPreview: false,
        warmed: true,
      });
    }

    const audio = await resolveAudioSource(trackId);

    if (trackId.startsWith('au_')) {
      return res.json({
        url: `/api/stream/${encodeURIComponent(trackId)}`,
        mode: 'range-proxy',
        source: 'audius',
        isPreview: false,
        mimeType: 'audio/mpeg',
        protocol: 'progressive',
        warmed: true,
      });
    }

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
    return res.status(error.status || 503).json({ error: error.message, code: error.code || undefined });
  }
});

router.get('/resolver/stats', (_req, res) => {
  res.json(getStreamResolverStats());
});

router.post('/download', async (req, res) => {
  const { videoId, title } = req.body || {};

  try {
    assertTrackId(videoId);
    if (videoId.startsWith('yt_')) {
      return res.status(409).json({
        error: 'Las pistas de YouTube no se pueden guardar offline desde ALEON.',
        code: 'YOUTUBE_OFFLINE_NOT_ALLOWED',
      });
    }

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

    if (videoId.startsWith('au_')) {
      const track = await getAudiusTrack(videoId);
      if (!track?.downloadable) {
        return res.status(409).json({
          error: 'El artista permite reproducir esta canción, pero no descargarla para uso offline.',
          code: 'OFFLINE_NOT_ALLOWED',
        });
      }
      await downloadAudiusTrack(videoId, filepath);
    } else {
      const audio = await resolveAudioSource(videoId);
      if (audio.isPreview) {
        return res.status(409).json({
          error: 'Esta fuente solo ofrece un preview y no puede guardarse como canción offline.',
        });
      }
      await downloadAudio(audio.url, filepath);
    }

    return res.json({
      success: true,
      filename,
      url: `/downloads/${encodeURIComponent(filename)}`,
      cached: false,
    });
  } catch (error) {
    console.error('[download]', error.message);
    return res.status(error.status || 500).json({
      error: error.status === 400 ? error.message : (error.message || 'No fue posible preparar la descarga'),
      code: error.code || undefined,
    });
  }
});

router.get('/:trackId', async (req, res) => {
  try {
    const trackId = assertTrackId(req.params.trackId);
    if (trackId.startsWith('yt_')) {
      return res.status(409).json({
        error: 'Esta pista usa el reproductor embebido de YouTube.',
        code: 'YOUTUBE_IFRAME_REQUIRED',
      });
    }
    if (trackId.startsWith('au_')) return proxyAudiusStream(trackId, req, res);

    res.setHeader('Cache-Control', 'no-store');
    const audio = await resolveAudioSource(trackId);
    if (!audio.proxyRequired) return res.redirect(307, audio.url);
    return pipeAudio(audio.url, res, req);
  } catch (error) {
    console.error('[stream]', error.message);
    if (!res.headersSent) return res.status(error.status || 503).json({ error: error.message, code: error.code || undefined });
    return undefined;
  }
});

module.exports = router;
