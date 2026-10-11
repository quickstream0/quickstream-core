// ============================================================================
// TinyZone Plugin (metadata + source) — movies & TV shows
// ============================================================================
// Scrapes https://tinyzonetv.app:
//   home (/home/), category pages (/movies/, /tv-series/, /genre/<slug>),
//   search (/search?keyword=), detail/watch pages (/movie/<slug>-<id>/,
//   /series/<slug>-<id>/, /series/<slug>-<id>/<s>-<e>/ for episodes).
//
// The three servers tinyzone exposes per item are UpCloud, Vidmoly and
// Videasy. UpCloud + Vidmoly are extracted here (the embed streams are
// resolved by the Open Extractors tool plugin); Videasy is intentionally not
// served — its current player is a JS-gated Next.js app with no plain-HTTP
// extraction path, and the old public API (api.speedracelight.com) is dead.
// ============================================================================

const BASE = 'https://tinyzonetv.app';

// Embed host whose favicons label the extracted server stubs.
const SERVER_META = {
  upcloud: { extractor: 'extractUpcloud', label: 'UpCloud' },
  vidmoly: { extractor: 'extractVidmoly', label: 'Vidmoly' },
};

// Display order for server stubs — most reliable first. Vidmoly is preferred
// over UpCloud (UpCloud sits behind a proof-of-work captcha).
const SERVER_ORDER = ['vidmoly', 'upcloud'];

// In-session one-slot cache: watch page html / extracted server list. Streams
// expand lazily (getStreams then getStreamSources run back-to-back for the
// same episode), so reusing the just-fetched server list avoids a duplicate
// page round-trip — while the TTL keeps stale data from lingering.
const CACHE_TTL_MS = 5 * 60 * 1000;
let pageCache = { key: null, value: null, at: 0 };

// ---------------------------------------------------------------------------
// http helpers
// ---------------------------------------------------------------------------

async function fetchText(url, referer) {
  const headers = {
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (referer) headers.Referer = referer;
  let lastError;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await http.get(url, { headers });
      if (!res || res.status === 403) {
        lastError = new Error(`HTTP ${res?.status}`);
      } else {
        return { data: res.data, url: res.url || url, status: res.status };
      }
    } catch (e) {
      lastError = e;
    }
    await delay((i + 1) * 700);
  }
  console.error(`TinyZone: request failed for ${url}:`, lastError?.message ?? lastError);
  return { data: '', url, status: null };
}

async function fetchPage(url, referer) {
  const key = url;
  const hit = pageCache;
  if (hit.key === key && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const res = await fetchText(url, referer);
  pageCache = { key, value: res, at: Date.now() };
  return res;
}

// ---------------------------------------------------------------------------
// parsing helpers
// ---------------------------------------------------------------------------

/** /movie/verity-63558/ → 'movie/verity-63558'; /series/x/1-2/ → 'series/x/1-2' */
function relPathOf(url) {
  let path = String(url || '').split('?')[0].split('#')[0];
  if (!/^https?:\/\//i.test(path)) path = BASE + path;
  try {
    return new URL(path, BASE).pathname.replace(/^\/+/, '').replace(/\/+$/, '');
  } catch (_) {
    return '';
  }
}

function mediaTypeOfRel(rel) {
  return rel.startsWith('series/') ? 'tv' : rel.startsWith('movie/') ? 'movie' : null;
}

/**
 * The app hands ids around as single path segments (its details route is
 * /details/:id/:type), so the card id is the slug without the type prefix.
 * `relFor` reconstructs the site-relative path movie|<series>/<slug> from the
 * id plus the media type.
 */
function relFor(id, mediaType) {
  const raw = String(id ?? '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (/^(movie|series)\//.test(raw)) return raw;
  const slug = raw.split('/').filter(Boolean).pop() || '';
  return slug ? `${mediaType === 'tv' ? 'series' : 'movie'}/${slug}` : '';
}

function seasonCountOf(infor) {
  const m = infor.match(/SS\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

function episodeCountOf(infor) {
  const m = infor.match(/EPS\s+(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

/** One `.film_list-wrap` item → media card. */
function mapFilmItem(block) {
  const linkTag = block.match(/<a\b[^>]*>/);
  if (!linkTag || !/film-poster-ahref/.test(linkTag[0])) return null;
  const hrefMatch = linkTag[0].match(/href="([^"]+)"/);
  if (!hrefMatch) return null;
  const rel = relPathOf(hrefMatch[1]);
  const mediaType = mediaTypeOfRel(rel);
  if (!mediaType) return null;

  const nameMatch = block.match(/<h3 class="film-name"><a[^>]*title="([^"]*)"/);
  const linkTitle = linkTag[0].match(/title="([^"]*)"/);
  // Card poster img tags put src before class: <img src="…" class="film-poster-img …">.
  const promoTag = block.match(/<img\b[^>]*>/);
  let poster = null;
  if (promoTag && /film-poster-img/.test(promoTag[0])) {
    const src = promoTag[0].match(/src="([^"]+)"/);
    if (src && !/^data:|loading/.test(src[1])) {
      poster = src[1];
    } else {
      const dataSrc = promoTag[0].match(/data-src="([^"]+)"/);
      poster = dataSrc ? dataSrc[1] : null;
    }
  }
  const inforMatch = block.match(/<div class="film-infor">([\s\S]*?)<\/div>/);
  const infor = inforMatch ? inforMatch[1] : '';
  const year = (infor.match(/\b(19|20)\d{2}\b/) || [])[0] || null;
  const releaseYear = year ? parseInt(year, 10) : null;
  const title = nameMatch ? nameMatch[1] : linkTitle ? linkTitle[1] : rel;

  const quality = (infor.match(/class="fi-ql">([^<]+)</) || [])[1] || null;
  const ss = seasonCountOf(infor);
  const eps = episodeCountOf(infor);
  const bottomText =
    mediaType === 'tv'
      ? [ss ? `SS ${ss}` : null, eps ? `EPS ${eps}` : null]
          .filter(Boolean)
          .join('  ')
      : releaseYear
        ? `${releaseYear}`
        : null;
  const stacked = {};
  if (quality) stacked.topLeft = { text: quality };
  if (bottomText) stacked.bottomLeft = { text: bottomText };

  return {
    id: rel.split('/')[1] ?? rel,
    title,
    name: title,
    media_type: mediaType,
    poster_url: poster,
    backdrop_url: poster,
    overview: '',
    release_date: releaseYear ? `${releaseYear}-01-01` : null,
    release_year: releaseYear,
    quality,
    season_count: ss,
    episode_count: eps,
    endpoint: mediaType === 'tv' ? '/tv-series/' : '/movies/',
    card_style: { orientation: 'portrait', stacked },
  };
}

/** All `.flw-item` cards inside a html slice. */
function mapFilmItems(html) {
  const items = [];
  const re = /<div class="flw-item">([\s\S]*?)<div class="clearfix"><\/div>\s*<\/div>/g;
  let m;
  while ((m = re.exec(html))) {
    const item = mapFilmItem(m[1]);
    if (item) items.push(item);
  }
  return items;
}

/**
 * "You may also like" section on watch pages: everything between the heading
 * and the comments section that follows it, i.e. one `.film_list-wrap` of
 * `.flw-item` cards. Some items have an empty related block (no recs).
 */
function parseRecommendations(html) {
  const marker = 'You may also like';
  const idx = html.indexOf(marker);
  if (idx === -1) return [];
  const tail = html.slice(idx);
  let end = tail.indexOf('id="film_comments"');
  if (end === -1) end = tail.length;
  const wrap = tail.indexOf('<div class="film_list-wrap">');
  if (wrap === -1 || wrap > end) return [];
  return mapFilmItems(tail.slice(wrap, end));
}

/** Last page number from a category pagination nav (for hasMore). */
function lastPageFrom(html) {
  const pages = [];
  const re = /href="[^"]*\/page\/(\d+)\//g;
  let m;
  while ((m = re.exec(html))) pages.push(parseInt(m[1], 10));
  return pages.length ? Math.max(...pages) : 1;
}

function envelope(results, page, total) {
  const hasMore = page < total;
  return {
    page,
    hasMore,
    total_pages: Math.max(1, total),
    total_results: results.length,
    results,
  };
}

// ---------------------------------------------------------------------------
// Home
// ---------------------------------------------------------------------------

/**
 * Rows from /home/: Trending Movies + Trending TV Shows (± tabs) and the
 * Latest Movies / Latest TV Shows blocks; each row maps to its /movies/ or
 * /tv-series/ category for "See All".
 */
export async function getHomeContent(page = 1) {
  if (page !== 1) {
    return { results: [], hasMore: false, page, total_pages: 1, total_results: 0 };
  }

  const res = await fetchPage(`${BASE}/home/`);
  const html = typeof res?.data === 'string' ? res.data : '';
  const rows = [];

  const sectionRe = /<section[^>]*class="block_area[^"]*block_area_home[^"]*"[^>]*>([\s\S]*?)<\/section>/g;
  let sec;
  while ((sec = sectionRe.exec(html))) {
    const body = sec[1];

    // Trending tabs live in one section; separate the two panes if present.
    const moviesIdx = body.indexOf('id="trending-movies"');
    const tvIdx = body.indexOf('id="trending-tv"');
    if (moviesIdx !== -1 || tvIdx !== -1) {
      const moviesSlice =
        moviesIdx !== -1
          ? body.slice(moviesIdx, tvIdx > moviesIdx ? tvIdx : body.length)
          : '';
      const tvSlice =
        tvIdx !== -1
          ? body.slice(tvIdx, moviesIdx > tvIdx ? moviesIdx : body.length)
          : '';
      const movies = mapFilmItems(moviesSlice);
      const tv = mapFilmItems(tvSlice);
      if (movies.length) {
        rows.push(rowOf('trending-movies', 'Trending Movies', '/movies/', movies));
      }
      if (tv.length) {
        rows.push(rowOf('trending-tv', 'Trending TV Shows', '/tv-series/', tv));
      }
      continue;
    }

    const headingMatch = body.match(
      /<h2[^>]*class="[^"]*cat-heading[^"]*"[^>]*>([^<]+)<\/h2>/
    );
    const title = headingMatch ? headingMatch[1].trim() : null;
    const scrambles = [];
    const viewRe = /class="float-right viewmore"[\s\S]{0,200}?href="([^"]+)"/g;
    let vm;
    while ((vm = viewRe.exec(body))) scrambles.push(vm[1]);
    const endpoint = scrambles[0] || null;
    const items = mapFilmItems(body);
    if (items.length && title) rows.push(rowOf(slugify(title), title, endpoint, items));
  }

  return {
    page: 1,
    hasMore: false,
    total_pages: 1,
    total_results: rows.length,
    results: rows,
  };
}

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

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// ---------------------------------------------------------------------------
// Category pages (media items)
// ---------------------------------------------------------------------------

export async function getMediaItems(endpoint = '/movies/', page = 1) {
  const ep = String(endpoint || '/movies/');
  if (ep.startsWith('search:')) {
    return search(ep.slice('search:'.length), page);
  }

  const trimmed = ep.replace(/\/+$/, '') || '/movies/';
  const pageUrl =
    page > 1
      ? `${BASE}${trimmed}/page/${page}/`
      : `${BASE}${trimmed}/`;

  const res = await fetchPage(pageUrl);
  const html = typeof res?.data === 'string' ? res.data : '';
  const results = mapFilmItems(html);
  const last = lastPageFrom(html);

  return {
    results,
    hasMore: page < last,
    page,
    total_pages: Math.max(1, last),
    total_results: results.length,
    endpoint: ep,
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export async function search(query, page = 1) {
  const q = String(query ?? '').trim();
  if (q.length < 2) {
    return { results: [], hasMore: false, page: 1, total_pages: 0, total_results: 0 };
  }
  const pageUrl =
    page > 1
      ? `${BASE}/search/page/${page}/?keyword=${encodeURIComponent(q)}`
      : `${BASE}/search?keyword=${encodeURIComponent(q)}`;

  const res = await fetchPage(pageUrl, `${BASE}/`);
  const html = typeof res?.data === 'string' ? res.data : '';
  const results = mapFilmItems(html);
  const last = lastPageFrom(html);

  return {
    results,
    hasMore: page < last,
    page,
    total_pages: Math.max(0, last),
    total_results: results.length,
    endpoint: `search:${q}`,
  };
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

/**
 * id is the bare card slug ('verity-63558' / 'breaking-bear-75080') that the
 * app passes through its /details/:id/:type route; mediaType ('movie'|'tv')
 * tells us which site section the id belongs to.
 */
export async function getDetails(id, mediaType, prioritySeason) {
  const rel = relFor(id, mediaType);
  const baseRel = rel.split('/').slice(0, 2).join('/'); // keep movie/x or series/x
  const type = mediaTypeOfRel(baseRel);
  const slug = rel.split('/')[1];
  if (!type || !slug) {
    console.warn('TinyZone: unknown detail path', rel);
    return null;
  }

  const url = `${BASE}/${type === 'tv' ? 'series' : 'movie'}/${slug}/`;
  const res = await fetchPage(url);
  const html = typeof res?.data === 'string' ? res.data : '';

  const heading = html.match(/<h2 class="heading-name">\s*<a[^>]*>([^<]*)</) || [];
  const title = (heading[1] || '').trim() || slug.replace(/-/g, ' ');

  const posterMatch = html.match(
    /<div class="dp-i-c-poster">[\s\S]*?<img[^>]*src="([^"]+)"/
  );
  const poster = posterMatch
    ? posterMatch[1].replace('/w185/', '/w342/')
    : null;

  const desc = html.match(/<div class="description">([\s\S]*?)<\/div>/) || [];
  const overview = (desc[1] || '').replace(/<[^>]+>/g, '').trim();

  const imdb = html.match(/<button[^>]*class="btn btn-sm btn-warning">\s*IMDB:\s*([\d.]+)/);
  const voteAverage = imdb ? parseFloat(imdb[1]) : null;

  const quality = html.match(/<button[^>]*class="btn btn-sm btn-quality">\s*<strong>([^<]+)</) || [];
  const released = html.match(/<strong>Released:\s*<\/strong>\s*<\/span>\s*([^<]+)</) || [];
  const releaseDate = (released[1] || '').trim();
  const releaseYear = releaseDate ? parseInt(releaseDate.slice(0, 4), 10) : null;

  const genreHrefs = html.match(/<span class="type"><strong>Genre:\s*<\/strong>\s*<\/span>([\s\S]*?)<\/div>/) || [];
  const genres = [];
  const genreRe = /<a[^>]*href="\/genre\/([^"]+)"[^>]*title="([^"]+)"/g;
  let gm;
  const genreBody = genreHrefs[1] || '';
  while ((gm = genreRe.exec(genreBody))) {
    genres.push({
      id: gm[1],
      name: gm[2],
      type: 'genre',
      title: gm[2],
      endpoint: `/genre/${gm[1]}`,
    });
  }

  const castHrefs = html.match(/<span class="type"><strong>Casts:\s*<\/strong>\s*<\/span>([\s\S]*?)<\/div>/) || [];
  const cast = [];
  const castRe = /<a[^>]*href="\/actor\/([^"]+)"[^>]*title="([^"]+)"/g;
  let cm;
  const castBody = castHrefs[1] || '';
  let order = 0;
  while ((cm = castRe.exec(castBody))) {
    cast.push({ id: cm[1], name: cm[2], character: null, order: order++, profile_url: null });
  }

  const details = {
    id: slug,
    media_type: type,
    title,
    name: title,
    overview,
    poster_url: poster,
    backdrop_url: poster,
    release_date: releaseDate || null,
    release_year: releaseYear,
    vote_average: voteAverage,
    genres,
    cast,
    status: quality[1] || null,
    endpoint: type === 'tv' ? '/tv-series/' : '/movies/',
    tv_series: type === 'tv',
  };

  if (type === 'tv') {
    details.seasons = parseSeasons(html, slug);
    details.number_of_seasons = details.seasons.length;
  }

  const recs = parseRecommendations(html);
  if (recs.length) {
    details.recommendations = [
      {
        id: 'recommendations',
        title: 'You may also like',
        endpoint: null,
        card_style: { orientation: 'portrait' },
        results: recs,
        hasMore: false,
        page: 1,
        total_pages: 1,
        total_results: recs.length,
      },
    ];
  }

  return details;
}

/** Season list from the series watch page's `.ss-item` dropdown. */
function parseSeasons(html, slug) {
  const seasons = [];
  const re = /<a[^>]*data-ss="(\d+)"[^>]*data-id="[^"]+"[^>]*class="[^"]*ss-item[^"]*"[^>]*>\s*Season\s*(\d+)/g;
  let m;
  while ((m = re.exec(html))) {
    const n = parseInt(m[1], 10);
    seasons.push({
      id: slug,
      name: `Season ${n}`,
      season_number: n,
      seasonNumber: n,
      episode_count: 0,
    });
  }
  return seasons;
}

// ---------------------------------------------------------------------------
// Season episodes
// ---------------------------------------------------------------------------

/**
 * getSeasonEpisodes(mediaId, seasonNumber) — the app passes the show id and
 * the season to fetch. The option list for the requested season comes from
 *   GET /ajax/ajax.php?episode=<season token>
 * with the season token scraped from the series page.
 */
export async function getSeasonEpisodes(mediaId, seasonNumber) {
  const rel = relFor(mediaId, 'tv');
  const want = parseInt(seasonNumber, 10) || 1;
  const slug = rel.split('/')[1];
  if (!slug) return [];

  const seriesUrl = `${BASE}/series/${slug}/`;
  const res = await fetchPage(seriesUrl);
  const html = typeof res?.data === 'string' ? res.data : '';

  // data-ss="N" data-id="<token>" pairs on the season dropdown.
  const tokenRe = new RegExp(
    '<a[^>]*data-ss="' + want + '"[^>]*data-id="([^"]+)"'
  );
  const tokenMatch = html.match(tokenRe);
  const token = tokenMatch ? tokenMatch[1] : null;
  if (!token) {
    console.warn(`TinyZone: no season ${want} token on ${seriesUrl}`);
    return [];
  }

  const epsRes = await fetchPage(
    `${BASE}/ajax/ajax.php?episode=${encodeURIComponent(token)}`,
    seriesUrl
  );
  const epsHtml = typeof epsRes?.data === 'string' ? epsRes.data : '';

  const episodes = [];
  const epRe = /<a[^>]*class="[^"]*eps-item[^"]*"[^>]*href="([^"]+)"[^>]*title="([^"]*)"[^>]*>[\s\S]*?<strong>\s*Eps\s+(\d+)\s*:/g;
  let m;
  while ((m = epRe.exec(epsHtml))) {
    const eRel = relPathOf(m[1]);
    const epNumber = parseInt(m[3], 10);
    episodes.push({
      id: eRel,
      episode_number: epNumber,
      episodeNumber: epNumber,
      season_number: want,
      seasonNumber: want,
      name: m[2] || `Episode ${epNumber}`,
      overview: '',
    });
  }

  // NOTE: returns a BARE ARRAY — the details screen's datasource requires
  // `result is List` (a {episodes: [...]} map is silently discarded there),
  // while the player's parser accepts either shape.
  return episodes;
}

// ---------------------------------------------------------------------------
// Streams — lazy server expansion via Open Extractors
// ---------------------------------------------------------------------------

/**
 * Server stubs for the item. The watch page (or episode page for TV) embeds a
 * `const pl_url` session token whose ajax response lists the servers
 * (UpCloud / Vidmoly / Videasy). Only servers with an implemented extractor
 * are advertised; they stay lazy (no `sources`) and expand per server.
 */
export async function getStreams(metadata) {
  const servers = await serversFor(metadata);
  const mapped = servers.filter((s) => SERVER_META[s.id]);
  if (mapped.length === 0) {
    console.warn('TinyZone: no supported servers for', metadata?.id);
    return { providers: [] };
  }
  return {
    providers: [
      {
        id: 'com.tinyzone',
        name: 'TinyZone',
        logo: null,
        reliable: mapped.length > 0,
        servers: mapped.map((s) => ({
          id: s.id,
          name: SERVER_META[s.id].label,
        })),
      },
    ],
  };
}

export async function getStreamSources(metadata, providerId, serverId) {
  const key = String(serverId ?? '').toLowerCase();
  const meta = SERVER_META[key];
  if (!meta) return { sources: [], subtitles: [] };

  const servers = await serversFor(metadata);
  const embed = servers.find((s) => s.id === key);
  if (!embed || !embed.url) {
    console.warn(`TinyZone: no embed for server ${key}`);
    return { sources: [], subtitles: [] };
  }

  if (!(await isExtractorReady(meta.extractor))) return { sources: [], subtitles: [] };

  let server;
  try {
    server = await pluginManager.call('open-extractors', meta.extractor, [
      { url: embed.url, name: meta.label, id: key },
    ]);
  } catch (e) {
    console.error(`TinyZone: ${meta.extractor} failed:`, e?.message ?? e);
    return { sources: [], subtitles: [] };
  }

  if (!Array.isArray(server?.sources) || server.sources.length === 0) {
    console.warn(`TinyZone: no playable stream for ${meta.label}`);
    return { sources: [], subtitles: [] };
  }

  return {
    sources: server.sources,
    subtitles: Array.isArray(server.subtitles) ? server.subtitles : [],
  };
}

/**
 * Resolves the server list for the metadata's item: movie → watch page;
 * tv → episode page /series/<slug>-<id>/<s>-<e>/.
 */
async function serversFor(metadata) {
  const rel = relFor(metadata?.id, metadata?.media_type);
  const type = mediaTypeOfRel(rel);
  if (!type) {
    console.warn('TinyZone: cannot resolve servers for', metadata?.id, metadata?.media_type);
    return [];
  }

  let watchRel = rel;
  if (type === 'tv' && rel.split('/').length === 2) {
    const season = metadata?.season ?? metadata?.season_number ?? 1;
    const episode = metadata?.episode ?? metadata?.episode_number ?? 1;
    watchRel = `${rel}/${season}-${episode}`;
  }

  const watchUrl = `${BASE}/${watchRel}/`;
  const res = await fetchPage(watchUrl);
  const html = typeof res?.data === 'string' ? res.data : '';
  const pl = html.match(/const pl_url = '([^']+)';/);
  if (!pl) {
    console.warn(`TinyZone: no pl_url on ${watchUrl}`);
    return [];
  }

  const listRes = await fetchPage(pl[1], watchUrl);
  const listHtml = typeof listRes?.data === 'string' ? listRes.data : '';
  return parseServerList(listHtml);
}

/** Map an episode/server/providers html's `.sv-item` anchors → servers. */
function parseServerList(html) {
  const servers = [];
  const re = /<a[^>]*class="[^"]*sv-item[^"]*"[^>]*data-srv="([^"]+)"[^>]*data-id="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const rawName = String(m[1] || '').toLowerCase();
    const id = rawName.includes('upcloud')
      ? 'upcloud'
      : rawName.includes('vidmoly')
        ? 'vidmoly'
        : null;
    if (id && m[2]) servers.push({ id, url: m[2] });
  }
  return servers.sort((a, b) => serverRank(a.id) - serverRank(b.id));
}

/** Sort rank for a server id; unknown servers sort last. */
function serverRank(id) {
  const i = SERVER_ORDER.indexOf(id);
  return i === -1 ? SERVER_ORDER.length : i;
}

async function isExtractorReady(method) {
  try {
    const okay = await pluginManager.isInstalled('open-extractors');
    if (okay) return true;
    console.warn('TinyZone: Open Extractors plugin not installed');
    return false;
  } catch (e) {
    console.warn('TinyZone: pluginManager.isInstalled failed:', e?.message ?? e);
    return false;
  }
}