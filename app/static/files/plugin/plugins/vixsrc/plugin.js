// ============================================================================
// VixSrc Plugin — direct source provider (contract v1)
// ============================================================================
// VixSrc is a standalone provider: it resolves a movie/tv id (imdb or tmdb)
// straight to a signed HLS playlist — no embed-host extractors involved.
//
//  1. getStreams(metadata)     → provider stub (single lazy server)
//  2. getStreamSources(...)    → API /api/{type}/{id}[/{season}/{episode}]?lang=
//       → { src: "/embed/<eid>?token=…&t=…&expires=…&lang=…&skin=vixsrc&canPlayFHD=1" }
//       → embed page HTML: window.video / window.masterPlaylist / window.canPlayFHD
//       → build https://vixsrc.to/playlist/<id>?token=…&expires=…&lang=…
//           [+&b=1 when the masterPlaylist url carries b=1]
//           [+&h=1 when window.canPlayFHD is true]
//
// The `b=1` flag is CRITICAL — tuning it wrongly breaks the link. It must be
// read ONLY from the `url:` inside window.masterPlaylist. The `window.streams`
// entries use `?ub=1` / `?ab=1` ("server B"), which merely *contain* the b=1
// substring and must never enable the flag (that's what "b" means in
// masterPlaylist, not streams).
// ============================================================================

const vixSrcBase = 'https://vixsrc.to';
const SUPPORTED_LANGS = ['it', 'en', 'ru', 'es'];

const API_HEADERS = {
  Referer: `${vixSrcBase}/`,
  Origin: vixSrcBase,
  'X-Requested-With': 'XMLHttpRequest',
  Accept: 'application/json, text/plain, */*',
};

const EMBED_HEADERS = {
  Referer: `${vixSrcBase}/`,
  Origin: vixSrcBase,
  'X-Requested-With': 'XMLHttpRequest',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

// ---------------------------------------------------------------------------
// Step 1 — provider list
// ---------------------------------------------------------------------------

/**
 * Returns one provider whose single server is a lazy stub. The embed is only
 * resolved via getStreamSources() when the user actually picks the server.
 */
export async function getStreams(metadata) {
  // Field names are what the app's player sends (snake_case).
  const mediaType = metadata.media_type; // 'movie' | 'tv'
  if (mediaType !== 'movie' && mediaType !== 'tv') {
    console.warn('VixSrc: unsupported media_type:', mediaType);
    return { providers: [] };
  }
  const id = metadata.imdb_id || metadata.tmdb_id;
  if (!id) {
    console.warn('VixSrc: no imdb_id/tmdb_id in metadata');
    return { providers: [] };
  }
  return {
    providers: [
      {
        id: 'com.quickstream.plugin.vixsrc',
        name: 'VixSrc',
        logo: `${vixSrcBase}/favicon.ico`,
        reliable: true,
        servers: [
          {
            id: 'vixsrc',
            name: 'VixSrc',
            logo: `${vixSrcBase}/favicon.ico`,
          }
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Step 2 — one server's signed playlist
// ---------------------------------------------------------------------------

/**
 * Resolves the API embed, parses window.masterPlaylist and returns the signed
 * playlist URL. Returns [] when nothing usable was found (the player then
 * moves on to the next server).
 */
export async function getStreamSources(metadata, providerId, serverId) {
  const mediaType = metadata.media_type;
  const id = metadata.imdb_id || metadata.tmdb_id;
  if (!id) return { sources: [], subtitles: [] };

  const lang = await selectedLang();

  // 1) API → embed path.
  let embedPath;
  try {
    embedPath = await fetchEmbedPath(mediaType, id, metadata, lang);
  } catch (e) {
    console.error('VixSrc: API call failed:', e.message);
    return { sources: [], subtitles: [] };
  }

  // 2) Embed page → playlist params. The API src can 410 "Gone" between list
  //    and play (expired embed); on that specific error we refresh the API
  //    once and retry, mirroring the references.
  let parsed = null;
  try {
    parsed = await parseEmbed(embedPath);
  } catch (e) {
    const gone = e?.status === 410 || /410/.test(String(e?.message || ''));
    if (gone) {
      console.warn('VixSrc: 410 Gone — refreshing embed link…');
      try {
        embedPath = await fetchEmbedPath(mediaType, id, metadata, lang);
        parsed = await parseEmbed(embedPath);
      } catch (e2) {
        console.error('VixSrc: embed still failed after retry:', e2.message);
      }
    } else {
      console.error('VixSrc: embed failed:', e.message);
    }
  }

  if (!parsed?.token || !parsed?.expires) {
    console.warn('VixSrc: no playable stream (missing token/expires)');
    return { sources: [], subtitles: [] };
  }

  // 3) Signed playlist url. b=/h= only when the embed page says so.
  const params = [
    `token=${parsed.token}`,
    `expires=${parsed.expires}`,
    `lang=${lang}`,
  ];
  if (parsed.hasBParam) params.push('b=1');
  if (parsed.canPlayFHD) params.push('h=1');
  const sourceUrl = `${vixSrcBase}/playlist/${parsed.videoId}?${params.join('&')}`;

  return {
    sources: [
      {
        url: sourceUrl,
        quality: 'auto',
        label: 'VixSrc',
        // VixSrc serves an HLS master playlist (m3u8 without an extension in
        // the path), so hint the container for hint-dependent players.
        stream_type: 'hls',
        // The playlist/variant/segment requests must look like they came from
        // the embed page (referer-gated).
        headers: {
          Referer: `${vixSrcBase}/${embedPath.replace(/^\//, '')}`,
          Origin: vixSrcBase,
        },
      },
    ],
    subtitles: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolves the configured audio language (it/en/ru/es, default en). */
async function selectedLang() {
  const config = (await pluginStorage.get()) || {};
  const lang = String(config.lang || 'en').toLowerCase();
  return SUPPORTED_LANGS.includes(lang) ? lang : 'en';
}

/** GET /api/{type}/{id}[/season/episode]?lang=… → embed path (`/embed/…`). */
async function fetchEmbedPath(mediaType, id, metadata, lang) {
  const apiPath =
    mediaType === 'tv'
      ? `api/tv/${id}/${metadata.season ?? 1}/${metadata.episode ?? 1}`
      : `api/movie/${id}`;
  const response = await http.get(`${vixSrcBase}/${apiPath}?lang=${lang}`, {
    headers: API_HEADERS,
  });
  const src = String(response?.data?.src || '').trim();
  if (!src) throw new Error('VixSrc: empty src from API');
  return src;
}

/**
 * Fetches the embed page and pulls videoId / token / expires / b-flag / FHD
 * out of its inline scripts.
 */
async function parseEmbed(embedPath) {
  const embedUrl = `${vixSrcBase}${embedPath.charAt(0) === '/' ? '' : '/'}${embedPath}`;
  const response = await http.get(embedUrl, { headers: EMBED_HEADERS });
  const html = typeof response?.data === 'string' ? response.data : '';
  const scriptText = (html.match(/<script>([\s\S]*?)<\/script>/g) || [])
    .map((s) => s.replace(/^<script>/, '').replace(/<\/script>$/, ''))
    .join('\n');

  const videoId =
    (scriptText.match(/window\.video[\s\S]*?id:\s*'([^']+)'/) || [])[1] || '';

  // Everything playable lives in window.masterPlaylist; scope the token/expires
  // and the crucial b=1 check to that object only.
  const masterMatch = scriptText.match(
    /window\.masterPlaylist\s*=\s*\{[\s\S]*?url:\s*['"]([^'"]+)['"]/
  );
  const masterBlock = masterMatch ? masterMatch[0] : '';
  const masterUrl = masterMatch ? masterMatch[1] : '';
  const token = (masterBlock.match(/'token':\s*'([^']+)'/) || [])[1] || '';
  const expires = (masterBlock.match(/'expires':\s*'([^']+)'/) || [])[1] || '';

  const hasBParam = /[?&]b=1($|[&"'])/.test(masterUrl);
  const canPlayFHD = /window\.canPlayFHD\s*=\s*true/.test(scriptText);

  return { videoId, token, expires, hasBParam, canPlayFHD };
}