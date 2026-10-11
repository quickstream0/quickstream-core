// ============================================================================
// Streamed Sports Plugin for QuickStream — Phase 1: Catalog
// ============================================================================

const MIRRORS = ['https://streamed.pk', 'https://streamed.st'];
const IMAGE_BASE = 'https://www.quickstream.fyi/static/images/sports';

const CACHE_TTL_MS = 10 * 60 * 1000;
const PAGE_SIZE = 20;

let baseUrl = null;
let matchIndex = {};
let matchIndexUpdatedAt = 0;

const SPORT_ART = {
  'american-football': { label: 'American Football', art: `${IMAGE_BASE}/american-football.jpg` },
  'afl': { label: 'Australian Football League', art: `${IMAGE_BASE}/afl.jpg` },
  'baseball': { label: 'Baseball', art: `${IMAGE_BASE}/baseball.jpg` },
  'basketball': { label: 'Basketball', art: `${IMAGE_BASE}/basketball.jpg` },
  'billiards': { label: 'Billiards', art: `${IMAGE_BASE}/billiards.jpg` },
  'cricket': { label: 'Cricket', art: `${IMAGE_BASE}/cricket.jpg` },
  'darts': { label: 'Darts', art: `${IMAGE_BASE}/darts.jpg` },
  'fight': { label: 'Fight (UFC, Boxing)', art: `${IMAGE_BASE}/fight.jpg` },
  'football': { label: 'Football', art: `${IMAGE_BASE}/football.jpg` },
  'golf': { label: 'Golf', art: `${IMAGE_BASE}/golf.jpg` },
  'hockey': { label: 'Hockey', art: `${IMAGE_BASE}/hockey.jpg` },
  'motor-sports': { label: 'Motor Sports', art: `${IMAGE_BASE}/motor-sports.jpg` },
  'other': { label: 'More Sports', art: `${IMAGE_BASE}/other.jpg` },
  'rugby': { label: 'Rugby', art: `${IMAGE_BASE}/rugby.jpg` },
  'tennis': { label: 'Tennis', art: `${IMAGE_BASE}/tennis.jpg` },
  'olympics': { label: 'Olympics', art: `${IMAGE_BASE}/olympics.png` },
};

// ---------- http helpers ---------------------------------------------------

const MIRROR_LIST_URL = 'https://strmd.link/';

// Session-memoized list of mirrors scraped from the official mirror list page.
// Mirrors change rarely (weeks-months), so a plain session cache is plenty.
let discoveredMirrors = null;

async function fetchMirrorList() {
  if (discoveredMirrors) return discoveredMirrors;
  let html = '';
  try {
    const resp = await http.get(MIRROR_LIST_URL, {
      headers: { Accept: 'text/html' },
    });
    html = typeof resp?.data === 'string' ? resp.data : '';
  } catch (_) {}

  // https://streamed.pk | https://streamed.st | ... — anchor hrefs only
  // (status.strmd.link is excluded by the `https://streamed.` prefix).
  const seen = new Set();
  const mirrors = [];
  const re = /href="(https:\/\/streamed\.[a-z0-9.-]+)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const value = m[1];
    if (!seen.has(value)) {
      seen.add(value);
      mirrors.push(value);
    }
  }
  if (mirrors.length > 0) discoveredMirrors = mirrors;
  return mirrors;
}

async function probeMirror(m) {
  try {
    const r = await http.get(`${m}/api/matches/featured`, {
      responseType: 'json',
      headers: { Accept: 'application/json' },
    });
    return !!(r && r.data);
  } catch (_) {
    return false;
  }
}

async function pickBaseUrl() {
  if (baseUrl) return baseUrl;

  // The authoritative mirror list (https://strmd.link/) answers which mirrors
  // are live today, so candidates come from there instead of probing every
  // hardcoded mirror. Each candidate is still verified with one lightweight
  // probe before adoption — a listed mirror can linger offline for days
  // before it is removed. When the page is unreachable, fall back to the
  // hardcoded MIRRORS.
  const listed = await fetchMirrorList();
  const candidates = [...new Set([...listed, ...MIRRORS])];
  for (const candidate of candidates) {
    if (await probeMirror(candidate)) {
      baseUrl = candidate;
      return candidate;
    }
  }
  baseUrl = MIRRORS[0];
  return baseUrl;
}

async function getJson(path) {
  const host = await pickBaseUrl();
  const resp = await http.get(`${host}${path}`, {
    responseType: 'json',
    headers: { Accept: 'application/json' },
  });
  return resp?.data ?? [];
}

// ---------- match helpers --------------------------------------------------

function slugOf(match) {
  return String(match?.category || match?.sport || 'other');
}

function labelOf(match) {
  const slug = slugOf(match);
  return SPORT_ART[slug]?.label ?? slug.charAt(0).toUpperCase() + slug.slice(1);
}

function badgeOf(match, side) {
  return match?.teams?.[side]?.badge ?? match?.[side]?.badge ?? null;
}

function getMatchBadge(badgeHash) {
  if (!badgeHash) return null;
  const base = baseUrl || MIRRORS[0];
  return `${base}/api/images/badge/${badgeHash}.webp`;
}

// ---------- match index (10-minute TTL cache) --------------------------------
// Sports events change minute to minute, so the in-session match index is only
// trusted for CACHE_TTL_MS before it must be refreshed from the catalog. Any
// refetch rebuilds the index with the new data (the stale snapshot is replaced
// wholesale, never merged over).

function isIndexFresh() {
  return (
    matchIndexUpdatedAt > 0 &&
    Date.now() - matchIndexUpdatedAt < CACHE_TTL_MS
  );
}

function indexMatches(list) {
  for (const m of list || []) {
    if (m?.id) matchIndex[String(m.id)] = m;
  }
}

/** Pure lookup — callers that need live data must refreshMatchIndex() first. */
function resolveMatchById(want) {
  return matchIndex[String(want ?? '')] ?? null;
}

async function refreshMatchIndex() {
  try {
    const d = await getJson('/api/matches/all');
    const list = Array.isArray(d) ? d : (d?.matches ?? []);
    const rebuilt = {};
    for (const m of list) {
      if (m?.id) rebuilt[String(m.id)] = m;
    }
    if (Object.keys(rebuilt).length === 0) return;
    matchIndex = rebuilt;
    matchIndexUpdatedAt = Date.now();
  } catch (_) {
    // Mirrors may be down; the last snapshot stays available and the next
    // access retries the refresh.
  }
}

function matchPoster(match) {
  const id = String(match?.id ?? '');
  const poster = match?.poster;
  const homeBadge = badgeOf(match, 'home');
  const awayBadge = badgeOf(match, 'away');
  const base = baseUrl || MIRRORS[0];

  if (poster) {
    if (poster.startsWith('http')) return poster;
    return `${base}${poster}`;
  }
  if (homeBadge && awayBadge) {
    return `${base}/api/images/poster/${homeBadge}/${awayBadge}.webp`;
  }
  return `${base}/api/images/poster/${id}/fallback.webp`;
}

function teamsOf(match) {
  const t = match?.teams || {};
  const home = t?.home?.name || match?.home || null;
  const away = t?.away?.name || match?.away || null;
  return { home, away };
}

function titleOf(match) {
  if (match?.title) return match.title;
  const { home, away } = teamsOf(match);
  if (home && away) return `${home} vs ${away}`;
  return match?.id ? match.id.replace(/-/g, ' ') : 'Live Match';
}

function dateInfo(match) {
  const raw = match?.date;
  if (!raw) return { epoch: null, iso: null, year: null, label: null };
  let secs = Number(raw);
  if (secs > 1e12) secs = Math.floor(secs / 1000);
  const d = new Date(secs * 1000);
  if (isNaN(d.getTime())) return { epoch: null, iso: null, year: null, label: null };
  return {
    epoch: secs,
    iso: d.toISOString().split('T')[0],
    year: d.getUTCFullYear(),
    label: d.toUTCString(),
  };
}

function computeLiveStatus(match, endpoint) {
  if (endpoint && endpoint.includes('/live')) return { isLive: true, text: 'LIVE' };
  
  const date = dateInfo(match);
  if (!date.epoch) return { isLive: false, text: null };

  const startTimeMs = date.epoch * 1000;
  const nowMs = Date.now();
  const estimatedDurationMs = 120 * 60 * 1000;
  
  if (nowMs >= startTimeMs && nowMs <= startTimeMs + estimatedDurationMs) {
    return { isLive: true, text: 'LIVE' };
  }
  
  return { isLive: false, text: null };
}

function genresFor(match) {
  const slug = slugOf(match);
  const label = labelOf(match);
  return [
    {
      id: slug,
      name: label,
      type: 'sport',
      title: label,
      endpoint: `matches:${slug}`,
    },
  ];
}

function mapToMediaItem(match, endpoint = '') {
  const { home, away } = teamsOf(match);
  const date = dateInfo(match);
  const liveStatus = computeLiveStatus(match, endpoint);

  return {
    id: String(match?.id ?? ''),
    title: titleOf(match),
    name: titleOf(match),
    media_type: 'sport',
    poster_url: matchPoster(match),
    backdrop_url: matchPoster(match),
    overview: `${labelOf(match)} — ${titleOf(match)}.`,
    release_date: date.iso,
    release_year: date.year,
    genres: genresFor(match),
    endpoint: `match:${match?.id ?? ''}`,
    card_style: {
      stacked: {
        top_left: { 
          text: liveStatus.text,
          backgroundColor: liveStatus.isLive ? 'red' : null
        },
        bottom_right: { text: labelOf(match) },
      },
    },
  };
}

function mapToMediaItems(matches, endpoint = '') {
  // Index every real match as it is listed so a tapped card's details (and
  // later its streams) resolve from memory while the index is fresh.
  indexMatches(matches);
  return (matches || [])
    .filter((m) => m && (m.id || m.title))
    .map((m) => mapToMediaItem(m, endpoint))
    .filter(Boolean);
}

// ===========================================================================
// Home
// ===========================================================================

export async function getHomeContent(page = 1) {
  if (page !== 1) {
    return { results: [], hasMore: false, page, total_pages: 1, total_results: 0 };
  }

  const featuredData = await getJson('/api/matches/featured');
  const featured = Array.isArray(featuredData) ? featuredData : (featuredData?.matches ?? []);

  const popularLiveByCountData = await getJson('/api/matches/live/popular-viewcount');
  const popularLiveByCount = Array.isArray(popularLiveByCountData) ? popularLiveByCountData : (popularLiveByCountData?.matches ?? []);

  const popularLiveData = await getJson('/api/matches/live/popular');
  const popularLive = Array.isArray(popularLiveData) ? popularLiveData : (popularLiveData?.matches ?? []);

  // Dynamically extract categories available from all matches
  const allMatchesData = await getJson('/api/matches/all');
  const allMatches = Array.isArray(allMatchesData) ? allMatchesData : (allMatchesData?.matches ?? []);
  
  const activeSlugsSet = new Set();
  allMatches.forEach(m => {
    const s = slugOf(m);
    if (s) activeSlugsSet.add(s);
  });
  
  const dynamicSlugs = Array.from(activeSlugsSet);
  if (dynamicSlugs.length === 0) {
    dynamicSlugs.push(...Object.keys(SPORT_ART));
  }

  const sportTiles = dynamicSlugs.map((slug) => {
    const artObj = SPORT_ART[slug] || { label: slug.toUpperCase(), art: `${IMAGE_BASE}/other.jpg` };
    return {
      id: slug,
      title: artObj.label,
      name: artObj.label,
      media_type: 'sport',
      poster_url: artObj.art,
      backdrop_url: artObj.art,
      endpoint: `matches:${slug}`,
      card_style: {
        orientation: 'square',
        route: 'category',
      },
    };
  });

  const rows = [];
  
  // 1. Browse Sports Category Grid
  rows.push({
    id: 'sports-row',
    title: 'Browse Sports',
    endpoint: null,
    card_style: { orientation: 'square' },
    results: sportTiles,
    hasMore: false,
    page: 1,
    total_pages: 1,
    total_results: sportTiles.length,
  });

  // 2. Featured Matches Row
  if (featured.length > 0) {
    rows.push({
      id: 'featured',
      title: 'Featured Matches',
      endpoint: 'matches:featured',
      card_style: {
        orientation: 'landscape',
        banner: true,
      },
      results: mapToMediaItems(featured.slice(0, PAGE_SIZE), '/api/matches/featured'),
      hasMore: featured.length > PAGE_SIZE,
      page: 1,
      total_pages: Math.ceil(featured.length / PAGE_SIZE),
      total_results: featured.length,
    });
  }

  // 3. Popular Live By Viewers
  if (popularLiveByCount.length > 0) {
    rows.push({
      id: 'popular-live-viewcount',
      title: 'Popular Live (by viewers)',
      endpoint: 'matches:live',
      card_style: { orientation: 'landscape' },
      results: mapToMediaItems(popularLiveByCount.slice(0, PAGE_SIZE), '/api/matches/live/popular-viewcount'),
      hasMore: popularLiveByCount.length > PAGE_SIZE,
      page: 1,
      total_pages: Math.ceil(popularLiveByCount.length / PAGE_SIZE),
      total_results: popularLiveByCount.length,
    });
  }

  // 4. Popular Live
  if (popularLive.length > 0) {
    rows.push({
      id: 'popular-live',
      title: 'Popular Live',
      endpoint: 'matches:live',
      card_style: { orientation: 'landscape' },
      results: mapToMediaItems(popularLive.slice(0, PAGE_SIZE), '/api/matches/live/popular'),
      hasMore: popularLive.length > PAGE_SIZE,
      page: 1,
      total_pages: Math.ceil(popularLive.length / PAGE_SIZE),
      total_results: popularLive.length,
    });
  }

  // 5. Dynamic Individual Sport Rows (Football, Basketball, Tennis, etc.)[cite: 6]
  const sportRowData = await Promise.all(
    dynamicSlugs.map(async (slug) => {
      try {
        const d = await getJson(`/api/matches/${slug}`);
        const matches = Array.isArray(d) ? d : (d?.matches ?? []);
        return { slug, matches };
      } catch (_) {
        return { slug, matches: [] };
      }
    })
  );

  for (const { slug, matches } of sportRowData) {
    if (matches.length > 0) {
      const sportInfo = SPORT_ART[slug] || { label: slug.charAt(0).toUpperCase() + slug.slice(1) };
      rows.push({
        id: `row-${slug}`,
        title: sportInfo.label,
        endpoint: `matches:${slug}`,
        card_style: { orientation: 'landscape' },
        results: mapToMediaItems(matches.slice(0, PAGE_SIZE), `/api/matches/${slug}`),
        hasMore: matches.length > PAGE_SIZE,
        page: 1,
        total_pages: Math.ceil(matches.length / PAGE_SIZE),
        total_results: matches.length,
      });
    }
  }

  return {
    page: 1,
    hasMore: false,
    total_pages: 1,
    total_results: rows.length,
    results: rows,
  };
}

// ===========================================================================
// Media items (endpoint, page)
// ===========================================================================

export async function getMediaItems(endpoint = 'matches:all', page = 1) {
  const ep = String(endpoint || 'matches:all');

  // The host synthesizes `search:<query>` endpoints when the user taps
  // "See All" on a search rail — delegate to search() so paging matches the
  // search results exactly.
  if (ep.startsWith('search:')) {
    return search(ep.slice('search:'.length), page);
  }

  const kind = ep.startsWith('matches:') ? ep.slice('matches:'.length) : ep;

  let list = [];
  let d = null;
  if (kind === 'all') {
    d = await getJson('/api/matches/all');
  } else if (kind === 'featured') {
    d = await getJson('/api/matches/featured');
  } else if (kind === 'live') {
    d = await getJson('/api/matches/live/popular');
  } else {
    d = await getJson(`/api/matches/${kind}`);
  }
  list = Array.isArray(d) ? d : (d?.matches ?? []);

  const start = (page - 1) * PAGE_SIZE;
  const slice = list.slice(start, start + PAGE_SIZE);
  const results = mapToMediaItems(slice, ep);
  const hasMore = start + PAGE_SIZE < list.length;

  return {
    results,
    hasMore,
    page,
    total_pages: Math.max(1, Math.ceil(list.length / PAGE_SIZE)),
    total_results: list.length,
    endpoint: ep,
  };
}

// ===========================================================================
// Search — client-side filter over the full event catalog
// ===========================================================================
// Streamed has no dedicated search endpoint, but the ENTIRE event catalog
// (live + upcoming) is always available via /api/matches/all — so lookups are
// a local, case-insensitive AND-match across titles, team names, and sport
// categories instead of a server-side query. The host only routes searches
// here once the plugin declares the `search` capability in its manifest.

function matchScoresMatch(match, words) {
  const haystacks = [
    titleOf(match),
    ...Object.values(teamsOf(match)),
    labelOf(match),
    slugOf(match),
    String(match?.category || ''),
    String(match?.sport || ''),
  ]
    .map((h) => String(h).toLowerCase())
    .filter(Boolean);
  return words.every((w) => haystacks.some((h) => h.includes(w)));
}

export async function search(query, page = 1) {
  const q = String(query ?? '').trim();
  if (q.length < 2) {
    return { results: [], hasMore: false, page: 1, total_pages: 0, total_results: 0 };
  }

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const d = await getJson('/api/matches/all');
  const all = Array.isArray(d) ? d : (d?.matches ?? []);
  const matching = all.filter((m) => m && matchScoresMatch(m, words));

  const start = (Math.max(1, page) - 1) * PAGE_SIZE;
  const slice = matching.slice(start, start + PAGE_SIZE);
  const results = mapToMediaItems(slice, `search:${q}`);
  const hasMore = start + PAGE_SIZE < matching.length;

  return {
    results,
    hasMore,
    page,
    total_pages: Math.max(0, Math.ceil(matching.length / PAGE_SIZE)),
    total_results: matching.length,
    endpoint: `search:${q}`,
  };
}

// ===========================================================================
// Details
// ===========================================================================

export async function getDetails(id, mediaType) {
  const want = String(id ?? '');

  // Sports data changes minute to minute: serve the match from the in-session
  // index while it is fresh, otherwise refresh the whole index from the
  // catalog (updating the cache with the new data) and re-read it. On a
  // refresh failure the last snapshot is kept and reused.
  let match = matchIndex[want];
  if (!isIndexFresh()) {
    await refreshMatchIndex();
    match = matchIndex[want] ?? match;
  }
  const resolved = match ?? { id: want, title: 'Match details', category: 'other' };
  const { home, away } = teamsOf(resolved);
  const homeBadge = badgeOf(resolved, 'home');
  const awayBadge = badgeOf(resolved, 'away');
  const date = dateInfo(resolved);
  const liveStatus = computeLiveStatus(resolved);

  const description =
    resolved?.description ||
    `${labelOf(resolved)} — ${titleOf(resolved)}` +
    (date.label ? ` \u2014 ${date.label}` : '') +
    '.';

  const castList = [];
  if (home) {
    const badgeUrl = getMatchBadge(homeBadge);
    castList.push({
      id: 'home',
      name: home,
      character: 'Home Team',
      profile_url: badgeUrl,
      profileUrl: badgeUrl,
      order: 0,
    });
  }
  if (away) {
    const badgeUrl = getMatchBadge(awayBadge);
    castList.push({
      id: 'away',
      name: away,
      character: 'Away Team',
      profile_url: badgeUrl,
      profileUrl: badgeUrl,
      order: 1,
    });
  }

  return {
    id: want,
    media_type: 'sport',
    title: titleOf(resolved),
    name: titleOf(resolved),
    overview: description,
    poster_url: matchPoster(resolved),
    backdrop_url: matchPoster(resolved),
    release_date: date.iso,
    release_year: date.year,
    genres: genresFor(resolved),
    cast: castList,
    endpoint: `matches:${slugOf(resolved)}`,
    status: liveStatus.isLive ? 'Live' : (date.epoch && date.epoch * 1000 > Date.now() ? 'Upcoming' : 'Finished'),
  };
}

// ===========================================================================
// Streams — lazy server expansion, one playable m3u8 per server
// ===========================================================================
// The match's `sources` array (admin, delta, golf, …) IS the lazy server list:
// each entry { source, id } becomes a server stub. Expanding a server calls the
// Streamed API for its embed records, then walks those records best-first and
// resolves the FIRST working m3u8 by loading the embed page in the headless
// WebView and intercepting the first request whose URL ends in `.m3u8`. Stream
// URLs are just channel links, so they are cached for STREAM_CACHE_TTL_MS.

const STREAM_CACHE_TTL_MS = 60 * 60 * 1000;

// ---------- match resolution (reuses the TTL match index) -------------------

async function resolveMatch(metadata) {
  const want = String(metadata?.id ?? metadata?.endpoint ?? '');
  if (!want) return null;
  let match = resolveMatchById(want);
  if (!isIndexFresh()) {
    await refreshMatchIndex();
    match = resolveMatchById(want) ?? match;
  }
  return match;
}

function sourceSeedsFor(match) {
  const raw =
    match?.sources ?? match?.source_list ?? match?.embed_sources ?? match?.streamed_sources;
  if (!Array.isArray(raw)) return [];
  return raw.filter((s) => s && s.source && s.id);
}

// ---------- m3u8 resolution via headless WebView interception --------------

function streamCacheKey(embedUrl) {
  return `streamed:stream:${embedUrl}`;
}

async function cachedStream(embedUrl) {
  try {
    const raw = await storage.get(streamCacheKey(embedUrl));
    if (!raw || typeof raw !== 'object' || !raw.url) return null;
    if (Date.now() - (raw.cachedAt ?? 0) > STREAM_CACHE_TTL_MS) return null;
    return { url: raw.url, headers: raw.headers ?? {} };
  } catch (_) {
    return null;
  }
}

async function cacheStream(embedUrl, entry) {
  try {
    await storage.set(streamCacheKey(embedUrl), {
      url: entry.url,
      headers: entry.headers ?? {},
      cachedAt: Date.now(),
    });
  } catch (_) {}
}

/// Loads the embed page headlessly and returns the first `.m3u8` request (the
/// exact playable link) with the request headers it fired with.
async function resolveEmbedM3u8(embedUrl) {
  const hit = await cachedStream(embedUrl);
  if (hit) return hit;

  let requests = [];
  try {
    const res = await webview.monitor(embedUrl, null, null, 4000);
    requests = Array.isArray(res?.requests) ? res.requests : [];
  } catch (e) {
    console.error('Streamed: webview monitor failed for', embedUrl, '-', e?.message ?? e);
    return null;
  }

  const m3u8 = requests.find(
    (r) => typeof r?.url === 'string' && r.url.endsWith('.m3u8'),
  );
  if (!m3u8?.url) {
    console.warn('Streamed: no .m3u8 intercepted for', embedUrl);
    return null;
  }

  const entry = {
    url: m3u8.url,
    headers:
      m3u8.headers && typeof m3u8.headers === 'object' ? m3u8.headers : {},
  };
  await cacheStream(embedUrl, entry);
  console.log('Streamed: resolved m3u8 ->', entry.url);
  return entry;
}

function bestRecordsFirst(records) {
  return [...(records || [])].sort((a, b) => {
    const aHd = a.hd === true ? 0 : 1;
    const bHd = b.hd === true ? 0 : 1;
    if (aHd !== bHd) return aHd - bHd;
    return (Number(a.streamNo) || 0) - (Number(b.streamNo) || 0);
  });
}

// ---------- contract exports -----------------------------------------------

export async function getStreams(metadata) {
  const match = await resolveMatch(metadata);
  if (!match) return { providers: [] };
  const seeds = sourceSeedsFor(match);
  if (seeds.length === 0) return { providers: [] };

  const servers = seeds.map((s) => ({
    id: s.source,
    name: s.source.charAt(0).toUpperCase() + s.source.slice(1),
  }));

  return {
    providers: [
      {
        id: 'streamed',
        name: 'Streamed',
        logo: 'https://streamed.st/favicon.png',
        servers, // lazy: no `sources` key — expanded on demand one by one
      },
    ],
  };
}

export async function getStreamSources(metadata, providerId, serverId) {
  const match = await resolveMatch(metadata);
  if (!match) return { sources: [], subtitles: [] };

  const seed = sourceSeedsFor(match).find(
    (s) => String(s.source) === String(serverId),
  );
  if (!seed) {
    console.warn(`Streamed: no source "${serverId}" for match ${match.id}`);
    return { sources: [], subtitles: [] };
  }

  let records = [];
  try {
    const base = await pickBaseUrl();
    const resp = await http.get(`${base}/api/stream/${seed.source}/${seed.id}`, {
      responseType: 'json',
      headers: { Accept: 'application/json' },
    });
    records = Array.isArray(resp?.data) ? resp.data : [];
  } catch (e) {
    console.error('Streamed: stream list request failed:', e?.message ?? e);
    return { sources: [], subtitles: [] };
  }
  if (records.length === 0) return { sources: [], subtitles: [] };

  // Resolve only the FIRST WORKING record (HD first, then lowest streamNo);
  // the player's lazy fallback advances to the next server if playback fails.
  for (const rec of bestRecordsFirst(records)) {
    if (!rec?.embedUrl) continue;
    const resolved = await resolveEmbedM3u8(rec.embedUrl);
    if (!resolved) continue;
    return {
      sources: [
        {
          url: resolved.url,
          quality: rec.hd === true ? 'HD' : 'SD',
          label: rec.language || `${seed.source} · ${rec.streamNo ?? 1}`,
          stream_type: 'hls',
          headers: resolved.headers,
          headers_required: true,
        },
      ],
      subtitles: [],
    };
  }

  console.warn(`Streamed: no playable stream for ${seed.source}/${seed.id}`);
  return { sources: [], subtitles: [] };
}