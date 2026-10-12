// ============================================================================
// Wlext Plugin (metadata) — movies & TV series
// ============================================================================
// Metadata-only provider for https://wlext.is, a WordPress site exposing a
// REST API at /wp-json/wp/v2 with three relevant post types:
//   movies, series, novelasenespanol
// and the taxonomies genre, country, language, actor, release_year, subtitle.
//
// Responses are trimmed with `_fields` (the full single-post payload includes
// a ~300KB `yoast_head` block), posters are resolved in bulk through the
// `media` collection, and term ids are resolved to names via the taxonomy
// collections. Cards are keyed by slug; `media_type` disambiguates the route.
//
// Streams/servers (HYDRA and friends) are intentionally not implemented yet.
// ============================================================================

const BASE = 'https://wlext.is';
const REST = `${BASE}/wp-json/wp/v2`;

// The site forces 20 items per page for the custom post types regardless of
// the requested `per_page`; X-WP-TotalPages is authoritative for hasMore.
const PAGE_SIZE = 20;

const FIELDS =
  'id,slug,date,title,excerpt,featured_media,genre,country,actor,language,subtitle,release_year,type,link';

const CACHE_TTL_MS = 5 * 60 * 1000;

// In-session caches (per plugin instance). Home/category rows resolve the same
// terms, posters and pages repeatedly, so caching keeps request counts low.
const jsonCache = new Map(); // url -> { value, at }
const htmlCache = new Map(); // url -> { value, at }
const termCache = {}; // taxonomy -> Map(id -> { id, name, slug })
const posterCache = new Map(); // media id -> url | null

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

async function fetchJson(url, referer) {
  const hit = jsonCache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const headers = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (referer) headers.Referer = referer;

  let lastError;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await http.get(url, { headers });
      const status = res?.status ?? 0;
      if (status >= 200 && status < 300) {
        let data = res.data;
        if (typeof data === 'string') {
          try {
            data = JSON.parse(data);
          } catch (_) {
            data = null;
          }
        }
        const totalPages = parseInt(headerOf(res.headers, 'x-wp-totalpages'), 10) || 0;
        const value = { data, totalPages };
        jsonCache.set(url, { value, at: Date.now() });
        return value;
      }
      // 400 (e.g. page out of range) / 404 won't improve on retry.
      if (status >= 400 && status < 500 && status !== 403 && status !== 429) {
        return { data: null, totalPages: 0 };
      }
      lastError = new Error(`HTTP ${status}`);
    } catch (e) {
      lastError = e;
    }
    await delay((i + 1) * 600);
  }
  console.error(`Wlext: request failed for ${url}:`, lastError?.message ?? lastError);
  return { data: null, totalPages: 0 };
}

async function fetchText(url, referer) {
  const hit = htmlCache.get(url);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const headers = {
    Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
  if (referer) headers.Referer = referer;

  let lastError;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await http.get(url, { headers });
      const status = res?.status ?? 0;
      if (status >= 200 && status < 300) {
        const value = { data: typeof res.data === 'string' ? res.data : '', url: res.url || url };
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
    await delay((i + 1) * 600);
  }
  console.error(`Wlext: page fetch failed for ${url}:`, lastError?.message ?? lastError);
  return { data: '', url };
}

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------

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

function fromCodePoint(code) {
  try {
    return String.fromCodePoint(code);
  } catch (_) {
    return '';
  }
}

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

function stripHtml(html) {
  if (!html) return '';
  return decodeEntities(String(html).replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// term / poster resolution
// ---------------------------------------------------------------------------

function termsOf(taxonomy) {
  if (!termCache[taxonomy]) termCache[taxonomy] = new Map();
  return termCache[taxonomy];
}

function normaliseTerm(term) {
  return { id: term.id, name: decodeEntities(term.name), slug: term.slug };
}

/** Bulk-resolve taxonomy term ids → { id, name, slug }. */
async function resolveTerms(taxonomy, ids) {
  const wanted = [
    ...new Set((ids || []).filter((id) => id != null)),
  ].filter((id) => !termsOf(taxonomy).has(id));
  if (wanted.length === 0) return termsOf(taxonomy);

  for (let i = 0; i < wanted.length; i += 100) {
    const chunk = wanted.slice(i, i + 100);
    const url = `${REST}/${taxonomy}?include=${chunk.join(',')}&per_page=100&_fields=id,name,slug`;
    const res = await fetchJson(url, `${BASE}/`);
    const arr = Array.isArray(res.data) ? res.data : [];
    for (const term of arr) termsOf(taxonomy).set(term.id, normaliseTerm(term));
    for (const id of chunk) if (!termsOf(taxonomy).has(id)) termsOf(taxonomy).set(id, null);
  }
  return termsOf(taxonomy);
}

/** Resolve a single taxonomy term by slug (cached). */
async function resolveTermBySlug(taxonomy, slug) {
  const cache = termsOf(taxonomy);
  for (const term of cache.values()) if (term && term.slug === slug) return term;
  const res = await fetchJson(
    `${REST}/${taxonomy}?slug=${encodeURIComponent(slug)}&_fields=id,name,slug`,
    `${BASE}/`
  );
  const term = Array.isArray(res.data) ? res.data[0] : null;
  if (!term) return null;
  const normalised = normaliseTerm(term);
  cache.set(normalised.id, normalised);
  return normalised;
}

/** Bulk-resolve featured media ids → source_url. */
async function resolvePosters(posts) {
  const wanted = [
    ...new Set(posts.map((p) => p.featured_media).filter(Boolean)),
  ].filter((id) => !posterCache.has(id));

  for (let i = 0; i < wanted.length; i += 100) {
    const chunk = wanted.slice(i, i + 100);
    const url = `${REST}/media?include=${chunk.join(',')}&per_page=100&_fields=id,source_url`;
    const res = await fetchJson(url, `${BASE}/`);
    const arr = Array.isArray(res.data) ? res.data : [];
    for (const media of arr) posterCache.set(media.id, media.source_url || null);
    for (const id of chunk) if (!posterCache.has(id)) posterCache.set(id, null);
  }
}

/** Real release year, preferring the release_year taxonomy over the post date. */
function yearOfPost(post) {
  const ids = Array.isArray(post.release_year) ? post.release_year : [];
  for (const id of ids) {
    const term = termsOf('release_year').get(id);
    if (term && /^\d{4}$/.test(term.name)) return parseInt(term.name, 10);
  }
  const year = post.date ? parseInt(String(post.date).slice(0, 4), 10) : NaN;
  return Number.isFinite(year) ? year : null;
}

// ---------------------------------------------------------------------------
// card mapping
// ---------------------------------------------------------------------------

function cardOf(post, mediaType) {
  const title = decodeEntities(post.title?.rendered || post.slug);
  const year = yearOfPost(post);
  const poster = posterCache.get(post.featured_media) || null;
  return {
    id: post.slug,
    title,
    name: title,
    media_type: mediaType,
    poster_url: poster,
    backdrop_url: poster,
    overview: stripHtml(post.excerpt?.rendered),
    release_date: year ? `${year}-01-01` : post.date ? String(post.date).slice(0, 10) : null,
    release_year: year,
    endpoint: mediaType === 'tv' ? 'series' : 'movies',
    card_style: {
      orientation: 'portrait',
      stacked: {
        topRight: { text: mediaType === 'tv' ? 'TV' : 'Movie' },
        bottomLeft: year ? { text: String(year) } : null,
      },
    },
  };
}

/** Resolve posters/years then map a homogeneous list of posts to cards. */
async function buildCards(posts, mediaType) {
  if (!posts.length) return [];
  await Promise.all([resolvePosters(posts), resolveYears(posts)]);
  return posts.map((post) => cardOf(post, mediaType));
}

/** Same, for lists mixing movies and series (entries: { post, mediaType }). */
async function buildMixedCards(entries) {
  if (!entries.length) return [];
  const posts = entries.map((entry) => entry.post);
  await Promise.all([resolvePosters(posts), resolveYears(posts)]);
  return entries.map((entry) => cardOf(entry.post, entry.mediaType));
}

async function resolveYears(posts) {
  const ids = [];
  for (const post of posts) {
    if (Array.isArray(post.release_year)) ids.push(...post.release_year);
  }
  if (ids.length) await resolveTerms('release_year', ids);
}

// ---------------------------------------------------------------------------
// REST collection queries
// ---------------------------------------------------------------------------

const FILTER_KEYS = {
  genre: 'genre',
  country: 'country',
  language: 'language',
  actor: 'actor',
};

async function queryCollection(postType, opts = {}) {
  const page = parseInt(opts.page, 10) || 1;
  const params = [`per_page=${PAGE_SIZE}`, `page=${page}`, 'orderby=date', 'order=desc'];
  if (opts.search) params.push(`search=${encodeURIComponent(opts.search)}`);
  for (const key of ['genre', 'country', 'language', 'actor', 'release_year']) {
    if (opts[key] != null) params.push(`${key}=${encodeURIComponent(opts[key])}`);
  }
  params.push(`_fields=${FIELDS}`);

  const res = await fetchJson(`${REST}/${postType}?${params.join('&')}`, `${BASE}/`);
  const posts = Array.isArray(res.data) ? res.data : [];
  return { posts, totalPages: res.totalPages || 0 };
}

function envelope(results, page, totalPages, endpoint) {
  return {
    results,
    page,
    hasMore: totalPages ? page < totalPages : results.length >= PAGE_SIZE,
    total_pages: Math.max(1, totalPages || page),
    total_results: results.length,
    endpoint,
  };
}

// ---------------------------------------------------------------------------
// Home content
// ---------------------------------------------------------------------------

const GENRE_ROWS = ['action', 'drama', 'comedy', 'romance', 'thriller'];

export async function getHomeContent(page = 1) {
  if (Number(page) !== 1) {
    return { results: [], page, hasMore: false, total_pages: 1, total_results: 0 };
  }

  const latest = await Promise.all([
    rowFromCollection('latest-movies', 'Latest Movies', 'movies', 'movie'),
    rowFromCollection('latest-series', 'Latest TV Shows', 'series', 'tv'),
  ]);

  const genreRows = await Promise.all(
    GENRE_ROWS.map((slug) => rowFromGenre(slug))
  );

  const rows = [...latest, ...genreRows].filter((row) => row.results.length);
  return {
    page: 1,
    hasMore: false,
    total_pages: 1,
    total_results: rows.length,
    results: rows,
  };
}

async function rowFromCollection(id, title, postType, mediaType) {
  const { posts } = await queryCollection(postType, { page: 1 });
  const results = await buildCards(posts, mediaType);
  return rowOf(id, title, mediaType === 'tv' ? 'series' : 'movies', results);
}

async function rowFromGenre(slug) {
  const id = `genre-${slug}`;
  const term = await resolveTermBySlug('genre', slug);
  if (!term) return rowOf(id, titleCase(slug), `genre/${slug}`, []);
  const [movies, series] = await Promise.all([
    queryCollection('movies', { page: 1, genre: term.id }),
    queryCollection('series', { page: 1, genre: term.id }),
  ]);
  const entries = mergeEntries(movies.posts, series.posts);
  const results = await buildMixedCards(entries);
  return rowOf(id, term.name, `genre/${slug}`, results);
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

function titleCase(slug) {
  return String(slug)
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

// ---------------------------------------------------------------------------
// Media items (categories / "see all")
// ---------------------------------------------------------------------------

export async function getMediaItems(endpoint = 'movies', page = 1) {
  const ep = String(endpoint || 'movies').replace(/^\/+|\/+$/g, '') || 'movies';
  const wantPage = parseInt(page, 10) || 1;

  if (ep.startsWith('search:')) return search(ep.slice('search:'.length), wantPage);

  if (ep === 'movies' || ep === 'latest-movies') {
    const { posts, totalPages } = await queryCollection('movies', { page: wantPage });
    return envelope(await buildCards(posts, 'movie'), wantPage, totalPages, 'movies');
  }
  if (ep === 'series' || ep === 'latest-series' || ep === 'tv') {
    const { posts, totalPages } = await queryCollection('series', { page: wantPage });
    return envelope(await buildCards(posts, 'tv'), wantPage, totalPages, 'series');
  }
  if (ep === 'novelas') {
    const { posts, totalPages } = await queryCollection('novelasenespanol', { page: wantPage });
    return envelope(await buildCards(posts, 'tv'), wantPage, totalPages, 'novelas');
  }

  const slash = ep.indexOf('/');
  if (slash > 0) {
    const taxonomy = ep.slice(0, slash);
    const slug = ep.slice(slash + 1);
    if (FILTER_KEYS[taxonomy]) return taxonomyPage(taxonomy, slug, wantPage);
  }

  const { posts, totalPages } = await queryCollection('movies', { page: wantPage });
  return envelope(await buildCards(posts, 'movie'), wantPage, totalPages, 'movies');
}

async function taxonomyPage(taxonomy, slug, page) {
  const endpoint = `${taxonomy}/${slug}`;
  const term = await resolveTermBySlug(taxonomy, slug);
  if (!term) return envelope([], page, 0, endpoint);

  const filter = { [FILTER_KEYS[taxonomy]]: term.id };
  const [movies, series] = await Promise.all([
    queryCollection('movies', { page, ...filter }),
    queryCollection('series', { page, ...filter }),
  ]);
  const entries = mergeEntries(movies.posts, series.posts);
  const results = await buildMixedCards(entries);
  const totalPages = Math.max(movies.totalPages || 0, series.totalPages || 0);
  return envelope(results, page, totalPages, endpoint);
}

/** Interleave movie + series posts newest-first (falls back to source order). */
function mergeEntries(moviePosts, seriesPosts) {
  const entries = [
    ...moviePosts.map((post) => ({ post, mediaType: 'movie' })),
    ...seriesPosts.map((post) => ({ post, mediaType: 'tv' })),
  ];
  return entries.sort((a, b) =>
    String(b.post.date || '').localeCompare(String(a.post.date || ''))
  );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export async function search(query, page = 1) {
  const q = String(query ?? '').trim();
  const wantPage = parseInt(page, 10) || 1;
  if (q.length < 2) {
    return { results: [], page: 1, hasMore: false, total_pages: 0, total_results: 0, endpoint: `search:${q}` };
  }

  const [movies, series] = await Promise.all([
    queryCollection('movies', { page: wantPage, search: q }),
    queryCollection('series', { page: wantPage, search: q }),
  ]);
  const entries = mergeEntries(movies.posts, series.posts);
  const results = await buildMixedCards(entries);
  const totalPages = Math.max(movies.totalPages || 0, series.totalPages || 0);
  return envelope(results, wantPage, totalPages, `search:${q}`);
}

// ---------------------------------------------------------------------------
// Details
// ---------------------------------------------------------------------------

export async function getDetails(id, mediaType, prioritySeason) {
  const mt = mediaType === 'tv' || mediaType === 'series' ? 'tv' : 'movie';
  const postType = mt === 'tv' ? 'series' : 'movies';
  const slug = String(id ?? '').replace(/^\/+|\/+$/g, '').split('/').pop();
  if (!slug) return null;

  const res = await fetchJson(
    `${REST}/${postType}?slug=${encodeURIComponent(slug)}&_fields=${FIELDS}`,
    `${BASE}/`
  );
  const post = Array.isArray(res.data) ? res.data[0] : null;
  if (!post) return null;

  await Promise.all([
    resolvePosters([post]),
    resolveYears([post]),
    resolveTerms('genre', post.genre || []),
    resolveTerms('country', post.country || []),
    resolveTerms('language', post.language || []),
    resolveTerms('actor', post.actor || []),
  ]);

  const title = decodeEntities(post.title?.rendered || post.slug);
  const year = yearOfPost(post);
  const poster = posterCache.get(post.featured_media) || null;

  const genres = (post.genre || [])
    .map((gid) => termsOf('genre').get(gid))
    .filter(Boolean)
    .map((term) => ({
      id: term.slug,
      name: term.name,
      title: term.name,
      type: 'genre',
      endpoint: `genre/${term.slug}`,
    }));

  const cast = (post.actor || [])
    .map((aid, order) => {
      const term = termsOf('actor').get(aid);
      return term ? { id: term.slug, name: term.name, character: null, order, profile_url: null } : null;
    })
    .filter(Boolean);

  const countries = (post.country || [])
    .map((cid) => termsOf('country').get(cid))
    .filter(Boolean)
    .map((term) => term.name);

  const languages = (post.language || [])
    .map((lid) => termsOf('language').get(lid))
    .filter(Boolean)
    .map((term) => term.name);

  const details = {
    id: post.slug,
    media_type: mt,
    title,
    name: title,
    overview: stripHtml(post.excerpt?.rendered),
    poster_url: poster,
    backdrop_url: poster,
    release_date: year ? `${year}-01-01` : post.date ? String(post.date).slice(0, 10) : null,
    release_year: year,
    genres,
    cast,
    countries,
    languages,
    endpoint: mt === 'tv' ? 'series' : 'movies',
    tv_series: mt === 'tv',
    link: post.link || `${BASE}/${mt === 'tv' ? 'series' : 'movies'}/${post.slug}/`,
  };

  if (mt === 'tv') {
    const season = seasonOf(post.title?.rendered, post.slug);
    const wantSeason = parseInt(prioritySeason, 10) || season;
    const { data: html } = await fetchText(`${BASE}/series/${post.slug}/`);
    const episodes = parseEpisodes(html, post.slug, wantSeason);
    details.seasons = [
      {
        id: post.slug,
        name: `Season ${season}`,
        season_number: season,
        seasonNumber: season,
        episode_count: episodes.length,
      },
    ];
    details.number_of_seasons = 1;
    if (wantSeason === season && episodes.length) details.episodes = episodes;
  }

  return details;
}

// ---------------------------------------------------------------------------
// Season episodes
// ---------------------------------------------------------------------------

export async function getSeasonEpisodes(mediaId, seasonNumber) {
  const slug = String(mediaId ?? '').replace(/^\/+|\/+$/g, '').split('/').pop();
  if (!slug) return [];
  const season = parseInt(seasonNumber, 10) || 1;
  const { data: html } = await fetchText(`${BASE}/series/${slug}/`);
  // NOTE: bare array — the details screen's datasource requires `result is List`.
  return parseEpisodes(html, slug, season);
}

/** Parse the series page's `<select id="loadepisode">` options. */
function parseEpisodes(html, slug, season) {
  const source = typeof html === 'string' ? html : '';
  const select = source.match(/<select[^>]*id="loadepisode"[^>]*>([\s\S]*?)<\/select>/i);
  const scope = select ? select[1] : source;
  const episodes = [];
  const re = /<option[^>]*value="episode=(\d+)"[^>]*>\s*([^<]*)</gi;
  let match;
  while ((match = re.exec(scope))) {
    const number = parseInt(match[1], 10);
    const label = (match[2] || '').trim() || `Episode ${number}`;
    episodes.push({
      id: `${slug}-s${season}e${number}`,
      episode_number: number,
      episodeNumber: number,
      season_number: season,
      seasonNumber: season,
      name: label,
      overview: '',
    });
  }
  return episodes;
}

/** Season number derived from the title ("… – Season 2") or slug; default 1. */
function seasonOf(title, slug) {
  const text = decodeEntities(title || '');
  const match =
    text.match(/season\s*(\d+)/i) || String(slug || '').match(/season[- _]?(\d+)/i);
  return match ? parseInt(match[1], 10) : 1;
}
