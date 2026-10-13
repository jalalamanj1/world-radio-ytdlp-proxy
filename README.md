# world-radio-ytdlp-proxy

yt-dlp HTTP proxy for the **World Radio** app — enables YouTube search and
streaming full audio (the browser can't extract YouTube audio directly).

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/health` | `{ "ok": true }` |
| GET | `/search?q=QUERY&limit=N` | `{ ok, items: [{ id, title, uploader, duration, thumbnail }] }` |
| GET | `/stream?id=VIDEOID` | Streams the best audio (supports `Range` = seeking) |

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
