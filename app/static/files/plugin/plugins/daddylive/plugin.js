// ============================================================================
// DaddyLive (DaddyLiveHD / DLHD / dlive.sx) — metadata + stream resolver
// ============================================================================
// Live sports schedule and 24/7 channels scraped from the public site. The
// site documents a keyed JSON API (/daddyapi.php?key=…&endpoint=channels|
// schedule|info), but the same data is served in the public HTML, so no key is
// required:
//
//   /                       today's schedule, grouped as
//                           div.schedule__category (name in div.card__meta)
//                             div.schedule__event
//                               span.schedule__eventTitle
//                               span.schedule__time[data-time]
//                               div.schedule__channels a[href=/watch.php?id=N]
//   /index.php?cat=<cat>    the same markup filtered to one category
//   /24-7-channels.php      always-on channels: a.card[href=/watch.php?id=N]
//
// Stream resolution is a single hop. Every playable id is a "channel id":
//
//   https://dembed.st/premiumtv/daddy.php?id=<channelId>  ->  const SRC="<m3u8>"
//
// The edge host in SRC (edge.<random>.sbs/premium<id>/index.m3u8) rotates and
// is only populated while the channel is on air (offline ids 404 with
// "unknown channel").
//
// PLAYBACK CAVEAT — the HLS segments are NOT plain transport streams. Each one
// is a valid PNG whose pixels carry a "TIKTIKPX" container wrapping a
// raw-deflate MPEG-TS payload:
//
//   PNG -> zlib inflate IDAT + unfilter -> "TIKTIKPX" + deflate -> MPEG-TS
//
// The site's own player unwraps this in the browser (hls.js + pako). A plain
// mpv/ExoPlayer pipeline cannot, and the plugin runtime exposes no proxy or
// decrypt hook, so the resolved URL is returned for completeness but will not
// play until an unwrap layer exists. Metadata, catalog and resolution all work.
// ============================================================================

const MIRRORS = [
  'https://dlive.sx',
  'https://dlhd.pk',
  'https://dlhd.st',
  'https://dlstreams.st',
];

const EMBED_URL = 'https://dembed.st/premiumtv/daddy.php?id=';

// No per-channel artwork is published on the public pages, so the site's own
// wordmark stands in for posters/backdrops (titles/time carry the meaning).
const LOGO = 'https://dlive.sx/assets/logos/logo.png';

const PAGE_SIZE = 40;
const HOME_TTL_MS = 60 * 1000; // the schedule changes minute to minute
const CHANNELS_TTL_MS = 10 * 60 * 1000; // 24/7 channel list is fairly static
const STREAM_TTL_MS = 5 * 60 * 1000; // edge host / token rotates

// ---------------------------------------------------------------------------
// session caches
// ---------------------------------------------------------------------------

let hostCache = null;
let homeCache = { at: 0, value: null };
let channelsCache = { at: 0, value: null };
const streamCache = new Map(); // channelId -> { at, url, label }
let eventIndex = new Map(); // "ev_<hash>" -> event
let channelIndex = new Map(); // "51" -> name

// ---------------------------------------------------------------------------
// http helpers
// ---------------------------------------------------------------------------

async function getText(url, headers) {
  const resp = await http.get(url, headers ? { headers } : undefined);
  const data = resp && resp.data;
  return typeof data === 'string' ? data : '';
}

async function readHost() {
  try {
    const v = await storage.get('daddylive:host');
    return typeof v === 'string' && v ? v : null;
  } catch (_) {
    return null;
  }
}

async function writeHost(base) {
  try {
    await storage.set('daddylive:host', base);
  } catch (_) {}
}

// Picks a reachable mirror. Mirrors chain-redirect to the canonical host, so
// any of them can serve the same markup; the last-good host is remembered.
async function pickHost() {
  if (hostCache) return hostCache;
  const saved = await readHost();
  const candidates = [];
  if (saved) candidates.push(saved);
  for (const m of MIRRORS) {
    if (candidates.indexOf(m) === -1) candidates.push(m);
  }
  for (const base of candidates) {
    try {
      const resp = await http.get(`${base}/24-7-channels.php`);
      const html = typeof resp?.data === 'string' ? resp.data : '';
      if (html.indexOf('watch.php?id=') !== -1) {
        hostCache = base;
        await writeHost(base);
        return base;
      }
    } catch (_) {}
  }
  hostCache = MIRRORS[0];
  return hostCache;
}

// ---------------------------------------------------------------------------
// parsing helpers
// ---------------------------------------------------------------------------

function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
}

function clean(s) {
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

function slug(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// FNV-1a (32-bit) -> base36, used to key events without embedding glyphs or
// separators in the id (ids travel through URL path segments).
function hashId(s) {
  let h = 0x811c9dc5;
  const str = String(s);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

function todayISO() {
  try {
    return new Date().toISOString().split('T')[0];
  } catch (_) {
    return null;
  }
}

function eventId(category, time, title) {
  return `ev_${hashId(`${category}\n${time}\n${title}`)}`;
}

// Keeps only the first schedule day (the site also renders a stale day block).
function firstDay(html) {
  const start = html.indexOf('schedule__dayTitle');
  if (start === -1) return html;
  const next = html.indexOf('schedule__dayTitle', start + 18);
  return next === -1 ? html.slice(start) : html.slice(start, next);
}

function parseSchedule(html) {
  const out = { events: [], categories: [] };
  if (typeof html !== 'string' || !html) return out;

  const cats = firstDay(html).split(/class="schedule__category(?![A-Za-z])/);
  const seenCats = new Set();

  for (let c = 1; c < cats.length; c++) {
    const block = cats[c];
    const cm = /card__meta">([^<]*)</.exec(block);
    const category = clean(cm ? cm[1] : '') || 'Other';

    const events = block.split('class="schedule__event"');
    for (let e = 1; e < events.length; e++) {
      const evBlock = events[e];

      const tm = /schedule__eventTitle">([^<]*)</.exec(evBlock);
      const title = clean(tm ? tm[1] : '');
      if (!title) continue;

      const timeM = /data-time="([^"]*)"/.exec(evBlock);
      const time = timeM ? timeM[1] : '';

      const channels = [];
      const seenCh = new Set();
      const re =
        /<a\b[^>]*href="[^"]*watch\.php\?id=(\d+)"[^>]*>([^<]*)</g;
      let am;
      while ((am = re.exec(evBlock)) !== null) {
        const id = am[1];
        if (seenCh.has(id)) continue;
        seenCh.add(id);
        const name = clean(am[2]) || `Channel ${id}`;
        channels.push({ id, name });
        channelIndex.set(id, name);
      }

      const id = eventId(category, time, title);
      const event = {
        id,
        category,
        slug: slug(category),
        time,
        title,
        channels,
      };
      eventIndex.set(id, event);
      out.events.push(event);
    }

    if (!seenCats.has(category)) {
      seenCats.add(category);
      out.categories.push({ name: category, slug: slug(category) });
    }
  }

  // Category tiles should only advertise categories that have events today.
  const withEvents = new Set(out.events.map((ev) => ev.slug));
  out.categories = out.categories.filter((cat) => withEvents.has(cat.slug));
  return out;
}

function parseChannels(html) {
  const out = [];
  if (typeof html !== 'string' || !html) return out;
  const seen = new Set();
  const re =
    /<a class="card"[^>]*href="\/watch\.php\?id=(\d+)"[^>]*>\s*<div class="card__title">([^<]*)<\/div>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[1];
    if (seen.has(id)) continue;
    seen.add(id);
    const name = clean(m[2]) || `Channel ${id}`;
    out.push({ id, name });
    channelIndex.set(id, name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// catalog loaders
// ---------------------------------------------------------------------------

async function loadHome() {
  if (homeCache.value && Date.now() - homeCache.at < HOME_TTL_MS) {
    return homeCache.value;
  }
  const host = await pickHost();
  let parsed = { events: [], categories: [] };
  try {
    const html = await getText(`${host}/`);
    parsed = parseSchedule(html);
  } catch (e) {
    console.error('DaddyLive: schedule fetch failed -', e && e.message ? e.message : e);
  }
  if (parsed.events.length > 0) {
    homeCache = { at: Date.now(), value: parsed };
  }
  return parsed;
}

async function loadChannels() {
  if (channelsCache.value && Date.now() - channelsCache.at < CHANNELS_TTL_MS) {
    return channelsCache.value;
  }
  const host = await pickHost();
  let list = [];
  try {
    const html = await getText(`${host}/24-7-channels.php`);
    list = parseChannels(html);
  } catch (e) {
    console.error('DaddyLive: channel fetch failed -', e && e.message ? e.message : e);
  }
  if (list.length > 0) {
    channelsCache = { at: Date.now(), value: list };
  }
  return list;
}

async function channelName(id) {
  const key = String(id);
  if (channelIndex.has(key)) return channelIndex.get(key);
  await loadChannels();
  return channelIndex.get(key) || `Channel ${key}`;
}

async function findEvent(id) {
  const key = String(id);
  if (eventIndex.has(key)) return eventIndex.get(key);
  await loadHome();
  return eventIndex.get(key) || null;
}

// ---------------------------------------------------------------------------
// card / detail mapping
// ---------------------------------------------------------------------------

function genreOf(name) {
  return { name: name, type: 'genre', title: name };
}

function eventCard(ev) {
  const subtitle = [ev.time ? `${ev.time} GMT` : '', ev.category]
    .filter(Boolean)
    .join(' · ');
  return {
    id: ev.id,
    title: ev.title,
    name: ev.title,
    media_type: 'sport',
    poster_url: LOGO,
    backdrop_url: LOGO,
    overview: `${ev.category}${ev.time ? ` — ${ev.time} GMT` : ''}`,
    genres: [genreOf(ev.category)],
    endpoint: `event_${ev.id}`,
    card_style: {
      orientation: 'landscape',
      hasSubtitle: true,
      subtitle,
    },
  };
}

function channelCard(ch) {
  return {
    id: `ch_${ch.id}`,
    title: ch.name,
    name: ch.name,
    media_type: 'channel',
    poster_url: LOGO,
    backdrop_url: LOGO,
    overview: 'Live 24/7 channel.',
    genres: [genreOf('Live TV')],
    endpoint: `channel_${ch.id}`,
    card_style: { orientation: 'landscape' },
  };
}

function categoryTile(cat) {
  return {
    id: `cat_${cat.slug}`,
    title: cat.name,
    name: cat.name,
    media_type: 'sport',
    poster_url: LOGO,
    backdrop_url: LOGO,
    endpoint: `cat_${cat.slug}`,
    card_style: { orientation: 'square', route: 'category' },
  };
}

function pageEnvelope(items, page, endpoint) {
  const start = (Math.max(1, page) - 1) * PAGE_SIZE;
  const results = items.slice(start, start + PAGE_SIZE);
  return {
    results,
    hasMore: start + PAGE_SIZE < items.length,
    page,
    total_pages: Math.max(1, Math.ceil(items.length / PAGE_SIZE)),
    total_results: items.length,
    endpoint,
  };
}

// ---------------------------------------------------------------------------
// home
// ---------------------------------------------------------------------------

export async function getHomeContent(page = 1) {
  if (page !== 1) {
    return { results: [], hasMore: false, page, total_pages: 1, total_results: 0 };
  }

  const [home, channels] = await Promise.all([loadHome(), loadChannels()]);
  const rows = [];

  if (home.categories.length > 0) {
    rows.push({
      id: 'browse-sports',
      title: 'Browse Sports',
      endpoint: null,
      card_style: { orientation: 'square' },
      results: home.categories.map(categoryTile),
      hasMore: false,
      page: 1,
      total_pages: 1,
      total_results: home.categories.length,
    });
  }

  if (channels.length > 0) {
    rows.push({
      id: 'channels-24-7',
      title: '24/7 Channels',
      endpoint: 'channels',
      card_style: { orientation: 'landscape' },
      results: channels.slice(0, PAGE_SIZE).map(channelCard),
      hasMore: channels.length > PAGE_SIZE,
      page: 1,
      total_pages: Math.ceil(channels.length / PAGE_SIZE),
      total_results: channels.length,
    });
  }

  if (home.events.length > 0) {
    rows.push({
      id: 'events-today',
      title: 'Live & Upcoming Today',
      endpoint: 'events',
      card_style: { orientation: 'landscape' },
      results: home.events.slice(0, PAGE_SIZE).map(eventCard),
      hasMore: home.events.length > PAGE_SIZE,
      page: 1,
      total_pages: Math.ceil(home.events.length / PAGE_SIZE),
      total_results: home.events.length,
    });
  }

  return {
    page: 1,
    hasMore: false,
    total_pages: 1,
    total_results: rows.length,
    results: rows,
  };
}

// ---------------------------------------------------------------------------
// listing (endpoint, page)
// ---------------------------------------------------------------------------

export async function getMediaItems(endpoint = 'events', page = 1) {
  const ep = String(endpoint || 'events');

  if (ep.startsWith('search:')) {
    return search(ep.slice('search:'.length), page);
  }

  if (ep === 'channels') {
    const channels = await loadChannels();
    return pageEnvelope(channels.map(channelCard), page, ep);
  }

  const home = await loadHome();
  if (ep.startsWith('cat_')) {
    const wanted = ep.slice('cat_'.length);
    const items = home.events.filter((ev) => ev.slug === wanted).map(eventCard);
    return pageEnvelope(items, page, ep);
  }

  return pageEnvelope(home.events.map(eventCard), page, ep);
}

// ---------------------------------------------------------------------------
// search — client-side over the parsed schedule and channel list
// ---------------------------------------------------------------------------

export async function search(query, page = 1) {
  const q = String(query == null ? '' : query).trim();
  if (q.length < 2) {
    return { results: [], hasMore: false, page: 1, total_pages: 0, total_results: 0 };
  }

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const [home, channels] = await Promise.all([loadHome(), loadChannels()]);

  const events = home.events.filter((ev) => {
    const hay = `${ev.title} ${ev.category} ${ev.time}`.toLowerCase();
    return words.every((w) => hay.indexOf(w) !== -1);
  });

  const chans = channels.filter((ch) => {
    const hay = ch.name.toLowerCase();
    return words.every((w) => hay.indexOf(w) !== -1);
  });

  const items = [
    ...chans.map(channelCard),
    ...events.map(eventCard),
  ];

  const env = pageEnvelope(items, Math.max(1, page), `search:${q}`);
  env.endpoint = `search:${q}`;
  return env;
}

// ---------------------------------------------------------------------------
// details
// ---------------------------------------------------------------------------

export async function getDetails(id, mediaType) {
  const sid = String(id == null ? '' : id);

  if (sid.startsWith('ch_')) {
    const num = sid.slice(3);
    const name = await channelName(num);
    return {
      id: sid,
      media_type: 'channel',
      title: name,
      name,
      overview: 'Live 24/7 channel on DaddyLive.',
      poster_url: LOGO,
      backdrop_url: LOGO,
      genres: [genreOf('Live TV')],
      status: 'Live',
    };
  }

  const ev = await findEvent(sid);
  if (!ev) {
    return {
      id: sid,
      media_type: 'sport',
      title: 'Live Event',
      name: 'Live Event',
      overview: 'Event details are unavailable (the schedule may have changed).',
      poster_url: LOGO,
      backdrop_url: LOGO,
      genres: [genreOf('Sports')],
    };
  }

  const cast = (ev.channels || []).map((c, i) => ({
    id: `ch_${c.id}`,
    name: c.name,
    character: 'Channel',
    order: i,
  }));

  return {
    id: sid,
    media_type: 'sport',
    title: ev.title,
    name: ev.title,
    overview: `${ev.category}${ev.time ? ` — ${ev.time} GMT` : ''}.`,
    poster_url: LOGO,
    backdrop_url: LOGO,
    release_date: todayISO(),
    genres: [genreOf(ev.category)],
    status: 'Live',
    cast,
  };
}

// ---------------------------------------------------------------------------
// streams
// ---------------------------------------------------------------------------

function extractSrc(html) {
  if (typeof html !== 'string' || !html) return null;
  let m = /const\s+SRC\s*=\s*["']([^"']+)["']/.exec(html);
  if (!m) m = /SRC\s*=\s*["']([^"']+\.m3u8[^"']*)["']/i.exec(html);
  if (!m) m = /file\s*:\s*["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i.exec(html);
  return m ? m[1] : null;
}

async function resolveChannel(num) {
  const key = String(num);
  const hit = streamCache.get(key);
  if (hit && Date.now() - hit.at < STREAM_TTL_MS) return hit;

  let url = null;
  try {
    url = extractSrc(await getText(`${EMBED_URL}${encodeURIComponent(key)}`));
  } catch (_) {}

  if (!url) {
    // The embed host can rotate; fall back to the watch page's iframe.
    try {
      const host = await pickHost();
      const watch = await getText(`${host}/watch.php?id=${encodeURIComponent(key)}`);
      const ifm = /<iframe[^>]*\bsrc="([^"]+)"/i.exec(watch || '');
      if (ifm) url = extractSrc(await getText(ifm[1]));
    } catch (_) {}
  }

  if (!url) {
    console.warn(`DaddyLive: no m3u8 for channel ${key}`);
    return null;
  }

  const entry = { at: Date.now(), url, label: `Channel ${key}` };
  streamCache.set(key, entry);
  console.log(`DaddyLive: channel ${key} -> ${url}`);
  return entry;
}

async function serversFor(metadata) {
  const id = String(metadata && metadata.id != null ? metadata.id : '');
  const seen = new Set();
  const servers = [];
  const push = (chId, name) => {
    const key = String(chId);
    if (!key || seen.has(key)) return;
    seen.add(key);
    servers.push({ id: key, name: name || `Channel ${key}` });
  };

  if (id.startsWith('ch_')) {
    const num = id.slice(3);
    push(num, await channelName(num));
  } else if (id.startsWith('ev_')) {
    const ev = await findEvent(id);
    for (const ch of (ev && ev.channels) || []) push(ch.id, ch.name);
  } else if (/^\d+$/.test(id)) {
    push(id, await channelName(id));
  }

  return servers;
}

export async function getStreams(metadata) {
  const servers = await serversFor(metadata);
  if (servers.length === 0) return { providers: [] };
  return {
    providers: [
      {
        id: 'daddylive',
        name: 'DaddyLive',
        logo: LOGO,
        servers,
      },
    ],
  };
}

export async function getStreamSources(metadata, providerId, serverId) {
  const num = String(serverId == null ? '' : serverId).replace(/[^0-9]/g, '');
  if (!num) return { sources: [], subtitles: [] };

  const resolved = await resolveChannel(num);
  if (!resolved) return { sources: [], subtitles: [] };

  return {
    sources: [
      {
        url: resolved.url,
        quality: 'Live',
        label: resolved.label,
        stream_type: 'hls',
        headers_required: true,
        headers: { Origin: 'https://dembed.st', Referer: 'https://dembed.st/'}
      },
    ],
  };
}
