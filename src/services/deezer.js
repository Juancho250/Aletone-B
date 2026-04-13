const { fmt, fetchJSON } = require('../utils/helpers');

async function deezerSearch(q, limit = 15) {
  const data = await fetchJSON(
    `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=${limit}&output=json`
  );
  return (data.data || [])
    .map((t) => ({
      id: `dz_${t.id}`,
      title: t.title || '',
      artist: t.artist?.name || '',
      duration: t.duration || 0,
      durationStr: fmt(t.duration),
      thumbnail: t.album?.cover_medium || t.album?.cover || '',
      source: 'deezer',
      previewUrl: t.preview || null,
      streamable: !!(t.preview),
      isPreview: true, // solo 30s
    }))
    .filter((t) => t.streamable);
}

async function deezerTrackUrl(trackId) {
  const rawId = trackId.replace('dz_', '');
  const data = await fetchJSON(`https://api.deezer.com/track/${rawId}`);
  if (!data?.preview) throw new Error('Deezer: sin preview URL');
  return data.preview;
}

module.exports = { deezerSearch, deezerTrackUrl };