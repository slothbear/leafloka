import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';

const app = express();
const PORT = process.env.PORT || 3001;
const YT_API_KEY        = process.env.YOUTUBE_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

app.use(cors());
app.use(express.static('public'));

// ── Claude extraction ──────────────────────────────────────────
// Returns { place, weather, place_mention, weather_mention } per message.
// place_mention / weather_mention are the exact substrings from the original
// message text that Claude identified, so the frontend can highlight them.

const SYSTEM_PROMPT = `You are a location and weather extractor for a live YouTube chat stream belonging to a Buddhist insight meditation sangha (community) based at a meditation center in Redwood City, California.

Geographic context for disambiguation:
- The audience is global but heavily concentrated in the San Francisco Bay Area and California
- When a place name is ambiguous, default to the US / California interpretation unless the message contains strong evidence otherwise (e.g. a non-English greeting, an explicit country name, or a foreign context clue)
- Examples of Bay Area bias: "Santa Cruz" → Santa Cruz, California (not Tenerife or Bolivia); "Marin" → Marin County, California; "the Peninsula" → San Francisco Peninsula; "the East Bay" → East Bay, California; "Carmel" → Carmel-by-the-Sea, California; "Oakland" → Oakland, California
- Expand common California/US shorthand: "S. Ca." → Southern California, "N. Ca." → Northern California, "the Bay" → San Francisco Bay Area, "SoCal" → Southern California, "NorCal" → Northern California, "the City" → San Francisco
- Non-Bay Area examples that should NOT be defaulted to California: "Springfield" (too ambiguous — normalize to just "Springfield"), explicitly non-US contexts like "Bon dia" (Catalan), "Hola" (could be anywhere Spanish-speaking)

Rules:
- Extract a place name if the message mentions where the person is (city, region, state, country, neighborhood, etc.)
- Normalize the place to a full readable name (e.g. "Ashland Or" → "Ashland, Oregon", "N Ontario" → "Northern Ontario", "S. Ca." → "Southern California", "mt tam" → "Mount Tamalpais, California")
- Also return place_mention: the exact substring from the original message that you identified as a location reference (unnormalized, as it appeared)
- Extract a weather condition if mentioned and normalize to one of: sunny, rainy, cloudy, snowy, cold, hot, humid, windy, foggy, stormy
- Also return weather_mention: the exact substring from the original message that indicated weather (e.g. "drippy", "blustery", "cool sunny", "grey")
- If no clear location is mentioned, place and place_mention must be null
- If no weather is mentioned, weather and weather_mention must be null
- For vague references like "here" or "home" with no named place, place must be null
- Respond ONLY with a JSON array, one entry per input message, in the same order
- Each entry: { "place": string|null, "place_mention": string|null, "weather": string|null, "weather_mention": string|null }
- No explanation, no markdown, no extra text — raw JSON array only

Examples:
Input: ["Good morning from Ashland Or 🙏", "Nice day!", "Joining from rainy Santa Cruz", "warm greetings from mt tam fog", "Hello from the East Bay", "Bon dia sangha"]
Output: [{"place":"Ashland, Oregon","place_mention":"Ashland Or","weather":null,"weather_mention":null},{"place":null,"place_mention":null,"weather":null,"weather_mention":null},{"place":"Santa Cruz, California","place_mention":"Santa Cruz","weather":"rainy","weather_mention":"rainy"},{"place":"Mount Tamalpais, California","place_mention":"mt tam","weather":"foggy","weather_mention":"fog"},{"place":"East Bay, California","place_mention":"the East Bay","weather":null,"weather_mention":null},{"place":null,"place_mention":null,"weather":null,"weather_mention":null}]`;

async function extractLocationsWithClaude(messages) {
  if (!ANTHROPIC_API_KEY) {
    return {
      results: messages.map(() => ({ place: null, place_mention: null, weather: null, weather_mention: null })),
      error: 'ANTHROPIC_API_KEY not set',
    };
  }

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: JSON.stringify(messages) }],
      }),
    });

    const data = await res.json();
    if (data.error) {
      return {
        results: messages.map(() => ({ place: null, place_mention: null, weather: null, weather_mention: null })),
        error: `Claude API error: ${data.error.message}`,
      };
    }

    const raw = data.content?.[0]?.text?.trim() || '[]';
    // Strip markdown code fences if Claude wrapped the response in them
    const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(text);
    return {
      results: messages.map((_, i) => parsed[i] || { place: null, place_mention: null, weather: null, weather_mention: null }),
      error: null,
    };
  } catch (e) {
    return {
      results: messages.map(() => ({ place: null, place_mention: null, weather: null, weather_mention: null })),
      error: `Claude exception: ${e.message}`,
    };
  }
}

// ── Nominatim geocoder with in-process cache ──────────────────
const geocodeCache = new Map();

async function geocode(place) {
  const key = place.toLowerCase().trim();
  if (geocodeCache.has(key)) return geocodeCache.get(key);

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(place)}&format=json&limit=1`;
    const res = await fetch(url, {
      headers: {
        'Accept-Language': 'en',
        'User-Agent': 'LeafLoka/1.0 (hobbyproject)',
      },
    });
    const data = await res.json();
    if (data && data[0]) {
      const result = { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
      geocodeCache.set(key, result);
      return { ...result, error: null };
    }
    return { error: `not found` };
  } catch (e) {
    return { error: `exception: ${e.message}` };
  }
}

// ── YouTube API helpers ───────────────────────────────────────
async function getLiveChatId(videoId) {
  const url = `https://www.googleapis.com/youtube/v3/videos?part=liveStreamingDetails&id=${videoId}&key=${YT_API_KEY}`;
  const res = await fetch(url);
  const data = await res.json();
  const chatId = data?.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
  if (!chatId) throw new Error(`No active live chat found for video ${videoId}`);
  return chatId;
}

async function fetchChatMessages(liveChatId, pageToken) {
  let url = `https://www.googleapis.com/youtube/v3/liveChat/messages?liveChatId=${liveChatId}&part=snippet,authorDetails&maxResults=200&key=${YT_API_KEY}`;
  if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
  const res = await fetch(url);
  return res.json();
}

// ── Active streams ─────────────────────────────────────────────
const streams = new Map();

function broadcast(videoId, event, data) {
  const stream = streams.get(videoId);
  if (!stream) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of stream.clients) {
    try { client.write(payload); } catch (e) { stream.clients.delete(client); }
  }
}

function broadcastLog(videoId, level, message) {
  broadcast(videoId, 'log', { level, message, ts: new Date().toISOString() });
  process.stdout.write(`[${videoId}] [${level}] ${message}\n`);
}

async function pollChat(videoId) {
  const stream = streams.get(videoId);
  if (!stream || stream.clients.size === 0) {
    if (stream?.timer) clearTimeout(stream.timer);
    streams.delete(videoId);
    process.stdout.write(`[${videoId}] No clients, stopped polling\n`);
    return;
  }

  try {
    const data = await fetchChatMessages(stream.chatId, stream.nextToken);

    if (data.error) {
      broadcastLog(videoId, 'error', `YouTube API: ${data.error.message}`);
      stream.timer = setTimeout(() => pollChat(videoId), 10000);
      return;
    }

    stream.nextToken = data.nextPageToken;
    const interval = data.pollingIntervalMillis || 5000;

    const items = (data.items || []).filter(item =>
      item.snippet?.displayMessage && item.authorDetails?.displayName
    );

    if (items.length > 0) {
      const texts   = items.map(i => i.snippet.displayMessage);
      const authors = items.map(i => i.authorDetails.displayName);

      // Process in batches of 20 to avoid token limit issues
      const BATCH_SIZE = 20;
      const allExtractions = [];
      for (let b = 0; b < texts.length; b += BATCH_SIZE) {
        const batchTexts = texts.slice(b, b + BATCH_SIZE);
        broadcastLog(videoId, 'info', `Claude: processing ${batchTexts.length} message${batchTexts.length > 1 ? 's' : ''}…`);
        const { results, error: claudeError } = await extractLocationsWithClaude(batchTexts);
        if (claudeError) broadcastLog(videoId, 'error', `Claude failed: ${claudeError}`);
        allExtractions.push(...results);
      }

      for (let i = 0; i < items.length; i++) {
        const { place, place_mention, weather, weather_mention } = allExtractions[i] || { place: null, place_mention: null, weather: null, weather_mention: null };
        const author = authors[i];
        const text   = texts[i];

        if (place) {
          const weatherStr = weather ? ` · ${weather_mention || weather}` : '';
          broadcastLog(videoId, 'found', `@${author} → "${place_mention || place}"${weatherStr}`);

          // Geocode async
          geocode(place).then(geo => {
            if (geo.error) {
              broadcastLog(videoId, 'warn', `Nominatim: "${place}" → ${geo.error}`);
            } else {
              broadcastLog(videoId, 'geo', `Nominatim: "${place}" → ${geo.lat.toFixed(3)}, ${geo.lon.toFixed(3)}`);
              broadcast(videoId, 'location', {
                author, text, place, place_mention, weather, weather_mention,
                lat: geo.lat, lon: geo.lon,
              });
            }
          });
        } else {
          broadcastLog(videoId, 'skip', `@${author}: no location found`);
        }
      }
    }

    stream.timer = setTimeout(() => pollChat(videoId), interval);
  } catch (e) {
    broadcastLog(videoId, 'error', `Poll error: ${e.message}`);
    stream.timer = setTimeout(() => pollChat(videoId), 8000);
  }
}

// ── SSE endpoint ──────────────────────────────────────────────
app.get('/stream', async (req, res) => {
  const { videoId } = req.query;
  if (!videoId) return res.status(400).send('videoId required');
  if (!YT_API_KEY) return res.status(500).send('YOUTUBE_API_KEY not set');

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); } catch (e) { clearInterval(heartbeat); }
  }, 20000);

  if (!streams.has(videoId)) {
    try {
      const chatId = await getLiveChatId(videoId);
      const stream = { clients: new Set([res]), chatId, nextToken: null, timer: null };
      streams.set(videoId, stream);
      broadcastLog(videoId, 'info', `Connected to live chat ${chatId}`);
      pollChat(videoId);
    } catch (e) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`);
      res.end();
      return;
    }
  } else {
    streams.get(videoId).clients.add(res);
    broadcastLog(videoId, 'info', `Client joined (${streams.get(videoId).clients.size} total)`);
  }

  req.on('close', () => {
    clearInterval(heartbeat);
    const stream = streams.get(videoId);
    if (stream) {
      stream.clients.delete(res);
      process.stdout.write(`[${videoId}] Client left (${stream.clients.size} remaining)\n`);
    }
  });
});

// ── Geocode proxy ──────────────────────────────────────────────
app.get('/geocode', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q required' });
  const result = await geocode(q);
  if (result.error) res.status(404).json({ error: result.error });
  else res.json(result);
});

// ── Config endpoint — tells frontend if a video ID is pre-set ────
app.get('/config', (req, res) => {
  res.json({
    videoId: process.env.YOUTUBE_VIDEO_ID || null,
  });
});

// ── Health check ──────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeStreams: streams.size,
    totalClients: [...streams.values()].reduce((n, s) => n + s.clients.size, 0),
    claudeEnabled: !!ANTHROPIC_API_KEY,
    configuredVideoId: process.env.YOUTUBE_VIDEO_ID || null,
  });
});

app.listen(PORT, () => {
  process.stdout.write(`LeafLoka server running on port ${PORT}\n`);
  if (!YT_API_KEY)        process.stderr.write('⚠️  YOUTUBE_API_KEY not set\n');
  if (!ANTHROPIC_API_KEY) process.stderr.write('⚠️  ANTHROPIC_API_KEY not set — location extraction disabled\n');
});
