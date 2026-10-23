import "dotenv/config";
import express from "express";
import cors from "cors";
import Anthropic from "@anthropic-ai/sdk";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

process.on("uncaughtException", (err) =>
  console.error("Uncaught exception:", err),
);
process.on("unhandledRejection", (err) =>
  console.error("Unhandled rejection:", err),
);

const app = express();
// CLIENT_ORIGIN: comma-separated list of allowed sites, e.g. https://your-app.vercel.app
const allowed = (process.env.CLIENT_ORIGIN || "")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);
app.use(cors(allowed.length ? { origin: allowed } : undefined));
app.use(express.json({ limit: "10mb" }));

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";

const SYSTEM =
  "You are a voice assistant. Your reply will be read aloud by a text-to-speech engine. " +
  "Answer in short, natural spoken English: one to three sentences. " +
  "No markdown, no lists, no emojis, no URLs, no special symbols.";

// ---------- chat ----------
app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages is required" });
    }

    const trimmed = messages.slice(-20).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content),
    }));

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 300,
      system: SYSTEM,
      messages: trimmed,
    });

    const reply = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join(" ")
      .trim();

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Chat request failed" });
  }
});

// ---------- text to speech ----------
const MAX_TTS_CHARS = 200000; // about 35,000 words
const NEURAL_VOICE_PATTERN = /^en-(US|GB)-[A-Za-z]+Neural$/;

const NEURAL_VOICES = {
  "en-GB": [
    { id: "en-GB-SoniaNeural", name: "Sonia (female)" },
    { id: "en-GB-LibbyNeural", name: "Libby (female)" },
    { id: "en-GB-MaisieNeural", name: "Maisie (female)" },
    { id: "en-GB-RyanNeural", name: "Ryan (male)" },
    { id: "en-GB-ThomasNeural", name: "Thomas (male)" },
  ],
  "en-US": [
    { id: "en-US-AriaNeural", name: "Aria (female)" },
    { id: "en-US-JennyNeural", name: "Jenny (female)" },
    { id: "en-US-AvaNeural", name: "Ava (female)" },
    { id: "en-US-EmmaNeural", name: "Emma (female)" },
    { id: "en-US-GuyNeural", name: "Guy (male)" },
    { id: "en-US-AndrewNeural", name: "Andrew (male)" },
    { id: "en-US-BrianNeural", name: "Brian (male)" },
  ],
};

const escapeXml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Edge endpoint (free, unofficial, may return 429) ---
function collect(stream, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const timer = setTimeout(
      () => reject(new Error("TTS timed out")),
      timeoutMs,
    );
    const done = (fn, val) => {
      clearTimeout(timer);
      fn(val);
    };
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => done(resolve, Buffer.concat(chunks)));
    stream.on("error", (e) => done(reject, e));
    stream.on("close", () =>
      chunks.length
        ? done(resolve, Buffer.concat(chunks))
        : done(reject, new Error("Stream closed with no audio")),
    );
  });
}

const EDGE_FORMAT = OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3;

// Split long text into chunks (<= max chars) at sentence boundaries.
function splitText(text, max = 1000) {
  const clean = text.replace(/[ \t]+/g, " ").trim();
  const sentences = clean.match(/[^.!?\n]+[.!?]*["\u201d\u2019)]*\s*|\n+/g) || [
    clean,
  ];
  const chunks = [];
  let current = "";

  const push = (piece) => {
    if (!piece.trim()) return;
    if ((current + piece).length > max && current.trim()) {
      chunks.push(current.trim());
      current = "";
    }
    current += piece;
  };

  for (const sentence of sentences) {
    if (sentence.length <= max) {
      push(sentence);
    } else {
      // very long sentence: split on words
      let buf = "";
      for (const word of sentence.split(/(\s+)/)) {
        const pieces =
          word.length > max
            ? word.match(new RegExp(`.{1,${max}}`, "gs"))
            : [word];
        for (const piece of pieces) {
          if ((buf + piece).length > max && buf.trim()) {
            push(buf);
            buf = "";
          }
          buf += piece;
        }
      }
      push(buf);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [clean];
}

// One connection is reused for all chunks; on a failure it reconnects and retries that chunk.
async function edgeTts(text, voice) {
  const chunks = splitText(text);
  const parts = [];
  let tts = null;

  try {
    for (const chunk of chunks) {
      let lastErr = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          if (!tts) {
            tts = new MsEdgeTTS();
            await tts.setMetadata(voice, EDGE_FORMAT);
          }
          const { audioStream } = tts.toStream(escapeXml(chunk));
          parts.push(await collect(audioStream));
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          try {
            tts?.close();
          } catch {
            /* ignore */
          }
          tts = null;
          await sleep(1500 * (attempt + 1));
        }
      }
      if (lastErr) throw lastErr;
    }
  } finally {
    try {
      tts?.close();
    } catch {
      /* ignore */
    }
  }
  return Buffer.concat(parts);
}

// --- Azure Speech (official) ---
async function azureTts(text, voice) {
  const parts = [];
  for (const chunk of splitText(text, 3000))
    parts.push(await azureTtsChunk(chunk, voice));
  return Buffer.concat(parts);
}

async function azureTtsChunk(text, voice) {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  const ssml = `<speak version="1.0" xml:lang="${voice.slice(0, 5)}"><voice name="${voice}">${escapeXml(text)}</voice></speak>`;

  const r = await fetch(
    `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "audio-24khz-48kbitrate-mono-mp3",
        "User-Agent": "speech-app",
      },
      body: ssml,
    },
  );
  if (!r.ok)
    throw new Error(
      `Azure TTS error ${r.status}: ${(await r.text()).slice(0, 200)}`,
    );
  return Buffer.from(await r.arrayBuffer());
}

function provider() {
  const forced = (process.env.TTS_PROVIDER || "").trim().toLowerCase();
  if (forced === "azure" || forced === "edge") return forced;
  if (process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION)
    return "azure";
  return "edge";
}

app.get("/api/voices", (_req, res) =>
  res.json({ provider: provider(), voices: NEURAL_VOICES }),
);

app.post("/api/tts", async (req, res) => {
  const text = String(req.body?.text || "").trim();
  const voice = String(req.body?.voice || "en-GB-SoniaNeural");
  const p = provider();

  if (!text) return res.status(400).json({ error: "text is required" });
  if (text.length > MAX_TTS_CHARS) {
    return res
      .status(400)
      .json({ error: `Text is too long (max ${MAX_TTS_CHARS} characters)` });
  }
  if (!NEURAL_VOICE_PATTERN.test(voice))
    return res.status(400).json({ error: "Unsupported voice" });

  try {
    const audio =
      p === "azure" ? await azureTts(text, voice) : await edgeTts(text, voice);
    if (!audio.length) throw new Error("Empty audio");

    res.set({
      "Content-Type": "audio/mpeg",
      "Content-Length": audio.length,
      "Cache-Control": "no-store",
    });
    res.send(audio);
  } catch (err) {
    console.error(`TTS error (${p}):`, err);
    res
      .status(500)
      .json({ error: `Voice generation failed: ${err?.message || err}` });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true, tts: provider() }));

// Vercel runs the exported app as a serverless function; only listen locally.
const PORT = process.env.PORT || 3001;
if (!process.env.VERCEL) {
  app.listen(PORT, () =>
    console.log(
      `Server running on http://localhost:${PORT} (voice engine: ${provider()})`,
    ),
  );
}

export default app;
