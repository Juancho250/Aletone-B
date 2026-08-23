const { fmt, fetchJSON } = require('../utils/helpers');

const BASE = 'https://api.deezer.com';
const CACHE_TTL_MS = 10 * 60_000;
const cache = new Map();

function fold(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function trackFrom(item) {
  if (!item?.id) return null;
  return {
    catalogId: `dz_${item.id}`,
    externalId: String(item.id),
    title: item.title || '',
    titleShort: item.title_short || item.title || '',
    artist: item.artist?.name || '',
    artistId: item.artist?.id ? String(item.artist.id) : '',
    album: item.album?.title || '',
    albumId: item.album?.id ? String(item.album.id) : '',
    thumbnail: item.album?.cover_xl || item.album?.cover_big || item.album?.cover_medium || item.album?.cover || '',
    duration: Number(item.duration || 0),
    durationStr: fmt(Number(item.duration || 0)),
    rank: Number(item.rank || 0),
    explicit: Boolean(item.explicit_lyrics),
    previewUrl: item.preview || null,
    source: 'deezer-catalog',
    playable: false,
  };
}

function artistFrom(track) {
  if (!track?.artist) return null;
  return {
    id: track.artistId || `artist:${fold(track.artist)}`,
    name: track.artist,
    thumbnail: track.thumbnail || '',
    type: 'artist',
  };
}

function albumFrom(track) {
  if (!track?.album) return null;
  return {
    id: track.albumId || `album:${fold(track.artist)}:${fold(track.album)}`,
    title: track.album,
    artist: track.artist,
    thumbnail: track.thumbnail || '',
    type: 'album',
  };
}

async function searchCatalog(query, limit = 30) {
  const clean = String(query || '').trim().replace(/\s+/g, ' ').slice(0, 180);
  if (!clean) return { tracks: [], artists: [], albums: [] };
  const safeLimit = Math.min(Math.max(Number(limit) || 30, 1), 50);
  const key = `${fold(clean)}|${safeLimit}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const data = await fetchJSON(`${BASE}/search?q=${encodeURIComponent(clean)}&limit=${safeLimit}&output=json`);
  const tracks = (data.data || []).map(trackFrom).filter(Boolean);
  const artistMap = new Map();
  const albumMap = new Map();
  for (const track of tracks) {
    const artist = artistFrom(track);
    if (artist) {
      const akey = fold(artist.name);
      if (!artistMap.has(akey)) artistMap.set(akey, artist);
    }
    const album = albumFrom(track);
    if (album) {
      const akey = `${fold(album.artist)}|${fold(album.title)}`;
      if (!albumMap.has(akey)) albumMap.set(akey, album);
    }
  }

  const value = {
    tracks,
    artists: [...artistMap.values()].slice(0, 10),
    albums: [...albumMap.values()].slice(0, 12),
  };
  cache.set(key, { at: Date.now(), value });
  return value;
}

async function searchSuggestions(query, limit = 8) {
  const result = await searchCatalog(query, Math.max(12, limit * 2));
  const suggestions = [];
  const seen = new Set();
  const push = item => {
    const key = `${item.type}|${fold(item.value)}`;
    if (!item.value || seen.has(key)) return;
    seen.add(key);
    suggestions.push(item);
  };

  result.artists.slice(0, 4).forEach(item => push({
    type: 'artist', value: item.name, subtitle: 'Artista', thumbnail: item.thumbnail || '',
  }));
  result.tracks.slice(0, 6).forEach(item => push({
    type: 'track', value: item.title, subtitle: item.artist || 'Canción', thumbnail: item.thumbnail || '',
  }));
  result.albums.slice(0, 4).forEach(item => push({
    type: 'album', value: item.title, subtitle: item.artist || 'Álbum', thumbnail: item.thumbnail || '',
  }));

  return suggestions.slice(0, limit);
}

module.exports = { BASE, fold, searchCatalog, searchSuggestions };