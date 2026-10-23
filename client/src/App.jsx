import { useEffect, useRef, useState } from "react";

const SpeechRecognition =
  typeof window !== "undefined" &&
  (window.SpeechRecognition || window.webkitSpeechRecognition);

const ACCENTS = [
  { code: "en-GB", label: "UK English" },
  // { code: "en-US", label: "US English" },
];

const VOICES = {
  "en-GB": [
    { id: "en-GB-SoniaNeural", name: "Sonia (female)" },
    // { id: "en-GB-LibbyNeural", name: "Libby (female)" },
    // { id: "en-GB-MaisieNeural", name: "Maisie (female)" },
    // { id: "en-GB-RyanNeural", name: "Ryan (male)" },
    // { id: "en-GB-ThomasNeural", name: "Thomas (male)" },
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

// Empty in local dev (Vite proxies /api). On Vercel, set VITE_API_URL to your server URL.
const API = (import.meta.env.VITE_API_URL || "").replace(/\/$/, "");

const normLang = (l) => (l || "").replace("_", "-").toLowerCase();
const splitSentences = (text) => text.match(/[^.!?]+[.!?]*\s*/g) || [text];
const isNatural = (v) => /natural|neural|online/i.test(v.name);

export default function App() {
  const [accent, setAccent] = useState("en-GB");
  const [voice, setVoice] = useState(VOICES["en-GB"][0].id);
  const [engine, setEngine] = useState("neural"); // "neural" (server MP3) | "browser"
  const [browserVoices, setBrowserVoices] = useState([]);
  const [browserVoiceURI, setBrowserVoiceURI] = useState("");
  const [mode, setMode] = useState("assistant"); // "assistant" | "repeat"
  const [status, setStatus] = useState("idle"); // idle | listening | thinking | preparing | speaking
  const [interim, setInterim] = useState("");
  const [typed, setTyped] = useState("");
  const [messages, setMessages] = useState([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const recRef = useRef(null);
  const audioRef = useRef(null);
  const finalRef = useRef("");
  const idRef = useRef(0);
  const messagesRef = useRef([]);
  const modeRef = useRef(mode);
  const voiceRef = useRef(voice);
  const engineRef = useRef(engine);
  const accentRef = useRef(accent);
  const browserVoiceRef = useRef(browserVoiceURI);
  const browserVoicesRef = useRef(browserVoices);
  const logRef = useRef(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  useEffect(() => {
    voiceRef.current = voice;
  }, [voice]);
  useEffect(() => {
    engineRef.current = engine;
  }, [engine]);
  useEffect(() => {
    accentRef.current = accent;
  }, [accent]);
  useEffect(() => {
    browserVoiceRef.current = browserVoiceURI;
  }, [browserVoiceURI]);
  useEffect(() => {
    browserVoicesRef.current = browserVoices;
  }, [browserVoices]);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [messages, interim]);

  // load browser voices
  useEffect(() => {
    const load = () => setBrowserVoices(window.speechSynthesis.getVoices());
    load();
    window.speechSynthesis.onvoiceschanged = load;
    return () => {
      window.speechSynthesis.onvoiceschanged = null;
    };
  }, []);

  // browser voices for the chosen accent, natural voices first
  const accentBrowserVoices = browserVoices
    .filter((v) => normLang(v.lang) === normLang(accent))
    .sort((a, b) => Number(isNatural(b)) - Number(isNatural(a)));

  useEffect(() => {
    if (!accentBrowserVoices.length) {
      setBrowserVoiceURI("");
      return;
    }
    if (!accentBrowserVoices.some((v) => v.voiceURI === browserVoiceURI)) {
      setBrowserVoiceURI(accentBrowserVoices[0].voiceURI);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accent, browserVoices]);

  function changeAccent(code) {
    setAccent(code);
    setVoice(VOICES[code][0].id);
  }

  function changeEngine(value) {
    setEngine(value);
    setNotice("");
    setError("");
  }

  const nextId = () => ++idRef.current;
  const patchMessage = (id, patch) =>
    setMessages((prev) =>
      prev.map((m) => (m.id === id ? { ...m, ...patch } : m)),
    );

  // ---------- neural voice (server MP3) ----------
  async function synthesize(text) {
    setStatus("preparing");
    const res = await fetch(`${API}/api/tts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: voiceRef.current }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "Voice generation failed");
    }
    return URL.createObjectURL(await res.blob());
  }

  function play(url) {
    return new Promise((resolve) => {
      audioRef.current?.pause();
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
      setStatus("speaking");
      audio.play().catch(() => resolve());
    });
  }

  // ---------- browser voice ----------
  function speakBrowser(text) {
    return new Promise((resolve) => {
      const synth = window.speechSynthesis;
      synth.cancel();
      const voice = browserVoicesRef.current.find(
        (v) => v.voiceURI === browserVoiceRef.current,
      );
      const chunks = splitSentences(text).filter((c) => c.trim());
      if (!chunks.length) return resolve();
      setStatus("speaking");
      chunks.forEach((chunk, i) => {
        const u = new SpeechSynthesisUtterance(chunk.trim());
        u.lang = accentRef.current;
        if (voice) u.voice = voice;
        if (i === chunks.length - 1) {
          u.onend = () => resolve();
          u.onerror = () => resolve();
        }
        synth.speak(u);
      });
    });
  }

  function stopSpeaking() {
    audioRef.current?.pause();
    audioRef.current = null;
    window.speechSynthesis.cancel();
    setStatus("idle");
  }

  // speak a message with the neural voice (no browser fallback). Returns true on success.
  async function speakMessage(id, text) {
    try {
      const url = await synthesize(text);
      patchMessage(id, { audioUrl: url });
      await play(url);
      setStatus("idle");
      return true;
    } catch (err) {
      console.error(err);
      setError(
        `${err.message || "Voice generation failed"}. Please try again.`,
      );
      setStatus("idle");
      return false;
    }
  }

  async function replay(m) {
    setError("");
    if (m.audioUrl) await play(m.audioUrl);
    else await speakBrowser(m.content);
    setStatus("idle");
  }

  // ---------- typed text ----------
  async function sendTyped() {
    const text = typed.trim();
    if (!text || status !== "idle") return;
    setError("");
    setTyped("");
    const id = nextId();
    setMessages((prev) => [
      ...prev,
      { id, role: "user", kind: "typed", content: text },
    ]);
    const ok = await speakMessage(id, text);
    if (!ok) {
      // keep the text so a long passage is not lost
      setMessages((prev) => prev.filter((m) => m.id !== id));
      setTyped(text);
    }
  }

  function onTypedKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendTyped();
    }
  }

  // ---------- spoken input ----------
  async function handleUtterance(text) {
    const userId = nextId();
    const userMsg = { id: userId, role: "user", content: text };
    const history = [...messagesRef.current, userMsg];
    setMessages(history);

    if (modeRef.current === "repeat") {
      await speakMessage(userId, text);
      return;
    }

    try {
      setStatus("thinking");
      const res = await fetch(`${API}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: history
            .filter((m) => m.kind !== "typed")
            .map(({ role, content }) => ({ role, content })),
        }),
      });
      if (!res.ok) throw new Error("Server error");
      const { reply } = await res.json();
      const replyId = nextId();
      setMessages([
        ...history,
        { id: replyId, role: "assistant", content: reply },
      ]);
      await speakMessage(replyId, reply);
    } catch {
      setError(
        "Could not reach the server. Check that it is running on port 3001.",
      );
      setStatus("idle");
    }
  }

  function startListening() {
    setError("");
    if (!SpeechRecognition) {
      setError(
        "This browser has no speech recognition. Use Chrome, Edge or Safari.",
      );
      return;
    }
    stopSpeaking();

    const rec = new SpeechRecognition();
    rec.lang = accent;
    rec.interimResults = true;
    rec.continuous = false;
    finalRef.current = "";

    rec.onstart = () => setStatus("listening");
    rec.onresult = (e) => {
      let interimText = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const t = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalRef.current += t;
        else interimText += t;
      }
      setInterim(interimText || finalRef.current);
    };
    rec.onerror = (e) => {
      if (e.error === "not-allowed")
        setError(
          "Microphone access is blocked. Allow it in your browser settings.",
        );
      else if (e.error !== "no-speech" && e.error !== "aborted")
        setError(`Speech recognition error: ${e.error}`);
    };
    rec.onend = () => {
      setInterim("");
      const text = finalRef.current.trim();
      if (text) handleUtterance(text);
      else setStatus("idle");
    };

    recRef.current = rec;
    rec.start();
  }

  function onMicClick() {
    if (status === "listening") recRef.current?.stop();
    else if (status === "speaking") stopSpeaking();
    else if (status === "idle") startListening();
  }

  const busy = status === "thinking" || status === "preparing";

  const labels = {
    idle: "Tap to speak",
    listening: "Listening… tap to send",
    thinking: "Thinking…",
    preparing: "Preparing voice… long text can take a minute or more",
    speaking: "Speaking… tap to stop",
  };

  return (
    <main className="app">
      <header className="bar">
        <h1>Speak</h1>
        <div className="controls">
          <select
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            aria-label="Mode"
          >
            <option value="assistant">Assistant</option>
            <option value="repeat">Repeat back</option>
          </select>
          <select
            value={accent}
            onChange={(e) => changeAccent(e.target.value)}
            aria-label="Accent"
          >
            {ACCENTS.map((a) => (
              <option key={a.code} value={a.code}>
                {a.label}
              </option>
            ))}
          </select>
          <select
            value={engine}
            onChange={(e) => changeEngine(e.target.value)}
            aria-label="Voice engine"
          >
            <option value="neural">Neural voice (MP3)</option>
            {/* <option value="browser">Browser voice</option> */}
          </select>
          {engine === "neural" ? (
            <select
              value={voice}
              onChange={(e) => setVoice(e.target.value)}
              aria-label="Voice"
            >
              {VOICES[accent].map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          ) : (
            <select
              value={browserVoiceURI}
              onChange={(e) => setBrowserVoiceURI(e.target.value)}
              aria-label="Voice"
              disabled={!accentBrowserVoices.length}
            >
              {accentBrowserVoices.length === 0 && (
                <option value="">Default voice</option>
              )}
              {accentBrowserVoices.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name}
                </option>
              ))}
            </select>
          )}
        </div>
      </header>

      <section className="log" ref={logRef} aria-live="polite">
        {messages.length === 0 && !interim && (
          <p className="empty">Type below or tap the microphone.</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`entry ${m.role}`}>
            <p className={`msg ${m.role} ${m.kind === "typed" ? "typed" : ""}`}>
              {m.content}
            </p>
            {(m.audioUrl || m.browser) && (
              <div className="tools">
                <button
                  type="button"
                  onClick={() => replay(m)}
                  disabled={status !== "idle"}
                >
                  Play
                </button>
                {m.audioUrl && (
                  <a href={m.audioUrl} download={`speech-${m.id}.mp3`}>
                    Download MP3
                  </a>
                )}
              </div>
            )}
          </div>
        ))}
        {interim && <p className="msg user interim">{interim}</p>}
      </section>

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      <footer className="dock">
        <div className="compose">
          <textarea
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={onTypedKeyDown}
            placeholder="Type or paste text to read aloud"
            rows={2}
            aria-label="Text to read aloud"
          />
          <button
            type="button"
            className="send"
            onClick={sendTyped}
            disabled={!typed.trim() || status !== "idle"}
          >
            Read aloud
          </button>
        </div>

        <button
          className={`mic ${status}`}
          onClick={onMicClick}
          disabled={busy}
          aria-label={labels[status]}
        >
          {status === "speaking" ? (
            <svg viewBox="0 0 24 24" width="30" height="30">
              <rect
                x="6"
                y="6"
                width="12"
                height="12"
                rx="2"
                fill="currentColor"
              />
            </svg>
          ) : (
            <svg
              viewBox="0 0 24 24"
              width="30"
              height="30"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <rect x="9" y="3" width="6" height="12" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
            </svg>
          )}
        </button>
        <p className="state">{labels[status]}</p>
        {notice && <p className="state">{notice}</p>}
      </footer>
    </main>
  );
}
