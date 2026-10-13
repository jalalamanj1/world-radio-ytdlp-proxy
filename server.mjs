// World Radio — YouTube (yt-dlp) proxy.
//
// A tiny, dependency-free Node server that shells out to yt-dlp so the radio app
// can search YouTube and stream the audio of any video. It exists because a
// browser cannot extract YouTube audio directly (CORS + signature + IP locks).
//
//   GET /health                      -> { ok: true }
//   GET /search?q=QUERY&limit=N      -> { ok, items: [{ id, title, uploader, duration, thumbnail }] }
//   GET /stream?id=VIDEOID           -> streams the best audio (supports Range/seek)
//
// Requires the `yt-dlp` binary on PATH (see Dockerfile / README).

import http from "node:http";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const PORT = Number(process.env.PORT || 8080);
const YTDLP = process.env.YTDLP_PATH || "yt-dlp";
// Optional extra args before the command (e.g. YTDLP_PATH=python YTDLP_ARGS="-m yt_dlp").
const YTDLP_ARGS = (process.env.YTDLP_ARGS || "").split(" ").filter(Boolean);

function applyCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range,Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Content-Length,Content-Range,Accept-Ranges,Content-Type");
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

async function handleSearch(res, query, limit) {
  if (!query) return sendJson(res, 400, { ok: false, error: "q required" });
  const n = Math.min(30, Math.max(1, limit));
  const out = await runYt([
    `ytsearch${n}:${query}`,
    "--dump-single-json",
    "--flat-playlist",
    "--no-warnings",
    "--skip-download",
  ]);
  const data = JSON.parse(out);
  const items = (data.entries || [])
    .filter((e) => e && e.id)
    .map((e) => ({
      id: e.id,
      title: e.title || "Untitled",
      uploader: e.uploader || e.channel || "",
      duration: e.duration || undefined,
      thumbnail: `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
    }));
  sendJson(res, 200, { ok: true, items });
}

async function handleStream(req, res, id) {
  if (!id || !/^[\w-]{6,20}$/.test(id)) return sendJson(res, 400, { ok: false, error: "invalid id" });
  const page = `https://www.youtube.com/watch?v=${id}`;
  // Resolve the best audio-only stream (prefer m4a/AAC for widest browser support).
  const meta = await runYt([
    "-f",
    "bestaudio[ext=m4a]/bestaudio",
    "--no-playlist",
    "--no-warnings",
    "--print",
    "%(url)s|%(ext)s",
    page,
  ]);
  const [mediaUrl, ext] = meta.trim().split("|");
  if (!mediaUrl) return sendJson(res, 502, { ok: false, error: "no stream resolved" });

  const type =
    ext === "m4a" ? "audio/mp4" : ext === "webm" ? "audio/webm" : ext === "mp3" ? "audio/mpeg" : "application/octet-stream";

  const range = req.headers.range;
  const upstream = await fetch(mediaUrl, {
    headers: {
      ...(range ? { Range: range } : {}),
      "User-Agent": "Mozilla/5.0 (compatible; WorldRadioProxy/1.0)",
    },
  });
  const headers = { "Content-Type": type, "Accept-Ranges": "bytes" };
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

const server = http.createServer(async (req, res) => {
  applyCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  const url = new URL(req.url || "/", "http://localhost");
  try {
    if (url.pathname === "/health") return sendJson(res, 200, { ok: true });
    if (url.pathname === "/search") {
      const q = (url.searchParams.get("q") || "").trim();
      const limit = Number(url.searchParams.get("limit") || 12);
      return await handleSearch(res, q, limit);
    }
    if (url.pathname === "/stream") {
      const id = (url.searchParams.get("id") || "").trim();
      return await handleStream(req, res, id);
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    if (!res.headersSent) sendJson(res, 502, { ok: false, error: String(e?.message || e) });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`World Radio yt-dlp proxy listening on :${PORT}`);
});