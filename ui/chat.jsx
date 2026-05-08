// chat.jsx — chat-thread components: messages, citations, sources, slide preview.
// Loaded after React/Babel; depends on globals from mock.js.

const { useState, useEffect, useRef, useMemo, useCallback } = React;

// ─────────────────── Markdown + citation parsing ───────────────────
// Citations look like [L6_S27]. We assign each unique chunk_id a number
// based on its order of appearance in the answer text, and replace the
// raw token with a custom HTML span we'll later turn into a React node.

const CITE_RE = /\[((?:L\d+_S\d+)(?:,\s*L\d+_S\d+)*)\]/g;

function buildCitationMap(answerText, retrieved) {
  // Keep the order of appearance in the answer for a stable [1][2][3] numbering,
  // falling back to retrieved order for sources that aren't directly cited.
  const order = [];
  const seen = new Set();
  let m;
  CITE_RE.lastIndex = 0;
  while ((m = CITE_RE.exec(answerText)) !== null) {
    m[1].split(",").map(s => s.trim()).forEach(c => {
      if (!seen.has(c)) { seen.add(c); order.push(c); }
    });
  }
  retrieved.forEach(r => {
    if (!seen.has(r.chunk_id)) { seen.add(r.chunk_id); order.push(r.chunk_id); }
  });
  const map = {};
  order.forEach((id, i) => { map[id] = i + 1; });
  return map;
}

// Tiny safe-ish markdown renderer.
// Supports: **bold**, *italic*, `code`, paragraphs, $...$ inline math, $$...$$ display math, links.
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => (
    {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]
  ));
}

function renderInline(s) {
  // Order: code (locks the rest), then math, then bold, italic, links.
  // Use placeholders so nested ** / $ doesn't double-process.
  const tokens = [];
  const stash = (html) => { tokens.push(html); return `\u0001${tokens.length - 1}\u0001`; };

  // inline code
  s = s.replace(/`([^`]+)`/g, (_, inner) => stash(`<code>${escapeHtml(inner)}</code>`));
  // display math
  s = s.replace(/\$\$([^$]+?)\$\$/g, (_, tex) => stash(`<span data-math="display">${escapeHtml(tex)}</span>`));
  // inline math
  s = s.replace(/\$([^$\n]+?)\$/g, (_, tex) => stash(`<span data-math="inline">${escapeHtml(tex)}</span>`));
  // escape what's left
  s = escapeHtml(s);
  // bold and italic
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  // links [text](url)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  // restore placeholders
  s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => tokens[+i]);
  return s;
}

function splitParagraphs(s) {
  return s.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
}

// Replace [L6_S27] tokens with citation marker spans, multi-cite [a, b] becomes adjacent chips.
function injectCitations(html, citeMap, onCiteClick, activeChunk) {
  // Operate on a DOM element so we don't mutilate HTML strings further.
  const wrap = document.createElement("div");
  wrap.innerHTML = html;
  const walker = document.createTreeWalker(wrap, NodeFilter.SHOW_TEXT, null);
  const replacements = [];
  let node;
  while ((node = walker.nextNode())) {
    if (node.parentElement && node.parentElement.tagName === "CODE") continue;
    if (CITE_RE.test(node.textContent)) replacements.push(node);
  }
  CITE_RE.lastIndex = 0;
  replacements.forEach(textNode => {
    const text = textNode.textContent;
    const frag = document.createDocumentFragment();
    let last = 0;
    text.replace(CITE_RE, (full, ids, offset) => {
      if (offset > last) frag.appendChild(document.createTextNode(text.slice(last, offset)));
      ids.split(",").map(s => s.trim()).forEach(id => {
        const n = citeMap[id];
        if (!n) return;
        const span = document.createElement("span");
        span.className = "cite-marker";
        span.dataset.cite = id;
        span.dataset.num = String(n);
        frag.appendChild(span);
      });
      last = offset + full.length;
    });
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    textNode.parentNode.replaceChild(frag, textNode);
  });
  return wrap.innerHTML;
}

// React component that renders an HTML blob containing .cite-marker placeholders
// and turns them into live <Citation> components after mount.
function ProseAnswer({ answer, retrieved, citeMap, onCite, activeChunk }) {
  const ref = useRef(null);

  // Build HTML once
  const html = useMemo(() => {
    const paras = splitParagraphs(answer);
    const rendered = paras.map(p => {
      // a paragraph that's pure $$...$$ becomes a display block
      const m = p.match(/^\$\$([\s\S]+)\$\$$/);
      if (m) return `<div data-math="display-block">${escapeHtml(m[1])}</div>`;
      return `<p>${renderInline(p)}</p>`;
    }).join("");
    return injectCitations(rendered, citeMap);
  }, [answer, citeMap]);

  // After mount, swap .cite-marker spans for real buttons & render KaTeX.
  // Idempotent: math elements have their data-math attr removed after rendering
  // and cite-markers are replaced with buttons, so subsequent runs are no-ops.
  useEffect(() => {
    if (!ref.current) return;
    if (window.katex) {
      ref.current.querySelectorAll('[data-math="inline"]').forEach(el => {
        const tex = el.dataset.tex || el.textContent;
        el.dataset.tex = tex;
        try { window.katex.render(tex, el, { throwOnError: false, displayMode: false }); }
        catch (e) { el.textContent = tex; }
        el.removeAttribute("data-math");
      });
      ref.current.querySelectorAll('[data-math="display"], [data-math="display-block"]').forEach(el => {
        const tex = el.dataset.tex || el.textContent;
        el.dataset.tex = tex;
        try { window.katex.render(tex, el, { throwOnError: false, displayMode: true }); }
        catch (e) { el.textContent = tex; }
        el.removeAttribute("data-math");
      });
    }
    ref.current.querySelectorAll(".cite-marker").forEach(el => {
      const id = el.dataset.cite;
      const num = el.dataset.num;
      const r = retrieved.find(x => x.chunk_id === id);
      const btn = document.createElement("button");
      btn.className = "cite";
      btn.dataset.chunk = id;
      btn.textContent = num;
      btn.title = id;
      const tip = document.createElement("span");
      tip.className = "cite-tooltip";
      tip.innerHTML = `<code>${id}</code>${r ? `${r.lecture_title.replace("Lecture ", "L")} · p${r.page_num}` : "source"}`;
      btn.appendChild(tip);
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onCite(id);
      });
      el.replaceWith(btn);
    });
  }, [html, retrieved, onCite]);

  // Toggle .active class on cite buttons when activeChunk changes — without
  // re-rendering math (which previously duplicated the answer text).
  useEffect(() => {
    if (!ref.current) return;
    ref.current.querySelectorAll(".cite").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.chunk === activeChunk);
    });
  }, [activeChunk]);

  return <div className="prose" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ─────────────────────────── Tier pill ───────────────────────────
function TierPill({ tier, strippedCount }) {
  const labels = {
    pass:         { text: "Verified",     hint: "Every cited claim was verified against its source." },
    strip_smooth: { text: "Trimmed",      hint: `Verifier dropped ${strippedCount || 1} unsupported sentence${strippedCount === 1 ? "" : "s"}.` },
    refused:      { text: "Out of corpus", hint: "No confident answer in the course materials." },
  };
  const l = labels[tier] || labels.pass;
  return (
    <span className={`tier ${tier}`} title={l.hint}>
      <span className="tier-dot" />
      {l.text}
    </span>
  );
}

// ─────────────────────────── Sources block ───────────────────────────
function SourcesList({ retrieved, citeMap, onPick, activeChunk }) {
  if (!retrieved.length) return null;
  return (
    <div className="sources">
      <div className="sources-h">
        <SourcesIcon />
        <span>Sources · {retrieved.length}</span>
      </div>
      <div className="sources-list">
        {retrieved.map((r) => {
          const n = citeMap[r.chunk_id];
          const active = activeChunk === r.chunk_id;
          return (
            <button
              key={r.chunk_id}
              className={"source" + (active ? " active" : "")}
              onClick={() => onPick(r.chunk_id)}
            >
              <span className="source-num">{n}</span>
              <span className="source-title">
                <span className="source-title-1">{r.lecture_title}</span>
                <span className="source-title-2">{r.chunk_id} · slide {r.page_num}</span>
              </span>
              <span className="source-score">
                <span className="score-bar"><span className="score-fill" style={{ width: `${Math.round(r.score * 100)}%` }} /></span>
                <span>{r.score.toFixed(2)}</span>
              </span>
              <span className="source-arrow">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/></svg>
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SourcesIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
      <rect x="2.5" y="2.5" width="9" height="11" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="4.5" y="4.5" width="9" height="11" rx="1" stroke="currentColor" strokeWidth="1.2" fill="white" />
      <line x1="6.5" y1="8" x2="11.5" y2="8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
      <line x1="6.5" y1="11" x2="11.5" y2="11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

// ─────────────────────────── Chat message ───────────────────────────
function AssistantMessage({ msg, onCite, activeChunk, showDebug }) {
  const citeMap = useMemo(
    () => buildCitationMap(msg.answer, msg.retrieved || []),
    [msg.answer, msg.retrieved]
  );

  return (
    <div className="msg-assistant">
      <div className="msg-meta">
        <TierPill tier={msg.tier} strippedCount={msg.stripped_count} />
        {msg.sub_queries && msg.sub_queries.length > 0 && (
          <span className="sub-queries">
            <em>decomposed into</em>
            {msg.sub_queries.map((q, i) => <span key={i} className="sq-chip">{q}</span>)}
          </span>
        )}
      </div>

      {msg.tier === "refused" ? (
        <div className="prose refused">{msg.answer}</div>
      ) : (
        <ProseAnswer
          answer={msg.answer}
          retrieved={msg.retrieved || []}
          citeMap={citeMap}
          onCite={onCite}
          activeChunk={activeChunk}
        />
      )}

      {msg.tier === "strip_smooth" && (
        <div className="stripped-note">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" style={{ marginTop: 1 }}>
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2" />
            <path d="M8 5v3.5M8 11v.01" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <span>The verifier dropped {msg.stripped_count || 1} unsupported sentence{msg.stripped_count === 1 ? "" : "s"} from the model's output before showing you this answer.</span>
        </div>
      )}

      {msg.retrieved && msg.retrieved.length > 0 && (
        <SourcesList
          retrieved={msg.retrieved}
          citeMap={citeMap}
          onPick={onCite}
          activeChunk={activeChunk}
        />
      )}

      {showDebug && (msg.verdicts || msg.sub_queries) && (
        <details className="debug">
          <summary>debug · raw response</summary>
          <div className="debug-row"><span className="k">tier</span><span className="v">{msg.tier}</span></div>
          {msg.sub_queries && (
            <div className="debug-row"><span className="k">sub_queries</span><span className="v">{JSON.stringify(msg.sub_queries)}</span></div>
          )}
          {msg.verdicts && msg.verdicts.length > 0 && (
            <div className="debug-row"><span className="k">verdicts</span><span className="v">{msg.verdicts.map((v, i) => (
              <span key={i} className={v.verdict === "YES" ? "verdict-y" : v.verdict === "NO" ? "verdict-n" : "verdict-p"}>
                {v.cited_chunk_id}:{v.verdict}{i < msg.verdicts.length - 1 ? ", " : ""}
              </span>
            ))}</span></div>
          )}
        </details>
      )}
    </div>
  );
}

// ─────────────────────────── Slide preview ───────────────────────────
function SlidePreview({ chunkId, retrieved, apiBase, mockMode }) {
  const [imgState, setImgState] = useState("idle"); // idle | loading | loaded | error

  // Find source meta from anywhere in the conversation's most recent retrieved.
  const meta = retrieved && retrieved.find(r => r.chunk_id === chunkId);
  const slide = window.MOCK_SLIDES[chunkId];

  if (!chunkId) {
    return (
      <div className="preview-empty">
        <div className="pe-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <rect x="3.5" y="5" width="17" height="13" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
            <path d="M3.5 8h17" stroke="currentColor" strokeWidth="1.4" />
            <circle cx="6" cy="6.5" r="0.6" fill="currentColor" />
            <circle cx="8" cy="6.5" r="0.6" fill="currentColor" />
          </svg>
        </div>
        <h3>Slide preview</h3>
        <p>Click a citation, like <span className="cite" style={{ verticalAlign: "0", margin: 0 }}>1</span>, or any source below an answer to see the slide it came from.</p>
      </div>
    );
  }

  const docId = meta?.doc_id || chunkId.split("_")[0];
  const pageNum = meta?.page_num || parseInt(chunkId.split("_S")[1], 10);
  const lectureTitle = meta?.lecture_title || (window.MOCK_PDFS.find(p => p.doc_id === docId)?.title) || docId;

  return (
    <>
      {mockMode && slide ? (
        <MockSlideRender slide={slide} pageNum={pageNum} lectureTitle={lectureTitle} />
      ) : mockMode ? (
        <MockSlideFallback chunkId={chunkId} pageNum={pageNum} lectureTitle={lectureTitle} />
      ) : (
        <RealSlideImg apiBase={apiBase} docId={docId} pageNum={pageNum} />
      )}
      <div className="preview-caption">
        <code>{chunkId}</code>
        <span>{lectureTitle} · slide {pageNum}</span>
      </div>
    </>
  );
}

function MockSlideRender({ slide, pageNum, lectureTitle }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!ref.current || !window.katex) return;
    ref.current.querySelectorAll(".slide-math").forEach(el => {
      const tex = el.dataset.tex;
      try { window.katex.render(tex, el, { throwOnError: false, displayMode: true }); }
      catch (e) { el.textContent = tex; }
    });
  }, [slide]);

  return (
    <div className="slide-card" ref={ref}>
      <h2>{slide.title}</h2>
      <div className="slide-content">
        {slide.body.map((b, i) => {
          if (b.kind === "text") return <p key={i}>{b.text}</p>;
          if (b.kind === "math") return <div key={i} className="slide-math" data-tex={b.tex}>{b.tex}</div>;
          if (b.kind === "bullets") return <ul key={i}>{b.items.map((it, j) => <li key={j}>{it}</li>)}</ul>;
          return null;
        })}
      </div>
      <div className="slide-lec">{lectureTitle}</div>
      <div className="slide-no">{pageNum}</div>
    </div>
  );
}

function MockSlideFallback({ chunkId, pageNum, lectureTitle }) {
  return (
    <div className="slide-card">
      <h2>{lectureTitle}</h2>
      <div className="slide-content">
        <p style={{ color: "var(--subtle)", fontStyle: "italic" }}>
          (Mock preview unavailable for <code>{chunkId}</code>. With a live API_BASE, the real slide PNG would load here.)
        </p>
      </div>
      <div className="slide-lec">{lectureTitle}</div>
      <div className="slide-no">{pageNum}</div>
    </div>
  );
}

function RealSlideImg({ apiBase, docId, pageNum }) {
  const [state, setState] = useState("loading");
  const url = `${apiBase}/page/${docId}/${pageNum}`;
  useEffect(() => { setState("loading"); }, [url]);
  return (
    <div style={{ width: "100%", maxWidth: 560, aspectRatio: "4 / 3", background: "white",
                  border: "1px solid var(--border)", borderRadius: 6, boxShadow: "var(--shadow)",
                  display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
      {state === "loading" && <div className="preview-loading"><div className="loading-dots"><span/><span/><span/></div>fetching slide…</div>}
      {state === "error" && <div className="preview-loading">Failed to load — is API_BASE up?</div>}
      <img
        src={url}
        alt={`${docId} slide ${pageNum}`}
        style={{ display: state === "loaded" ? "block" : "none", maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }}
        onLoad={() => setState("loaded")}
        onError={() => setState("error")}
      />
    </div>
  );
}

Object.assign(window, {
  AssistantMessage,
  SlidePreview,
  TierPill,
  SourcesList,
  buildCitationMap,
});
