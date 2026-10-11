// Open Extractors Plugin
// Exposes extraction functions for other plugins to use

// =========================
// Internal Helpers
// =========================

async function fetchWithRetry(url, maxRetries = 3, extraHeaders = {}) {
  const config = await pluginStorage.get() || {};
  const timeout = (config.timeout || 30) * 1000;
  const userAgent = config.user_agent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await http.get(url, {
        headers: { 'User-Agent': userAgent, ...extraHeaders }
      });
      return response;
    } catch (e) {
      lastError = e;
      await delay(1000 * (i + 1));
    }
  }
  throw lastError;
}

function extractFromHtml(html, regex, fallback) {
  const match = html.match(regex);
  return match ? match[1] : fallback;
}

/**
 * Normalizes an extractor argument into `{ url, id, name }`.
 *
 * Canonical call is an embed object `{ url, name?, id? }`; a bare url string is
 * still accepted for convenience. A missing `id` gets a random one so every
 * returned server is addressable. A missing `name` stays null here and is
 * filled by [asServer] with the extractor's own default name.
 */
function normalizeEmbed(embed) {
  const raw = typeof embed === 'string' ? { url: embed } : embed || {};
  return {
    url: raw.url,
    id: raw.id || randomId(),
    name: raw.name || null,
  };
}

/** Builds the server contract: `{ id, name, sources, subtitles }`. */
function asServer(embed, defaultName, sources, subtitles = []) {
  return {
    id: embed.id,
    name: embed.name || defaultName,
    sources,
    subtitles,
  };
}

/** Short random id, used when an embed arrives without one. */
function randomId() {
  return (
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  );
}

/**
 * Best-effort subtitle tracks from an unpacked player script. VidHide /
 * StreamWish-family players declare tracks as `{ file: "…/English.vtt",
 * label: "English" }` or a bare `"subtitle": "…vtt"`. Returns [] when none
 * are found, so callers can always pass the result through.
 */
function subtitleTracksFrom(unpacked, base) {
  if (!unpacked) return [];
  const tracks = [];
  const seen = new Set();

  const push = (rawUrl, label) => {
    if (!rawUrl) return;
    const url = absolutize(rawUrl, base);
    if (!url || seen.has(url)) return;
    seen.add(url);
    const path = url.split('?')[0].toLowerCase();
    tracks.push({
      label: label || 'Subtitle',
      url,
      language: null,
      format: path.endsWith('.srt') ? 'srt' : 'vtt',
    });
  };

  const trackRe =
    /\{[^{}]*?file\s*:\s*["']([^"']+\.(?:vtt|srt)(?:\?[^"']*)?)["'][^{}]*?\}/gi;
  let m;
  while ((m = trackRe.exec(unpacked))) {
    const labelMatch = m[0].match(/label\s*:\s*["']([^"']+)["']/i);
    push(m[1], labelMatch ? labelMatch[1] : null);
  }

  const simpleRe =
    /["']?subtitle["']?\s*:\s*["']([^"']+\.(?:vtt|srt)(?:\?[^"']*)?)["']/gi;
  while ((m = simpleRe.exec(unpacked))) push(m[1], null);

  return tracks;
}

// =========================
// Exposed Methods
// =========================

/**
 * Extract DoodStream video URL
 *
 * DoodStream rotates through many domains (dood.watch, dood.li, dsvplay.com,
 * playmogo.com, do7go.com, d000d.com, vide0.net, …) — they are all the same
 * backend, and the embed host 302s to whichever server currently serves it.
 * The playable url is a signed redirect built in two hops:
 *
 *   1. the embed page (on the *redirected* host) carries
 *        $.get('/pass_md5/<hash>/<token>', function (data) {
 *          dsplayer.src({ src: data + makePlay() });
 *        });
 *   2. GET <finalOrigin>/pass_md5/… (Referer: the final page) answers with a
 *      CDN prefix; `makePlay()` appends 10 random alphanumerics and
 *      `?token=<token>[&expiry=<now>]`.
 *
 * The pass_md5 endpoint must be called on the redirected host (the original
 * one is Cloudflare-blocked), so the extractor reads the post-redirect url
 * from the http response. The file is referer-gated too: the CDN answers 206
 * only when the site is the referer, hence the source carries that header.
 *
 * @param {{url: string, id?: string, name?: string}} embed - embed (or bare url)
 * @returns {Promise<{id: string, name: string, sources: Array, subtitles: Array}>}
 */
export async function extractDoodstream(embed) {
  const e = normalizeEmbed(embed);
  if (!e.url) throw new Error('No embed url given');

  const url = String(e.url).replace('/d/', '/e/');
  let html = '';
  let finalUrl = url;

  // 1) Plain HTTP first — the embed is a static page. Redirects are followed,
  //    and `page.url` is the host that actually served it.
  try {
    const page = await fetchWithRetry(url, 3, { Referer: url });
    html = typeof page?.data === 'string' ? page.data : '';
    if (page?.url) finalUrl = page.url;
  } catch (_) {
    // fall through to the browser fallback
  }

  let md5Path = doodMd5Path(html);

  // 2) Fallback: render the embed in a real browser engine (also survives a
  //    Cloudflare interstitial) and take the final main-frame url from it.
  if (!md5Path) {
    try {
      const page = await webview.monitor(url, null, { Referer: url }, 5000);
      html = typeof page?.data === 'string' ? page.data : '';
      finalUrl = lastMainFrame(page?.requests) || finalUrl;
      md5Path = doodMd5Path(html);
    } catch (e) {
      console.warn(`DoodStream webview fallback failed: ${e?.message}`);
    }
  }

  if (!md5Path) {
    throw new Error(`DoodStream extraction failed: no pass_md5 in ${url}`);
  }

  const finalBase = originOf(finalUrl) || originOf(url);
  const md5Url = finalBase + md5Path;
  const token = doodToken(html) || md5Path.substring(md5Path.lastIndexOf('/') + 1);

  const md5 = await fetchWithRetry(md5Url, 3, { Referer: finalUrl });
  const prefix = typeof md5?.data === 'string' ? md5.data.trim() : '';
  if (!/^https?:\/\//.test(prefix)) {
    throw new Error(
      `DoodStream: pass_md5 did not return a url (got "${prefix.slice(0, 40)}")`
    );
  }

  // Mirror the player's makePlay(): 10 random alphanumerics + token (+ expiry
  // when this deployment signs with it).
  const play = prefix + randomChars(10) +
    `?token=${token}` +
    (html.includes('expiry=') ? `&expiry=${Date.now()}` : '');

  return asServer(e, 'DoodStream', [
    {
      url: play,
      quality: 'auto',
      label: 'DoodStream',
      stream_type: streamTypeOf(play),
      headers: finalBase ? { Referer: `${finalBase}/` } : {},
    },
  ]);
}

/** `/pass_md5/<hash>/<token>` path from the embed page, or null. */
function doodMd5Path(html) {
  const m = (html || '').match(/\/pass_md5\/[^\s'"<>]+/);
  return m ? m[0] : null;
}

/**
 * The token the player signs with. Normally hardcoded in makePlay(); falls
 * back to the pass_md5 path's last segment (they match on current builds).
 */
function doodToken(html) {
  const m = (html || '').match(/makePlay[\s\S]{0,300}?token=([A-Za-z0-9]+)/);
  return m ? m[1] : null;
}

/** Site origin (`scheme://host`) of a URL, or null. */
function originOf(url) {
  const m = String(url || '').match(/^https?:\/\/[^/]+/i);
  return m ? m[0] : null;
}

/** `count` random characters from the alphabet DoodStream's makePlay uses. */
function randomChars(count) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < count; i++) {
    out += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return out;
}

/**
 * Extract Streamtape video URL
 *
 * @param {{url: string, id?: string, name?: string}} embed - embed (or bare url)
 * @returns {Promise<{id: string, name: string, sources: Array, subtitles: Array}>}
 */
export async function extractStreamtape(embed) {
  const e = normalizeEmbed(embed);
  if (!e.url) throw new Error('No embed url given');
  try {
    const html = await fetchWithRetry(e.url);
    
    // Streamtape uses a specific pattern
    const match = html.data.match(/document\.write\("(.*?)"\)/);
    if (match) {
      // Extract from the encoded string
      const decoded = JSON.parse(`"${match[1]}"`);
      const videoMatch = decoded.match(/https:\/\/[^"]+\.mp4/);
      if (videoMatch) {
        return asServer(e, 'Streamtape', [
          {
            url: videoMatch[0],
            quality: 'auto',
            stream_type: streamTypeOf(videoMatch[0]),
          },
        ]);
      }
    }
    
    throw new Error('No video found in Streamtape page');
  } catch (e2) {
    console.error('Failed to extract Streamtape:', e2.message);
    throw new Error(`Streamtape extraction failed: ${e2.message}`);
  }
}

/**
 * Extract Streamwish video URL
 *
 * streamwish.to/e/<id> is now only a JS interstitial ("Page is loading,
 * please wait…") that runs an obfuscated /main.js and redirects after ~1-2s
 * to the real player on a rotating host (hgplaycdn.com, playnixes.com, …),
 * which carries the packed JS with the HLS links.
 *
 * Plain HTTP can't follow that JS redirect, so — like the old Flutter
 * scraper — we let a real browser engine do it:
 *   1. Try plain HTTP on the given url and the known player mirrors first
 *      (keeps working when the caller already hands us the final page).
 *   2. Render the embed via webview.monitor, which returns the final page
 *      HTML plus every network request. The last main-frame request is the
 *      final player URL — we unpack the rendered HTML and also re-fetch the
 *      final URL over plain HTTP (least reliance on the webview).
 *
 * @param {{url: string, id?: string, name?: string}} embed - StreamWish embed (or bare url)
 * @returns {Promise<{id: string, name: string, sources: Array, subtitles: Array}>}
 */
export async function extractStreamwish(embed) {
  const e = normalizeEmbed(embed);
  if (!e.url) throw new Error('No embed url given');

  const referer = 'https://streamwish.to/';
  const path = (e.url.match(/^https:\/\/[^/]+([^\s]*)/) || [])[1] || '/';
  const candidates = [e.url];
  for (const host of STREAMWISH_PLAYER_MIRRORS) {
    candidates.push(`https://${host}${path}`);
  }

  // 1) Static pages (already-final url, or a mirror that serves the player
  //    without JS) — fastest path.
  for (const url of candidates) {
    const found = await tryFetchAndUnpack(url, referer, e);
    if (found) return found;
  }

  // 2) Follow the interstitial redirect in a real browser engine.
  try {
    const page = await webview.monitor(
      e.url,
      null,
      { Referer: referer },
      6000
    );

    // The rotating player hosts emit the HLS links relative to their own
    // origin (e.g. /stream/…/master.m3u8), so resolve against the page that
    // carried them — the last main-frame request the webview saw.
    const finalUrl = lastMainFrame(page?.requests) || e.url;

    // The player script also carries its subtitle tracks; unpack once and
    // reuse it for both the HLS link and the tracks.
    const unpacked = page?.data ? unpackPackedBlock(page.data) || page.data : '';
    const subtitles = subtitleTracksFrom(unpacked, finalUrl);

    // Best signal: the exact playlist request the player itself made while
    // the page loaded (already absolute, and authoritative for CDNs that
    // gate on the player's own cookies/referer).
    const playerRequested = lastM3u8Request(page?.requests);
    if (playerRequested) {
      return asServer(
        e,
        'StreamWish',
        [
          {
            url: playerRequested,
            quality: 'auto',
            label: 'StreamWish',
            stream_type: 'hls',
          },
        ],
        subtitles
      );
    }

    const fromHtml = page?.data ? bestHlsLink(unpacked) : null;
    if (fromHtml) {
      return asServer(
        e,
        'StreamWish',
        [
          {
            url: absolutize(fromHtml, finalUrl),
            quality: 'auto',
            label: 'StreamWish',
            stream_type: 'hls',
          },
        ],
        subtitles
      );
    }

    const fromFinal = await tryFetchAndUnpack(finalUrl, referer, e);
    if (fromFinal) return fromFinal;
  } catch (err) {
    console.warn(`StreamWish webview redirect failed: ${err?.message}`);
  }

  throw new Error(`StreamWish extraction failed for ${e.url}`);
}

// hgplaycdn.com (and other mirrors) serve the real player for streamwish;
// the interstitial may also pick any of these at random.
const STREAMWISH_PLAYER_MIRRORS = [
  'hgplaycdn.com',
  'playnixes.com',
];

async function tryFetchAndUnpack(url, referer, embed) {
  try {
    const page = await fetchWithRetry(url, 3, { Referer: referer });
    const html = typeof page?.data === 'string' ? page.data : '';
    const unpacked = unpackPackedBlock(html) || html;
    const hls = bestHlsLink(unpacked);
    if (hls) {
      return asServer(
        embed,
        'StreamWish',
        [
          {
            url: absolutize(hls, url),
            quality: 'auto',
            label: 'StreamWish',
            stream_type: 'hls',
          },
        ],
        subtitleTracksFrom(unpacked, url)
      );
    }
  } catch (_) {
    // keep trying the remaining strategies
  }
  return null;
}

/**
 * Extract FileLions video URL
 *
 * FileLions (the current brand of the old VidHide hoster) serves its embeds
 * across rotating domains (filelions.to, callistanise.com, morencius.com,
 * vidhide.com, …). The embed page is a static JWPlayer page whose packed
 * script assigns HLS playlists to `var links = { hls3, hls4, hls2 }`:
 *
 *   hls4 = /stream/……/master.m3u8          (preferred, often protocol-relative)
 *   hls3 = https://….shot/master.txt        (CDN mirror, transient)
 *   hls2 = https://….m3u8?t=…&s=…&e=…      (CDN mirror, signed)
 *
 * The player itself resolves `links.hls4 || links.hls3 || links.hls2` and
 * falls back on the others when the primary fails. We reuse the same
 * preference order via bestHlsLink() after unpacking the page's packed
 * script; the (usually relative) hls4 path is resolved against the final
 * embed origin. The CDN is referer-gated, so the source carries a Referer
 * header for the same origin.
 *
 * @param {{url: string, id?: string, name?: string}} embed - FileLions embed (or bare url)
 * @returns {Promise<{id: string, name: string, sources: Array, subtitles: Array}>}
 */
export async function extractFilelions(embed) {
  const e = normalizeEmbed(embed);
  if (!e.url) throw new Error('No embed url given');

  const referer = originOf(e.url) ? `${originOf(e.url)}/` : e.url;
  const page = await fetchWithRetry(e.url, 3, { Referer: referer });
  const html = typeof page?.data === 'string' ? page.data : '';
  const finalUrl = page?.url || e.url;
  const finalOrigin = originOf(finalUrl);

  const unpacked = unpackPackedBlock(html) || html;
  const hls = bestHlsLink(unpacked);
  if (!hls) {
    throw new Error(`FileLions extraction failed: no HLS links in ${finalUrl}`);
  }

  return asServer(
    e,
    'FileLions',
    [
      {
        url: absolutize(hls, finalUrl),
        quality: 'auto',
        label: 'FileLions',
        stream_type: 'hls',
        headers: finalOrigin ? { Referer: `${finalOrigin}/` } : {},
      },
    ],
    subtitleTracksFrom(unpacked, finalUrl)
  );
}

/**
 * Extract VidMoly video URL
 *
 * VidMoly (vidmoly.me/.to/.net + the kaembed.net player mirror) serves its
 * embeds as static pages whose inline JWPlayer setup carries the HLS playlist
 * directly:
 *
 *   sources: [{ file: "https://prx-ps-a-1.vmpx.online/hls2/…/master.m3u8?…" }]
 *
 * The embed host (currently kaembed.net via 0123movie.space) may rotate, so
 * the extractor follows redirects and uses the page that actually served the
 * player as the referer base for the (referer-gated) CDN. Subtitle tracks are
 * parsed from the same script when present.
 *
 * @param {{url: string, id?: string, name?: string}} embed - VidMoly embed (or bare url)
 * @returns {Promise<{id: string, name: string, sources: Array, subtitles: Array}>}
 */
export async function extractVidmoly(embed) {
  const e = normalizeEmbed(embed);
  if (!e.url) throw new Error('No embed url given');

  const url = httpify(e.url);
  const page = await fetchWithRetry(url, 3, {
    Referer: originOf(url) || url,
  });
  const html = typeof page?.data === 'string' ? page.data : '';
  const finalUrl = page?.url || url;
  const finalOrigin = originOf(finalUrl);

  const hls = vidmolyHls(html);
  if (!hls) {
    throw new Error(`VidMoly extraction failed: no sources block in ${finalUrl}`);
  }

  return asServer(
    e,
    'Vidmoly',
    [
      {
        url: hls,
        quality: 'auto',
        label: 'Vidmoly',
        stream_type: 'hls',
        headers: finalOrigin ? { Referer: `${finalOrigin}/` } : {},
      },
    ],
    vidmolyTracks(html, finalUrl)
  );
}

/** The JWPlayer HLS from a VidMoly-family page, or null. */
function vidmolyHls(html) {
  const m = (html || '').match(
    /sources\s*:\s*\[\s*\{\s*file\s*:\s*["']([^"']+)["']\s*\}\s*\]/
  );
  return m ? m[1] : null;
}

/** Best-effort subtitle tracks from a VidMoly JWPlayer setup. */
function vidmolyTracks(html, base) {
  return subtitleTracksFrom(html, base);
}

/**
 * Extract UpCloud video URL (the Byse/upcloud embed family)
 *
 * TinyZone/0123movie-branded embeds under `/mv/...` and `/pl/...` resolve to
 * the Byse player (`mfw09.org/e/<code>` — a React SPA fronting a REST API).
 * The static metadata endpoints are plain HTTP:
 *
 *   /api/videos/<code>/embed/details   → 200 JSON
 *   /api/videos/<code>/embed/settings  → 200 JSON
 *   /api/videos/stream/<code>          → 403 unless the request carries the
 *                                        browser context (captcha/fingerprint)
 *
 * So extraction is layered:
 *   1. Follow the embed redirect to the final Byse page and read the code.
 *   2. Try the stream API over plain HTTP (works for items without captcha).
 *   3. Fall back to webview.monitor to render the player and intercept the
 *      media (m3u8/mpd/mp4) request the page fires.
 *
 * @param {{url: string, id?: string, name?: string}} embed - UpCloud embed (or bare url)
 * @returns {Promise<{id: string, name: string, sources: Array, subtitles: Array}>}
 */
export async function extractUpcloud(embed) {
  const e = normalizeEmbed(embed);
  if (!e.url) throw new Error('No embed url given');

  const url = httpify(e.url);
  let html = '';
  let finalUrl = url;
  try {
    const page = await fetchWithRetry(url, 2, { Referer: url });
    html = typeof page?.data === 'string' ? page.data : '';
    if (page?.url) finalUrl = page.url;
  } catch (_) {
    // fall through to the webview fallback
  }

  const code = byseEmbedCode(finalUrl) || byseEmbedCode(url);
  const origin = originOf(finalUrl) || originOf(url);

  // 1) Byse REST player — proof-of-work captcha → encrypted playback → HLS.
  //    Entirely server-side: no browser, interactive captcha or device
  //    attestation required (the player solves/derives everything client-side,
  //    which is reproducible here).
  if (code && origin) {
    try {
      const extracted = await byseExtract(origin, code);
      if (extracted && extracted.sources.length) {
        return asServer(e, 'UpCloud', extracted.sources, extracted.subtitles);
      }
    } catch (err) {
      console.warn(`UpCloud playback API failed: ${err?.message}`);
    }

    // 1b) Legacy direct stream API — cheap when the item has no captcha gate.
    try {
      const api = await fetchWithRetry(
        `${origin}/api/videos/stream/${code}`,
        2,
        {
          Referer: `${origin}/e/${code}`,
          Origin: origin,
          Accept: 'application/json',
        }
      );
      const stream = byseStreamUrl(api?.data);
      if (stream) {
        return asServer(e, 'UpCloud', [
          {
            url: stream,
            quality: 'auto',
            label: 'UpCloud',
            stream_type: streamTypeOf(stream),
            headers: origin ? { Referer: `${origin}/` } : {},
          },
        ]);
      }
    } catch (_) {
      // fall through to the webview fallback
    }
  }

  // 2) Render the player in a real browser engine and intercept the media
  //    request it fires (survives the captcha/fingerprint interstitial).
  try {
    const page = await webview.monitor(
      finalUrl,
      null,
      { Referer: `${origin}/` },
      9000
    );
    const requests = Array.isArray(page?.requests) ? page.requests : [];
    const media = lastMediaRequest(requests);
    if (media) {
      return asServer(e, 'UpCloud', [
        {
          url: media,
          quality: 'auto',
          label: 'UpCloud',
          stream_type: streamTypeOf(media),
        },
      ]);
    }
  } catch (err) {
    console.warn(`UpCloud webview fallback failed: ${err?.message}`);
  }

  throw new Error(`UpCloud extraction failed for ${finalUrl}`);
}

/** The Byse embed/download code from a URL, or null. */
function byseEmbedCode(url) {
  const m = String(url || '').match(
    /\/(?:e|d)\/([A-Za-z0-9_-]+)/
  );
  return m ? m[1] : null;
}

/** Playable src from a Byse stream API payload (string or JSON object). */
function byseStreamUrl(data) {
  if (typeof data === 'string') {
    const m = data.match(/https?:\/\/[^\s"'<>]+/);
    return m && /\.(?:m3u8|m3u|mp4|m4v|mkv|mpd|ts)(?:[?#]|$)/i.test(m[0])
      ? m[0]
      : null;
  }
  if (data && typeof data === 'object') {
    for (const key of ['url', 'stream_url', 'playlist_url', 'file']) {
      const value = data[key];
      if (typeof value === 'string' && value) return value;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Byse / UpCloud REST player (mfw09.org `e/<code>`) decryption pipeline
// ---------------------------------------------------------------------------
// The player gates its HLS manifest behind a proof-of-work "captcha" and an
// AES-256-GCM encrypted payload. Both are computed client-side, so the whole
// flow is reproducible over plain HTTP:
//
//   1. POST /api/videos/<code>/embed/captcha         → {pow_nonce,pow_difficulty,pow_token}
//   2.                solve the PoW (custom hash → leading zero bits)
//   3. POST /api/videos/<code>/embed/captcha/verify   → {status:"ok", token}
//   4. POST /api/videos/<code>/embed/playback         → {playback:{key_parts,iv,payload,version}}
//      header X-Captcha-Token: <token>, body {"fingerprint":{}}
//   5. AES-256-GCM decrypt the payload with the assembled key
//
// Only the GCM CTR keystream is needed to decrypt, so a compact pure-JS AES is
// used — the FJS runtime exposes no WebCrypto.

/** Runs the full Byse captcha→playback→decrypt flow. `{sources,subtitles}` or null. */
async function byseExtract(origin, code) {
  const apiBase = `${origin}/api/videos/${code}`;
  const baseHeaders = {
    Origin: origin,
    Referer: `${origin}/e/${code}`,
    Accept: 'application/json, text/plain, */*',
  };
  const jsonHeaders = { ...baseHeaders, 'Content-Type': 'application/json' };

  const challenge = await http.post(`${apiBase}/embed/captcha`, '{}', {
    headers: jsonHeaders,
  });
  const chal = challenge?.data;
  if (!chal || !chal.pow_nonce) return null;

  const solution = byseSolvePow(chal.pow_nonce, chal.pow_difficulty || 0);
  if (solution == null) return null;

  const verify = await http.post(
    `${apiBase}/embed/captcha/verify`,
    JSON.stringify({ pow_token: chal.pow_token, solution }),
    { headers: jsonHeaders }
  );
  const verified = verify?.data;
  if (!verified || verified.status !== 'ok' || !verified.token) return null;

  const playback = await http.post(
    `${apiBase}/embed/playback`,
    JSON.stringify({ fingerprint: {} }),
    { headers: { ...jsonHeaders, 'X-Captcha-Token': verified.token } }
  );
  const blob = playback?.data?.playback;
  if (!blob) return null;

  const config = byseDecryptPayload(blob);
  if (!config) return null;

  const referer = { Referer: `${origin}/` };
  const sources = (Array.isArray(config.sources) ? config.sources : [])
    .filter((s) => s && typeof s.url === 'string' && s.url)
    .map((s) => ({
      url: s.url,
      quality: s.quality || 'auto',
      label: s.label || 'UpCloud',
      stream_type: byseSourceType(s),
      headers: referer,
    }));
  if (!sources.length) return null;

  const subtitles = (Array.isArray(config.tracks) ? config.tracks : [])
    .filter((t) => t && typeof t.url === 'string' && t.url)
    .map((t) => ({
      label: t.title || t.language || 'Subtitle',
      url: t.url,
      language: t.language || null,
      format: /\.srt(?:[?#]|$)/i.test(t.url) ? 'srt' : 'vtt',
    }));

  return { sources, subtitles };
}

/** HLS/DASH/file hint for a decrypted Byse source entry. */
function byseSourceType(source) {
  const mime = String(source?.mime_type || '').toLowerCase();
  const url = String(source?.url || '');
  if (mime.includes('mpegurl') || /\.m3u8(?:[?#]|$)/i.test(url)) return 'hls';
  if (mime.includes('dash') || /\.mpd(?:[?#]|$)/i.test(url)) return 'dash';
  return streamTypeOf(url);
}

/** Decrypts a Byse playback blob → `{sources,tracks,poster_url,…}` or null. */
function byseDecryptPayload(blob) {
  if (!blob || !Array.isArray(blob.key_parts) || blob.key_parts.length === 0) {
    return null;
  }
  const key = byseAssembleKey(blob);
  const iv = base64UrlToBytes(blob.iv);
  const sealed = base64UrlToBytes(blob.payload);
  if (!key.length || iv.length !== 12 || sealed.length <= 16) return null;
  const plaintext = aes256Ctr(key, iv, sealed.subarray(0, sealed.length - 16));
  try {
    return JSON.parse(utf8Decode(plaintext));
  } catch (_) {
    return null;
  }
}

/**
 * Assembles the AES key from `key_parts`. The server stamps the payload with a
 * `version`; the player selects the two real parts via `[n, 31-n]` and
 * concatenates them (the other parts are decoys). Falls back to every part when
 * the version is absent or out of range.
 */
function byseAssembleKey(blob) {
  const parts = Array.isArray(blob.key_parts) ? blob.key_parts : [];
  const n = parseInt(String(blob.version ?? '').trim(), 10);
  let chosen = parts;
  if (Number.isInteger(n) && n >= 1 && n <= 20) {
    const picked = [n, 31 - n]
      .filter((i) => i >= 1 && i <= parts.length)
      .map((i) => parts[i - 1])
      .filter((s) => typeof s === 'string' && s.length > 0);
    if (picked.length > 0) chosen = picked;
  }
  const decoded = chosen
    .filter((s) => typeof s === 'string' && s.length > 0)
    .map(base64UrlToBytes);
  const total = decoded.reduce((a, p) => a + p.length, 0);
  const key = new Uint8Array(total);
  let offset = 0;
  for (const part of decoded) {
    key.set(part, offset);
    offset += part.length;
  }
  return key;
}

/** Solves the Byse proof-of-work (returns the nonce string, or null on timeout). */
function byseSolvePow(nonce, difficulty, timeoutMs = 25000) {
  const bits = Number(difficulty) || 0;
  if (bits <= 0) return '0';
  const prefix = `${nonce}:`;
  const started = Date.now();
  let counter = 0;
  for (;;) {
    for (let i = 0; i < 1024; i++) {
      if (byseLeadingZeroBits(byseHash(prefix + counter)) >= bits) {
        return String(counter);
      }
      counter += 1;
    }
    if (Date.now() - started > timeoutMs) return null;
  }
}

// The player's custom 256-bit hash (4-word state, 512-word sponge, ARX mixing).
// Not SHA-256, despite the API's misleading `sha256-leading-zero-bits` label.
const BYSE_SCRATCH = new Uint32Array(512);

function byseHash(str) {
  const bytes = asciiBytes(str);
  const s = new Uint32Array([1779033703, 3144134277, 1013904242, 2773480762]);
  for (let i = 0; i < bytes.length; i++) {
    s[0] = (s[0] + bytes[i]) >>> 0;
    s[0] = rotr(s[0], 7);
    bysePermute(s);
  }
  for (let i = 0; i < 8; i++) bysePermute(s);

  const r = BYSE_SCRATCH;
  for (let i = 0; i < 512; i++) {
    bysePermute(s);
    r[i] = (s[0] ^ s[2]) >>> 0;
  }
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 512; j++) {
      const a = r[j] & 511;
      let c = (r[j] + r[a]) >>> 0;
      c = rotr(c, 13);
      c = (c ^ Math.imul(r[(j + 1) & 511], 2654435761)) >>> 0;
      r[j] = c;
      s[0] = (s[0] ^ c) >>> 0;
      bysePermute(s);
    }
  }

  const out = new Uint32Array(8);
  const stride = 64; // 512 / 8
  for (let i = 0; i < 8; i++) {
    bysePermute(s);
    let v = s[0];
    const base = i * stride;
    for (let j = 0; j < stride; j++) {
      const d = r[base + j];
      v = (v + d) >>> 0;
      v = rotr(v, 5);
      v = (v ^ Math.imul(d, 2246822519)) >>> 0;
    }
    out[i] = (v ^ s[2]) >>> 0;
  }
  return out;
}

function bysePermute(s) {
  s[0] = (s[0] + s[1]) >>> 0;
  s[3] = rotr(s[3] ^ s[0], 16);
  s[2] = (s[2] + s[3]) >>> 0;
  s[1] = rotr(s[1] ^ s[2], 12);
  s[0] = (s[0] + s[1]) >>> 0;
  s[3] = rotr(s[3] ^ s[0], 8);
  s[2] = (s[2] + s[3]) >>> 0;
  s[1] = rotr(s[1] ^ s[2], 7);
}

function byseLeadingZeroBits(words) {
  let bits = 0;
  for (let i = 0; i < words.length; i++) {
    if (words[i] === 0) {
      bits += 32;
      continue;
    }
    return bits + Math.clz32(words[i]);
  }
  return bits;
}

function rotr(value, shift) {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

function asciiBytes(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) bytes[i] = str.charCodeAt(i) & 255;
  return bytes;
}

// --- AES-256 CTR (GCM keystream only) ---------------------------------------

const AES_SBOX = [
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
];
const AES_RCON = [0x00,0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36];

/** Decrypts AES-256-GCM ciphertext bytes via CTR (counter starts at 2). */
function aes256Ctr(key, iv, data) {
  const { words, rounds } = aesExpandKey(key);
  const counter = new Uint8Array(16);
  counter.set(iv);
  const out = new Uint8Array(data.length);
  let block = 2;
  for (let offset = 0; offset < data.length; offset += 16) {
    counter[12] = (block >>> 24) & 255;
    counter[13] = (block >>> 16) & 255;
    counter[14] = (block >>> 8) & 255;
    counter[15] = block & 255;
    const keystream = aesEncryptBlock(counter, words, rounds);
    const n = Math.min(16, data.length - offset);
    for (let i = 0; i < n; i++) out[offset + i] = data[offset + i] ^ keystream[i];
    block = (block + 1) >>> 0;
  }
  return out;
}

function aesExpandKey(key) {
  const nk = key.length / 4;
  const rounds = nk + 6;
  const words = [];
  for (let i = 0; i < nk; i++) {
    words.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
  }
  for (let i = nk; i < 4 * (rounds + 1); i++) {
    let t = words[i - 1].slice();
    if (i % nk === 0) {
      t = [t[1], t[2], t[3], t[0]].map((x) => AES_SBOX[x]);
      t[0] ^= AES_RCON[i / nk];
    } else if (nk > 6 && i % nk === 4) {
      t = t.map((x) => AES_SBOX[x]);
    }
    words.push(words[i - nk].map((x, j) => x ^ t[j]));
  }
  return { words, rounds };
}

function aesEncryptBlock(input, words, rounds) {
  const s = input.slice();
  aesAddKey(s, words, 0);
  for (let round = 1; round < rounds; round++) {
    for (let i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
    const t = s.slice();
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) s[4 * col + row] = t[4 * ((col + row) % 4) + row];
    }
    aesMixColumns(s);
    aesAddKey(s, words, round);
  }
  for (let i = 0; i < 16; i++) s[i] = AES_SBOX[s[i]];
  const t = s.slice();
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 4; col++) s[4 * col + row] = t[4 * ((col + row) % 4) + row];
  }
  aesAddKey(s, words, rounds);
  return s;
}

function aesAddKey(state, words, round) {
  for (let col = 0; col < 4; col++) {
    const word = words[4 * round + col];
    for (let row = 0; row < 4; row++) state[4 * col + row] ^= word[row];
  }
}

function aesMixColumns(state) {
  for (let col = 0; col < 4; col++) {
    const a0 = state[4 * col];
    const a1 = state[4 * col + 1];
    const a2 = state[4 * col + 2];
    const a3 = state[4 * col + 3];
    state[4 * col] = gfMul(a0, 2) ^ gfMul(a1, 3) ^ a2 ^ a3;
    state[4 * col + 1] = a0 ^ gfMul(a1, 2) ^ gfMul(a2, 3) ^ a3;
    state[4 * col + 2] = a0 ^ a1 ^ gfMul(a2, 2) ^ gfMul(a3, 3);
    state[4 * col + 3] = gfMul(a0, 3) ^ a1 ^ a2 ^ gfMul(a3, 2);
  }
}

function gfMul(a, b) {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p & 0xff;
}

// --- base64url / utf-8 ------------------------------------------------------

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64UrlToBytes(str) {
  const normalized = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of normalized) {
    if (ch === '=') break;
    const value = B64_ALPHABET.indexOf(ch);
    if (value < 0) continue;
    buffer = (buffer << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function utf8Decode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i];
    if (b < 0x80) {
      out += String.fromCharCode(b);
      i += 1;
    } else if (b < 0xe0) {
      out += String.fromCharCode(((b & 0x1f) << 6) | (bytes[i + 1] & 0x3f));
      i += 2;
    } else if (b < 0xf0) {
      out += String.fromCharCode(
        ((b & 0x0f) << 12) | ((bytes[i + 1] & 0x3f) << 6) | (bytes[i + 2] & 0x3f)
      );
      i += 3;
    } else {
      const cp =
        ((b & 0x07) << 18) |
        ((bytes[i + 1] & 0x3f) << 12) |
        ((bytes[i + 2] & 0x3f) << 6) |
        (bytes[i + 3] & 0x3f);
      const c = cp - 0x10000;
      out += String.fromCharCode(0xd800 + (c >> 10), 0xdc00 + (c & 0x3ff));
      i += 4;
    }
  }
  return out;
}

/**
 * The last media request the player made while the page loaded (HLS playlist,
 * DASH manifest or direct file) — the authoritative playable url.
 */
function lastMediaRequest(requests) {
  if (!Array.isArray(requests)) return null;
  const mediaRe = /\.(?:m3u8|m3u|mpd|mp4|m4v|mkv|ts)(?:[?#]|$)\/|\/stream\//i;
  for (let i = requests.length - 1; i >= 0; i--) {
    const req = requests[i];
    if (!req || typeof req.url !== 'string') continue;
    const u = req.url;
    if (u.includes('.m3u8') || u.includes('/stream/') || mediaRe.test(u)) {
      return u;
    }
  }
  return null;
}

/** Forces an http(s) scheme onto a bare/relative embed url. */
function httpify(url) {
  let u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  return u;
}

/** Last main-frame request URL captured by webview.monitor, or null. */
function lastMainFrame(requests) {
  if (!Array.isArray(requests)) return null;
  for (let i = requests.length - 1; i >= 0; i--) {
    const req = requests[i];
    if (req && req.isMainFrame === true && typeof req.url === 'string') {
      return req.url;
    }
  }
  return null;
}

/** The last media (playlist) request the player made while the page loaded. */
function lastM3u8Request(requests) {
  if (!Array.isArray(requests)) return null;
  for (let i = requests.length - 1; i >= 0; i--) {
    const req = requests[i];
    if (!req || typeof req.url !== 'string') continue;
    const u = req.url;
    if (u.includes('.m3u8') || u.includes('/stream/')) return u;
  }
  return null;
}

/** Turns a possibly-relative media URL into an absolute one using [base]. */
function absolutize(url, base) {
  if (!url || !base) return url;
  try {
    return new URL(url, base).toString();
  } catch (_) {
    return url;
  }
}

/**
 * Best-effort container hint for a resolved media URL, so hint-dependent
 * players (better_player/ExoPlayer) can open extension-less streams.
 * Returns 'hls', 'dash', 'mpegts' or 'other' (direct files: mp4/mkv/…).
 * Extractors that know the format semantically should pass it explicitly
 * instead of relying on this.
 */
function streamTypeOf(url) {
  const path = String(url || '')
    .split('?')[0]
    .split('#')[0]
    .toLowerCase();
  if (path.endsWith('.m3u8') || path.endsWith('.m3u')) return 'hls';
  if (path.endsWith('.mpd')) return 'dash';
  if (path.endsWith('.ts')) return 'mpegts';
  return 'other';
}

/**
 * Extract MixDrop video URL
 *
 * mxdrop/mixdrop embeds are static pages whose packed script assigns a signed
 * direct .mp4 on mxcontent.net to MDCore.wurl (typically protocol-relative,
 * e.g. //2.mxcontent.net/v2/<id>.mp4?s=..&e=..&_t=..). Unlike StreamWish there
 * is no JS interstitial to follow — the wurl is authored straight into the
 * page — so plain HTTP + the same Dean Edwards unpacker is enough.
 *
 * @param {{url: string, id?: string, name?: string}} embed - MixDrop embed (or bare url)
 * @returns {Promise<{id: string, name: string, sources: Array, subtitles: Array}>}
 */
export async function extractMixdrop(embed) {
  const e = normalizeEmbed(embed);
  if (!e.url) throw new Error('No embed url given');

  const pageUrl = normalizeMixdropUrl(e.url);
  const origin = (pageUrl.match(/^https?:\/\/[^/]+/) || [])[0] || '';
  const page = await fetchWithRetry(pageUrl, 3, { Referer: `${origin}/` });
  const html = typeof page?.data === 'string' ? page.data : '';

  const wurl = mixdropWurl(html);
  if (!wurl) {
    throw new Error(`MixDrop extraction failed: no MDCore.wurl in ${pageUrl}`);
  }

  return asServer(e, 'MixDrop', [
    {
      url: absolutize(wurl, pageUrl),
      quality: 'auto',
      label: 'MixDrop',
      stream_type: streamTypeOf(wurl),
      // mxcontent.net serves the signed file only when the request carries the
      // embed page as referer; the app's player sends it via source headers.
      headers: origin ? { Referer: `${origin}/` } : {},
    },
  ]);
}

/** Cleans an embed url: force https, /f/<id> → /e/<id>, drop query/fragment. */
function normalizeMixdropUrl(url) {
  let u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) u = `https://${u}`;
  u = u.replace(/^http:/i, 'https:');
  u = u.replace(/\/f\//, '/e/');
  return u.split('?')[0].split('#')[0];
}

/** Finds MDCore.wurl in the (possibly packed) page html; null when absent. */
function mixdropWurl(html) {
  if (!html) return null;
  // Try the literal wurl first (already-unpacked page), then unpack the packer.
  const unpacked = unpackPackedBlock(html) || html;
  const m = unpacked.match(/MDCore\.wurl\s*=\s*["']([^"']+)["']/);
  return m ? m[1].trim() : null;
}

/**
 * Unpack the carefully-detected Dean Edwards packer block used by hgplaycdn
 * embeds (barebones variant, no eval involved — just token replacement).
 *
 *   eval(function(p,a,c,k,e,d){while(c--)if(k[c])p=p.replace(
 *     new RegExp('\\b'+c.toString(a)+'\\b','g'),k[c]);return p}
 *   ('PACKED', BASE, COUNT, 'word0|word1|…'.split('|')[, 0, {}]))
 *
 * BASE/COUNT vary per deployment (seen 62/45 and 36/484) and the trailing
 * `,0,{}` args are optional, so the tail stays loose.
 */
function unpackPackedBlock(source) {
  const m = (source || '').match(
    /function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('((?:[^'\\]|\\.)*)',\s*(\d+),\s*(\d+),\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)(?:\s*,\s*\d+\s*,\s*\{\s*\})?\)+/
  );
  if (!m) return null;

  const packed = m[1];
  const base = parseInt(m[2], 10) || 62;
  const count = parseInt(m[3], 10) || 0;
  const words = m[4].split('|');

  let out = packed;
  for (let i = 0; i < count; i++) {
    const word = words[i];
    if (!word) continue;
    // \b boundaries stop a short token matching inside a longer word (e.g.
    // token "a" inside "master"); the replacement function also keeps
    // dictionary words containing "$" safe.
    out = out.replace(
      new RegExp('\\b' + i.toString(base) + '\\b', 'g'),
      () => word
    );
  }
  return out;
}

/**
 * Picks the playable HLS playlist out of an unpacked StreamWish player
 * script. The player itself resolves `links.hls4 || links.hls3 || links.hls2`;
 * we prefer a real .m3u8 over the .txt variant (whose CDN hosts rotate often).
 */
function bestHlsLink(unpacked) {
  const linksMatch = unpacked.match(/var\s+links\s*=\s*(\{[\s\S]*?\});/);
  const links = {};
  if (linksMatch) {
    try {
      Object.assign(links, JSON.parse(linksMatch[1]));
    } catch {
      // fall through to per-key regex below
    }
  }

  const pick = (key) => links[key] && typeof links[key] === 'string'
    ? links[key]
    : (unpacked.match(
        new RegExp(`["']?${key}["']?\\s*:\\s*["']([^"']+)["']`)
      ) || [])[1] || null;

  const candidates = [];
  for (const key of ['hls4', 'hls3', 'hls2']) {
    const url = pick(key);
    if (url) candidates.push(url);
  }
  if (!candidates.length) return null;

  const isM3u8 = (url) => url.split('?')[0].endsWith('.m3u8');
  candidates.sort((a, b) => (isM3u8(a) ? 0 : 1) - (isM3u8(b) ? 0 : 1));
  return candidates[0];
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extract Google Drive video URL
 * @param {{url: string, id?: string, name?: string}} embed - Drive share/embed (or bare url)
 * @returns {Promise<{id: string, name: string, sources: Array, subtitles: Array}>}
 */
export async function extractGDrive(embed) {
  const e = normalizeEmbed(embed);
  if (!e.url) throw new Error('No embed url given');

  const page = await fetchWithRetry(e.url);
  const html = typeof page?.data === 'string' ? page.data : '';
  // Google Drive folder embeds expose the item ids; the direct file link needs
  // the /uc?export=download&id=<id> form.
  const idMatch = html.match(/[\\?&]id=([\w-]+)/);
  if (idMatch) {
    return asServer(e, 'GDrive', [
      {
        url: `https://drive.google.com/uc?export=download&id=${idMatch[1]}`,
        quality: 'auto',
        stream_type: 'other',
      },
    ]);
  }
  throw new Error(`GDrive extraction failed: no file id in ${e.url}`);
}