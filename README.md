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

## Deploy on Render (free, ~1 minute)

1. Click **New → Web Service** in [Render](https://render.com) and connect this repo
   (or use **New → Blueprint** — it reads `render.yaml`).
2. Render detects the `Dockerfile` automatically. Choose the **Free** plan.
3. Deploy, then copy the service URL, e.g. `https://world-radio-ytdlp.onrender.com`.
4. In the radio app, set the build var `VITE_RADIO_API` to that URL and rebuild.

> Free instances sleep after idle; the first request after a pause takes ~30–60s.
> yt-dlp needs periodic updates — redeploy now and then.

## Run locally with Docker

```bash
docker build -t world-radio-ytdlp .
docker run -p 8080:8080 world-radio-ytdlp
```

## Notes

- Personal, low-volume use. Streaming YouTube content may conflict with
  YouTube's Terms of Service — use at your own risk.
