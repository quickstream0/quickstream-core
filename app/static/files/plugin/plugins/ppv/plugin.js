// ============================================================================
// PPV (ppv.st) — live sports streams plugin for QuickStream
// ============================================================================
const API_BASE = 'https://api.ppv.st';
const LOGO = 'https://ppv.st/favicon.ico';

const CACHE_TTL_MS = 5 * 60 * 1000;
const PAGE_SIZE = 20;
const STREAM_CACHE_TTL_MS = 60 * 60 * 1000;

let streamList = [];
let categoryList = [];
let streamIndex = {};
let indexUpdatedAt = 0;

async function fetchCatalog() {
  const resp = await http.get(`${API_BASE}/api/streams`, {
    responseType: 'json',
    headers: { Accept: 'application/json' },
  });
  const data = resp && resp.data ? resp.data : {};
  const cats = Array.isArray(data.streams) ? data.streams : [];
  const flat = [];
  for (const cat of cats) {
    const items = Array.isArray(cat && cat.streams) ? cat.streams : [];
    for (const s of items) {
      if (!s) continue;
      flat.push(Object.assign({}, s, {
        category: (s.category_name || cat.category || 'Other'),
        category_id: cat.id,
        category_always_live: !!(cat.always_live),
      }));
    }
  }
  return { cats, flat };
}

async function refreshIndex() {
  try {
    const { cats, flat } = await fetchCatalog();
    if (!flat || flat.length === 0) return;
    const rebuilt = {};
    for (const s of flat) {
      if (s && s.id != null) rebuilt[String(s.id)] = s;
    }
    streamList = flat;
    categoryList = cats;
    streamIndex = rebuilt;
    indexUpdatedAt = Date.now();
  } catch (e) {
    console.error('PPV: catalog refresh failed -', e && e.message ? e.message : e);
  }
}

function isIndexFresh() {
  return indexUpdatedAt > 0 && (Date.now() - indexUpdatedAt) < CACHE_TTL_MS;
}

async function ensureIndex() {
  if (!isIndexFresh()) await refreshIndex();
}

function resolveStream(want) {
  const key = String(want == null ? '' : want);
  if (streamIndex[key]) return streamIndex[key];
  if (key.startsWith('stream:')) return streamIndex[key.slice('stream:'.length)] || null;
  return null;
}

function resolveStreamFromMetadata(metadata) {
  if (!metadata) return null;
  let want = metadata.id != null ? metadata.id : metadata.endpoint;
  if (want == null && metadata.url) want = metadata.url;
  const s = resolveStream(want);
  if (s) return s;
  const needle = String(want == null ? '' : want);
  if (needle) {
    for (const k in streamIndex) {
      const v = streamIndex[k];
      if (v && (String(v.uri_name) === needle || String(v.id) === needle)) return v;
    }
  }
  return null;
}
function isLiveNow(s) {
  if (!s) return false;
  if (s.always_live || s.category_always_live) return true;
  const now = Date.now() / 1000;
  const start = Number(s.starts_at || 0);
  const end = Number(s.ends_at || 0);
  if (start && end) return now >= start && now <= end;
  if (start) return now >= start && now <= start + 3 * 3600;
  return false;
}

function isoDate(ts) {
  if (!ts) return null;
  const d = new Date(Number(ts) * 1000);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().split('T')[0];
}

function yearOf(ts) {
  if (!ts) return null;
  const d = new Date(Number(ts) * 1000);
  if (isNaN(d.getTime())) return null;
  return d.getUTCFullYear();
}

function mapToMediaItem(s, endpoint) {
  const live = isLiveNow(s);
  return {
    id: String(s.id),
    title: s.name || 'Stream',
    name: s.name || 'Stream',
    media_type: 'sport',
    poster_url: s.poster || null,
    backdrop_url: s.poster || null,
    overview: [s.tag, s.source_tag].filter(Boolean).join(' · ') || (s.category || ''),
    release_date: isoDate(s.starts_at),
    release_year: yearOf(s.starts_at),
    genres: [
      {
        id: s.category,
        name: s.category,
        type: 'sport',
        title: s.category,
        endpoint: `category:${s.category}`,
      },
    ],
    endpoint: `stream:${s.id}`,
    card_style: {
      orientation: 'landscape',
      stacked: {
        top_left: live ? { text: 'LIVE', background_color: 'red' } : null,
        bottom_right: s.source_tag ? { text: s.source_tag } : null,
      },
    },
  };
}

function mapToMediaItems(list, endpoint) {
  return (list || [])
    .filter((m) => m && (m.id != null || m.name))
    .map((m) => mapToMediaItem(m, endpoint));
}

function distinctCategories() {
  const seen = new Set();
  const out = [];
  for (const c of categoryList) {
    const name = c && c.category;
    if (name && !seen.has(name)) {
      seen.add(name);
      out.push(c);
    }
  }
  if (out.length === 0) {
    const set = new Set();
    for (const s of streamList) {
      if (s && s.category && !set.has(s.category)) {
        set.add(s.category);
        out.push({ category: s.category, id: s.category_id, always_live: s.category_always_live });
      }
    }
  }
  return out;
}

export async function getHomeContent(page = 1) {
  if (page !== 1) {
    return { results: [], hasMore: false, page, total_pages: 1, total_results: 0 };
  }
  await ensureIndex();

  const rows = [];

  const liveNow = streamList.filter(isLiveNow);
  if (liveNow.length > 0) {
    rows.push({
      id: 'live-now',
      title: 'Live Now',
      endpoint: 'category:live',
      card_style: { orientation: 'landscape' },
      results: mapToMediaItems(liveNow.slice(0, PAGE_SIZE), 'category:live'),
      hasMore: liveNow.length > PAGE_SIZE,
      page: 1,
      total_pages: Math.max(1, Math.ceil(liveNow.length / PAGE_SIZE)),
      total_results: liveNow.length,
    });
  }

  for (const cat of distinctCategories()) {
    const name = cat.category;
    const items = streamList.filter((s) => s.category === name);
    if (items.length === 0) continue;
    rows.push({
      id: name,
      title: name,
      endpoint: `category:${name}`,
      card_style: { orientation: 'landscape' },
      results: mapToMediaItems(items.slice(0, PAGE_SIZE), `category:${name}`),
      hasMore: items.length > PAGE_SIZE,
      page: 1,
      total_pages: Math.max(1, Math.ceil(items.length / PAGE_SIZE)),
      total_results: items.length,
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

export async function getMediaItems(endpoint = 'category:all', page = 1) {
  await ensureIndex();
  const ep = String(endpoint == null ? 'category:all' : endpoint);

  if (ep.startsWith('search:')) {
    return search(ep.slice('search:'.length), page);
  }

  const kind = ep.startsWith('category:') ? ep.slice('category:'.length) : ep;

  let list = [];
  if (kind === 'all') {
    list = streamList;
  } else if (kind === 'live') {
    list = streamList.filter(isLiveNow);
  } else {
    list = streamList.filter((s) => s.category === kind);
  }

  const start = (Math.max(1, page) - 1) * PAGE_SIZE;
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

export async function search(query, page = 1) {
  const q = String(query == null ? '' : query).trim();
  if (q.length < 2) {
    return { results: [], hasMore: false, page: 1, total_pages: 0, total_results: 0 };
  }
  await ensureIndex();

  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matching = streamList.filter((s) => {
    const haystacks = [s.name, s.tag, s.source_tag, s.category, s.uri_name]
      .map((h) => String(h == null ? '' : h).toLowerCase())
      .filter(Boolean);
    return words.every((w) => haystacks.some((h) => h.includes(w)));
  });

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

export async function getDetails(id, mediaType) {
  const want = String(id == null ? '' : id);
  await ensureIndex();

  let stream = resolveStream(want);
  if (!stream && want.startsWith('stream:')) stream = resolveStream(want.slice(7));

  if (!stream) {
    stream = { id: want, name: 'Stream', category: 'Sports', tag: null, source_tag: null, poster: null, starts_at: null, ends_at: null, always_live: false, iframe: null, substreams: [] };
  }

  const live = isLiveNow(stream);
  const start = stream.starts_at ? Number(stream.starts_at) * 1000 : null;
  const status = stream.always_live
    ? 'Live'
    : live
    ? 'Live'
    : start && start > Date.now()
    ? 'Upcoming'
    : start
    ? 'Finished'
    : null;

  const castList = [];
  if (stream.source_tag) {
    castList.push({ id: 'source', name: stream.source_tag, character: 'Source', order: 0 });
  }

  return {
    id: want,
    media_type: 'sport',
    title: stream.name || 'Stream',
    name: stream.name || 'Stream',
    overview: [stream.tag, stream.source_tag].filter(Boolean).join(' · ') || (stream.category || ''),
    poster_url: stream.poster || null,
    backdrop_url: stream.poster || null,
    release_date: isoDate(stream.starts_at),
    release_year: yearOf(stream.starts_at),
    genres: [
      {
        id: stream.category || 'Sports',
        name: stream.category || 'Sports',
        type: 'sport',
        title: stream.category || 'Sports',
        endpoint: `category:${stream.category || 'Sports'}`,
      },
    ],
    cast: castList,
    status: status,
    extra: stream.iframe ? { web_url: stream.iframe } : null,
  };
}

function collectServers(stream) {
  const out = [];
  if (!stream) return out;
  if (stream.iframe) {
    out.push({
      id: String(stream.id),
      name: stream.source_tag || stream.tag || 'Main',
      iframe: stream.iframe,
    });
  }
  const subs = Array.isArray(stream.substreams) ? stream.substreams : [];
  for (const sub of subs) {
    if (!sub || !sub.iframe) continue;
    out.push({
      id: String(sub.id != null ? sub.id : sub.uri_name),
      name: sub.source_tag || sub.tag || 'Alt',
      iframe: sub.iframe,
    });
  }
  const seen = new Set();
  const deduped = [];
  for (const s of out) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    deduped.push(s);
  }
  return deduped;
}

export async function getStreams(metadata) {
  await ensureIndex();
  const stream = resolveStreamFromMetadata(metadata);
  if (!stream) return { providers: [], subtitles: [] };

  const servers = collectServers(stream).map((s) => ({
    id: s.id,
    name: s.name,
  }));

  if (servers.length === 0) return { providers: [], subtitles: [] };

  return {
    providers: [
      {
        id: 'ppv',
        name: 'PPV',
        logo: LOGO,
        servers,
      },
    ],
    subtitles: [],
  };
}

function originOf(url) {
  const m = /^(https?:\/\/[^/?#]+)/i.exec(String(url || ''));
  return m ? m[1] : '';
}

function streamCacheKey(iframe) {
  return `ppv:stream:${iframe}`;
}

async function cachedStream(iframe) {
  try {
    const raw = await storage.get(streamCacheKey(iframe));
    if (!raw || typeof raw !== 'object' || !raw.url) return null;
    if (Date.now() - (raw.cachedAt || 0) > STREAM_CACHE_TTL_MS) return null;
    return { url: raw.url, headers: raw.headers || {} };
  } catch (_) {
    return null;
  }
}

async function cacheStream(iframe, entry) {
  try {
    await storage.set(streamCacheKey(iframe), {
      url: entry.url,
      headers: entry.headers || {},
      cachedAt: Date.now(),
    });
  } catch (_) {}
}

export async function getStreamSources(metadata, providerId, serverId) {
  await ensureIndex();
  const stream = resolveStreamFromMetadata(metadata);
  if (!stream) return { sources: [], subtitles: [] };

  const server = collectServers(stream).find((s) => String(s.id) === String(serverId));
  if (!server || !server.iframe) {
    console.warn(`PPV: no server "${serverId}" for stream ${stream.id}`);
    return { sources: [], subtitles: [] };
  }

  const iframe = server.iframe;

  const hit = await cachedStream(iframe);
  if (hit) {
    return {
      sources: [
        {
          url: hit.url,
          quality: 'HD',
          label: server.name,
          stream_type: 'hls',
          headers: hit.headers,
          headers_required: true,
        },
      ],
      subtitles: [],
    };
  }

  let requests = [];
  try {
    const res = await webview.monitor(iframe, null, null, 5000);
    requests = Array.isArray(res && res.requests) ? res.requests : [];
  } catch (e) {
    console.error('PPV: webview monitor failed for', iframe, '-', e && e.message ? e.message : e);
    return { sources: [], subtitles: [] };
  }

  const m3u8s = requests.filter((r) => typeof r?.url === 'string' && r.url.toLowerCase().split('#')[0].split('?')[0].endsWith('.m3u8'));
  const pick = m3u8s.find((r) => /master|playlist|index/i.test(r.url)) || m3u8s[0];
  if (!pick || !pick.url) {
    console.warn('PPV: no .m3u8 intercepted for', iframe);
    return { sources: [], subtitles: [] };
  }

  const headers = (pick.headers && typeof pick.headers === 'object') ? Object.assign({}, pick.headers) : {};

  const embedOrigin = originOf(iframe);
  if (embedOrigin) {
    const has = (name) => Object.keys(headers).some((k) => k.toLowerCase() === name);
    if (!has('referer')) headers.Referer = `${embedOrigin}/`;
    if (!has('origin')) headers.Origin = embedOrigin;
  }

  const entry = { url: pick.url, headers };
  await cacheStream(iframe, entry);

  console.log('PPV: resolved m3u8 ->', entry.url);

  return {
    sources: [
      {
        url: entry.url,
        quality: 'HD',
        label: server.name,
        stream_type: 'hls',
        headers: entry.headers,
        headers_required: true,
      },
    ],
    subtitles: [],
  };
}

