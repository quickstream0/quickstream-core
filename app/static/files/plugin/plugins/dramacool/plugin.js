// DramaCool Plugin
//
// Metadata + source provider for https://dramacool9.com.ro (a WordPress-style
// Asian drama / K-show site). The catalogue is HTML-only (no usable REST API),
// so cards, details and episodes are scraped from the rendered pages:
//
//   • home            → `#drama` / `#kshow` "latest episode" boxes
//   • listings        → archive pages rendered as <ul class="box"> card grids
//   • search          → /?s=<query> (+ /page/N/?s=<query>)
//   • series details  → /<slug> with #all-episodes
//   • streams         → /<slug>-episode-<N>.html server buttons, whose embeds
//                       are handed to Open Extractors (vidbasic / kisskh).
//
// Movies are not offered: DramaCool's movie pages carry no playable server.
//
// The archive pages link directly to series (`/<slug>`); the home boxes link to
// episodes (`/<slug>-episode-<N>.html`). Card ids are always the series slug,
// so a card opened from either place resolves to the same detail page.

const BASE = 'https://dramacool9.com.ro';
const PLUGIN_ID = 'com.quickstream.plugin.dramacool';
const OFFSITE_PLUGIN = 'com.quickstream.plugin.open-extractors';

// The site forces 20 items per page on archive grids.
const PAGE_SIZE = 20;
const CACHE_TTL_MS = 5 * 60 * 1000;

// In-session caches (per plugin instance). Home rows, category pages and the
// server list of an episode are each fetched more than once per navigation.
const htmlCache = new Map(); // url -> { data, url, at }
const serversCache = new Map(); // episode url -> servers[]

// ---------------------------------------------------------------------------
// http helpers
// ---------------------------------------------------------------------------

function headerOf(headers, name) {
  if (!headers) return null;
  const lower = String(name).toLowerCase();
  let value = null;
  for (const key in headers) {
    if (key.toLowerCase() === lower) {
      value = headers[key];
      break;
    }
  }
  if (value == null) return null;
  // Dio exposes headers as Map<String, List<String>>, so values arrive as arrays.
  return Array.isArray(value) ? value[0] : value;
}

async function fetchText(url, referer) {
  const hit = htmlCache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const headers = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    Referer: referer || `${BASE}/`,
  };

  let lastError;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await http.get(url, { headers });
      const status = res?.status ?? 0;
      if (status >= 200 && status < 300) {
        const value = {
          data: typeof res.data === 'string' ? res.data : '',
          url: res.url || url,
        };
        htmlCache.set(url, { value, at: Date.now() });
        return value;
      }
      if (status >= 400 && status < 500 && status !== 403 && status !== 429) {
        return { data: '', url };
      }
      lastError = new Error(`HTTP ${status}`);
    } catch (e) {
      lastError = e;
    }
    await delay(600 * (i + 1));
  }
  console.error(`DramaCool: fetch failed for ${url}:`, lastError?.message ?? lastError);
  return { data: '', url };
}

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------

const ENTITY_MAP = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  ndash: '–',
  mdash: '—',
};

function fromCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch (_) {
    return '';
  }
}

function decodeEntities(input) {
  if (input == null) return '';
  return String(input)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z0-9#]+);/gi, (match, name) => {
      const key = name.toLowerCase();
      return Object.prototype.hasOwnProperty.call(ENTITY_MAP, key) ? ENTITY_MAP[key] : match;
    });
}

function stripHtml(html) {
  if (html == null) return '';
  return decodeEntities(String(html).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(html) {
  return decodeEntities(String(html == null ? '' : html).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// url / slug helpers
// ---------------------------------------------------------------------------

/** Bare last path segment, without `.html` or a trailing `-episode-N`. */
function seriesSlug(href) {
  const clean = String(href || '').split('?')[0].replace(/\/+$/, '');
  let last = clean.split('/').pop() || '';
  last = last.replace(/\.html?$/i, '');
  last = last.replace(/-episode-\d+(?:-\d+)?$/i, '');
  return last;
}

/** Site-relative path (no leading/trailing slash), e.g. `genre/life`. */
function relPath(href) {
  return String(href || '')
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/^\/+|\/+$/g, '');
}

function basename(href) {
  const clean = String(href || '').split('?')[0].replace(/\/+$/, '');
  return clean.split('/').pop() || '';
}

function yearOfTitle(title) {
  const match = String(title || '').match(/\((\d{4})\)/);
  return match ? parseInt(match[1], 10) : null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// card parsing
// ---------------------------------------------------------------------------

/**
 * Map an `<a class="mask">` card grid (`<ul class="box">`) to cards. Works for
 * archive pages (links to `/<slug>`) and home boxes (links to episodes).
 */
function parseCards(html) {
  const source = typeof html === 'string' ? html : '';
  const out = [];
  const seen = new Set();
  const re = /<a[^>]*class=["']mask["'][^>]*href=["']([^"']+)["'][^>]*title=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(source))) {
    const href = match[1];
    const attrTitle = decodeEntities(match[2]);
    const inner = match[3];
    const slug = seriesSlug(href);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    const poster = (inner.match(/data-original=["']([^"']+)["']/i) || [])[1] || null;
    const h3 = (inner.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i) || [])[1] || '';
    const epText = (inner.match(/class=["']ep sub["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || '';
    const title = stripHtml(h3) || cleanEpisodeTitle(attrTitle);
    const episodeNumber = parseInt((epText.match(/\d+/) || [])[0], 10);

    out.push(cardOf(slug, title, poster, Number.isFinite(episodeNumber) ? episodeNumber : null));
  }
  return out;
}

function cleanEpisodeTitle(title) {
  return String(title || '')
    .replace(/\s+Episode\s+\d+.*$/i, '')
    .trim();
}

function cardOf(slug, title, poster, episodeNumber) {
  const year = yearOfTitle(title);
  return {
    id: slug,
    title,
    name: title,
    media_type: 'tv',
    poster_url: poster,
    backdrop_url: poster,
    overview: null,
    release_date: year ? `${year}-01-01` : null,
    release_year: year,
    card_style: {
      orientation: 'portrait',
      stacked: {
        topRight: { text: 'TV' },
        bottomLeft: episodeNumber
          ? { text: `EP ${episodeNumber}` }
          : year
            ? { text: String(year) }
            : null,
      },
    },
  };
}

/** The `<ul class="box">` grid nested under the element with the given id. */
function boxById(html, id) {
  const source = typeof html === 'string' ? html : '';
  const start = source.indexOf(`id="${id}"`);
  if (start < 0) return '';
  const box = source.indexOf('class="box"', start);
  if (box < 0) return '';
  const end = source.indexOf('</ul>', box);
  return source.slice(box, end < 0 ? undefined : end);
}

// ---------------------------------------------------------------------------
// envelopes
// ---------------------------------------------------------------------------

function rowOf(id, title, endpoint, results) {
  return {
    id,
    title,
    endpoint,
    card_style: { orientation: 'portrait' },
    results,
    hasMore: false,
    page: 1,
    total_pages: 1,
    total_results: results.length,
  };
}

function listEnvelope(results, page, totalPages, endpoint) {
  const total = Math.max(1, totalPages || page);
  return {
    results,
    page,
    hasMore: page < total,
    total_pages: total,
    total_results: results.length,
    endpoint,
  };
}

function emptyList(page, endpoint) {
  return {
    results: [],
    page,
    hasMore: false,
    total_pages: 1,
    total_results: 0,
    endpoint,
  };
}

// ---------------------------------------------------------------------------
// home content
// ---------------------------------------------------------------------------

export async function getHomeContent(page = 1) {
  const wantPage = parseInt(page, 10) || 1;
  if (wantPage > 1) {
    return { results: [], page: wantPage, hasMore: false, total_pages: 1, total_results: 0 };
  }

  const [home, popular, korean] = await Promise.all([
    fetchText(`${BASE}/`),
    fetchText(`${BASE}/all-most-popular-dramaz`),
    fetchText(`${BASE}/country/south-korea`),
  ]);

  const rows = [];
  const dramas = parseCards(boxById(home.data, 'drama')).slice(0, PAGE_SIZE);
  const kshows = parseCards(boxById(home.data, 'kshow')).slice(0, PAGE_SIZE);

  if (dramas.length) {
    rows.push(rowOf('recent-dramas', 'Recent Dramas', 'category/latest-asian-drama-releases-hd', dramas));
  }
  if (kshows.length) {
    rows.push(rowOf('recent-kshows', 'Recent K-Shows', 'category/latest-kshow-releases', kshows));
  }

  const popularCards = parseCards(popular.data).slice(0, PAGE_SIZE);
  if (popularCards.length) rows.push(rowOf('popular', 'Popular', 'popular', popularCards));

  const koreanCards = parseCards(korean.data).slice(0, PAGE_SIZE);
  if (koreanCards.length) rows.push(rowOf('korean-dramas', 'Korean Dramas', 'country/south-korea', koreanCards));

  return { results: rows, page: 1, hasMore: false, total_pages: 1, total_results: rows.length };
}

// ---------------------------------------------------------------------------
// media items (see-all / pagination)
// ---------------------------------------------------------------------------

export async function getMediaItems(endpoint = 'popular', page = 1) {
  const wantPage = parseInt(page, 10) || 1;
  const ep = String(endpoint || '').replace(/^\/+|\/+$/g, '');
  if (!ep) return emptyList(wantPage, endpoint);

  if (ep.startsWith('search:')) return search(ep.slice('search:'.length), wantPage);

  let url;
  if (/^https?:\/\//i.test(ep)) {
    url = wantPage <= 1 ? ep : `${ep.replace(/\/+$/, '')}/page/${wantPage}`;
  } else {
    const path = ep === 'popular' ? '/all-most-popular-dramaz' : `/${ep}`;
    url = wantPage <= 1 ? `${BASE}${path}` : `${BASE}${path}/page/${wantPage}`;
  }

  const { data: html } = await fetchText(url);
  const results = parseCards(html);
  const totalPages = totalPagesOf(html, url);
  return listEnvelope(results, wantPage, totalPages, ep);
}

/** Highest `/page/N` link for this archive (canonical-anchored). */
function totalPagesOf(html, url) {
  const source = typeof html === 'string' ? html : '';
  const canonical = (source.match(/rel=["']canonical["'][^>]*href=["']([^"']+)["']/i) || [])[1];
  const anchor = (canonical || url).split('?')[0].replace(/\/+$/, '');
  const re = new RegExp(`${escapeRegExp(anchor)}/page/(\\d+)`, 'g');
  let max = 1;
  let match;
  while ((match = re.exec(source))) max = Math.max(max, parseInt(match[1], 10));
  return max;
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

export async function search(query, page = 1) {
  const q = String(query ?? '').trim();
  const wantPage = parseInt(page, 10) || 1;
  if (q.length < 2) {
    return { results: [], page: 1, hasMore: false, total_pages: 0, total_results: 0, endpoint: `search:${q}` };
  }

  const url = wantPage <= 1
    ? `${BASE}/?s=${encodeURIComponent(q)}`
    : `${BASE}/page/${wantPage}/?s=${encodeURIComponent(q)}`;
  const { data: html } = await fetchText(url);
  const results = parseCards(html);

  const titleMatch = html.match(/Page\s+\d+\s+of\s+(\d+)/i);
  const totalPages = titleMatch
    ? parseInt(titleMatch[1], 10)
    : results.length >= PAGE_SIZE
      ? wantPage + 1
      : wantPage;

  return {
    results,
    page: wantPage,
    hasMore: wantPage < totalPages,
    total_pages: totalPages,
    total_results: results.length,
    endpoint: `search:${q}`,
  };
}

// ---------------------------------------------------------------------------
// details
// ---------------------------------------------------------------------------

export async function getDetails(id, mediaType, prioritySeason) {
  const slug = seriesSlug(String(id || ''));
  if (!slug) return null;

  const { data: html } = await fetchText(`${BASE}/${slug}`);
  if (!html) return null;

  const title = stripHtml((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]) || slug;
  const poster = (html.match(/class=["']drama-thumbnail["'][\s\S]*?data-original=["']([^"']+)["']/i) || [])[1] || null;
  const synopsis = (html.match(/class=["']synopsis["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '';
  const overview = stripHtml(synopsis.replace(/<span[^>]*>[\s\S]*?<\/span>/i, ''));

  const episodes = parseEpisodes(html, slug);
  const isTv = episodes.length > 0;
  const mt = isTv ? 'tv' : 'movie';
  const season = 1;
  const wantSeason = parseInt(prioritySeason, 10) || season;
  const year = parseInt((html.match(/release-year[^>]*>[\s\S]*?>(\d{4})</i) || [])[1] || '', 10)
    || yearOfTitle(title);

  const genres = metaLinks(html, 'Genres:').map((link) => {
    const ep = relPath(link.href);
    return { id: ep.split('/').pop(), name: link.text, title: link.text, type: 'genre', endpoint: ep };
  });
  const cast = metaLinks(html, 'Starring:').map((link, order) => ({
    id: basename(link.href),
    name: link.text,
    character: null,
    order,
    profile_url: null,
  }));

  const details = {
    id: slug,
    title,
    name: title,
    media_type: mt,
    poster_url: poster,
    backdrop_url: poster,
    overview,
    release_date: year ? `${year}-01-01` : null,
    release_year: year,
    status: metaText(html, 'Status:') || null,
    director: metaText(html, 'Director:') || null,
    genres,
    countries: metaLinks(html, 'Country:').map((link) => link.text),
    cast,
  };

  if (isTv) {
    details.number_of_seasons = 1;
    details.number_of_episodes = episodes.length;
    details.seasons = [
      {
        id: slug,
        name: 'Season 1',
        season_number: season,
        seasonNumber: season,
        episode_count: episodes.length,
        episodes: wantSeason === season ? episodes : undefined,
      },
    ];
    if (wantSeason === season) details.episodes = episodes;
  }

  return details;
}

/** Plain text following a `<span>Label</span>` up to the end of its `<p>`. */
function metaText(html, label) {
  const block = metaBlock(html, label);
  if (!block) return '';
  return stripHtml(block.replace(/<span[^>]*>[\s\S]*?<\/span>/i, ''));
}

/** `{ href, text }[]` for the `<a>` tags in the paragraph carrying `Label`. */
function metaLinks(html, label) {
  const block = metaBlock(html, label);
  if (!block) return [];
  const links = [];
  const re = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(block))) {
    const text = stripHtml(match[2]);
    if (text) links.push({ href: match[1], text });
  }
  return links;
}

function metaBlock(html, label) {
  const source = typeof html === 'string' ? html : '';
  const span = source.match(new RegExp(`<span[^>]*>\\s*${escapeRegExp(label)}\\s*</span>`, 'i'));
  if (!span) return '';
  const start = span.index;
  const end = source.indexOf('</p>', start);
  if (end < 0) return source.slice(start);
  return source.slice(start, end);
}

// ---------------------------------------------------------------------------
// episodes
// ---------------------------------------------------------------------------

export async function getSeasonEpisodes(mediaId, seasonNumber) {
  const slug = seriesSlug(String(mediaId || ''));
  if (!slug) return [];
  const { data: html } = await fetchText(`${BASE}/${slug}`);
  // NOTE: bare array — the details screen's datasource requires `result is List`.
  return parseEpisodes(html, slug);
}

/** Parse `#all-episodes .list` anchors into episodes, ordered ascending. */
function parseEpisodes(html, slug) {
  const source = typeof html === 'string' ? html : '';
  const block = (source.match(/id=["']all-episodes["'][\s\S]*?<ul[^>]*class=["']list["'][^>]*>([\s\S]*?)<\/ul>/i) || [])[1] || '';
  const episodes = [];
  const seen = new Set();
  const re = /<a[^>]*href=["']([^"']+)["'][^>]*title=["']([^"']*)["'][^>]*>/gi;
  let match;
  while ((match = re.exec(block))) {
    const href = match[1];
    const title = decodeEntities(match[2]);
    const number = parseInt(
      (href.match(/-episode-(\d+)(?:-\d+)?\.html/i) || [])[1]
        || (title.match(/Episode\s+(\d+)/i) || [])[1]
        || '',
      10
    );
    if (!Number.isFinite(number) || seen.has(number)) continue;
    seen.add(number);
    episodes.push({
      id: href,
      episode_number: number,
      season_number: 1,
      name: title || `Episode ${number}`,
      overview: null,
      still_url: null,
      air_date: null,
    });
  }
  return episodes.sort((a, b) => a.episode_number - b.episode_number);
}

// ---------------------------------------------------------------------------
// streams — lazy servers via Open Extractors
// ---------------------------------------------------------------------------

const EXTRACTORS = {
  vidbasic: 'extractVidbasic',
  kisskh: 'extractKisskh',
};

export async function getStreams(metadata) {
  const servers = await serversFor(metadata);
  const supported = servers.filter((server) => EXTRACTORS[server.kind]);
  if (supported.length === 0) {
    console.warn('DramaCool: no supported servers for', metadata?.id);
    return { providers: [] };
  }

  return {
    providers: [
      {
        id: PLUGIN_ID,
        name: 'DramaCool',
        logo: `${BASE}/favicon.ico`,
        reliable: true,
        servers: supported.map((server) => ({ id: server.id, name: server.name })),
      },
    ],
  };
}

export async function getStreamSources(metadata, providerId, serverId) {
  const servers = await serversFor(metadata);
  const server = servers.find((candidate) => candidate.id === serverId);
  if (!server) {
    console.warn('DramaCool: unknown server', serverId);
    return { sources: [], subtitles: [] };
  }

  const extractor = EXTRACTORS[server.kind];
  if (!extractor) return { sources: [], subtitles: [] };

  let result;
  try {
    result = await pluginManager.call(OFFSITE_PLUGIN, extractor, [
      { url: server.url, name: server.name, id: server.id },
    ]);
  } catch (e) {
    console.error(`DramaCool: ${extractor} failed:`, e?.message ?? e);
    return { sources: [], subtitles: [] };
  }

  if (!Array.isArray(result?.sources) || result.sources.length === 0) {
    console.warn(`DramaCool: no playable stream for ${server.name}`);
    return { sources: [], subtitles: [] };
  }

  return {
    sources: result.sources,
    subtitles: Array.isArray(result.subtitles) ? result.subtitles : [],
  };
}

/** Resolve the episode page for the item and parse its server buttons. */
async function serversFor(metadata) {
  const mt = String(metadata?.media_type || metadata?.mediaType || 'tv').toLowerCase();
  if (mt === 'movie') return [];

  const slug = seriesSlug(String(metadata?.id || ''));
  if (!slug) {
    console.warn('DramaCool: cannot resolve episode for', metadata?.id);
    return [];
  }

  const episode = parseInt(metadata?.episode, 10)
    || parseInt(metadata?.episode_number, 10)
    || 1;
  const url = `${BASE}/${slug}-episode-${episode}.html`;
  if (serversCache.has(url)) return serversCache.get(url);

  const { data: html } = await fetchText(url, `${BASE}/${slug}`);
  const servers = parseServers(html);
  serversCache.set(url, servers);
  return servers;
}

/** Map `.server-btn` buttons to `{ id, name, url, kind }`. */
function parseServers(html) {
  const source = typeof html === 'string' ? html : '';
  const out = [];
  const seen = new Set();
  const re = /<button[^>]*class=["'][^"']*server-btn[^"']*["'][^>]*data-src=["']([^"']+)["'][^>]*>([\s\S]*?)<\/button>/gi;
  let match;
  while ((match = re.exec(source))) {
    const url = match[1];
    const kind = hostKind(url);
    if (!kind) continue;
    const id = `${kind}:${basename(url)}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const name = stripHtml(match[2].replace(/<span[^>]*>[\s\S]*?<\/span>/i, '')) || 'Server';
    out.push({ id, name, url, kind });
  }
  return out;
}

function hostKind(url) {
  const value = String(url || '').toLowerCase();
  if (value.includes('vidbasic')) return 'vidbasic';
  if (value.includes('kisskh') || value.includes('megaplay')) return 'kisskh';
  return null;
}
