# world-radio-ytdlp-proxy

yt-dlp HTTP proxy for the **World Radio** app — enables YouTube search and
streaming full audio (the browser can't extract YouTube audio directly).

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | `{ ok, resolveCache, searchCache, inflight, prefetch }` |
| GET | `/search?q=QUERY&limit=N` | `{ ok, items: [{ id, title, uploader, duration, thumbnail }] }` |
| GET | `/ytmsearch?q=QUERY&limit=N` | Same shape, via YouTube Music |
| GET | `/stream?id=VIDEOID` | Streams the best audio (supports `Range` = seeking) |
| GET | `/dm/{ID}.m3u8` | 302-redirects to a signed Dailymotion HLS url |

## Caching

Resolved media URLs and search results are kept in memory, so the slow yt-dlp
extraction runs once per track/query instead of on every play, seek or repeat
search. A stale (expired) media URL is refreshed automatically on the next
request. `/stream` responses report `X-Cache: HIT | MISS | REFRESH`.

| Env | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | Listen port |
| `YTDLP_PATH` | `yt-dlp` | yt-dlp binary, or an interpreter (e.g. `python`) |
| `YTDLP_ARGS` | — | Extra args before the command (e.g. `-m yt_dlp`) |
| `RESOLVE_TTL_MS` | `3600000` | Media-url cache lifetime |
| `SEARCH_TTL_MS` | `600000` | Search-result cache lifetime |
| `PREFETCH` | off | `1` warms the top search result's stream in the background |

## Deploy on Render (free, ~2 minutes)

1. Sign in to [Render](https://render.com) and click **New → Blueprint**.
2. Connect this repo. Render reads `render.yaml` and creates the `world-radio-ytdlp`
   web service (Docker, **Free** plan, health check `/health`, `PREFETCH=1`).
3. Wait for the first deploy, then copy the service URL, e.g.
   `https://world-radio-ytdlp.onrender.com`.
4. Point the radio app at it — either:
   - write the URL into `endpoint.txt` (the app reads it at runtime, no rebuild), or
   - set the build var `VITE_RADIO_API` and rebuild the app.

The push-based service redeploys automatically on every commit to `master`.

> **Free plan sleeps after ~15 min idle** (next request takes ~30–60s). The
> `.github/workflows/keepalive.yml` workflow pings `/health` every 10 minutes to
> keep it warm — enable Actions on the repo and it runs automatically.
>
> **Datacenter IPs** can trip YouTube's "confirm you're not a bot" on some videos.
> yt-dlp mitigates this, but if it happens often, export browser cookies to
> `cookies.txt` and add `--cookies /app/cookies.txt` to `YTDLP_ARGS` (mount it as a
> secret file). yt-dlp also needs periodic updates — redeploy now and then.

## Run locally with Docker

```bash
docker build -t world-radio-ytdlp .
docker run -p 8080:8080 world-radio-ytdlp
```

## Notes

- Personal, low-volume use. Streaming YouTube content may conflict with
  YouTube's Terms of Service — use at your own risk.
