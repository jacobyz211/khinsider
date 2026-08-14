/**
 * Eclipse Music addon — KHInsider (downloads.khinsider.com)
 *
 * FIXES THIS VERSION:
 * 1. Search album objects were missing the "artist" field entirely
 *    after the previous preview-track rewrite. Eclipse's client model
 *    almost certainly requires it on every catalog item — a MISSING
 *    field (not just an empty one) is likely why results stopped
 *    rendering in Eclipse even though the raw JSON looked fine.
 *    Restored artist: "Various / Game OST" on every album object, and
 *    removed the preview-tracks feature entirely (not needed).
 * 2. artworkURL now defaults to "" instead of undefined everywhere —
 *    JSON.stringify silently DROPS keys whose value is undefined,
 *    which means the key disappears from the response entirely rather
 *    than being present-but-empty. Consistently present keys are
 *    safer for a client parser than keys that sometimes exist and
 *    sometimes don't.
 * 3. Album track parsing now has the same strict-then-loose-fallback
 *    pattern already applied to search: if table#songlist doesn't
 *    match (markup mismatch), fall back to scanning the album's
 *    #pageContent for any link pointing under this album's own path,
 *    so tracks still populate instead of coming back empty.
 *
 * Deploy: wrangler deploy
 * Secrets (optional): wrangler secret put UPSTASH_REDIS_REST_URL
 *                      wrangler secret put UPSTASH_REDIS_REST_TOKEN
 */

import { Redis } from "@upstash/redis/cloudflare";

const BASE_URL = "https://downloads.khinsider.com";
const FETCH_TIMEOUT_MS = 4000;

const CACHE_TTL_SEARCH = 60 * 15;
const CACHE_TTL_ALBUM = 60 * 60 * 6;
const CACHE_TTL_STREAM = 60 * 60 * 24;

const FORMAT_PREFERENCE = ["flac", "ogg", "mp3"];

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const KNOWN_ROUTES = new Set(["manifest.json", "search", "stream", "album", "generate", "debug"]);

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
    .trim();
}

function stripTags(html) {
  return decodeEntities(html.replace(/<[^>]+>/g, "").trim());
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
/* Track id encoding — base64url of the song page's relative path      */
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

function extractCoverHref(html) {
  const m = /<a[^>]+href="([^"]+)"[^>]*>\s*<img\b/.exec(html);
  return m ? m[1] : "";
}

/* ------------------------------------------------------------------ */
/* Search — strict table parse first, loose anchor scan as fallback    */
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

  // Every album object always carries the same fields, always with
  // concrete (non-undefined) values, so nothing gets silently dropped
  // by JSON.stringify or rejected by the client for a missing field.
  const albums = rawAlbums.map((a) => ({
    id: a.id,
    title: a.title,
    artist: "Various / Game OST",
    artworkURL: "",
  }));

  return { albums, tracks: [], artists: [], playlists: [] };
}

/* ------------------------------------------------------------------ */
/* Album — strict table parse first, loose anchor scan as fallback     */
/* ------------------------------------------------------------------ */

function parseAlbumTracksStrict(scopedHtml, albumUrl) {
  const songlistMatch = scopedHtml.match(/<table\b[^>]*\bid="songlist"[^>]*>[\s\S]*?<\/table>/i);
  if (!songlistMatch) return [];
  const rows = songlistMatch[0].match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
  const tracks = [];
  let index = 1;
  for (const row of rows) {
    if (/<th/i.test(row)) continue;
    const anchor = firstAnchor(row);
    if (!anchor || !anchor.text) continue;
    const songPath = anchor.href.startsWith("http") ? anchor.href : new URL(anchor.href, albumUrl).toString();
    tracks.push({ id: encodeTrackId(songPath), title: anchor.text, trackNumber: index++, format: "audio" });
  }
  return tracks;
}

/**
 * Fallback: scan the whole #pageContent region for any link whose path
 * sits directly under this album's own path (i.e., a per-song page),
 * excluding the album page's own self-link and any external links.
 * Used only if the strict table#songlist selector doesn't match.
 */
function parseAlbumTracksLoose(scopedHtml, albumUrl, albumId) {
  const albumPathPrefix = `/game-soundtracks/album/${albumId}/`;
  const anchors = allAnchors(scopedHtml);
  const tracks = [];
  const seen = new Set();
  let index = 1;
  for (const a of anchors) {
    if (!a.text) continue;
    let path;
    try {
      path = a.href.startsWith("http") ? new URL(a.href).pathname : a.href;
    } catch {
      continue;
    }
    if (!path.startsWith(albumPathPrefix)) continue;
    if (path === albumPathPrefix) continue; // self-link back to album
    if (seen.has(path)) continue;
    seen.add(path);
    const songPath = a.href.startsWith("http") ? a.href : new URL(a.href, albumUrl).toString();
    tracks.push({ id: encodeTrackId(songPath), title: a.text, trackNumber: index++, format: "audio" });
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
  const artworkURL = firstTableMatch ? extractCoverHref(firstTableMatch[0]) : "";

  const albumUrl = `${BASE_URL}/game-soundtracks/album/${albumId}`;
  let tracks = parseAlbumTracksStrict(scoped, albumUrl);
  if (tracks.length === 0) {
    tracks = parseAlbumTracksLoose(scoped, albumUrl, albumId);
  }

  return {
    id: albumId,
    title,
    artist: "Various / Game OST",
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
/* Stream — resolve the actual direct file URL from a song's own page  */
/* ------------------------------------------------------------------ */

function parseSongFileLinks(html) {
  const fileRe = /<a[^>]+href="(https?:\/\/[^"]+\/(?:soundtracks|ost)\/[^"]+)"[^>]*>/g;
  const links = [];
  let m;
  while ((m = fileRe.exec(html)) !== null) links.push(m[1]);
  return links;
}

function pickPreferredFile(links) {
  for (const ext of FORMAT_PREFERENCE) {
    const match = links.find((l) => l.toLowerCase().endsWith(`.${ext}`));
    if (match) return { url: match, format: ext };
  }
  return links.length ? { url: links[0], format: (links[0].split(".").pop() || "mp3").toLowerCase() } : null;
}

async function handleStream(trackId) {
  const songPath = decodeTrackId(trackId);
  const { finalUrl, html } = await fetchHtml(songPath);
  if (/\/404$/.test(finalUrl)) throw new Error("Song page not found (404)");
  const links = parseSongFileLinks(html);
  const picked = pickPreferredFile(links);
  if (!picked) throw new Error("No direct file link found for this track");
  return { url: picked.url, format: picked.format, quality: "native" };
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

async function withRedisCache(env, ctx, key, ttl, fn) {
  const redis = getRedis(env);
  const cached = await rGet(redis, key);
  if (cached) return json(cached);
  const data = await fn();
  const writeBack = rSet(redis, key, data, ttl);
  if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(writeBack);
  else await writeBack;
  return json(data);
}

/* ------------------------------------------------------------------ */
/* Manifest + token routing                                            */
/* ------------------------------------------------------------------ */

function manifest(token) {
  return {
    id: token ? `com.eclipse-addons.khinsider.${token}` : "com.eclipse-addons.khinsider",
    name: "KHInsider",
    version: "1.3.0",
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
        const q = url.searchParams.get("q") || "chrono trigger";
        try {
          const result = await handleSearch(q);
          return json({ ok: true, result });
        } catch (err) {
          return json({ ok: false, error: err.message }, 502);
        }
      }

      if (rest === "/manifest.json") return json(manifest(token));

      if (rest === "/search" || rest.startsWith("/search?")) {
        const q = url.searchParams.get("q") || "";
        const cacheKey = `khinsider:search:${q.toLowerCase()}`;
        return withRedisCache(env, ctx, cacheKey, CACHE_TTL_SEARCH, () => handleSearch(q));
      }

      const albumMatch = rest.match(/^\/album\/(.+)$/);
      if (albumMatch) {
        const cacheKey = `khinsider:album:${albumMatch[1]}`;
        return withRedisCache(env, ctx, cacheKey, CACHE_TTL_ALBUM, () => handleAlbum(albumMatch[1]));
      }

      const streamMatch = rest.match(/^\/stream\/(.+)$/);
      if (streamMatch) {
        const cacheKey = `khinsider:stream:${streamMatch[1]}`;
        return withRedisCache(env, ctx, cacheKey, CACHE_TTL_STREAM, () => handleStream(streamMatch[1]));
      }

      return json({ error: "Not found", path: rest }, 404);
    } catch (err) {
      return json({ error: err.message || "Internal error" }, 500);
    }
  },
};
