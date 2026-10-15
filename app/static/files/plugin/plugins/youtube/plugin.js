// YouTube Plugin
//
// Metadata + source + search provider for https://www.youtube.com. Unlike the
// HTML-scraped catalogue plugins, YouTube is driven entirely through its
// internal JSON API ("InnerTube", `/youtubei/v1/*`), so this plugin is pure
// HTTP + JSON — no webview, no HTML parsing, no JavaScript execution.
//
// Modelling:
//   • video            → `movie`   (id `yt:v:<videoId>`)
//   • playlist         → `tv`      (id `yt:p:<playlistId>`, one season whose
//                                    episodes are the playlist's videos)
//   • channel          → `tv`      (id `yt:c:<channelId>`, one season whose
//                                    episodes are the channel's uploads, i.e.
//                                    the derived `UU…` uploads playlist)
//
// Endpoints used:
//   • search   → POST /youtubei/v1/search   (WEB client)      — query + paging
//   • browse   → POST /youtubei/v1/browse   (WEB client)      — playlist /
//                channel pages and their continuations
//   • player   → POST /youtubei/v1/player   (IOS + ANDROID)   — stream data
//   • next     → POST /youtubei/v1/next     (WEB client)      — related videos
//
// Streaming (the reason extractors usually break): we deliberately avoid
// signature/`n` deciphering and the PO-token dance by asking the **iOS** client
// for the player response. It hands back `streamingData.hlsManifestUrl` — a
// standard HLS master playlist with muxed renditions (240p…1080p) plus separate
// audio groups and subtitle tracks — that plays as-is. As a fallback the
// **ANDROID** ("androidSdkless") client returns direct `googlevideo` URLs whose
// `sig` is already applied (no `n`); only itag 18 (360p) is muxed there, so it
// is offered second. Both are plain HTTP with a matching User-Agent — no
// visitorData, no cookies, no challenge solving.
//
// Home: the anonymous `FEwhat_to_watch` feed is essentially empty, so the home
// screen is built from a curated table of InnerTube search queries (Trending,
// Music, Gaming, …), each row backed by `search:<query>` for "see all".

export const id = 'com.quickstream.plugin.youtube';
export const name = 'YouTube';
export const version = '0.0.0';
export const type = ['metadata', 'source', 'search'];

const PLUGIN_ID = 'com.quickstream.plugin.youtube';
const YT = 'https://www.youtube.com';
const INNERTUBE = `${YT}/youtubei/v1`;
const WATCH_BASE = `${YT}/watch?v=`;
const LOGO = `${YT}/favicon.ico`;

// Stable id prefixes so a media id round-trips through getDetails/
// getSeasonEpisodes/getStreams without guessing the kind.
const ID_VIDEO = 'yt:v:';
const ID_PLAYLIST = 'yt:p:';
const ID_CHANNEL = 'yt:c:';

const CACHE_TTL_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20000;

const PLAYER_CACHE = new Map(); // `${client}:${videoId}` → { value, at }
const BROWSE_CACHE = new Map(); // browseId/continuation key → { value, at }
const COLLECTION_CACHE = new Map(); // `${kind}:${id}` → { value, at }
const SEARCH_TOKENS = new Map(); // `${query}\u0000${page}` → continuation token

// How far to walk a playlist/channel continuation chain when it becomes the
// episode list for a "series". Kept modest so getDetails stays quick.
const MAX_EPISODES = 150;
const MAX_CONTINUATION_PAGES = 4;

// Curated home rows, partitioned into pages of ~5 rows (the host appends one
// page at a time; `hasMore` on the envelope drives the next fetch). Every row
// except the (single) banner row is a search-backed landscape rail.
const HOME_PAGES = [
  [
    { id: 'trending', title: 'Trending Now', query: 'music video', banner: true },
    { id: 'music', title: 'Music', query: 'official music video' },
    { id: 'gaming', title: 'Gaming', query: 'gameplay trailer' },
    { id: 'movies', title: 'Movies & Trailers', query: 'official movie trailer' },
    { id: 'news', title: 'News', query: 'breaking news' },
  ],
  [
    { id: 'sports', title: 'Sports', query: 'sports highlights' },
    { id: 'tech', title: 'Tech', query: 'tech review' },
    { id: 'learning', title: 'Learning', query: 'documentary' },
    { id: 'comedy', title: 'Comedy', query: 'stand up comedy' },
    { id: 'live', title: 'Live', query: 'live now music' },
  ],
  [
    { id: 'podcasts', title: 'Podcasts', query: 'podcast episode' },
    { id: 'cooking', title: 'Cooking', query: 'recipe' },
    { id: 'travel', title: 'Travel', query: 'travel vlog 4k' },
    { id: 'anime', title: 'Anime', query: 'anime opening' },
    { id: 'fitness', title: 'Fitness', query: 'workout music' },
  ],
];

// ---------------------------------------------------------------------------
// InnerTube clients
// ---------------------------------------------------------------------------

const WEB_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const IOS_UA =
  'com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)';
const ANDROID_UA = 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip';

/** Client context for search / browse / next (server-rendered catalogues). */
function webClient() {
  return { clientName: 'WEB', clientVersion: '2.20240726.01.00', hl: 'en', gl: 'US' };
}

/** Client context for the player response that exposes `hlsManifestUrl`. */
function iosClient() {
  return {
    clientName: 'IOS',
    clientVersion: '20.10.4',
    deviceMake: 'Apple',
    deviceModel: 'iPhone16,2',
    userAgent: IOS_UA,
    hl: 'en',
    platform: 'MOBILE',
    osName: 'IOS',
    osVersion: '18.1.0.22B83',
    timeZone: 'UTC',
    gl: 'US',
    utcOffsetMinutes: 0,
  };
}

/** "androidSdkless" client: direct, already-signed URLs (itag 18 muxed). */
function androidClient() {
  return {
    clientName: 'ANDROID',
    clientVersion: '20.10.38',
    userAgent: ANDROID_UA,
    hl: 'en',
    timeZone: 'UTC',
    utcOffsetMinutes: 0,
    osName: 'Android',
    osVersion: '11',
  };
}

function webHeaders() {
  return {
    'Content-Type': 'application/json',
    'User-Agent': WEB_UA,
    'Accept-Language': 'en-US,en;q=0.9',
    Origin: YT,
    Referer: `${YT}/`,
  };
}

function iosHeaders() {
  return {
    'Content-Type': 'application/json',
    'User-Agent': IOS_UA,
    'Accept-Language': 'en-US,en;q=0.9',
  };
}

function androidHeaders() {
  return {
    'Content-Type': 'application/json',
    'User-Agent': ANDROID_UA,
    'Accept-Language': 'en-US,en;q=0.9',
  };
}

function clientFor(kind) {
  if (kind === 'ios') return { client: iosClient(), headers: iosHeaders() };
  if (kind === 'android') return { client: androidClient(), headers: androidHeaders() };
  return { client: webClient(), headers: webHeaders() };
}

// ---------------------------------------------------------------------------
// http helper
// ---------------------------------------------------------------------------

async function innertube(endpoint, body, headers) {
  const url = `${INNERTUBE}/${endpoint}?prettyPrint=false`;
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await http.post(url, JSON.stringify(body), { headers });
      const status = res?.status ?? 0;
      if (status >= 200 && status < 300 && res?.data) {
        return typeof res.data === 'object' ? res.data : JSON.parse(res.data);
      }
      lastError = new Error(`HTTP ${status}`);
    } catch (e) {
      lastError = e;
    }
    await delay(400 * (attempt + 1));
  }
  console.error(`YouTube: ${endpoint} failed:`, lastError?.message ?? lastError);
  return null;
}

// ---------------------------------------------------------------------------
// generic JSON walkers
// ---------------------------------------------------------------------------

/** Pre-order (document-order) visit of every object node in a JSON tree. */
function walkAll(node, visit) {
  if (node === null || typeof node !== 'object') return;
  visit(node);
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) walkAll(node[i], visit);
    return;
  }
  for (const key in node) walkAll(node[key], visit);
}

/** First node (document order) matching `predicate`, or null. */
function findFirst(node, predicate) {
  let found = null;
  walkAll(node, (n) => {
    if (found === null && predicate(n)) found = n;
  });
  return found;
}

/** Text out of a `{ runs }` / `{ simpleText }` / plain-string node. */
function textOf(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node.runs)) return node.runs.map((r) => r.text || '').join('');
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (typeof node.content === 'string') return node.content;
  return '';
}

/** Largest thumbnail URL in a `{ width, height, url }[]` list. */
function pickThumb(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  let best = null;
  let bestArea = -1;
  for (const item of list) {
    const url = item?.url;
    if (!url) continue;
    const area = (item.width || 0) * (item.height || 0);
    if (area >= bestArea) {
      bestArea = area;
      best = url;
    }
  }
  return best || list[list.length - 1]?.url || null;
}

/** First continuation token anywhere in a response (document order). */
function findContinuation(root) {
  let token = null;
  walkAll(root, (n) => {
    if (token) return;
    token =
      n?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token ||
      n?.continuationItemViewModel?.continuationCommand?.innertubeCommand?.continuationCommand?.token ||
      null;
  });
  return token;
}

// ---------------------------------------------------------------------------
// renderer normalisation → { kind, ytId, title, thumbUrl, ... }
// ---------------------------------------------------------------------------

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const PLAYLIST_ID_RE = /^(PL|UU|OLAK5uy_|RD|LL|FL|MPREb_|VLPL)[A-Za-z0-9_-]{10,}$/;
const CHANNEL_ID_RE = /^UC[A-Za-z0-9_-]{22}$/;

function kindFromId(cid) {
  if (CHANNEL_ID_RE.test(cid)) return 'channel';
  if (PLAYLIST_ID_RE.test(cid)) return 'playlist';
  if (VIDEO_ID_RE.test(cid)) return 'video';
  return 'video';
}

/** New "lockup" renderer (used by playlist / channel / home browse pages). */
function fromLockup(l) {
  const meta = l?.metadata?.lockupMetadataViewModel;
  const cid = l?.contentId || '';
  const type = String(l?.contentType || '');
  let kind = kindFromId(cid);
  if (type.includes('PLAYLIST')) kind = 'playlist';
  else if (type.includes('CHANNEL')) kind = 'channel';
  else if (type.includes('VIDEO')) kind = 'video';

  const sources = l?.contentImage?.thumbnailViewModel?.image?.sources || [];
  let duration = '';
  const overlays = l?.contentImage?.thumbnailViewModel?.overlays || [];
  for (const overlay of overlays) {
    const badges = overlay?.thumbnailBottomOverlayViewModel?.badges || [];
    for (const badge of badges) {
      const txt = badge?.thumbnailBadgeViewModel?.text;
      if (txt && /^\d+(:\d{2})+$/.test(txt)) {
        duration = txt;
        break;
      }
    }
    if (duration) break;
  }

  const rows = meta?.metadata?.contentMetadataViewModel?.metadataRows || [];
  const parts = [];
  for (const row of rows) {
    for (const part of row?.metadataParts || []) {
      const t = part?.text?.content;
      if (t) parts.push(t);
    }
  }

  return {
    kind,
    ytId: cid,
    title: meta?.title?.content || '',
    thumbUrl: pickThumb(sources),
    durationText: duration,
    metaParts: parts,
    channelTitle: '',
    channelId: '',
    description: '',
  };
}

function fromVideoRenderer(v) {
  const byline = v.ownerText?.runs?.[0] || v.shortBylineText?.runs?.[0] || v.longBylineText?.runs?.[0];
  let duration = v.lengthText?.simpleText || '';
  if (!duration) {
    const timeOverlay = (v.thumbnailOverlays || []).find(
      (o) => o?.thumbnailOverlayTimeStatusRenderer
    );
    duration = timeOverlay?.thumbnailOverlayTimeStatusRenderer?.text?.simpleText || '';
  }
  const snippet = (v.detailedMetadataSnippets || [])
    .map((s) => textOf(s?.snippetText))
    .join(' ')
    .trim();
  return {
    kind: 'video',
    ytId: v.videoId || '',
    title: textOf(v.title),
    thumbUrl: pickThumb(v.thumbnail?.thumbnails),
    durationText: duration,
    viewsText: v.viewCountText?.simpleText || v.shortViewCountText?.simpleText || '',
    publishedText: v.publishedTimeText?.simpleText || '',
    channelTitle: byline?.text || '',
    channelId: byline?.navigationEndpoint?.browseEndpoint?.browseId || '',
    description: snippet || textOf(v.descriptionSnippet),
  };
}

function fromPlaylistRenderer(p) {
  return {
    kind: 'playlist',
    ytId: p.playlistId || '',
    title: textOf(p.title),
    thumbUrl: pickThumb(p.thumbnail?.thumbnails),
    countText: p.videoCountText?.simpleText || p.videoCountShortText?.simpleText || '',
    channelTitle: textOf(p.shortBylineText) || textOf(p.longBylineText),
    channelId:
      p.shortBylineText?.runs?.[0]?.navigationEndpoint?.browseEndpoint?.browseId || '',
    description: '',
  };
}

function fromChannelRenderer(c) {
  return {
    kind: 'channel',
    ytId: c.channelId || c.navigationEndpoint?.browseEndpoint?.browseId || '',
    title: textOf(c.title),
    thumbUrl: pickThumb(c.thumbnail?.thumbnails),
    countText: c.videoCountText?.simpleText || '',
    channelTitle: textOf(c.title),
    channelId: c.channelId || '',
    description: textOf(c.descriptionSnippet),
  };
}

/** Every catalogue item in a response, in document order, de-duplicated. */
function extractItems(root) {
  const out = [];
  const seen = new Set();
  walkAll(root, (node) => {
    let item = null;
    if (node.lockupViewModel) item = fromLockup(node.lockupViewModel);
    else if (node.videoRenderer) item = fromVideoRenderer(node.videoRenderer);
    else if (node.compactVideoRenderer) item = fromVideoRenderer(node.compactVideoRenderer);
    else if (node.gridVideoRenderer) item = fromVideoRenderer(node.gridVideoRenderer);
    else if (node.playlistRenderer) item = fromPlaylistRenderer(node.playlistRenderer);
    else if (node.channelRenderer) item = fromChannelRenderer(node.channelRenderer);
    if (!item || !item.ytId) return;
    // Auto-generated / authenticated playlists (mixes, Watch Later, Liked,
    // Favourites) are not browsable anonymously — they resolve to an alert
    // rather than a video list — so never advertise them as a series.
    if (item.kind === 'playlist' && /^(RD|LM|WL|LL|FL)/.test(item.ytId)) return;
    const key = `${item.kind}:${item.ytId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  });
  return out;
}

// ---------------------------------------------------------------------------
// MediaItem mapping
// ---------------------------------------------------------------------------

function toMediaItem(item) {
  if (item.kind === 'playlist' || item.kind === 'channel') return toTvItem(item);
  return toVideoItem(item);
}

function toVideoItem(item) {
  const stacked = {};
  if (item.durationText) stacked.bottomRight = { text: item.durationText };
  return {
    id: ID_VIDEO + item.ytId,
    title: item.title || '',
    name: item.title || '',
    media_type: 'movie',
    poster_url: item.thumbUrl,
    backdrop_url: item.thumbUrl,
    overview: item.description || '',
    card_style: {
      orientation: 'landscape',
      subtitle: item.channelTitle || undefined,
      stacked: Object.keys(stacked).length ? stacked : undefined,
    },
  };
}

function toTvItem(item) {
  const stacked = {};
  if (item.countText) stacked.bottomLeft = { text: item.countText };
  return {
    id: (item.kind === 'channel' ? ID_CHANNEL : ID_PLAYLIST) + item.ytId,
    title: item.title || '',
    name: item.title || '',
    media_type: 'tv',
    poster_url: item.thumbUrl,
    backdrop_url: item.thumbUrl,
    overview: item.description || '',
    card_style: {
      orientation: 'landscape',
      subtitle: item.channelTitle || undefined,
      stacked: Object.keys(stacked).length ? stacked : undefined,
    },
  };
}

// ---------------------------------------------------------------------------
// envelopes
// ---------------------------------------------------------------------------

function rowOf(row, results, cardStyle) {
  return {
    id: row.id,
    title: row.title,
    endpoint: `search:${row.query}`,
    card_style: cardStyle || { orientation: 'landscape' },
    results,
    hasMore: true,
    page: 1,
    total_pages: 1,
    total_results: results.length,
  };
}

function listEnvelope(results, page, hasMore, endpoint) {
  return {
    results,
    page,
    hasMore,
    total_pages: hasMore ? page + 1 : page,
    total_results: results.length,
    endpoint,
  };
}

function emptyList(page, endpoint) {
  return {
    results: [],
    page,
    hasMore: false,
    total_pages: page,
    total_results: 0,
    endpoint,
  };
}

// ---------------------------------------------------------------------------
// id parsing
// ---------------------------------------------------------------------------

function typeOf(metadata) {
  const mt = String(metadata?.media_type || metadata?.mediaType || 'tv').toLowerCase();
  return mt.includes('movie') ? 'movie' : 'tv';
}

function episodeOf(metadata) {
  const raw = metadata?.episode ?? metadata?.episode_number;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** `raw` is either a prefixed id we produced, or a bare YouTube id. */
function parseId(raw, mediaType) {
  const s = String(raw || '').trim();
  if (s.startsWith(ID_VIDEO)) return { kind: 'video', ytId: s.slice(ID_VIDEO.length) };
  if (s.startsWith(ID_PLAYLIST)) return { kind: 'playlist', ytId: s.slice(ID_PLAYLIST.length) };
  if (s.startsWith(ID_CHANNEL)) return { kind: 'channel', ytId: s.slice(ID_CHANNEL.length) };
  if (CHANNEL_ID_RE.test(s)) return { kind: 'channel', ytId: s };
  if (PLAYLIST_ID_RE.test(s)) return { kind: 'playlist', ytId: s };
  if (VIDEO_ID_RE.test(s)) return { kind: 'video', ytId: s };
  const t = String(mediaType || '').toLowerCase();
  return { kind: t.includes('movie') ? 'video' : 'playlist', ytId: s };
}

function idFor(parsed) {
  if (parsed.kind === 'playlist') return ID_PLAYLIST + parsed.ytId;
  if (parsed.kind === 'channel') return ID_CHANNEL + parsed.ytId;
  return ID_VIDEO + parsed.ytId;
}

// ---------------------------------------------------------------------------
// player responses (details + streams)
// ---------------------------------------------------------------------------

async function playerResponse(videoId, kind) {
  const key = `${kind}:${videoId}`;
  const hit = PLAYER_CACHE.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const { client, headers } = clientFor(kind);
  const data = await innertube(
    'player',
    {
      context: { client },
      videoId,
      contentCheckOk: true,
      racyCheckOk: true,
    },
    headers
  );
  PLAYER_CACHE.set(key, { value: data, at: Date.now() });
  return data;
}

// ---------------------------------------------------------------------------
// browse (playlists / channels)
// ---------------------------------------------------------------------------

async function browse(browseId, continuation) {
  const key = continuation ? `c:${continuation}` : `b:${browseId}`;
  const hit = BROWSE_CACHE.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const body = continuation
    ? { context: { client: webClient() }, continuation }
    : { context: { client: webClient() }, browseId };

  const data = await innertube('browse', body, webHeaders());
  BROWSE_CACHE.set(key, { value: data, at: Date.now() });
  return data;
}

/** Header (title/description/thumbnail/owner) of a playlist or channel page. */
function headerOf(data) {
  const title =
    findFirst(data, (n) => n?.pageHeaderViewModel?.title)
      ?.pageHeaderViewModel?.title?.dynamicTextViewModel?.text?.content ||
    findFirst(data, (n) => n?.playlistHeaderRenderer?.title)?.playlistHeaderRenderer?.title
      ?.simpleText ||
    findFirst(data, (n) => n?.metadata?.playlistMetadataRenderer?.title)
      ?.metadata?.playlistMetadataRenderer?.title ||
    findFirst(data, (n) => n?.microformat?.microformatDataRenderer?.title)
      ?.microformat?.microformatDataRenderer?.title ||
    '';

  const description =
    findFirst(data, (n) => n?.metadata?.playlistMetadataRenderer?.description)
      ?.metadata?.playlistMetadataRenderer?.description ||
    textOf(
      findFirst(data, (n) => n?.pageHeaderViewModel?.description)?.pageHeaderViewModel
        ?.description
    ) ||
    findFirst(data, (n) => n?.microformat?.microformatDataRenderer?.description)
      ?.microformat?.microformatDataRenderer?.description ||
    '';

  const thumb =
    pickThumb(
      findFirst(data, (n) => n?.microformat?.microformatDataRenderer?.thumbnail)
        ?.microformat?.microformatDataRenderer?.thumbnail?.thumbnails
    ) || null;

  const owner =
    findFirst(data, (n) => n?.microformat?.microformatDataRenderer?.ownerChannelName)
      ?.microformat?.microformatDataRenderer?.ownerChannelName || '';

  return { title, description: String(description || '').trim(), thumb, owner };
}

/** Uploads playlist id for a channel (`UC…` → `UU…`). */
function uploadsPlaylistId(channelId) {
  return channelId.startsWith('UC') ? `UU${channelId.slice(2)}` : channelId;
}

/**
 * Ordered video list for a `VL…` browse target, walking the continuation
 * chain up to [MAX_EPISODES].
 */
async function paginateVideos(browseId) {
  const data = await browse(browseId);
  let items = extractItems(data).filter((it) => it.kind === 'video');
  let token = findContinuation(data);

  let guard = 0;
  while (token && items.length < MAX_EPISODES && guard < MAX_CONTINUATION_PAGES) {
    const next = await browse(null, token);
    const more = extractItems(next).filter((it) => it.kind === 'video');
    if (more.length === 0) break;
    items = items.concat(more);
    token = findContinuation(next);
    guard++;
  }

  return items.slice(0, MAX_EPISODES);
}

/**
 * Ordered video list for a playlist or channel, walking the browse
 * continuation chain up to [MAX_EPISODES]. Cached per collection.
 */
async function collectionItems(parsed) {
  const key = `${parsed.kind}:${parsed.ytId}`;
  const hit = COLLECTION_CACHE.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  let items;
  if (parsed.kind === 'channel') {
    // Regular channels expose a chronological uploads playlist (`UC…`→`UU…`);
    // some curated channels (e.g. YouTube hubs) have no uploads playlist, so
    // fall back to the channel page's own video shelves.
    items = await paginateVideos(`VL${uploadsPlaylistId(parsed.ytId)}`);
    if (items.length === 0) items = await paginateVideos(parsed.ytId);
  } else {
    items = await paginateVideos(`VL${parsed.ytId}`);
  }

  COLLECTION_CACHE.set(key, { value: items, at: Date.now() });
  return items;
}

// ---------------------------------------------------------------------------
// search
// ---------------------------------------------------------------------------

function searchTokenKey(query, page) {
  return `${query.toLowerCase()}\u0000${page}`;
}

export async function search(query, page = 1) {
  const q = String(query ?? '').trim();
  const pg = Math.max(1, parseInt(page, 10) || 1);
  const endpoint = `search:${q}`;
  if (q.length < 2) return emptyList(1, endpoint);

  let body;
  if (pg <= 1) {
    body = { context: { client: webClient() }, query: q };
  } else {
    const token = SEARCH_TOKENS.get(searchTokenKey(q, pg));
    if (!token) return emptyList(pg, endpoint);
    body = { context: { client: webClient() }, continuation: token };
  }

  const data = await innertube('search', body, webHeaders());
  if (!data) return emptyList(pg, endpoint);

  const results = extractItems(data).map(toMediaItem);
  const token = findContinuation(data);
  if (token) SEARCH_TOKENS.set(searchTokenKey(q, pg + 1), token);

  return listEnvelope(results, pg, !!token, endpoint);
}

// ---------------------------------------------------------------------------
// home
// ---------------------------------------------------------------------------

export async function getHomeContent(page = 1) {
  const wantPage = Math.max(1, parseInt(page, 10) || 1);
  const pageRows = HOME_PAGES[wantPage - 1];
  if (!pageRows) {
    return { results: [], page: wantPage, hasMore: false, total_pages: HOME_PAGES.length, total_results: 0 };
  }

  const rows = await Promise.all(
    pageRows.map(async (row) => {
      const res = await search(row.query, 1);
      const results = (res.results || []).slice(0, 15);
      if (row.banner) {
        // Banner rows render as a hero carousel; normalise each card to
        // landscape so the row-level `banner` flag drives the layout.
        const hero = results.map((item) => ({
          ...item,
          card_style: { orientation: 'landscape' },
        }));
        return rowOf(row, hero, { banner: true, orientation: 'landscape' });
      }
      return rowOf(row, results);
    })
  );

  const filled = rows.filter((r) => r.results.length > 0);
  return {
    results: filled,
    page: wantPage,
    hasMore: wantPage < HOME_PAGES.length,
    total_pages: HOME_PAGES.length,
    total_results: filled.length,
  };
}

// ---------------------------------------------------------------------------
// getMediaItems ("see all" for a row, or an opened playlist/channel)
// ---------------------------------------------------------------------------

export async function getMediaItems(endpoint, page = 1) {
  const pg = Math.max(1, parseInt(page, 10) || 1);
  const ep = String(endpoint ?? '').trim();
  if (!ep) return emptyList(pg, endpoint);

  if (ep.startsWith('search:')) return search(ep.slice('search:'.length), pg);

  const parsed = parseId(ep, null);
  if (parsed.kind === 'playlist' || parsed.kind === 'channel') {
    if (pg > 1) return emptyList(pg, ep);
    const items = await collectionItems(parsed);
    return listEnvelope(items.map(toMediaItem), pg, false, ep);
  }

  return emptyList(pg, ep);
}

// ---------------------------------------------------------------------------
// details
// ---------------------------------------------------------------------------

export async function getDetails(id, mediaType, prioritySeason) {
  const parsed = parseId(id, mediaType);
  if (!parsed.ytId) return null;
  if (parsed.kind === 'video') return videoDetails(parsed.ytId);
  return collectionDetails(parsed);
}

function durationToMinutes(text) {
  const parts = String(text || '').split(':').map((p) => parseInt(p, 10));
  if (parts.length === 0 || parts.some((n) => !Number.isFinite(n))) return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : null;
}

async function videoDetails(ytId) {
  // The WEB player response carries the full `microformat` (publish date,
  // channel, category) even when playback is blocked, so it is the source of
  // truth for metadata; playback itself is resolved separately via iOS/Android.
  const player = await playerResponse(ytId, 'web');
  const vd = player?.videoDetails || {};
  const mf = player?.microformat?.playerMicroformatRenderer || {};
  const poster = pickThumb(vd.thumbnail?.thumbnails) || `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`;
  const lengthSec = parseInt(vd.lengthSeconds, 10);
  const published = mf.publishDate || mf.uploadDate || null;
  const owner = mf.ownerChannelName || vd.author || '';

  const genres = mf.category ? [{ name: mf.category, title: mf.category, type: 'genre' }] : [];
  const companies = owner ? [{ name: owner, title: owner, type: 'channel' }] : [];

  const details = {
    id: ID_VIDEO + ytId,
    title: vd.title || '',
    name: vd.title || '',
    media_type: 'movie',
    poster_url: poster,
    backdrop_url: poster,
    overview: vd.shortDescription || '',
    release_date: published,
    release_year: published ? (String(published).match(/\d{4}/) || [])[0] || null : null,
    vote_average: null,
    vote_count: vd.viewCount || null,
    runtime: Number.isFinite(lengthSec) ? Math.max(1, Math.round(lengthSec / 60)) : null,
    status: mf.isFamilySafe === false ? 'Restricted' : 'Public',
    cast: [],
    genres,
    production_companies: companies,
    extra: { web_url: `${WATCH_BASE}${ytId}`, share_text: vd.title || 'YouTube' },
  };

  const related = await relatedFor(ytId);
  if (related.length) {
    details.recommendations = [
      { id: `${ytId}-related`, title: 'Related videos', card_style: { orientation: 'landscape' }, results: related },
    ];
  }
  return details;
}

async function relatedFor(ytId) {
  const data = await innertube('next', { context: { client: webClient() }, videoId: ytId }, webHeaders());
  if (!data) return [];
  return extractItems(data)
    .filter((it) => it.kind === 'video' && it.ytId !== ytId)
    .slice(0, 12)
    .map(toMediaItem);
}

function episodeItem(parsed, item, number) {
  return {
    id: `${idFor(parsed)}:${number}`,
    episode_number: number,
    season_number: 1,
    name: item.title || `Video ${number}`,
    overview: item.description || null,
    still_url: item.thumbUrl || null,
    air_date: null,
    runtime: durationToMinutes(item.durationText),
  };
}

async function collectionDetails(parsed) {
  const browseId = parsed.kind === 'channel' ? parsed.ytId : `VL${parsed.ytId}`;
  const data = await browse(browseId);
  const header = headerOf(data);
  const items = await collectionItems(parsed);
  const episodes = items.map((it, index) => episodeItem(parsed, it, index + 1));

  const poster = header.thumb || items[0]?.thumbUrl || null;
  const webUrl =
    parsed.kind === 'channel'
      ? `${YT}/channel/${parsed.ytId}`
      : `${YT}/playlist?list=${parsed.ytId}`;

  return {
    id: idFor(parsed),
    title: header.title || '',
    name: header.title || '',
    media_type: 'tv',
    poster_url: poster,
    backdrop_url: poster,
    overview: header.description || '',
    release_date: null,
    release_year: null,
    vote_average: null,
    cast: [],
    genres: [],
    number_of_episodes: episodes.length,
    number_of_seasons: 1,
    seasons: [
      {
        id: idFor(parsed),
        name: 'Videos',
        season_number: 1,
        seasonNumber: 1,
        episode_count: episodes.length,
        episodes,
      },
    ],
    episodes,
    extra: { web_url: webUrl, share_text: header.title || 'YouTube' },
  };
}

// ---------------------------------------------------------------------------
// season episodes (bare array — the host datasource requires a List)
// ---------------------------------------------------------------------------

export async function getSeasonEpisodes(mediaId, seasonNumber) {
  const parsed = parseId(mediaId, 'tv');
  if (parsed.kind === 'video') return [];
  if (parsed.kind !== 'playlist' && parsed.kind !== 'channel') return [];
  const items = await collectionItems(parsed);
  return items.map((it, index) => episodeItem(parsed, it, index + 1));
}

// ---------------------------------------------------------------------------
// streams
// ---------------------------------------------------------------------------

/** Resolve the video id a getStreams(metadata) call refers to. */
async function videoIdFor(metadata) {
  const parsed = parseId(metadata?.id, metadata?.media_type || metadata?.mediaType);
  if (parsed.kind === 'video') return parsed.ytId;
  const items = await collectionItems(parsed);
  if (items.length === 0) return '';
  const want = episodeOf(metadata);
  const picked = items[want - 1] || items[0];
  return picked?.ytId || '';
}

export async function getStreams(metadata) {
  const videoId = await videoIdFor(metadata);
  if (!videoId) {
    console.warn('YouTube: could not resolve a video for', metadata?.id);
    return { providers: [] };
  }

  const [ios, android] = await Promise.all([
    playerResponse(videoId, 'ios'),
    playerResponse(videoId, 'android'),
  ]);

  const hls = ios?.streamingData?.hlsManifestUrl;
  const formats = android?.streamingData?.formats || [];
  const muxed =
    formats.find((f) => f.itag === 18 && f.url) ||
    formats.find((f) => /mp4a/i.test(f.mimeType || '') && /avc1/i.test(f.mimeType || '') && f.url);

  const servers = [];
  if (hls) {
    servers.push({
      id: 'hls',
      name: 'HLS (adaptive)',
      sources: [{ url: hls, quality: 'auto', label: 'Adaptive HLS', stream_type: 'hls' }],
    });
  }
  if (muxed?.url) {
    servers.push({
      id: 'mp4',
      name: 'MP4 (360p)',
      sources: [{ url: muxed.url, quality: muxed.qualityLabel || '360p', label: '360p', stream_type: 'other' }],
    });
  }

  if (servers.length === 0) {
    console.warn('YouTube: no playable stream for', videoId);
    return { providers: [] };
  }

  return {
    providers: [
      { id: PLUGIN_ID, name: 'YouTube', logo: LOGO, reliable: true, servers },
    ],
    subtitles: [],
  };
}
