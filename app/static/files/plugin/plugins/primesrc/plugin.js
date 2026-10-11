// ============================================================================
// PrimeSrc Plugin — source embeds from the PrimeSrc API (contract v1)
// ============================================================================
// The API is two hops:
//   1. getStreams(metadata)  → GET /api/v1/s?imdb=..&type=..[&season=..&episode=..]
//        → { info, servers: [{ key, name, file_name, ... }] }
//   2. getStreamSources(...) → GET /api/v1/l?key=<server key>
//        → { link, host, host_id }            ← the embed page URL
// The server list is returned as LAZY stubs (no `sources` key), so the app
// requests the embed for only the server the user actually selects.
// The embed page itself is NOT parsed here — hanging "how to turn an embed
// url into a playable stream" is delegated to the shared Open Extractors
// plugin, so every provider reuses the same scrapers and hosts only add their
// own logic once. PrimeSrc therefore carries no embed-scraping code.
// ============================================================================

const primeSrcBase = 'https://primesrc.me';

const primesrcApiBase = `${primeSrcBase}/api/v1`;

// Hosts whose embeds Open Extractors can currently turn into playable
// streams. Anything else is skipped with a warning until an extractor lands.
// `SUPPORTED_HOST_LABELS` blocks those servers at the list step, so the app
// never issues the expensive (and Cloudflare-challenged) /l request for
// them. Keep both lists in sync; add a label here when an extractor ships.
const STREAMWISH_EMBED_HOSTS = /streamwish\.to|hgplaycdn\.com/i;
const MIXDROP_EMBED_HOSTS =
  /mixdrop\.(?:co|bz|ag|ch|to|cv|club)|mxdrop\.(?:to|top|ag)|mi?i?xdrop\.net|m1xdrop\.net/i;
// DoodStream is one backend behind many rotating domains — the embed host
// redirects to whichever is currently serving, and the extractor follows it.
const DOOD_EMBED_HOSTS = new RegExp(
  [
    'dood\\.[a-z]{2,4}', // dood.watch, dood.li, dood.la, dood.ws, …
    'doodstream\\.com',
    'dsvplay\\.com',
    'ds2play\\.com',
    'mikaylaarealike\\.com',
    'myvidplay\\.com',
    'playmogo\\.com',
    'do7go\\.com',
    'd000d\\.com',
    'vide0\\.net',
  ].join('|'),
  'i'
);
// FileLions (the VidHide-branded hoster) embeds also rotate across domains;
// the extractor follows whichever is currently serving.
const FILELIONS_EMBED_HOSTS = new RegExp(
  [
    'filelions\\.(?:to|com|io|cc|site|net)',
    'callistanise\\.com',
    'morencius\\.com',
    'vidhide(?:pro)?\\.com',
  ].join('|'),
  'i'
);
const SUPPORTED_EMBED_HOSTS = new RegExp(
  `${STREAMWISH_EMBED_HOSTS.source}|${MIXDROP_EMBED_HOSTS.source}|` +
    `${DOOD_EMBED_HOSTS.source}|${FILELIONS_EMBED_HOSTS.source}`
);
const SUPPORTED_HOST_LABELS = [
  'streamwish',
  'mixdrop',
  'mxdrop',
  'dood',
  'dsvplay',
  'ds2play',
  'mikayla',
  'myvidplay',
  'playmogo',
  'do7go',
  'd000d',
  'vide0',
  'filelions',
  'callistanise',
  'morencius',
  'vidhide',
];

// Canonical site logo for a server host, when known; the app renders it next
// to the server name (provider-style). Favicons degrade to a plain icon in
// the UI if they 404.
const HOST_LOGOS = {
  streamwish: 'https://streamwish.to/favicon.ico',
  mixdrop: 'https://mxdrop.top/favicon.ico',
  dood: 'https://playmogo.com/favicon.ico',
  filelions: 'https://filelions.to/favicon.ico',
};

// ---------------------------------------------------------------------------
// Step 1 — server list
// ---------------------------------------------------------------------------

/**
 * Returns one provider whose servers are lazy stubs (no `sources` key).
 * The app resolves a server's embed via getStreamSources() when it is picked.
 */
export async function getStreams(metadata) {
  // Field names are what the app's player sends (snake_case).
  const mediaType = metadata.media_type; // 'movie' | 'tv'
  const imdbId = metadata.imdb_id;
  const tmdbId = metadata.tmdb_id;

  if (mediaType !== 'movie' && mediaType !== 'tv') {
    console.warn('PrimeSrc: unsupported media_type:', mediaType);
    return { providers: [] };
  }

  // The API accepts either imdb= or tmdb=; prefer imdb when present.
  const idParam = imdbId ? `imdb=${imdbId}` : tmdbId ? `tmdb=${tmdbId}` : null;
  if (!idParam) {
    console.warn('PrimeSrc: no imdb_id/tmdb_id in metadata');
    return { providers: [] };
  }

  const tvQuery =
    mediaType === 'tv'
      ? `&season=${metadata.season ?? 1}&episode=${metadata.episode ?? 1}`
      : '';

  let response;
  try {
    response = await http.get(
      `${primesrcApiBase}/s?${idParam}&type=${mediaType}${tvQuery}`
    );
  } catch (e) {
    console.error('PrimeSrc: server list request failed:', e.message, e);
    return { providers: [] };
  }

  const servers = response?.data?.servers;
  if (!Array.isArray(servers) || servers.length === 0) {
    console.warn(
      `PrimeSrc: no servers for ${idParam} (status ${response?.status})`
    );
    return { providers: [] };
  }

  // Drop servers whose host has no extractor yet (`/l` is the expensive,
  // Cloudflare-challenged hop — don't make it for streams we can't play).
  const supported = servers.filter(hostLabelImplemented);
  if (supported.length === 0) {
    console.warn(
      `PrimeSrc: ${servers.length} server(s) found for ${idParam}, but none ` +
        `on an implemented host (${SUPPORTED_HOST_LABELS.join(', ')}) — ` +
        'skipping.'
    );
    return { providers: [] };
  }

  return {
    providers: [
      {
        id: 'com.primesrc',
        name: 'PrimeSrc',
        logo: `${primeSrcBase}/logo.svg`,
        reliable: true,
        servers: supported.map((s) => ({
          id: s.key, // PrimeSrc server key → passed to getStreamSources
          name: serverLabel(s),
          logo: serverLogo(s),
        })),
      },
    ],
  };
}

/** True when the server's label names a host with an implemented extractor. */
function hostLabelImplemented(server) {
  const label = String(server.name || '').toLowerCase();
  if (!label) return false;
  const normalized = label.replace(/[^a-z0-9]/g, '');
  return SUPPORTED_HOST_LABELS.some((host) => normalized.includes(host));
}

/** Known site logo for a server's host, or null (app shows a plain icon). */
function serverLogo(server) {
  const label = String(server.name || '').toLowerCase();
  if (/mx?i?xdrop/.test(label)) return HOST_LOGOS.mixdrop;
  if (/filelions|callistanise|morencius|vidhide/.test(label)) {
    return HOST_LOGOS.filelions;
  }
  if (/dood|dsvplay|ds2play|mikayla|myvidplay|playmogo|do7go|d000d|vide0/.test(label)) {
    return HOST_LOGOS.dood;
  }
  if (label.includes('streamwish')) return HOST_LOGOS.streamwish;
  return null;
}

// ---------------------------------------------------------------------------
// Step 2 — one server's embed data
// ---------------------------------------------------------------------------

/**
 * Fetches the embed record for one server: { link, host, host_id }, then
 * asks Open Extractors to turn it into a playable stream. Returns [] when
 * nothing usable was found (the player then moves on to the next server).
 */
export async function getStreamSources(metadata, providerId, serverId) {
  const embed = await fetchEmbed(serverId);
  if (!embed?.link) return { sources: [], subtitles: [] };

  console.log(
    `PrimeSrc: embed resolved → host "${embed.host}" (${embed.host_id}) → ${embed.link}`
  );

  if (!SUPPORTED_EMBED_HOSTS.test(embed.link)) {
    console.warn(`PrimeSrc: host "${embed.host}" has no extractor yet`);
    return { sources: [], subtitles: [] };
  }

  // Route by embed host: each family runs its own extractor.
  const extractorName = MIXDROP_EMBED_HOSTS.test(embed.link)
    ? 'extractMixdrop'
    : DOOD_EMBED_HOSTS.test(embed.link)
      ? 'extractDoodstream'
      : FILELIONS_EMBED_HOSTS.test(embed.link)
        ? 'extractFilelions'
        : 'extractStreamwish';

  // Open Extractors takes the embed ({url, name?, id?}) and returns a full
  // server ({id, name, sources, subtitles}), so the extractor — which knows
  // the host and any subtitle tracks — owns the id/name/sources assembly.
  // pluginManager.call is only allowed for dependencies declared in this
  // plugin's manifest (open-extractors, methods: extractStreamwish +
  // extractMixdrop + extractDoodstream + extractFilelions).
  let server;
  try {
    server = await pluginManager.call('open-extractors', extractorName, [
      { url: embed.link, name: embed.host, id: embed.host_id },
    ]);
  } catch (e) {
    console.error(`PrimeSrc: ${extractorName} failed:`, e.message, e);
    return { sources: [], subtitles: [] };
  }

  if (!Array.isArray(server?.sources) || server.sources.length === 0) {
    console.warn(`PrimeSrc: no playable stream for ${embed.link}`);
    return { sources: [], subtitles: [] };
  }

  // The extractor already returns the server-owned sources + subtitles; the
  // getStreamSources envelope keeps them at the same level per the v2 contract.
  return {
    sources: server.sources,
    subtitles: Array.isArray(server.subtitles) ? server.subtitles : [],
  };
}

/**
 * GET /api/v1/l?key=… → embed record, transparently surviving a Cloudflare
 * JS challenge.
 *
 * From the in-app Dart client, a challenged response is a 403 HTML page
 * ("Just a moment…"). We then hand the URL to the visible WebView dialog
 * (globalThis.webview.captcha) so the challenge runs in a real browser
 * engine. Its cookies (cf_clearance/__cf_bm) are imported into the app's
 * HTTP session, so the plain retry below rides the validated session — for
 * this server and every later one. If the retry still fails, we parse the
 * dialog's final HTML (which is the JSON for this endpoint).
 */
async function fetchEmbed(serverId) {
  const url = `${primesrcApiBase}/l?key=${serverId}`;

  let response;
  try {
    response = await http.get(url);
  } catch (e) {
    console.error(
      `PrimeSrc: embed request failed for key=${serverId}:`,
      e.message,
      e
    );
    return null;
  }

  if (isCloudflareChallenge(response)) {
    console.warn(
      `PrimeSrc: Cloudflare challenge for key=${serverId} — opening the verification dialog…`
    );
    let solvedHtml = null;
    try {
      const solved = await webview.captcha(url, null);
      solvedHtml = solved?.data;
    } catch (e) {
      console.error('PrimeSrc: captcha dialog failed:', e.message, e);
    }

    // The WebView's session cookies are stored now — a plain request should
    // ride them.
    try {
      response = await http.get(url);
      console.log(`PrimeSrc: retry after challenge → status ${response?.status}`);
    } catch (e) {
      response = null;
    }

    if (!response?.isSuccess && solvedHtml) {
      // Fall back to the HTML the dialog returned (the JSON for /l).
      const parsed = normalizeEmbedData(solvedHtml);
      if (parsed) return parsed;
      console.warn('PrimeSrc: verification dialog did not yield JSON');
      return null;
    }
  }

  const data = normalizeEmbedData(response?.data);
  // for debugging
  console.log('Is success response:', response?.isSuccess);
  console.log('Data link:', data?.link);
  // if (!response?.isSuccess || !data?.link) {
  //   console.warn(
  //     `PrimeSrc: no embed for key=${serverId} (status ${response?.status})`
  //   );
  //   return null;
  // }

  return data;
}

/**
 * The embeds endpoint answers JSON; Dio decodes it into an object when the
 * content-type is application/json, but returns a raw string when the server
 * (or Cloudflare after a challenge) serves it as text/html. Normalize both.
 */
function normalizeEmbedData(data) {
  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      return null;
    }
  }
  return data && typeof data === 'object' ? data : null;
}

/** True when [response] is Cloudflare's managed JS-challenge page. */
function isCloudflareChallenge(response) {
  return (
    response?.status === 403 &&
    typeof response?.data === 'string' &&
    /cf_chl|Just a moment|challenge-platform/i.test(response.data)
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Nicer server label: host name + resolution parsed from the file name. */
function serverLabel(server) {
  const host = server.name || 'Unknown';
  const quality = qualityFromName(server.file_name || server.name);
  return quality ? `${host} · ${quality}` : host;
}

/** Pulls "4K"/"2160p"/"1080p"/"720p"/"480p" out of a release file name. */
function qualityFromName(fileName) {
  if (!fileName) return null;
  const match = fileName.match(/\b(4k|2160p|1080p|720p|480p)\b/i);
  return match ? match[1].toUpperCase() : null;
}