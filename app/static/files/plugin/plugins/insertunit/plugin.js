// ============================================================================
// InsertUnit Plugin — direct source provider (contract v1)
// ============================================================================
// InsertUnit is a single-endpoint provider: `GET /embed/imdb/<imdbId>` returns
// the whole title at once — movie or TV, ALL seasons and episodes, every stream
// URL inline — no separate movie/tv endpoint, no season/episode parameters.
//
//  1. getStreams(metadata)     → fetch + parse the embed page once
//       · the payload is cached in module memory (1h TTL) so switching
//         episodes reuses the same parse instead of refetching
//       · movie → makePlayer({ source: { dash, dasha, hls, audio, cc } })
//       · tv    → makePlayer({ playlist: { current, seasons[] } })
//  2. The requested season/episode (from metadata, falling back to the page's
//     own `current`) is resolved from the cached payload and returned as one
//     provider → one server with inline sources + subtitles. Nothing is lazy:
//     the player can start immediately.
//
// The page's own player appends a per-load runtime token (&c460da74) to every
// dash/hls/dasha URL just before playback. The working Dart reference does NOT
// append it and the links play fine, so we ship without it — but `appendToken`
// is kept as a one-line hook in case the CDN starts rejecting untokenized URLs.
//
// Source URLs are signed with an expiry (`t=…`), so the in-memory cache TTL is
// kept short; a refetch is cheap.
// ============================================================================

const BASE = 'https://api.insertunit.ws';

const PAGE_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  Origin: BASE,
  Referer: `${BASE}/`,
};

// Carried on every playable stream: the interkh CDN is referer-gated so the
// requests must look like they come from the embed page. Not marked
// headers_required — the reference provider attaches them without the flag.
const SOURCE_HEADERS = {
  Origin: BASE,
  Referer: `${BASE}/`,
};

// The page's client-side player appends `&${runtimeToken}` to every source
// URL before playback (e.g. `&c460da74`). Arm this flag ONLY if the CDN ever
// starts rejecting the URLs from the raw HTML (current behavior matches the
// working Dart reference: no suffix needed).
const APPEND_RUNTIME_TOKEN = false;

// Signed URLs expire (~`t=` param). Cache the parsed payload briefly so
// episode hops within a session don't refetch, but never trust it long.
const CACHE_TTL_MS = 60 * 60 * 1000;

// Single-entry module-level cache (memory only — URLs must not survive
// restart anyway).
let _cache = { key: null, fetchedAt: 0, payload: null };

// ---------------------------------------------------------------------------
// Contract — getStreams
// ---------------------------------------------------------------------------

/**
 * Resolves playable sources for the exact title/season/episode in [metadata].
 * InsertUnit needs an IMDb id to do anything at all.
 */
export async function getStreams(metadata) {
  const imdbId = String(metadata.imdb_id || '').trim();
  if (!/^tt\d+$/i.test(imdbId)) {
    console.warn(
      `InsertUnit: requires imdb_id (tt…) — got "${metadata.imdb_id}"`
    );
    return { providers: [] };
  }

  const mediaType = metadata.media_type;
  if (mediaType !== 'movie' && mediaType !== 'tv') {
    console.warn(`InsertUnit: unsupported media_type: ${mediaType}`);
    return { providers: [] };
  }

  const payload = await loadPayload(imdbId);
  if (!payload) {
    console.warn(`InsertUnit: no player data for ${imdbId}`);
    return { providers: [] };
  }

  if (payload.blocked) {
    console.warn(`InsertUnit: content blocked by rights holder for ${imdbId}`);
    return { providers: [] };
  }

  const resolved = payload.playlist
    ? resolveTv(payload.playlist, metadata.season, metadata.episode)
    : payload.source
      ? resolveMovie(payload.source)
      : { sources: [], subtitles: [] };

  if (resolved.sources.length === 0) {
    console.warn(
      `InsertUnit: no playable sources for ${imdbId} ` +
        `(type=${mediaType} season=${metadata.season} episode=${metadata.episode})`
    );
    return { providers: [] };
  }

  console.log(
    `InsertUnit: ${imdbId} → ${resolved.sources.length} source(s), ` +
      `${resolved.subtitles.length} subtitle(s)`
  );

  return {
    providers: [
      {
        id: 'com.quickstream.plugin.insertunit',
        name: 'InsertUnit',
        logo: `${BASE}/favicon.ico`,
        reliable: true,
        servers: [
          {
            id: 'insertunit',
            name: 'InsertUnit',
            logo: `${BASE}/favicon.ico`,
            sources: resolved.sources,
            subtitles: resolved.subtitles,
          },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Fetch + parse
// ---------------------------------------------------------------------------

/** Fetches the embed page (cache-aware) and returns the reduced player data. */
async function loadPayload(imdbId) {
  const now = Date.now();
  if (_cache.key === imdbId && now - _cache.fetchedAt < CACHE_TTL_MS) {
    return _cache.payload;
  }

  const url = `${BASE}/embed/imdb/${imdbId}`;
  let html = '';
  try {
    const res = await http.get(url, { headers: PAGE_HEADERS, timeout: 30000 });
    if (typeof res?.data === 'string') html = res.data;
  } catch (e) {
    console.error(`InsertUnit: page fetch failed for ${imdbId}:`, e.message);
    return null;
  }

  const payload = parsePlayer(html);
  if (!payload) {
    console.warn(`InsertUnit: could not parse player data for ${imdbId}`);
    return null;
  }

  _cache = { key: imdbId, fetchedAt: now, payload };
  return payload;
}

/**
 * Extracts the `makePlayer({…})` invocation literal and reduces it to just the
 * fields we care about: `blocked`, `source` (movie) and `playlist` (TV).
 */
function parsePlayer(html) {
  if (!html || typeof html !== 'string') return null;

  const literal = extractBlock(html, 'makePlayer({');
  if (!literal) return null;

  const payload = { blocked: /blocked:\s*true/.test(literal) };

  const sourceBlock = extractBlock(literal, 'source:');
  if (sourceBlock) payload.source = extractMovieSource(sourceBlock);

  const playlistBlock = extractBlock(literal, 'playlist:');
  if (playlistBlock) payload.playlist = extractPlaylist(playlistBlock);

  if (!payload.source && !payload.playlist) return null;
  return payload;
}

/**
 * Movie `source` object. Top-level keys (dash/dasha/hls) are quoted/order-safe
 * to regex; the nested `audio` and `cc` payloads are already valid JSON.
 */
function extractMovieSource(block) {
  const source = { dash: '', dasha: '', hls: '', cc: [] };

  const dash = block.match(/([{,]\s*)dash:\s*"([^"]+)"/);
  source.dash = dash ? maybeAppendToken(dash[2]) : '';

  const dasha = block.match(/([{,]\s*)dasha:\s*"([^"]+)"/);
  source.dasha = dasha ? maybeAppendToken(dasha[2]) : '';

  const hls = block.match(/([{,]\s*)hls:\s*"([^"]+)"/);
  source.hls = hls ? maybeAppendToken(hls[2]) : '';

  const ccBlock = extractList(block, 'cc:');
  if (ccBlock) {
    try {
      const cc = JSON.parse(ccBlock);
      if (Array.isArray(cc)) source.cc = cc.filter((s) => s && s.url && s.name);
    } catch (e) {
      console.warn('InsertUnit: cc JSON parse failed:', e.message);
    }
  }

  return source;
}

/**
 * TV `playlist` object. `seasons` is valid JSON straight out of the page;
 * `current` is JS-literal style with unquoted keys.
 */
function extractPlaylist(block) {
  const playlist = { seasons: [], current: null };

  const seasonsBlock = extractList(block, 'seasons:');
  if (seasonsBlock) {
    try {
      const seasons = JSON.parse(seasonsBlock);
      if (Array.isArray(seasons)) playlist.seasons = seasons;
    } catch (e) {
      console.error('InsertUnit: seasons JSON parse failed:', e.message);
    }
  }

  const current = block.match(
    /current:\s*\{\s*season:\s*(\d+)\s*,\s*episode:\s*"?(\d+)"?\s*}/
  );
  if (current) playlist.current = { season: Number(current[1]), episode: Number(current[2]) };

  return playlist;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** TV: locate the requested season/episode (page `current` as fallback). */
function resolveTv(playlist, reqSeason, reqEpisode) {
  const sources = [];
  const subtitles = [];

  if (!Array.isArray(playlist.seasons) || playlist.seasons.length === 0) {
    return { sources, subtitles };
  }

  let season = reqSeason == null ? NaN : Number(reqSeason);
  let episode = reqEpisode == null ? NaN : Number(reqEpisode);
  if (!Number.isFinite(season) || !Number.isFinite(episode)) {
    const current = playlist.current;
    if (!current) return { sources, subtitles };
    season = current.season;
    episode = current.episode;
  }

  const seasonData = playlist.seasons.find((s) => Number(s.season) === season);
  if (!seasonData || seasonData.blocked) return { sources, subtitles };

  const episodes = Array.isArray(seasonData.episodes) ? seasonData.episodes : [];
  const episodeData = episodes.find(
    (e) => Number(e.episode) === episode || String(e.episode) === String(episode)
  );
  if (!episodeData || episodeData.blocked) return { sources, subtitles };

  pushStream(sources, maybeAppendToken(episodeData.hls), 'HLS', 'hls');
  pushStream(sources, maybeAppendToken(episodeData.dash), 'DASH', 'dash');
  pushStream(sources, maybeAppendToken(episodeData.dasha), 'DASHA', 'dash');
  parseSubtitles(episodeData.cc, subtitles);

  return { sources, subtitles };
}

/** Movie: dash + dasha + hls are the same video, up to three formats/tracks. */
function resolveMovie(source) {
  const sources = [];
  const subtitles = [];

  pushStream(sources, maybeAppendToken(source.hls), 'HLS', 'hls');
  pushStream(sources, maybeAppendToken(source.dash), 'DASH', 'dash');
  pushStream(sources, maybeAppendToken(source.dasha), 'DASHA', 'dash');
  parseSubtitles(source.cc, subtitles);

  return { sources, subtitles };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Adds a stream unless the URL is unusable or already present. */
function pushStream(sources, url, label, streamType) {
  if (!url || typeof url !== 'string' || !/^https?:/i.test(url)) return;
  if (sources.some((s) => s.url === url)) return;
  sources.push({
    url,
    quality: 'auto',
    label,
    stream_type: streamType,
    headers: SOURCE_HEADERS,
  });
}

/** No-op unless armed — appended to every source URL when enabled. */
function maybeAppendToken(url) {
  if (!APPEND_RUNTIME_TOKEN || !url) return url;
  return url + '&c460da74';
}

/** Maps InsertUnit subtitle names to a friendly label + ISO language code. */
function parseSubtitles(cc, subtitles) {
  if (!Array.isArray(cc)) return;
  for (const sub of cc) {
    if (!sub || !sub.url || !sub.name) continue;
    const lower = String(sub.name).toLowerCase();
    let label = String(sub.name);
    let code = null;

    if (/рус|rus/.test(lower)) { label = 'Russian'; code = 'ru'; }
    else if (/англ|eng/.test(lower)) { label = 'English'; code = 'en'; }
    else if (/укр|ukr/.test(lower)) { label = 'Ukrainian'; code = 'uk'; }
    else if (/пол|pol/.test(lower)) { label = 'Polish'; code = 'pl'; }
    else if (/нем|deu/.test(lower)) { label = 'German'; code = 'de'; }
    else if (/фран|fra/.test(lower)) { label = 'French'; code = 'fr'; }
    else if (/исп|spa/.test(lower)) { label = 'Spanish'; code = 'es'; }

    subtitles.push({ label, url: sub.url, language: code, format: 'vtt' });
  }
}

/**
 * Extracts the first balanced `{…}` block that begins at [needle]. The scanner
 * is string-aware so braces inside quoted URLs (e.g. `${spriteNum}` in the
 * preview src) never break the matching.
 */
function extractBlock(text, needle) {
  const idx = text.indexOf(needle);
  if (idx < 0) return null;
  const start = text.indexOf('{', idx);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Extracts the first balanced `[…]` block that begins at [needle] (used for
 * `seasons:` and `cc:`), with the same string-aware brace/bracket counting.
 */
function extractList(text, needle) {
  const idx = text.indexOf(needle);
  if (idx < 0) return null;
  const start = text.indexOf('[', idx);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}