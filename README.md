# LeafLoka

Real-time world map showing where YouTube live chat viewers are watching from,
built for the Blue Leaflet Sangha. Dots appear on the map as chatters say things
like "Hello from sunny Oakland!" Weather emoji icons indicate conditions they
mention. Multiple viewers from the same city grow the dot larger, with a count badge.

## How it works

1. Browser opens `/stream?videoId=...` as a Server-Sent Events connection
2. Server polls YouTube Live Chat API every ~5s (respecting `pollingIntervalMillis`)
3. Each message is checked for location phrases via regex
4. Matched locations are geocoded via Nominatim (free, no key needed)
5. `location` events are broadcast to all connected browsers
6. The frontend places/grows emoji dots on a D3 world map

## Setup

### 1. Get a YouTube Data API key

- Go to https://console.cloud.google.com/
- Create a project → Enable **YouTube Data API v3**
- Credentials → Create API Key
- (Optional) restrict it to YouTube Data API v3 only

### 2. Get an Anthropic API key

- Go to https://console.anthropic.com/
- Create an API key
- Location & weather extraction uses `claude-haiku-4-5` — fast and cheap (fractions of a cent per session)

### 3. Local dev

```bash
npm install
YOUTUBE_API_KEY=your_yt_key ANTHROPIC_API_KEY=your_anthropic_key npm run dev
# open http://localhost:3001
```

### 4. Deploy to Fly.io (free tier)

```bash
# Install flyctl
brew install flyctl        # macOS
# or: curl -L https://fly.io/install.sh | sh

# Login / create account
fly auth signup            # or: fly auth login

# Launch (first time)
fly launch --name leafloka --region bos --no-deploy
# It will detect the Dockerfile automatically

# Set your API key as a secret (never commit this)
fly secrets set YOUTUBE_API_KEY=your_yt_key ANTHROPIC_API_KEY=your_anthropic_key

# Deploy
fly deploy

# Your app will be at: https://leafloka.fly.dev
```

### 5. Point the frontend at your backend

In `public/index.html`, find this line near the bottom of the script:

```js
const backendUrl = window.BACKEND_URL || 'http://localhost:3001';
```

For the deployed version, either:
- Change it to your Fly URL: `'https://leafloka.fly.dev'`
- Or set `window.BACKEND_URL` in a tiny inline script at the top of `index.html`

Since `public/` is served by the same Express app, in production
the frontend and backend share the same origin — so you can just use `''`
(empty string) as the backendUrl and the SSE fetch will be relative.

### 6. Use it

1. Open a YouTube live stream in another tab
2. Copy the video ID from the URL (the part after `v=`)
3. Paste it into the Video ID field and click Connect
4. As chatters announce their locations, dots appear on the map

## API endpoints

| Endpoint | Description |
|---|---|
| `GET /stream?videoId=XXX` | SSE stream of chat events |
| `GET /geocode?q=Oakland` | Proxy to Nominatim (cached) |
| `GET /health` | Status + active stream count |

## SSE event types

```
event: location   — { author, text, place, weather, lat, lon }
event: chat       — { author, text }   (non-location messages)
event: error      — { message }
```

## Notes

- **Nominatim rate limit**: 1 req/sec. The server caches results in memory,
  so the same city only ever geocodes once per server process lifetime.
- **State is in-memory**: restarting the server clears the dot history.
  This is intentional — each stream session is ephemeral.
- **Fly.io free tier**: 3 shared VMs with 256MB RAM included free.
  This app uses ~30MB idle, so you have plenty of headroom.
- **Multiple viewers**: if several people connect to the same `videoId`,
  only one polling loop runs — they all share the same SSE fan-out.
