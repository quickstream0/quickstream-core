// HiAnime Plugin
//
// Metadata + source provider for https://hianime.ms (an anime catalogue). The
// site is server-rendered HTML (cards, details and watch pages), so every part
// of the catalogue is scraped from those pages:
//
//   • home            → a fixed set of catalogue rows (/top-airing, /most-popular,
//                        /updates, /movies, /tv, /most-favorite), each paginating
//                        via ?page=N
//   • listings        → /<path>?page=N card grids (.flw-item)
//   • search          → /search?q=<query> (single page, no pagination)
//   • details         → /details/<slug>-<hash> (.anisc-info + synopsis)
//   • episodes        → the watch page's #episodes-list (.ws-ep anchors)
//   • streams         → the "Ryu" (MegaPlay) server on the watch page, whose
//                        embed is handed to Open Extractors (extractMegaplay).
//
// Each title has several servers (Ryu, Volt, Warp, Ayame). Only Ryu/MegaPlay
// has a plain-HTTP extraction path (getSources + an AES-256-CBC blob); Volt
// (vidnest.fun) and Warp (tryembed.us.cc) are JS-gated players with nonce /
// request-signature checks and are intentionally not served — the same call
// made for TinyZone's Videasy server.
//
// Every title is modelled as `tv` or `movie` (from the card's data-pf-ref
// prefix, or the details page's Format / breadcrumb). Long-running series are
// grouped into the site's own episode ranges ("Episodes 1–100", …), surfaced
// as seasons so the player can page through 1000+ episode shows.

const BASE = 'https://hianime.ms';
const PLUGIN_ID = 'com.quickstream.plugin.hianime';
const OFFSITE_PLUGIN = 'com.quickstream.plugin.open-extractors';

// MegaPlay's embed host (`var _hAni = atob('…')` on the watch page).
const MEGAPLAY_ORIGIN = 'https://megaplay.buzz';

const CACHE_TTL_MS = 5 * 60 * 1000;
const htmlCache = new Map(); // url -> { data, url, at }
const serversCache = new Map(); // slug|ep -> servers[]

// Home rows: id, title, catalogue path (also the "See All" endpoint).
const HOME_ROWS = [
  { id: 'top-airing', title: 'Top Airing', endpoint: 'top-airing' },
  { id: 'most-popular', title: 'Most Popular', endpoint: 'most-popular' },
  { id: 'updates', title: 'Recently Updated', endpoint: 'updates' },
  { id: 'movies', title: 'Anime Movies', endpoint: 'movies' },
  { id: 'tv', title: 'TV Series', endpoint: 'tv' },
  { id: 'most-favorite', title: 'Most Favorite', endpoint: 'most-favorite' },
];

// ---------------------------------------------------------------------------
// http helpers
// ---------------------------------------------------------------------------

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
  console.error(`HiAnime: fetch failed for ${url}:`, lastError?.message ?? lastError);
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

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// slug / type helpers
// ---------------------------------------------------------------------------

/** Bare `slug-hash` segment from a details/watch path (or a raw id). */
function slugOf(id) {
  const clean = String(id || '').split('?')[0].split('#')[0].replace(/\/+$/, '');
  const last = clean.split('/').pop() || '';
  return last.replace(/\.html?$/i, '');
}

function typeOf(metadata) {
  const mt = String(metadata?.media_type || metadata?.mediaType || 'tv').toLowerCase();
  return mt.includes('movie') ? 'movie' : 'tv';
}

function episodeOf(metadata) {
  const raw = metadata?.episode ?? metadata?.episode_number;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

function relPath(href) {
  return String(href || '')
    .replace(/^https?:\/\/[^/]+/i, '')
    .replace(/^\/+|\/+$/g, '');
}

// ---------------------------------------------------------------------------
// card parsing
// ---------------------------------------------------------------------------

function parseCards(html) {
  const source = typeof html === 'string' ? html : '';
  const out = [];
  const seen = new Set();
  const parts = source.split('class="flw-item"');
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i];
    const hrefMatch = block.match(/href="[^"]*\/details\/([^"]+)"/);
    if (!hrefMatch) continue;
    const slug = slugOf(hrefMatch[1]);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);

    const ref = (block.match(/data-pf-ref="([sm])\d+"/) || [])[1];
    const mediaType = ref === 'm' ? 'movie' : 'tv';

    const imgTag = (block.match(/<img[^>]*film-poster-img[^>]*>/i) || [])[0] || '';
    let poster = (imgTag.match(/\bsrc="([^"]+)"/) || [])[1] || null;
    if (!poster || /no-poster|placeholder/i.test(poster)) {
      poster = (imgTag.match(/data-src="([^"]+)"/) || [])[1] || poster;
    }
    const alt = (imgTag.match(/\balt="([^"]*)"/) || [])[1] || '';

    let title = decodeEntities((block.match(/data-ename="([^"]*)"/) || [])[1] || '');
    if (!title) {
      const h3 = block.match(/<h3[^>]*class="[^"]*film-name[^"]*"[^>]*>([\s\S]*?)<\/h3>/i);
      title = h3 ? stripHtml(h3[1]) : slug;
    }

    const year = parseInt(
      (alt.match(/\((\d{4})\)/) || [])[1]
        || (block.match(/<span class="fdi-item">\s*((?:19|20)\d{2})\s*<\/span>/) || [])[1]
        || '',
      10
    );
    const episodeCount = parseInt(
      (block.match(/tick-eps[^>]*>\s*(\d+)\s*</) || [])[1]
        || (block.match(/(\d+)\s*eps/i) || [])[1]
        || '',
      10
    );
    const ratingRaw = (block.match(/tick-rate"[^>]*>[\s\S]*?([\d]+\.?[\d]*)\s*</) || [])[1];
    const rating = parseFloat(ratingRaw);

    const hasDub = /tick-dub/.test(block);
    const hasSub = /tick-sub/.test(block);
    const stacked = {};
    if (hasDub) stacked.topLeft = { text: 'DUB' };
    else if (hasSub) stacked.topLeft = { text: 'SUB' };
    if (mediaType === 'tv' && Number.isFinite(episodeCount)) {
      stacked.topRight = { text: `${episodeCount} EP` };
    } else if (Number.isFinite(year)) {
      stacked.bottomLeft = { text: `${year}` };
    }

    out.push({
      id: slug,
      title,
      name: title,
      media_type: mediaType,
      poster_url: poster,
      backdrop_url: poster,
      overview: '',
      release_date: Number.isFinite(year) ? `${year}-01-01` : null,
      release_year: Number.isFinite(year) ? year : null,
      vote_average: Number.isFinite(rating) ? rating : null,
      episode_count: Number.isFinite(episodeCount) ? episodeCount : null,
      card_style: { orientation: 'portrait', stacked },
    });
  }
  return out;
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

  const pages = await Promise.all(HOME_ROWS.map((row) => fetchText(`${BASE}/${row.endpoint}`)));
  const rows = [];
  HOME_ROWS.forEach((row, index) => {
    const cards = parseCards(pages[index]?.data || '');
    if (cards.length) rows.push(rowOf(row.id, row.title, row.endpoint, cards));
  });

  return { results: rows, page: 1, hasMore: false, total_pages: 1, total_results: rows.length };
}

// ---------------------------------------------------------------------------
// media items (see-all / pagination)
// ---------------------------------------------------------------------------

export async function getMediaItems(endpoint = 'top-airing', page = 1) {
  const wantPage = parseInt(page, 10) || 1;
  const ep = String(endpoint || '').replace(/^\/+|\/+$/g, '');
  if (!ep) return emptyList(wantPage, endpoint);

  if (ep.startsWith('search:')) return search(ep.slice('search:'.length), wantPage);

  const url = wantPage <= 1 ? `${BASE}/${ep}` : `${BASE}/${ep}?page=${wantPage}`;
  const { data: html } = await fetchText(url);
  const results = parseCards(html);
  const totalPages = totalPagesOf(html);
  return listEnvelope(results, wantPage, totalPages, ep);
}

/** Highest `?page=N` link on a catalogue page. */
function totalPagesOf(html) {
  const source = typeof html === 'string' ? html : '';
  const re = /href="[^"]*[?&]page=(\d+)"/g;
  let max = 1;
  let match;
  while ((match = re.exec(source))) max = Math.max(max, parseInt(match[1], 10));
  return max;
}

// ---------------------------------------------------------------------------
// search (single page — the site exposes no result pagination)
// ---------------------------------------------------------------------------

export async function search(query, page = 1) {
  const q = String(query ?? '').trim();
  if (q.length < 2) {
    return { results: [], page: 1, hasMore: false, total_pages: 0, total_results: 0, endpoint: `search:${q}` };
  }

  const { data: html } = await fetchText(`${BASE}/search?q=${encodeURIComponent(q)}`, `${BASE}/`);
  const results = parseCards(html);

  return {
    results,
    page: 1,
    hasMore: false,
    total_pages: 1,
    total_results: results.length,
    endpoint: `search:${q}`,
  };
}

// ---------------------------------------------------------------------------
// details
// ---------------------------------------------------------------------------

export async function getDetails(id, mediaType, prioritySeason) {
  const slug = slugOf(String(id || ''));
  if (!slug) return null;

  const { data: html } = await fetchText(`${BASE}/details/${slug}`, `${BASE}/`);
  if (!html) return null;

  const title = decodeEntities((html.match(/<h1[^>]*data-ename="([^"]*)"/) || [])[1] || '')
    || stripHtml((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1])
    || slug;

  const poster = (html.match(/<div class="anisc-poster">[\s\S]*?<img[^>]*\bsrc="([^"]+)"/) || [])[1]
    || (html.match(/<img[^>]*class="film-poster-img"[^>]*\bsrc="([^"]+)"/) || [])[1]
    || null;
  const backdrop = (html.match(/class="anis-cover"\s*style="background-image:\s*url\(['"]?([^'")]+)['"]?\)/) || [])[1] || poster;

  const overview = stripHtml((html.match(/id="synopsis-text"[^>]*>([\s\S]*?)<\/div>/i) || [])[1] || '');

  const refPrefix = (html.match(/data-pf-ref="([sm])\d+"/) || [])[1];
  const formatText = metaText(html, 'Format:');
  const crumb = (html.match(/<span itemprop="name">(TV|MOVIE|ONA|OVA|SPECIAL)<\/span>/i) || [])[1] || '';
  const isMovie = refPrefix === 'm'
    || /^movie$/i.test(formatText)
    || /^movie$/i.test(crumb)
    || String(mediaType || '').toLowerCase().includes('movie');

  const year = parseInt(
    (metaText(html, 'Year:').match(/\d{4}/) || [])[0]
      || (metaText(html, 'Released:').match(/\d{4}/) || [])[1]
      || (title.match(/\((\d{4})\)/) || [])[1]
      || (metaText(html, 'Premiered:').match(/\d{4}/) || [])[0]
      || '',
    10
  );
  const rating = parseFloat((metaText(html, 'Rating:').match(/([\d.]+)/) || [])[1]);

  const genres = metaLinks(html, 'Genres:').map((link) => ({
    name: link.text,
    title: link.text,
    type: 'genre',
    endpoint: relPath(link.href),
  }));
  const studios = metaLinks(html, 'Studios:').map((link) => ({
    name: link.text,
    title: link.text,
    type: 'studio',
    endpoint: relPath(link.href),
  }));

  const details = {
    id: slug,
    title,
    name: title,
    media_type: isMovie ? 'movie' : 'tv',
    poster_url: poster,
    backdrop_url: backdrop,
    overview,
    release_date: Number.isFinite(year) ? `${year}-01-01` : null,
    release_year: Number.isFinite(year) ? year : null,
    vote_average: Number.isFinite(rating) ? rating : null,
    status: metaText(html, 'Status:') || null,
    genres,
    production_companies: studios,
    cast: [],
  };

  if (!isMovie) {
    const episodes = await episodesFor(slug);
    if (episodes.length) {
      const seasons = seasonsOf(episodes);
      const want = parseInt(prioritySeason, 10) || 1;
      details.number_of_episodes = episodes.length;
      details.number_of_seasons = seasons.length;
      details.seasons = seasons.map((season) => {
        const mine = episodes
          .filter((e) => e.season === season.dataSeason)
          .map((e) => episodeItem(slug, e, season.seasonNumber));
        return {
          id: slug,
          name: season.name,
          season_number: season.seasonNumber,
          seasonNumber: season.seasonNumber,
          episode_count: mine.length,
          episodes: season.seasonNumber === want ? mine : undefined,
        };
      });
      const priority = seasons.find((s) => s.seasonNumber === want);
      if (priority) {
        details.episodes = episodes
          .filter((e) => e.season === priority.dataSeason)
          .map((e) => episodeItem(slug, e, priority.seasonNumber));
      }
    }
  }

  return details;
}

/** Plain text following a `<span class="item-head">Label</span>`. */
function metaText(html, label) {
  const block = metaBlock(html, label);
  if (!block) return '';
  return stripHtml(block.replace(/<span[^>]*class="item-head"[^>]*>[\s\S]*?<\/span>/i, ''));
}

/** `{ href, text }[]` for the `<a>` tags in the item carrying `Label`. */
function metaLinks(html, label) {
  const block = metaBlock(html, label);
  if (!block) return [];
  const links = [];
  const re = /<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(block))) {
    const text = stripHtml(match[2]);
    if (text) links.push({ href: match[1], text });
  }
  return links;
}

function metaBlock(html, label) {
  const source = typeof html === 'string' ? html : '';
  const span = source.match(new RegExp(`<span[^>]*class="item-head"[^>]*>\\s*${escapeRegExp(label)}\\s*</span>`, 'i'));
  if (!span) return '';
  const start = span.index;
  const end = source.indexOf('</div>', start);
  if (end < 0) return source.slice(start);
  return source.slice(start, end);
}

// ---------------------------------------------------------------------------
// episodes
// ---------------------------------------------------------------------------

export async function getSeasonEpisodes(mediaId, seasonNumber) {
  const slug = slugOf(String(mediaId || ''));
  if (!slug) return []; // bare array — the details datasource requires `result is List`

  const want = parseInt(seasonNumber, 10) || 1;
  const episodes = await episodesFor(slug);
  if (!episodes.length) return [];

  const seasons = seasonsOf(episodes);
  const season = seasons.find((s) => s.seasonNumber === want);
  if (!season) return [];
  return episodes
    .filter((e) => e.season === season.dataSeason)
    .map((e) => episodeItem(slug, e, want));
}

/** Raw parsed episode → the episode item contract the app expects. */
function episodeItem(slug, episode, seasonNumber) {
  return {
    id: `${slug}:${episode.number}`,
    episode_number: episode.number,
    season_number: seasonNumber,
    name: episode.name,
    overview: null,
    still_url: null,
    air_date: null,
  };
}

/** Episode list for a series, fetched from its episode-1 watch page. */
async function episodesFor(slug) {
  const watchUrl = await watchHrefFor(slug, 1, false);
  if (!watchUrl) return [];
  const { data: html } = await fetchText(watchUrl, `${BASE}/`);
  return parseEpisodeAnchors(html);
}

/** `.ws-ep` anchors → `{ number, season, name }[]`, ordered ascending. */
function parseEpisodeAnchors(html) {
  const source = typeof html === 'string' ? html : '';
  const out = [];
  const seen = new Set();
  const re = /<a\b([^>]*\bws-ep\b[^>]*)>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(source))) {
    const attrs = match[1];
    const number = parseInt((attrs.match(/data-episode="(\d+)"/) || [])[1] || '', 10);
    if (!Number.isFinite(number) || seen.has(number)) continue;
    seen.add(number);
    const season = parseInt((attrs.match(/data-season="(\d+)"/) || [])[1] || '0', 10);
    const titleEl = (match[2].match(/<span[^>]*class="ws-ep__title"[^>]*>([\s\S]*?)<\/span>/) || [])[1] || '';
    const aria = decodeEntities((attrs.match(/aria-label="([^"]*)"/) || [])[1] || '').replace(/^Episode\s+\d+:\s*/i, '');
    const name = stripHtml(titleEl) || aria || `Episode ${number}`;
    out.push({ number, season: Number.isFinite(season) ? season : 0, name });
  }
  return out.sort((a, b) => a.number - b.number);
}

/** Distinct data-season buckets → { dataSeason, seasonNumber, name }. */
function seasonsOf(episodes) {
  const values = [...new Set(episodes.map((e) => e.season))].sort((a, b) => a - b);
  return values.map((value, index) => {
    const mine = episodes.filter((e) => e.season === value);
    const first = mine[0]?.number;
    const last = mine[mine.length - 1]?.number;
    const label = values.length > 1 && Number.isFinite(first) && Number.isFinite(last)
      ? `Episodes ${first}–${last}`
      : 'Season 1';
    return { dataSeason: value, seasonNumber: index + 1, name: label };
  });
}

/** Watch URL for one episode, derived from the details page's play button. */
async function watchHrefFor(slug, episode, isMovie) {
  const { data: html } = await fetchText(`${BASE}/details/${slug}`, `${BASE}/`);
  const href = (html.match(/<a[^>]*href="([^"]+\/watch-[^"]+)"[^>]*class="[^"]*btn-play[^"]*"/i) || [])[1]
    || (html.match(/<a[^>]*class="[^"]*btn-play[^"]*"[^>]*href="([^"]+)"/i) || [])[1]
    || '';
  if (!href) return null;
  if (isMovie) return href;
  return href.replace(/-episode-\d+-/, `-episode-${episode}-`);
}

// ---------------------------------------------------------------------------
// streams — MegaPlay ("Ryu") via Open Extractors
// ---------------------------------------------------------------------------

export async function getStreams(metadata) {
  const servers = await serversFor(metadata);
  if (servers.length === 0) {
    console.warn('HiAnime: no supported servers for', metadata?.id);
    return { providers: [] };
  }
  return {
    providers: [
      {
        id: PLUGIN_ID,
        name: 'HiAnime',
        logo: `${BASE}/favicon.ico`,
        reliable: true,
        servers: servers.map((server) => ({ id: server.id, name: server.name })),
      },
    ],
  };
}

export async function getStreamSources(metadata, providerId, serverId) {
  const servers = await serversFor(metadata);
  const server = servers.find((candidate) => candidate.id === serverId);
  if (!server) {
    console.warn('HiAnime: unknown server', serverId);
    return { sources: [], subtitles: [] };
  }

  let result;
  try {
    result = await pluginManager.call(OFFSITE_PLUGIN, 'extractMegaplay', [
      { url: server.url, name: server.name, id: `megaplay:${serverId}` },
    ]);
  } catch (e) {
    console.error(`HiAnime: extractMegaplay failed:`, e?.message ?? e);
    return { sources: [], subtitles: [] };
  }

  if (!Array.isArray(result?.sources) || result.sources.length === 0) {
    console.warn(`HiAnime: no playable stream for ${server.name}`);
    return { sources: [], subtitles: [] };
  }

  return {
    sources: result.sources,
    subtitles: Array.isArray(result.subtitles) ? result.subtitles : [],
  };
}

/** Resolve the watch page and expose the MegaPlay sub/dub servers. */
async function serversFor(metadata) {
  const slug = slugOf(String(metadata?.id || ''));
  if (!slug) {
    console.warn('HiAnime: cannot resolve episode for', metadata?.id);
    return [];
  }

  const isMovie = typeOf(metadata) === 'movie';
  const episode = episodeOf(metadata);
  const cacheKey = `${slug}|${isMovie ? 'm' : episode}`;
  if (serversCache.has(cacheKey)) return serversCache.get(cacheKey);

  const watchUrl = await watchHrefFor(slug, episode, isMovie);
  if (!watchUrl) {
    serversCache.set(cacheKey, []);
    return [];
  }

  const { data: html } = await fetchText(watchUrl, `${BASE}/`);
  const anilistId = (html.match(/var anilistId\s*=\s*(\d+)/) || [])[1];
  if (!anilistId) {
    console.warn(`HiAnime: no anilistId on ${watchUrl}`);
    serversCache.set(cacheKey, []);
    return [];
  }

  const streamEp = isMovie ? 1 : episode;
  const servers = [{ id: 'sub', name: 'Ryu (Sub)', url: `${MEGAPLAY_ORIGIN}/stream/ani/${anilistId}/${streamEp}/sub` }];
  if (hasDub(html, isMovie ? null : episode)) {
    servers.push({ id: 'dub', name: 'Ryu (Dub)', url: `${MEGAPLAY_ORIGIN}/stream/ani/${anilistId}/${streamEp}/dub` });
  }

  serversCache.set(cacheKey, servers);
  return servers;
}

/** True when a DUB MegaPlay track exists for the episode. */
function hasDub(html, episode) {
  const source = typeof html === 'string' ? html : '';
  if (episode != null) {
    const anchor = source.match(new RegExp(`<a\\b[^>]*data-episode="${episode}"[^>]*>`, 'i'));
    if (anchor) {
      const dub = (anchor[0].match(/data-has-dub="(\d)"/) || [])[1];
      if (dub != null) return dub === '1';
    }
  }
  // Fallback (and the movie case): a DUB row exposing the MegaPlay button.
  return /data-version="dub"[^>]*data-server="backup"/i.test(source)
    || /data-server="backup"[^>]*data-version="dub"/i.test(source);
}
