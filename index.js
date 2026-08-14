/**
 * Eclipse Music addon — KHInsider (downloads.khinsider.com)
 *
 * KHInsider has no API — it's a plain HTML site. This addon scrapes it
 * directly, mirroring the same three-hop structure the reference
 * Python scraper (obskyr/khinsider) uses:
 *   1. Search page  -> list of matching album slugs/titles
 *   2. Album page   -> list of per-song page links (NOT direct files yet)
 *   3. Song page    -> the actual direct MP3/FLAC/OGG file URL
 *
 * Step 3 is resolved lazily, only when /stream/:id is actually called —
 * same pattern Eclipse already expects, so loading an album with 40
 * tracks doesn't require 40 extra fetches up front.
 *
 * Unlike JioSaavn, KHInsider file links are plain static URLs — no
 * DRM, no encryption, no region lock, no expiry. That means aggressive
 * caching is completely safe here (the opposite of the JioSaavn addon,
 * where stream caching was removed for correctness reasons).
 *
 * Deploy: wrangler deploy
 * Secrets (optional): wrangler secret put UPSTASH_REDIS_REST_URL
 *                      wrangler secret put UPSTASH_REDIS_REST_TOKEN
 */

import { Redis } from "@upstash/redis/cloudflare";

const BASE_URL = "https://downloads.khinsider.com";
const FETCH_TIMEOUT_MS = 4000;

const CACHE_TTL_SEARCH = 60 * 15;        // 15 min
const CACHE_TTL_ALBUM = 60 * 60 * 6;     // 6 hours — track list rarely changes
const CACHE_TTL_STREAM = 60 * 60 * 24;   // 24 hours — file URLs are static, safe to cache long

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
    const res = await fetch(path.startsWith("http") ? path : `${BASE_URL}${path}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`KHInsider ${path} -> HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Track id encoding — base64url of the song page's relative path      */
/* ------------------------------------------------------------------ */

function encodeTrackId(songPath) {
  const b64 = btoa(songPath).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return b64;
}

function decodeTrackId(id) {
  let b64 = id.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return atob(b64);
}

/* ------------------------------------------------------------------ */
/* Search — scrape the albumList tables                                */
/* ------------------------------------------------------------------ */

function parseSearchResults(html) {
  const albums = [];
  const seen = new Set();
  const anchorRe = /<a[^>]+href="([^"]*\/game-soundtracks\/album\/([^"\/]+))"[^>]*>([^<]+)<\/a>/g;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const id = m[2];
    const title = decodeEntities(m[3]);
    if (seen.has(id) || !title) continue;
    seen.add(id);
    albums.push({ id, title });
  }
  return albums;
}

async function handleSearch(query) {
  if (!query) return { albums: [], tracks: [], artists: [], playlists: [] };
  const html = await fetchHtml(`/search?search=${encodeURIComponent(query)}`);
  const albums = parseSearchResults(html).map((a) => ({
    id: a.id,
    title: a.title,
    artist: "Various / Game OST",
    artworkURL: undefined,
  }));
  // KHInsider has no separate track/artist/playlist search — everything
  // lives under albums (soundtracks). Empty arrays keep the Eclipse
  // contract shape consistent with other addons.
  return { albums, tracks: [], artists: [], playlists: [] };
}

/* ------------------------------------------------------------------ */
/* Album — scrape #songlist table for per-song page links              */
/* ------------------------------------------------------------------ */

function parseAlbumPage(html, albumId) {
  const titleMatch = html.match(/<h2[^>]*>([^<]+)<\/h2>/);
  const title = titleMatch ? decodeEntities(titleMatch[1]) : albumId;

  const coverMatch = html.match(/<img[^>]+src="([^"]+\/(?:soundtracks|ost|thumbs_align)\/[^"]+\.(?:jpg|png|jpeg))"/i);
  const artworkURL = coverMatch ? coverMatch[1] : undefined;

  const songlistMatch = html.match(/<table[^>]+id="songlist"[\s\S]*?<\/table>/i);
  const songlistHtml = songlistMatch ? songlistMatch[0] : "";

  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/g;
  const tracks = [];
  let rowMatch;
  let index = 1;
  while ((rowMatch = rowRe.exec(songlistHtml)) !== null) {
    const row = rowMatch[1];
    if (/<th/i.test(row)) continue; // header row
    const anchorMatch = row.match(/<a[^>]+href="([^"]+)"[^>]*>([^<]+)<\/a>/);
    if (!anchorMatch) continue;
    const songPath = anchorMatch[1];
    const trackTitle = stripTags(anchorMatch[2]);
    if (!trackTitle) continue;
    tracks.push({
      id: encodeTrackId(songPath.startsWith("http") ? songPath : new URL(songPath, `${BASE_URL}/game-soundtracks/album/${albumId}`).pathname),
      title: trackTitle,
      trackNumber: index++,
      format: "audio",
    });
  }

  return { id: albumId, title, artist: "Various / Game OST", artworkURL, trackCount: tracks.length, tracks };
}

async function handleAlbum(albumId) {
  const html = await fetchHtml(`/game-soundtracks/album/${albumId}`);
  if (/No such album/i.test(html)) throw new Error("Album not found");
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
  const html = await fetchHtml(songPath);
  const links = parseSongFileLinks(html);
  const picked = pickPreferredFile(links);
  if (!picked) throw new Error("No direct file link found for this track");
  return { url: picked.url, format: picked.format, quality: "native" };
}

/* ------------------------------------------------------------------ */
/* Upstash Redis + in-memory fallback — safe to cache everything here  */
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
    version: "1.0.0",
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
/* Landing page — same monochrome theme as the other addons            */
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
