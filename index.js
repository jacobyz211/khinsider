/**
 * Eclipse Music addon — KHInsider (downloads.khinsider.com)
 *
 * ROOT CAUSE FOUND (per eclipsemusic.app/docs schema):
 * Track objects require id, title, AND artist. Album track objects
 * were missing "artist" entirely, and sent "trackNumber" (not part of
 * the spec) and format: "audio" (not a valid value — spec only
 * recognizes mp3/flac/aac/m4a). A track object missing a required
 * field is almost certainly why Eclipse rejected the whole album as
 * "couldn't load" even though the JSON looked reasonable to a human.
 *
 * Fixed: every track object in the album response now includes
 * artist (mirrors the album-level artist), and drops the
 * non-spec fields entirely rather than sending invalid values.
 *
 * Deploy: wrangler deploy
 * Secrets (optional): wrangler secret put UPSTASH_REDIS_REST_URL
 *                      wrangler secret put UPSTASH_REDIS_REST_TOKEN
 */

import { Redis } from "@upstash/redis/cloudflare";

const BASE_URL = "https://downloads.khinsider.com";
const FETCH_TIMEOUT_MS = 4000;
const PREVIEW_TIMEOUT_MS = 3000;
const PREVIEW_COVER_COUNT = 6;

const CACHE_TTL_SEARCH = 60 * 15;
const CACHE_TTL_ALBUM = 60 * 60 * 6;

const ALBUM_ARTIST = "Various / Game OST";

const AUDIO_EXT_RE = /\.(mp3|flac|ogg)(\?[^"]*)?$/i;
const DIRECT_FILE_RE = /^https?:\/\/[^\/]+\/(?:soundtracks|ost)\/.+$/i;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const KNOWN_ROUTES = new Set(["manifest.json", "search", "stream", "album", "generate", "debug", "clearcache"]);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&#039;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .trim();
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function titleFromSongUrl(href) {
  let filename = href.split("/").pop() || "";
  filename = filename.replace(/\.(mp3|flac|ogg)(\?.*)?$/i, "");
  for (let i = 0; i < 4; i++) {
    try {
      const next = decodeURIComponent(filename);
      if (next === filename) break;
      filename = next;
    } catch {
      break;
    }
  }
  filename = filename.replace(/^\[TRACK\]-?/i, "").replace(/^[-\s]+/, "").trim();
  return filename;
}

async function fetchHtml(path, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = path.startsWith("http") ? path : `${BASE_URL}${path}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
      signal: controller.signal,
      redirect: "follow",
    });
    if (!res.ok) throw new Error(`KHInsider ${path} -> HTTP ${res.status}`);
    return { html: await res.text(), finalUrl: res.url };
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Track id encoding — the song-page path (needs a second hop)         */
/* ------------------------------------------------------------------ */

function encodeTrackId(songPath) {
  return btoa(songPath).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeTrackId(id) {
  let b64 = id.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return atob(b64);
}

/* ------------------------------------------------------------------ */
/* Small HTML helpers                                                   */
/* ------------------------------------------------------------------ */

function extractTdCells(rowHtml) {
  const cells = [];
  const tdRe = /<td[^>]*>([\s\S]*?)<\/td>/g;
  let m;
  while ((m = tdRe.exec(rowHtml)) !== null) cells.push(m[1]);
  return cells;
}

function firstAnchor(html) {
  const m = html.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
  if (!m) return null;
  return { href: m[1], text: stripTags(m[2]) };
}

function allAnchors(html) {
  const anchors = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) !== null) anchors.push({ href: m[1], text: stripTags(m[2]) });
  return anchors;
}

function extractCoverUrl(html) {
  const wrapped = /<a[^>]+href="([^"]+)"[^>]*>\s*<img\b/.exec(html);
  if (wrapped) return wrapped[1];
  const plain = /<img[^>]+src="([^"]+)"/.exec(html);
  return plain ? plain[1] : "";
}

/* ------------------------------------------------------------------ */
/* Search                                                               */
/* ------------------------------------------------------------------ */

function parseAlbumListTable(tableHtml) {
  const rows = tableHtml.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  const albums = [];
  for (let i = 1; i < rows.length; i++) {
    const cells = extractTdCells(rows[i]);
    if (cells.length < 2) continue;
    const anchor = firstAnchor(cells[1]);
    if (!anchor || !anchor.text) continue;
    const idMatch = anchor.href.match(/\/game-soundtracks\/album\/([^\/?#]+)/);
    const id = idMatch ? idMatch[1] : anchor.href.split("/").filter(Boolean).pop();
    if (!id) continue;
    albums.push({ id, title: anchor.text });
  }
  return albums;
}

function parseAlbumLinksLoose(html) {
  const albums = [];
  const seen = new Set();
  const anchorRe = /<a[^>]+href="([^"]*\/game-soundtracks\/album\/([^"\/?#]+))"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const id = m[2];
    const title = stripTags(m[3]);
    if (!title || seen.has(id)) continue;
    seen.add(id);
    albums.push({ id, title });
  }
  return albums;
}

async function handleSearch(query) {
  if (!query) return { albums: [], tracks: [], artists: [], playlists: [] };

  const { html, finalUrl } = await fetchHtml(`/search?search=${encodeURIComponent(query)}`);

  const redirectMatch = finalUrl.match(/\/game-soundtracks\/album\/([^\/?#]+)/);
  let rawAlbums = [];

  if (redirectMatch) {
    rawAlbums = [{ id: redirectMatch[1], title: query }];
  } else {
    const tables = html.match(/<table\b[^>]*\bclass="[^"]*albumList[^"]*"[^>]*>[\s\S]*?<\/table>/g) || [];
    const seen = new Set();
    for (const table of tables) {
      for (const a of parseAlbumListTable(table)) {
        if (seen.has(a.id)) continue;
        seen.add(a.id);
        rawAlbums.push(a);
      }
    }
    if (rawAlbums.length === 0) {
      rawAlbums = parseAlbumLinksLoose(html);
    }
  }

  const toFetchCover = rawAlbums.slice(0, PREVIEW_COVER_COUNT);
  const covers = await Promise.allSettled(toFetchCover.map((a) => fetchAlbumCoverOnly(a.id)));

  const albums = rawAlbums.map((a, i) => ({
    id: a.id,
    title: a.title,
    artist: ALBUM_ARTIST,
    artworkURL: i < PREVIEW_COVER_COUNT && covers[i].status === "fulfilled" ? covers[i].value : "",
  }));

  return { albums, tracks: [], artists: [], playlists: [] };
}

async function fetchAlbumCoverOnly(albumId) {
  const { html } = await fetchHtml(`/game-soundtracks/album/${albumId}`, PREVIEW_TIMEOUT_MS);
  const contentIdx = html.indexOf('id="pageContent"');
  const scoped = contentIdx >= 0 ? html.slice(contentIdx) : html;
  const firstTableMatch = scoped.match(/<table[^>]*>[\s\S]*?<\/table>/);
  return firstTableMatch ? extractCoverUrl(firstTableMatch[0]) : extractCoverUrl(scoped);
}

/* ------------------------------------------------------------------ */
/* Album — every track carries the required id/title/artist fields    */
/* ------------------------------------------------------------------ */

function parseAlbumTracks(scopedHtml) {
  const rows = scopedHtml.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  const tracks = [];
  const seenPaths = new Set();

  for (const row of rows) {
    const anchors = allAnchors(row).filter((a) => AUDIO_EXT_RE.test(a.href));
    if (anchors.length === 0) continue;

    const songPath = anchors[0].href;
    if (seenPaths.has(songPath)) continue;
    seenPaths.add(songPath);

    const visibleText = anchors.find((a) => a.text && a.text.trim() && a.text.trim() !== "&nbsp;")?.text;
    const title = (visibleText && visibleText.trim()) || titleFromSongUrl(songPath);
    if (!title) continue;

    // id, title, artist are all REQUIRED per the Eclipse addon schema.
    tracks.push({
      id: encodeTrackId(songPath),
      title,
      artist: ALBUM_ARTIST,
    });
  }

  return tracks;
}

function parseAlbumPage(html, albumId) {
  const contentIdx = html.indexOf('id="pageContent"');
  const scoped = contentIdx >= 0 ? html.slice(contentIdx) : html;

  const firstP = scoped.match(/<p[^>]*>([\s\S]*?)<\/p>/);
  if (firstP && stripTags(firstP[1]) === "No such album") {
    throw new Error("Album not found");
  }

  const titleMatch = scoped.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
  const title = titleMatch ? stripTags(titleMatch[1]) : albumId;

  const firstTableMatch = scoped.match(/<table[^>]*>[\s\S]*?<\/table>/);
  const artworkURL = firstTableMatch ? extractCoverUrl(firstTableMatch[0]) : extractCoverUrl(scoped);

  const tracks = parseAlbumTracks(scoped);

  return {
    id: albumId,
    title,
    artist: ALBUM_ARTIST,
    artworkURL,
    trackCount: tracks.length,
    tracks,
  };
}

async function handleAlbum(albumId) {
  const { html } = await fetchHtml(`/game-soundtracks/album/${albumId}`);
  return parseAlbumPage(html, albumId);
}

/* ------------------------------------------------------------------ */
/* Stream — two-hop resolution: song page path -> real direct file URL */
/* ------------------------------------------------------------------ */

async function handleStream(trackId) {
  const songPath = decodeTrackId(trackId);
  const { finalUrl, html } = await fetchHtml(songPath);
  if (/\/404$/.test(finalUrl)) throw new Error("Song page not found (404)");

  const anchors = allAnchors(html);
  const directLinks = anchors.map((a) => a.href).filter((href) => DIRECT_FILE_RE.test(href));
  if (directLinks.length === 0) throw new Error("No direct file link found for this track");

  const preferred =
    directLinks.find((l) => /\.flac$/i.test(l)) ||
    directLinks.find((l) => /\.ogg$/i.test(l)) ||
    directLinks.find((l) => /\.mp3$/i.test(l)) ||
    directLinks[0];

  const extMatch = preferred.match(/\.(mp3|flac|ogg)(\?.*)?$/i);
  const format = extMatch ? extMatch[1].toLowerCase() : "mp3";

  return { url: preferred, format, quality: "native" };
}

/* ------------------------------------------------------------------ */
/* Upstash Redis + in-memory fallback                                  */
/* ------------------------------------------------------------------ */

const memCache = new Map();

function getRedis(env) {
  if (env?.UPSTASH_REDIS_REST_URL && env?.UPSTASH_REDIS_REST_TOKEN) return Redis.fromEnv(env);
  return null;
}

async function rGet(redis, key) {
  if (redis) { try { return await redis.get(key); } catch {} }
  const e = memCache.get(key);
  if (!e) return null;
  if (e.exp < Date.now()) { memCache.delete(key); return null; }
  return e.val;
}

async function rSet(redis, key, value, ttl) {
  if (redis) { try { await redis.set(key, value, { ex: ttl }); return; } catch {} }
  memCache.set(key, { val: value, exp: Date.now() + ttl * 1000 });
  if (memCache.size > 500) memCache.delete(memCache.keys().next().value);
}

async function rDel(redis, key) {
  if (redis) { try { await redis.del(key); } catch {} }
  memCache.delete(key);
}

async function withRedisCacheIfNonEmpty(env, ctx, key, ttl, fn, isNonEmpty) {
  const redis = getRedis(env);
  const cached = await rGet(redis, key);
  if (cached) return json(cached);
  const data = await fn();
  if (isNonEmpty(data)) {
    const writeBack = rSet(redis, key, data, ttl);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(writeBack);
    else await writeBack;
  }
  return json(data);
}

/* ------------------------------------------------------------------ */
/* Manifest + token routing                                            */
/* ------------------------------------------------------------------ */

function manifest(token) {
  return {
    id: token ? `com.eclipse-addons.khinsider.${token}` : "com.eclipse-addons.khinsider",
    name: "KHInsider",
    version: "1.7.0",
    description: "Video game soundtracks from downloads.khinsider.com — MP3, FLAC, and OGG rips.",
    icon: "https://downloads.khinsider.com/favicon.ico",
    resources: ["search", "stream", "catalog"],
    types: ["album", "track"],
    contentType: "music",
  };
}

function generateToken() {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let t = "";
  const arr = new Uint8Array(28);
  crypto.getRandomValues(arr);
  for (let i = 0; i < arr.length; i++) t += chars[arr[i] % chars.length];
  return t;
}

function parsePath(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return { token: null, rest: "/" };
  if (KNOWN_ROUTES.has(parts[0])) return { token: null, rest: "/" + parts.join("/") };
  return { token: parts[0], rest: "/" + parts.slice(1).join("/") };
}

/* ------------------------------------------------------------------ */
/* Landing page                                                        */
/* ------------------------------------------------------------------ */

function landingPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>KHInsider — Eclipse Addon</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{background:#080808;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:48px 20px 64px;-webkit-font-smoothing:antialiased}
  .card{background:#111;border:1px solid #1e1e1e;border-radius:18px;padding:36px;max-width:540px;width:100%;box-shadow:0 24px 64px rgba(0,0,0,.6);margin-bottom:20px}
  h1{font-size:22px;font-weight:600;margin-bottom:8px;letter-spacing:-0.01em}
  p.sub{font-size:14px;color:#666;margin-bottom:20px;line-height:1.6}
  .tip{background:#0a0a0a;border:1px solid #1e1e1e;border-radius:10px;padding:12px 14px;margin-bottom:20px;font-size:12px;color:#888;line-height:1.7}
  .tip b{color:#ccc}
  button{width:100%;background:#e0e0e0;color:#080808;border:none;border-radius:10px;padding:14px 18px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .15s}
  button:hover{opacity:.85}
  button:disabled{opacity:.5;cursor:not-allowed}
  #genBox{display:none;margin-top:18px;background:#0a0a0a;border:1px solid #1e1e1e;border-radius:10px;padding:14px}
  #genBox .label{font-size:11px;color:#666;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
  #genUrl{font-size:12px;color:#e0e0e0;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;line-height:1.6}
  #copyBtn{width:auto;margin-top:12px;padding:8px 14px;font-size:12px;background:transparent;color:#e0e0e0;border:1px solid #1e1e1e}
  #copyBtn:hover{opacity:1;background:#1a1a1a}
  .count{font-size:11px;color:#444;margin-top:16px;text-align:center}
</style>
</head>
<body>
  <div class="card">
    <h1>KHInsider Addon for Eclipse</h1>
    <p class="sub">Generate a unique addon URL and install it in Eclipse under Settings → Cloud Storage → Add Connection → Addons.</p>
    <div class="tip"><b>Note:</b> Video game soundtracks — MP3/FLAC/OGG rips scraped directly from downloads.khinsider.com. No login needed.</div>
    <button id="genBtn" onclick="generate()">Generate Addon URL</button>
    <div id="genBox">
      <div class="label">Your manifest URL</div>
      <div id="genUrl"></div>
      <button id="copyBtn" onclick="copyUrl()">Copy</button>
    </div>
    <div class="count" id="countLabel"></div>
  </div>

<script>
  let genUrlVal = '';
  let genCount = 0;
  function generate() {
    const btn = document.getElementById('genBtn');
    btn.disabled = true;
    btn.textContent = 'Generating…';
    fetch('/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d.error) { alert(d.error); btn.disabled = false; btn.textContent = 'Generate Addon URL'; return; }
        genUrlVal = d.manifestUrl;
        genCount++;
        document.getElementById('genUrl').textContent = genUrlVal;
        document.getElementById('genBox').style.display = 'block';
        document.getElementById('countLabel').textContent = genCount + ' generated this session';
        btn.disabled = false;
        btn.textContent = 'Generate New Addon URL';
      })
      .catch(function () {
        alert('Failed to generate URL. Try again.');
        btn.disabled = false;
        btn.textContent = 'Generate Addon URL';
      });
  }
  function copyUrl() {
    if (!genUrlVal) return;
    navigator.clipboard.writeText(genUrlVal).then(function () {
      const btn = document.getElementById('copyBtn');
      const original = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(function () { btn.textContent = original; }, 1500);
    });
  }
</script>
</body>
</html>`;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    const url = new URL(request.url);
    const { token, rest } = parsePath(url.pathname);

    try {
      if (rest === "/" || rest === "") {
        return new Response(landingPage(), { headers: { "Content-Type": "text/html; charset=utf-8", ...CORS_HEADERS } });
      }

      if (rest === "/generate" && request.method === "POST") {
        const newToken = generateToken();
        return json({ token: newToken, manifestUrl: `${url.origin}/${newToken}/manifest.json` });
      }

      if (rest === "/debug") {
        const q = url.searchParams.get("q");
        const albumId = url.searchParams.get("album");
        const trackId = url.searchParams.get("track");
        try {
          if (trackId) {
            const result = await handleStream(trackId);
            return json({ ok: true, mode: "stream", result });
          }
          if (albumId) {
            const result = await handleAlbum(albumId);
            return json({ ok: true, mode: "album", result });
          }
          const result = await handleSearch(q || "chrono trigger");
          return json({ ok: true, mode: "search", result });
        } catch (err) {
          return json({ ok: false, error: err.message }, 502);
        }
      }

      if (rest === "/clearcache") {
        const q = url.searchParams.get("q") || "";
        const redis = getRedis(env);
        await rDel(redis, `khinsider:search:${q.toLowerCase()}`);
        return json({ cleared: `khinsider:search:${q.toLowerCase()}` });
      }

      if (rest === "/manifest.json") return json(manifest(token));

      if (rest === "/search" || rest.startsWith("/search?")) {
        const q = url.searchParams.get("q") || "";
        const cacheKey = `khinsider:search:${q.toLowerCase()}`;
        return withRedisCacheIfNonEmpty(
          env, ctx, cacheKey, CACHE_TTL_SEARCH,
          () => handleSearch(q),
          (data) => Array.isArray(data?.albums) && data.albums.length > 0
        );
      }

      const albumMatch = rest.match(/^\/album\/(.+)$/);
      if (albumMatch) {
        const cacheKey = `khinsider:album:${albumMatch[1]}`;
        return withRedisCacheIfNonEmpty(
          env, ctx, cacheKey, CACHE_TTL_ALBUM,
          () => handleAlbum(albumMatch[1]),
          (data) => Array.isArray(data?.tracks) && data.tracks.length > 0
        );
      }

      const streamMatch = rest.match(/^\/stream\/(.+)$/);
      if (streamMatch) {
        return json(await handleStream(streamMatch[1]));
      }

      return json({ error: "Not found", path: rest }, 404);
    } catch (err) {
      return json({ error: err.message || "Internal error" }, 500);
    }
  },
};
