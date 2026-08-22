const { fmt, fetchJSON } = require('../utils/helpers');

let scClientId = null;
let scClientIdFetchedAt = 0;
const CACHE_MS = 60 * 60 * 1000;

async function getSCClientId() {
  if (scClientId && Date.now() - scClientIdFetchedAt < CACHE_MS) return scClientId;

  console.log('[SC] Obteniendo client_id...');
  const html = await (
    await fetch('https://soundcloud.com', {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36',
      },
    })
  ).text();

  const scriptUrls = [
    ...html.matchAll(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js/g),
  ].map((m) => m[0]);

  for (const scriptUrl of scriptUrls.slice(-8)) {
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
  throw new Error('SoundCloud: client_id no encontrado en scripts');
}

function artwork(value = '') {
  return String(value || '')
    .replace('-large.', '-t500x500.')
    .replace('large', 't500x500');
}

function normalizeTrack(t) {
  const publisher = t.publisher_metadata || {};
  const duration = Math.max(0, Math.floor((t.duration || 0) / 1000));
  const access = t.access || (t.streamable === false ? 'blocked' : 'playable');

  return {
    id: `sc_${t.id}`,
    externalId: String(t.id || ''),
    title: t.title || '',
    artist: publisher.artist || t.user?.username || '',
    album: publisher.album_title || '',
    genre: t.genre || '',
    duration,
    durationStr: fmt(duration),
    thumbnail: artwork(t.artwork_url || t.user?.avatar_url || ''),
    source: 'soundcloud',
    permalink: t.permalink_url || '',
    releaseDate: t.release_date || t.created_at || null,
    playbackCount: Number(t.playback_count || 0),
    likesCount: Number(t.likes_count || t.favoritings_count || 0),
    repostsCount: Number(t.reposts_count || 0),
    access,
    streamable: t.streamable !== false && access !== 'blocked',
    fullStream: access !== 'preview' && access !== 'blocked' && t.streamable !== false,
    isPreview: access === 'preview',
  };
}

async function scSearch(q, limit = 15) {
  const cid = await getSCClientId();
  const safeLimit = Math.min(Math.max(Number(limit) || 15, 1), 50);
  const data = await fetchJSON(
    `https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(q)}&client_id=${cid}&limit=${safeLimit}&app_locale=en`
  );

  return (data.collection || [])
    .map(normalizeTrack)
    // Aletone no debe poner previews de 30 s en una cola normal.
    .filter((track) => track.streamable && track.fullStream);
}

async function scRelated(trackId, limit = 20) {
  const cid = await getSCClientId();
  const rawId = String(trackId || '').replace('sc_', '');
  if (!/^\d+$/.test(rawId)) return [];

  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 50);
  const data = await fetchJSON(
    `https://api-v2.soundcloud.com/tracks/${rawId}/related?client_id=${cid}&limit=${safeLimit}&linked_partitioning=1&app_locale=en`
  );

  const collection = Array.isArray(data) ? data : (data.collection || []);
  return collection
    .map(normalizeTrack)
    .filter((track) => track.streamable && track.fullStream);
}

function isPreviewTranscoding(transcoding) {
  const descriptor = [
    transcoding?.preset,
    transcoding?.quality,
    transcoding?.format?.protocol,
    transcoding?.format?.mime_type,
    transcoding?.url,
  ].filter(Boolean).join(' ').toLowerCase();
  return descriptor.includes('preview');
}

function transcodingScore(transcoding) {
  if (!transcoding || isPreviewTranscoding(transcoding)) return -1;
  const protocol = String(transcoding.format?.protocol || '').toLowerCase();
  const mime = String(transcoding.format?.mime_type || '').toLowerCase();
  const preset = String(transcoding.preset || '').toLowerCase();

  // Desde finales de 2025 SoundCloud prioriza AAC/HLS. Progressive MP3 puede
  // corresponder únicamente al preview de 30 s, por eso jamás lo preferimos.
  if (protocol === 'hls' && (mime.includes('mp4') || mime.includes('aac') || preset.includes('aac_160'))) return 120;
  if (protocol === 'hls' && preset.includes('aac_96')) return 110;
  if (protocol === 'hls' && mime.startsWith('audio/')) return 100;
  if (protocol === 'progressive' && mime.startsWith('audio/')) return 60;
  return 10;
}

async function scStreamInfo(trackId) {
  const cid = await getSCClientId();
  const rawId = String(trackId || '').replace('sc_', '');
  if (!/^\d+$/.test(rawId)) throw new Error('SoundCloud: ID inválido');

  const data = await fetchJSON(
    `https://api-v2.soundcloud.com/tracks/${rawId}?client_id=${cid}`
  );

  if (data?.access === 'preview') {
    const error = new Error('SoundCloud: esta pista solo permite preview de 30 segundos');
    error.status = 409;
    throw error;
  }
  if (data?.access === 'blocked' || data?.streamable === false) {
    const error = new Error('SoundCloud: esta pista no permite reproducción externa');
    error.status = 409;
    throw error;
  }

  const transcodings = (data?.media?.transcodings || [])
    .filter((item) => !isPreviewTranscoding(item))
    .map((item) => ({ item, score: transcodingScore(item) }))
    .filter(({ score }) => score >= 0)
    .sort((a, b) => b.score - a.score);

  const transcoding = transcodings[0]?.item;
  if (!transcoding?.url) throw new Error('SoundCloud: no hay stream completo disponible');

  const separator = transcoding.url.includes('?') ? '&' : '?';
  const resolved = await fetchJSON(`${transcoding.url}${separator}client_id=${cid}`);
  if (!resolved?.url) throw new Error('SoundCloud: URL de audio no resuelta');

  return {
    url: resolved.url,
    protocol: String(transcoding.format?.protocol || '').toLowerCase(),
    mimeType: transcoding.format?.mime_type || '',
    preset: transcoding.preset || '',
    proxyRequired: String(transcoding.format?.protocol || '').toLowerCase() === 'hls',
    isPreview: false,
  };
}

async function scStreamUrl(trackId) {
  return (await scStreamInfo(trackId)).url;
}

module.exports = {
  getSCClientId,
  scSearch,
  scRelated,
  scStreamInfo,
  scStreamUrl,
};
