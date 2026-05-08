// app.jsx — main App: state, layout, sidebar, composer, fetch-with-mock-fallback.
// Loaded after chat.jsx and tweaks-panel.jsx.

const { useState: useStateApp, useEffect: useEffectApp, useRef: useRefApp, useMemo: useMemoApp, useCallback: useCallbackApp } = React;

// API_BASE is now editable from the top bar (saved to localStorage).
// This default is used on first load; leave empty to start in mock mode.
const DEFAULT_API_BASE = "";
const API_BASE_KEY = "scholera.api_base";

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "density": "regular",
  "showDebug": false,
  "showSubQueries": true,
  "fontPair": "plex"
}/*EDITMODE-END*/;

// ─────────────────────────── Mock fetch ───────────────────────────
async function mockAsk(query) {
  await new Promise(r => setTimeout(r, 700 + Math.random() * 500));
  const q = query.toLowerCase().trim();
  const hit = window.MOCK_RESPONSES.find(r => r.match.some(m => q.includes(m)));
  if (hit) return { ...hit.payload, query };
  // Default: graceful refused for unknown queries
  return {
    query,
    tier: "refused",
    sub_queries: [query],
    answer: "I couldn't find a confident answer in the indexed lecture materials. Try one of the suggested queries, or rephrase to focus on a specific concept covered in class.",
    retrieved: [],
    verdicts: [],
  };
}

async function realAsk(apiBase, query) {
  const res = await fetch(`${apiBase}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "ngrok-skip-browser-warning": "true" },
    body: JSON.stringify({ query }),
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function fetchPdfs(apiBase) {
  if (!apiBase) return window.MOCK_PDFS;
  try {
    const res = await fetch(`${apiBase}/pdfs`, { headers: { "ngrok-skip-browser-warning": "true" } });
    if (!res.ok) throw new Error();
    return res.json();
  } catch (e) { return window.MOCK_PDFS; }
}

// ─────────────────────────── App ───────────────────────────
function App() {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);

  const [apiBase, setApiBase] = useStateApp(() => {
    try { return localStorage.getItem(API_BASE_KEY) || DEFAULT_API_BASE; }
    catch (e) { return DEFAULT_API_BASE; }
  });
  const [pdfs, setPdfs] = useStateApp([]);
  const [messages, setMessages] = useStateApp([]); // {role, content} or assistant payload
  const [pending, setPending] = useStateApp(false);
  const [activeChunk, setActiveChunk] = useStateApp(null);
  const [draft, setDraft] = useStateApp("");

  const threadRef = useRefApp(null);
  const inputRef = useRefApp(null);

  const mockMode = !apiBase;

  const saveApiBase = useCallbackApp((v) => {
    const cleaned = (v || "").trim().replace(/\/$/, "");
    setApiBase(cleaned);
    try { localStorage.setItem(API_BASE_KEY, cleaned); } catch (e) {}
  }, []);

  // Fetch PDFs whenever API base changes
  useEffectApp(() => { fetchPdfs(apiBase).then(setPdfs); }, [apiBase]);

  // Auto-scroll on new message
  useEffectApp(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight;
  }, [messages, pending]);

  // Density on root
  useEffectApp(() => {
    document.documentElement.setAttribute("data-density", t.density);
  }, [t.density]);

  // Font pair on root
  useEffectApp(() => {
    const root = document.documentElement;
    if (t.fontPair === "plex") {
      root.style.setProperty("--font-sans", '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif');
      root.style.setProperty("--font-serif", '"IBM Plex Serif", ui-serif, Georgia, serif');
    } else if (t.fontPair === "iowan") {
      root.style.setProperty("--font-sans", 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif');
      root.style.setProperty("--font-serif", '"Iowan Old Style", "Source Serif 4", Georgia, serif');
    } else if (t.fontPair === "all-sans") {
      root.style.setProperty("--font-sans", '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif');
      root.style.setProperty("--font-serif", '"IBM Plex Sans", ui-sans-serif, system-ui, sans-serif');
    }
  }, [t.fontPair]);

  const ask = useCallbackApp(async (query) => {
    if (!query.trim() || pending) return;
    const userMsg = { role: "user", content: query };
    setMessages(m => [...m, userMsg]);
    setPending(true);
    setDraft("");
    setActiveChunk(null);
    try {
      const payload = mockMode ? await mockAsk(query) : await realAsk(apiBase, query);
      setMessages(m => [...m, { role: "assistant", ...payload }]);
      // Auto-open the first source slide in the preview
      if (payload.retrieved && payload.retrieved.length > 0) {
        setActiveChunk(payload.retrieved[0].chunk_id);
      }
    } catch (e) {
      setMessages(m => [...m, {
        role: "assistant", tier: "refused",
        answer: `Couldn't reach the API at ${apiBase}. Check that the Colab ngrok tunnel is up, then try again.`,
        retrieved: [], verdicts: [], sub_queries: [],
      }]);
    } finally {
      setPending(false);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [pending, mockMode, apiBase]);

  const onSubmit = (e) => { e.preventDefault(); ask(draft); };
  const onKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(draft); }
  };

  // Last assistant message — used to find chunk metadata for the preview
  const lastRetrieved = useMemoApp(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant" && messages[i].retrieved) return messages[i].retrieved;
    }
    return [];
  }, [messages]);

  // Title for the preview head
  const previewMeta = useMemoApp(() => {
    if (!activeChunk) return null;
    // Look across all messages
    for (const m of messages) {
      if (m.role === "assistant" && m.retrieved) {
        const r = m.retrieved.find(x => x.chunk_id === activeChunk);
        if (r) return r;
      }
    }
    const docId = activeChunk.split("_")[0];
    const pageNum = parseInt(activeChunk.split("_S")[1], 10);
    return {
      chunk_id: activeChunk, doc_id: docId, page_num: pageNum,
      lecture_title: (pdfs.find(p => p.doc_id === docId)?.title) || docId,
    };
  }, [activeChunk, messages, pdfs]);

  const showPreview = !!activeChunk;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          <span>Scholera</span>
          <span className="brand-sep">/</span>
          <span className="brand-course">CS 4650 · Natural Language Processing</span>
        </div>
        <span className="topbar-spacer" />
        <ApiBaseField apiBase={apiBase} onSave={saveApiBase} mockMode={mockMode} />
      </header>

      <div className={`layout ${showPreview ? "" : "no-preview"}`}>
        {/* Sidebar — lectures */}
        <aside className="sidebar">
          <h2>Course materials</h2>
          {pdfs.map(p => {
            const m = p.doc_id.match(/^L(\d+)$/);
            const label = m ? `L${m[1]}` : p.doc_id;
            const active = activeChunk && activeChunk.startsWith(p.doc_id + "_");
            return (
              <button key={p.doc_id} className={"lec" + (active ? " active" : "")} title={`${p.doc_id} · ${p.filename}`}>
                <span className="lec-id" title={p.doc_id}>{label}</span>
                <span className="lec-title">{p.title.replace(/^Lecture \d+: /, "")}</span>
              </button>
            );
          })}
          <div className="sidebar-foot">
            <span>{pdfs.length} lectures indexed</span>
            <span><kbd>↵</kbd> send · <kbd>⇧↵</kbd> new line</span>
          </div>
        </aside>

        {/* Center — chat */}
        <main className="chat-col">
          <div className="thread" ref={threadRef}>
            {messages.length === 0 ? (
              <EmptyState pdfs={pdfs} onPick={(q) => ask(q)} />
            ) : (
              <div className="thread-inner">
                {messages.map((m, i) =>
                  m.role === "user"
                    ? <div className="msg-user" key={i}>{m.content}</div>
                    : <AssistantMessage
                        key={i}
                        msg={m}
                        onCite={setActiveChunk}
                        activeChunk={activeChunk}
                        showDebug={t.showDebug}
                      />
                )}
                {pending && (
                  <div className="loading-row">
                    <div className="loading-dots"><span/><span/><span/></div>
                    <span>retrieving · reranking · verifying…</span>
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="composer-wrap">
            <form className="composer" onSubmit={onSubmit}>
              <textarea
                ref={inputRef}
                rows={1}
                placeholder="Ask anything about the course…"
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  e.target.style.height = "auto";
                  e.target.style.height = Math.min(160, e.target.scrollHeight) + "px";
                }}
                onKeyDown={onKeyDown}
                autoFocus
              />
              <div className="composer-actions">
                <span className="composer-hint">
                  Answers cite the specific slide they came from — click a number to view it.
                </span>
                <button className="send-btn" type="submit" disabled={!draft.trim() || pending}>
                  <span>Ask</span>
                  <svg viewBox="0 0 16 16" fill="none"><path d="M3 8h10M9 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>
                </button>
              </div>
            </form>
          </div>
        </main>

        {/* Right — slide preview */}
        {showPreview && (
          <aside className="preview">
            <div className="preview-head">
              <div className="preview-head-title">
                <span className="ph-1">{previewMeta?.lecture_title || "Slide preview"}</span>
                <span className="ph-2">{previewMeta?.chunk_id} · slide {previewMeta?.page_num}</span>
              </div>
              <button className="icon-btn" onClick={() => setActiveChunk(null)} title="Close preview">
                <svg viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
              </button>
            </div>
            <div className="preview-body">
              <SlidePreview
                chunkId={activeChunk}
                retrieved={lastRetrieved}
                apiBase={apiBase}
                mockMode={mockMode}
              />
            </div>
          </aside>
        )}
      </div>

      {/* Tweaks */}
      <TweaksPanel>
        <TweakSection label="Density" />
        <TweakRadio label="Density" value={t.density} options={["compact", "regular"]}
                    onChange={(v) => setTweak("density", v)} />
        <TweakSection label="Typography" />
        <TweakSelect label="Font pairing" value={t.fontPair}
                     options={[
                       { value: "plex",     label: "IBM Plex (sans + serif)" },
                       { value: "iowan",    label: "System sans + Iowan/Source Serif" },
                       { value: "all-sans", label: "Sans only (no serif body)" },
                     ]}
                     onChange={(v) => setTweak("fontPair", v)} />
        <TweakSection label="Inspection" />
        <TweakToggle label="Show sub-queries" value={t.showSubQueries}
                     onChange={(v) => setTweak("showSubQueries", v)} />
        <TweakToggle label="Show debug payload" value={t.showDebug}
                     onChange={(v) => setTweak("showDebug", v)} />
      </TweaksPanel>
    </div>
  );
}

// ─────────────────────────── API_BASE field ───────────────────────────
function ApiBaseField({ apiBase, onSave, mockMode }) {
  const [draft, setDraft] = useStateApp(apiBase);
  const [savedFlash, setSavedFlash] = useStateApp(false);

  useEffectApp(() => { setDraft(apiBase); }, [apiBase]);

  const dirty = draft.trim().replace(/\/$/, "") !== apiBase;

  const commit = () => {
    onSave(draft);
    setSavedFlash(true);
    setTimeout(() => setSavedFlash(false), 1100);
  };

  return (
    <div className={`api-field ${mockMode ? "mock" : "live"}`} title={mockMode
      ? "Running on offline mock data. Paste your Colab ngrok URL to connect."
      : `Connected to ${apiBase}`}>
      <span className="conn-dot" />
      <span className="api-label">API</span>
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); e.target.blur(); } }}
        onBlur={commit}
        placeholder="https://xxxx.ngrok-free.app  ·  empty = mock data"
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
      />
      {savedFlash ? (
        <span className="api-status saved">saved</span>
      ) : dirty ? (
        <span className="api-status dirty">↵ to save</span>
      ) : (
        <span className="api-status">{mockMode ? "Mock data" : "Connected"}</span>
      )}
    </div>
  );
}

// ─────────────────────────── Empty state ───────────────────────────
function EmptyState({ pdfs, onPick }) {
  return (
    <div className="empty">
      <div className="empty-hi">
        <h1>Ask the course anything.</h1>
        <p>Answers are grounded in the indexed lecture PDFs and cite the exact slide each fact comes from. Out-of-scope questions are honestly refused.</p>
      </div>

      <div>
        <div className="empty-section-label">Try one of these</div>
        <div className="suggest-grid">
          {window.SUGGESTED_QUERIES.map((q, i) => (
            <button key={i} className="suggest" onClick={() => onPick(q)}>
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M3 7l4 4 6-7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" opacity="0.55"/>
              </svg>
              <span>{q}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="empty-section-label">{pdfs.length} lectures in scope</div>
        <div className="lec-grid">
          {pdfs.map(p => {
            const m = p.doc_id.match(/^L(\d+)$/);
            const label = m ? `L${m[1]}` : p.doc_id;
            return (
            <div key={p.doc_id} className="lec-row" title={p.doc_id}>
              <span className="lec-id">{label}</span>
              <span>{p.title.replace(/^Lecture \d+: /, "")}</span>
            </div>);
          })}
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
