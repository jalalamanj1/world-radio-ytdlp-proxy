// World Radio — YouTube (yt-dlp) proxy.
//
// A tiny, dependency-free Node server that shells out to yt-dlp so the radio app
// can search YouTube and stream the audio of any video. It exists because a
// browser cannot extract YouTube audio directly (CORS + signature + IP locks).
//
//   GET /health                      -> { ok, resolveCache, searchCache, ... }
//   GET /search?q=QUERY&limit=N      -> { ok, items: [{ id, title, uploader, duration, thumbnail }] }
//   GET /ytmsearch?q=QUERY&limit=N   -> same shape, via YouTube Music
//   GET /stream?id=VIDEOID           -> streams the best audio (supports Range/seek)
//   GET /dm/{ID}.m3u8                -> 302 to a signed Dailymotion HLS url
//
// Resolved media URLs and search results are cached in memory, so repeat plays,
// in-track seeks and identical queries skip the slow (~seconds) yt-dlp run.
//
// Env:
//   PORT             listen port (default 8080)
//   YTDLP_PATH       yt-dlp binary, or an interpreter (e.g. python)
//   YTDLP_ARGS       extra args before the command (e.g. "-m yt_dlp")
//   RESOLVE_TTL_MS   media-url cache lifetime (default 1h)
//   SEARCH_TTL_MS    search-result cache lifetime (default 10m)
//   PREFETCH         "1" to warm the top search result's stream in the background
//   YTDLP_COOKIES    path to a cookies.txt (helps when YouTube bot-checks the IP)
//
// Requires the `yt-dlp` binary on PATH (see Dockerfile / README).

import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const PORT = Number(process.env.PORT || 8080);
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
// Optional extra args before the command (e.g. YTDLP_PATH=python YTDLP_ARGS="-m yt_dlp").
const YTDLP_ARGS = (process.env.YTDLP_ARGS || "").split(" ").filter(Boolean);

// A resolved googlevideo URL stays valid for a few hours; an hour is safe.
const RESOLVE_TTL_MS = Number(process.env.RESOLVE_TTL_MS || 60 * 60 * 1000);
// Search results (e.g. the constant "top hits" query) are reused for a while.
const SEARCH_TTL_MS = Number(process.env.SEARCH_TTL_MS || 10 * 60 * 1000);
// Warm the top search result so the first tap starts almost instantly.
const PREFETCH = /^(1|true|yes)$/i.test(process.env.PREFETCH || "");

// yt-dlp player clients, tried in order until one returns a stream. YouTube
// blocks some clients on datacenter IPs ("failed to extract player response"),
// while `android_vr`/`web_embedded` generally work without a PO token.
const CLIENT_SETS = [
  "youtube:player_client=android_vr",
  "youtube:player_client=web_embedded,android_vr",
  "youtube:player_client=default,web_safari",
  "youtube:player_client=tv_embedded,web_embedded,mweb,android_vr",
];
// Netscape cookies.txt path. Needed when YouTube bot-checks a datacenter IP
// ("Sign in to confirm you're not a bot"). Render Secret Files mount at
// /etc/secrets/<name>, so dropping a secret file named cookies.txt is enough.
const COOKIES = process.env.YTDLP_COOKIES || "/etc/secrets/cookies.txt";
function cookieArgs() {
  try {
    return COOKIES && existsSync(COOKIES) ? ["--cookies", COOKIES] : [];
  } catch {
    return [];
  }
}
const cookiesActive = () => cookieArgs().length > 0;

const MAX_ENTRIES = 500;

/** videoId -> { url, ext, expiresAt } */
const resolveCache = new Map();
/** searchKey -> { items, expiresAt } */
const searchCache = new Map();
/** videoId -> in-flight resolve promise (dedupes concurrent resolves) */
const inflight = new Map();

function cacheSet(map, key, value) {
  if (map.size >= MAX_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range,Content-Type");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "Content-Length,Content-Range,Accept-Ranges,Content-Type,X-Cache",
  );
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function runYt(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(YTDLP, [...YTDLP_ARGS, ...args], { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error((err || `yt-dlp exited ${code}`).trim()))));
  });
}

// ---------------------------------------------------------------------------
// Resolve a video's best audio-only stream, cached + de-duplicated.
// ---------------------------------------------------------------------------

async function resolveAudio(id) {
  const cached = resolveCache.get(id);
  if (cached && cached.expiresAt > Date.now()) return { ...cached, hit: true };
  const pending = inflight.get(id);
  if (pending) return pending;

  const task = (async () => {
    const page = `https://www.youtube.com/watch?v=${id}`;
    console.log(`resolve ${id}: trying ${CLIENT_SETS.length} client set(s)`);
    let lastErr = null;
    for (const clientArg of CLIENT_SETS) {
      try {
        // Prefer m4a/AAC for widest browser support, but accept webm/any audio.
        const args = [
          "-f",
          "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best",
          "--extractor-args",
          clientArg,
          "--no-playlist",
          "--no-warnings",
          "--print",
          "%(url)s|%(ext)s",
        ];
        args.push(...cookieArgs());
        args.push(page);
        const meta = await runYt(args);
        const line = meta.trim();
        // Split on the LAST "|" so a "|" inside the url can't corrupt the parse.
        const sep = line.lastIndexOf("|");
        const url = (sep >= 0 ? line.slice(0, sep) : line).trim();
        const ext = (sep >= 0 ? line.slice(sep + 1) : "").trim();
        if (!url) throw new Error("no stream resolved");
        const entry = { url, ext, expiresAt: Date.now() + RESOLVE_TTL_MS, hit: false };
        cacheSet(resolveCache, id, entry);
        console.log(`resolve ${id}: ok via ${clientArg} (${ext || "?"})`);
        return entry;
      } catch (e) {
        lastErr = e;
        console.log(`resolve ${id}: client set failed (${clientArg}) -> ${String(e?.message || e).slice(0, 160)}`);
      }
    }
    throw lastErr || new Error("no stream resolved");
  })();

  inflight.set(id, task);
  try {
    return await task;
  } finally {
    inflight.delete(id);
  }
}

function contentTypeFor(ext) {
  return ext === "m4a"
    ? "audio/mp4"
    : ext === "webm"
      ? "audio/webm"
      : ext === "mp3"
        ? "audio/mpeg"
        : "application/octet-stream";
}

function fetchUpstream(mediaUrl, range) {
  return fetch(mediaUrl, {
    headers: {
      ...(range ? { Range: range } : {}),
      "User-Agent": "Mozilla/5.0 (compatible; WorldRadioProxy/1.0)",
    },
  });
}

async function handleStream(req, res, id) {
  if (!id || !/^[\w-]{6,20}$/.test(id)) return sendJson(res, 400, { ok: false, error: "invalid id" });

  let resolved = await resolveAudio(id);
  let upstream = await fetchUpstream(resolved.url, req.headers.range);
  let cache = resolved.hit ? "HIT" : "MISS";

  // A cached URL can expire (403/410) or the CDN can hiccup; refresh once.
  if (upstream.status === 403 || upstream.status === 410 || upstream.status >= 500) {
    resolveCache.delete(id);
    try {
      resolved = await resolveAudio(id);
      upstream = await fetchUpstream(resolved.url, req.headers.range);
      cache = "REFRESH";
    } catch {
      /* keep the original upstream response below */
    }
  }

  const headers = {
    "Content-Type": contentTypeFor(resolved.ext),
    "Accept-Ranges": "bytes",
    "X-Cache": cache,
  };
  const len = upstream.headers.get("content-length");
  if (len) headers["Content-Length"] = len;
  const cr = upstream.headers.get("content-range");
  if (cr) headers["Content-Range"] = cr;
  res.writeHead(upstream.status, headers);
  if (req.method === "HEAD" || !upstream.body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(upstream.body), res);
}

// ---------------------------------------------------------------------------
// Search (cached), shared by /search and /ytmsearch.
// ---------------------------------------------------------------------------

function normalizeItems(entries, limit) {
  return (entries || [])
    .filter((e) => e && e.id && /^[\w-]{11}$/.test(String(e.id)) && e.title)
    .slice(0, limit)
    .map((e) => ({
      id: e.id,
      title: e.title || "Untitled",
      uploader: e.uploader || e.channel || e.artist || "",
      duration: e.duration || undefined,
      thumbnail: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
    }));
}

async function searchYt(query, limit, music) {
  const n = Math.min(music ? 40 : 30, Math.max(1, limit));
  const target = music
    ? `https://music.youtube.com/search?q=${encodeURIComponent(query)}`
    : `ytsearch${n}:${query}`;
  const out = await runYt([target, "--dump-single-json", "--flat-playlist", "--no-warnings", "--skip-download"]);
  const data = JSON.parse(out);
  return normalizeItems(data.entries, n);
}

async function cachedSearch(key, produce) {
  const cached = searchCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return { items: cached.items, hit: true };
  const items = await produce();
  cacheSet(searchCache, key, { items, expiresAt: Date.now() + SEARCH_TTL_MS });
  return { items, hit: false };
}

function maybePrefetch(items) {
  if (!PREFETCH || items.length === 0) return;
  const id = items[0]?.id;
  if (!id || resolveCache.has(id) || inflight.has(id)) return;
  resolveAudio(id).catch(() => {});
}

async function handleSearch(req, res, query, limit, music) {
  if (!query) return sendJson(res, 400, { ok: false, error: "q required" });
  const { items, hit } = await cachedSearch(`${music ? "m" : "s"}:${limit}:${query}`, () => searchYt(query, limit, music));
  res.setHeader("X-Cache", hit ? "HIT" : "MISS");
  maybePrefetch(items);
  sendJson(res, 200, { ok: true, items });
}

const server = http.createServer(async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url || "/", "http://localhost");
  try {
    if (url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        resolveCache: resolveCache.size,
        searchCache: searchCache.size,
        inflight: inflight.size,
        prefetch: PREFETCH,
        cookies: cookiesActive(),
      });
    }
    if (url.pathname === "/search") {
      const q = (url.searchParams.get("q") || "").trim();
      const limit = Number(url.searchParams.get("limit") || 12);
      return await handleSearch(req, res, q, limit, false);
    }
    // YouTube Music search (songs/artists) via yt-dlp.
    if (url.pathname === "/ytmsearch") {
      const q = (url.searchParams.get("q") || "").trim();
      const limit = Number(url.searchParams.get("limit") || 20);
      return await handleSearch(req, res, q, limit, true);
    }
    if (url.pathname === "/stream") {
      const id = (url.searchParams.get("id") || "").trim();
      return await handleStream(req, res, id);
    }
    // Dailymotion: resolve the (signed) HLS url with yt-dlp, then redirect the
    // browser straight to the CDN (which sends CORS *, so hls.js can play it).
    const dm = url.pathname.match(/^\/dm\/([\w-]+)\.m3u8$/);
    if (dm) {
      const out = await runYt([
        "-f",
        "bestaudio/best",
        "--no-playlist",
        "--no-warnings",
        "-g",
        `https://www.dailymotion.com/video/${dm[1]}`,
      ]);
      const mediaUrl = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .find((u) => /\.m3u8(\?|$)/i.test(u) || /dmcdn|\.mp4(\?|$)/i.test(u)) || out.trim().split(/\r?\n/)[0];
      if (!mediaUrl) return sendJson(res, 502, { ok: false, error: "no dailymotion stream" });
      res.writeHead(302, { Location: mediaUrl });
      res.end();
      return;
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 502, { ok: false, error: String(e?.message || e) });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`World Radio yt-dlp proxy listening on :${PORT}${PREFETCH ? " (prefetch on)" : ""}`);
});
