# AI Tutor

A retrieval system over a semester's worth of lecture PDFs that answers student questions accurately, with citations back to the source slides.

## The Problem

A university course produces a thick stack of dense material over a semester — typically **10–15 lecture PDFs, 50–150 pages each**, mixing prose, mathematical notation, architecture diagrams, charts, and tables. By finals, that's well over a thousand pages of academic content.

Two things become hard at that scale:

1. **Cross-lecture understanding.** A student asking _"how do the concepts from Week 3 connect to what we covered in Week 9?"_ needs an answer that has actually read both weeks — not one that pattern-matches off a single chunk.
2. **Groundedness.** The system must answer from the actual lectures, with citations that survive verification. A confidently-wrong answer or a fabricated citation is worse than no answer.

Layered on top of that, slides aren't plain text. Many of the most important ideas live inside diagrams (a transformer block, an RNN unrolled in time) or formulas (cross-entropy, attention scores) — which naive PDF parsers either drop or mangle.

## The Approach

**One ingestion foundation.** Solving the problem: _given a query or topic, fetch the most relevant grounded passages from the course corpus._

The pipeline has two halves — offline ingestion and online query.

**Ingestion (one-time, offline):**

```
PDFs ─► Per-page VLM extraction ─► Slide/page-level chunks
                                              │
                                              ▼
                          Prepend lecture context (Contextual Retrieval)
                                              │
                                              ▼
                              Dense embeddings  +  BM25 sparse index
```

**Query (per request):**

```
Query ─► Decompose into sub-queries (small LLM)
                  │
                  ▼
       Hybrid retrieve per sub-query (RRF) ─► Pool & dedupe
                                                    │
                                                    ▼
                                          Cross-encoder rerank
                                                    │
                                                    ▼
                                  Generator with cited chunks
                                                    │
                                                    ▼
                                Verifier pass (claim ↔ citation)
```

### Why a VLM for ingestion, not a PDF parser?

Standard PDF parsers (PyPDF, pdfminer) work on prose-heavy documents but degrade hard on lecture slides because:

- Diagrams carry the actual lesson, not the surrounding caption.
- Equations are often rendered as images, not LaTeX.
- Slide layouts (multi-column, callouts, arrows) confuse linear text extraction.

Instead, every page is rendered to an image and passed through **Qwen3.6-27B**, which returns a structured representation: prose as markdown, equations as LaTeX, diagrams as natural-language descriptions. One model, one pass, no per-region routing pipeline.

This is slower than a parser — but ingestion is a one-time cost paid offline. Retrieval quality at query time is what matters, and starting from a clean structured representation is what makes that quality possible.

### Why slide-level chunks (with section-aware chunking for prose)?

Slide decks chunk themselves: each slide is a complete, citable semantic unit. Splitting them further with a token-based recursive splitter (`RecursiveCharacterTextSplitter`-style) shreds diagram captions and equation blocks for no benefit.

Rule:

- **Slide decks** (the lecture PDFs) → one chunk per slide.
- **Prose documents** ([lecture_notes_NN-1.pdf](CS584_NLP_SLIDES/lecture_notes_NN-1.pdf), [lecture_notes_LR_GD-1.pdf](CS584_NLP_SLIDES/lecture_notes_LR_GD-1.pdf), project rubrics) → **section-aware semantic chunking** with 10–15% token overlap, using the VLM's markdown structure (headings, paragraphs) as the splitting signal. Each chunk records the page where its centroid lives, for citation display.

Why not page-level for prose: page boundaries in prose PDFs are typesetting artifacts. A definition or sentence routinely splits across a page break, which would garble the embedding of both halves and guarantee retrieval misses the right one. Semantic boundaries are what we actually want; the page number is just for the citation.

Citations stay clean (`[Lecture 6, slide 14]` or `[lecture_notes_NN, page 3]`) and traceability is exact.

### Sentence Window Retrieval (parent-child)

Slide-level chunking has one well-known failure mode: the **pronoun/pointer problem**. Slide 14 might define the vanishing gradient problem; slide 15 then says _"because of this, we use LSTMs"_ over a diagram. A student asking _"why do we use LSTMs to solve vanishing gradients?"_ needs slide 15, but slide 15 doesn't contain the keywords — the explicit reference was severed by the chunk boundary.

Fix: **embed at the slide level, retrieve with a window of neighbors.** When slide 15 scores as a top hit, the chunk passed to the reranker and the generator is the concatenation of slides 14 + 15 + 16. Citation still anchors to the matched slide (`[Lecture 6, slide 15]`) — the window expands the _context_ without polluting the _citation_.

```
Match:               slide 15 of Lecture 6
Context fed to LLM:  slides 14 + 15 + 16, concatenated
Citation returned:   [Lecture 6, slide 15]
```

Default window = ±1 neighbor. Catches most pronoun references with minimal context bloat. We only apply this to slide decks — prose chunks are already semantically complete after section-aware chunking, so they don't need windowing.

### Chunk metadata schema

Every chunk carries enough metadata to drive filtering, neighbor lookup, and clean citations:

```python
{
    "chunk_id":       "L6_S15",          # globally unique
    "doc_id":         "L6",               # parent document key (groups siblings)
    "doc_type":       "lecture_deck",     # lecture_deck | lecture_notes | guidelines
    "lecture_title":  "Transformers",
    "ordinal":        15,                 # monotonic position within doc
                                           #   slide # for decks, chunk index for prose
    "page_num":       15,                 # for citation display
    "text":           "...",              # raw chunk content (what the LLM sees)
    "context_text":   "Lecture 6: Transformers — ...",
                                           # what gets prepended before embedding
}
```

Two in-memory indices built once at ingestion:

- `chunks_by_id` — O(1) lookup by `chunk_id` for the reranker and verifier.
- `chunks_by_doc` — sorted by `ordinal`, for O(window) neighbor slicing during Sentence Window Retrieval.

The `(doc_id, ordinal)` composite key is what makes parent-child fetch trivial and keeps the same shape if we later push into LanceDB (`WHERE doc_id = 'L6' AND ordinal BETWEEN 14 AND 16`).

### Why Contextual Retrieval (lecture-level prepending)?

A chunk like _"the gradients become exponentially small as the sequence grows longer"_ doesn't embed close to a query about _"the vanishing gradient problem in RNNs"_ — the chunk never says those words. This is the standard failure mode of pure semantic chunking on dense academic content.

Fix: borrow [Anthropic's Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval). During ingestion, generate a 1–2 sentence summary of each lecture once, then prepend `{lecture_title} — {summary}` to every chunk _before_ embedding (and only before embedding — the generator still sees the raw chunk). This anchors every chunk to its lecture's topic in embedding space and dramatically improves retrieval recall on cross-lecture queries.

Cheap: 17 lectures × one summary call ≈ negligible cost during ingestion.

### Why query decomposition?

Multi-hop questions like _"How does what we covered in Week 2 relate to the backpropagation lecture?"_ are exactly where single-pass retrieval fails — no single embedding catches both halves of the bridge. The dense retriever pulls one side, BM25 pulls the other, neither pulls both well.

Fix: before retrieval, run the query through Qwen3.5-4B with a decomposition prompt. The 4B splits the question into independent sub-queries (_"core concepts of Week 2"_, _"backpropagation"_), each retrieves its own top-k, results are pooled, deduped, and reranked together. The generator then sees a balanced context covering both sides of the question.

Cost: one extra ~1s LLM call per query. Materially better answers on the synthesis questions that are hardest to fake.

### Handling hard constraints vs. soft signals

Two different mechanisms depending on whether the query carries a real metadata constraint or just a topical hint.

- **Hard constraints** (_"quiz on weeks 5–8"_, _"only from Lecture 3"_, _"exclude project rubrics"_) → **pre-filter** via boolean mask before similarity computation. The dense and BM25 scores are computed only over chunks that match the constraint. Guarantees 100% compliance with no risk of an empty result set, which is what post-filter (retrieve top-k, drop non-matching) silently fails on. At ~4K chunks an in-memory masked numpy operation is effectively free.
- **Soft signals** (_"What's the late submission policy?"_ — no explicit filter, but the answer lives in the rubrics doc) → no filtering. We rely on BM25's lexical precision plus Contextual Retrieval (document title prepended to each chunk) to organically surface the right document over casual mentions elsewhere. This is a soft guarantee, not a hard one — if a lecture slide happens to use the same vocabulary, the wrong chunk can win. The reranker is the last line of defense.

**Scaling note:** numpy masking works because brute-force O(N) over 4K chunks is fast. At 100× scale (university-wide catalog), it becomes the bottleneck and push-down filtering in a real index ([LanceDB](https://lancedb.github.io/lancedb/), Qdrant) is the right migration.

### Why hybrid retrieval + reranking?

Pure vector search smooths over terminology — "vanishing gradients" and "exploding gradients" embed close together but mean different things. Pure BM25 misses paraphrase. Combining the two via Reciprocal Rank Fusion captures both lexical precision and semantic recall. A cross-encoder rerank then sharpens the top-50 down to the top-6 chunks the generator actually sees.

### Verification & failure handling

The biggest failure mode of RAG isn't retrieval — it's the generator confidently asserting something the retrieved chunks don't support. The verifier is the sieve that catches this; it is not an impenetrable wall.

**What counts as a claim.** Each sentence in the generated answer must carry an inline citation marker (e.g. `[L4, slide 7]`). That sentence + its cited chunk is one claim. Sentences without citations are themselves a failure mode and get stripped.

**Verifier prompt — strict NLI framing, not "support" framing.** The verifier model (Qwen3.5-4B, deterministic decoding) is asked the entailment question, not the similarity question:

```
Premise: <retrieved chunk>
Hypothesis: <generated sentence>

Does the premise contain sufficient evidence to entail EVERY factual
detail in the hypothesis? If any name, number, definition, or
relationship in the hypothesis is missing from the premise, output NO.

Answer: YES / NO / PARTIAL
```

The "every part" wording is deliberate. A loose "does this chunk support this claim?" prompt lets fused sentences slip through (_"backprop uses the chain rule [✓] and was invented by Rumelhart in 1986 [✗]"_). NLI framing forces the verifier to look for missing details, not just topical overlap.

**Tiered failure handling.** What we do with an unsupported claim depends on how badly the answer failed verification, not just whether anything failed at all:

| Verification result                                         | Action                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All claims pass                                             | Return as-is.                                                                                                                                                                                                                                                    |
| <50% load-bearing claims unsupported, answer still coherent | **Strip + smooth** — drop the failed sentences, run a quick rewrite pass for flow.                                                                                                                                                                               |
| 50–75% unsupported                                          | **Graceful degradation** — return supported claims with a transparent note: _"some content was excluded because it could not be verified against the source materials."_ Honest about the filtering action without pretending the answer was clean.              |
| >75% unsupported, or core claim of the answer fails         | **Honest refusal** — _"I couldn't find a confident answer in the course materials for this question. The system searched: [Lecture 3, Lecture 6, project guidelines]."_ Surfacing what _was_ searched lets the student refine their question or look themselves. |
| Constrained regeneration                                    | At any tier, one retry max with a targeted instruction (_"the cited chunk does not support claim X — rewrite using only what the chunks state"_). No retry loops.                                                                                                |

**Why not just always disclaim?** A footer disclaimer attached to a confidently-written answer gets ignored. Students take notes from the body text. The honest move is to act on the verifier's output (strip, refuse, or surface the filtering), not to hedge confidence in the prose.

## Stack

All open-weight models, all latest 2026 releases.

| Layer                           | Model                                                                  | Precision | VRAM     | Notes                                                                                                                                                                                                              |
| ------------------------------- | ---------------------------------------------------------------------- | --------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Ingestion VLM**               | [Qwen3.6-27B](https://huggingface.co/Qwen/Qwen3.6-27B)                 | bf16      | ~54 GB   | Loaded alone during offline ingestion — doesn't share VRAM with query-time models. Latest dense VLM (April 2026), leads OmniDocBench v1.5 at 91.2. Page image → structured markdown with LaTeX + diagram captions. |
| **Dense embeddings**            | [Qwen3-Embedding-8B](https://huggingface.co/Qwen/Qwen3-Embedding-8B)   | bf16      | ~15 GB   | Tops the MTEB multilingual leaderboard at 70.58. No Qwen3.5/3.6 embedding model has been released yet.                                                                                                             |
| **Sparse index**                | BM25 (`rank_bm25`)                                                     | —         | CPU only | Pure Python, no GPU.                                                                                                                                                                                               |
| **Reranker**                    | [Qwen3-Reranker-8B](https://huggingface.co/Qwen/Qwen3-Reranker-8B)     | bf16      | ~15 GB   | Highest-accuracy open reranker as of 2026 (146 ELO above bge-reranker-v2-m3). No Qwen3.5/3.6 reranker has been released yet.                                                                                       |
| **Generator**                   | [Qwen3.6-35B-A3B-FP8](https://huggingface.co/Qwen/Qwen3.6-35B-A3B-FP8) | **FP8**   | ~35 GB   | MoE, 36B total / 3B active. FP8 variant chosen so all query-time models fit on a single H100. Same family as the ingestion VLM — consistent prompt style and tokenizer across the pipeline.                        |
| **Query decomposer + verifier** | [Qwen3.5-4B](https://huggingface.co/Qwen/Qwen3.5-4B)                   | bf16      | ~8 GB    | Same small model serves two roles: decomposes multi-hop queries pre-retrieval, and checks claims against citations post-generation. Stays in-family with the generator for prompt-style consistency.               |
| **Vector store**                | FAISS (in-memory, flat index) + BM25 pickle                            | —         | ~25 MB   | **Alternative**: [LanceDB](https://lancedb.github.io/lancedb/) collapses dense + sparse + metadata filtering into one embedded store; worth the swap if rich metadata filters become important.                    |
| **PDF rendering**               | PyMuPDF                                                                | —         | CPU only | Page → 200 dpi PNG for the VLM.                                                                                                                                                                                    |
| **Runtime**                     | Python 3.11 + PyTorch + Transformers                                   | —         | —        | Notebook-first, designed for Colab/H100 environments.                                                                                                                                                              |

The generator is the only model that must run quantized. FP8 quality loss at MoE-35B scale is empirically minimal.

### Choices we considered and rejected

- **Docling + Nougat + separate diagram VLM** — a routed multi-tool pipeline. Works, but with H100-class compute available, a single unified VLM gives cleaner output and simpler code.
- **Qdrant / pgvector** — overkill at this corpus size. Belongs in the "what scales next" discussion, not the build.

## Use Cases

A student asks a natural-language question. The system retrieves grounded passages across all lectures, generates an answer that draws only from those passages, and returns it with inline citations to specific lectures and slides.

Example flows it handles:

- **Single-lecture lookups** — _"What is the difference between supervised and unsupervised learning?"_ → pulls from intro/foundational lecture, cites slide.
- **Cross-lecture synthesis** — _"How does what we covered in Week 2 relate to the backpropagation lecture?"_ → BM25 catches the lecture-week language, dense retrieval pulls semantically related concepts from both, generator stitches them with citations to both.
- **Concept clarification** — _"I don't understand the vanishing gradient problem — can you explain it simply?"_ → retrieves the relevant RNN slides where the concept is introduced, answers in plain language while staying tethered to the actual content.

## Test Corpus

The system is built and tested against a real graduate NLP course (CS584):

- 17 PDFs in [CS584_NLP_SLIDES/](CS584_NLP_SLIDES/), ~40 MB total
- ~12 lecture decks (intro, language modeling, word vectors, RNNs, seq2seq, transformers, pretrain/posttrain, reasoning, syntax)
- Plus supplementary material — midterm sample, project guidelines, rubrics, lecture notes on neural nets and gradient descent

This mix is deliberately representative:

- **Visual content density** — transformer block diagrams, attention heatmaps, RNN unroll figures
- **Formula density** — cross-entropy loss, softmax, attention scores, gradient computations
- **Document type variety** — lecture decks, prose lecture notes, project rubrics — tests metadata filtering (a question about RNNs should not pull in project rubrics)

## Test Cases

The tutor is verified end-to-end against the test corpus on three categories of question:

| Category                    | Example                                                                                  | What it tests                                                                                                                                                                         |
| --------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Single-source factual**   | _"What is the formula for scaled dot-product attention?"_                                | Does retrieval find the right slide? Does the generator preserve LaTeX?                                                                                                               |
| **Cross-lecture synthesis** | _"How do word2vec embeddings relate to the input representations used by transformers?"_ | Does retrieval pull from both [3-word-vectors-1.pdf](CS584_NLP_SLIDES/3-word-vectors-1.pdf) and [6-transformers.pdf](CS584_NLP_SLIDES/6-transformers.pdf)? Does the answer cite both? |
| **Diagram-grounded**        | _"Walk me through the architecture shown in the seq2seq with attention diagram."_        | Did the VLM caption the diagram well enough that retrieval and generation can answer from the caption?                                                                                |
| **Out-of-corpus refusal**   | _"Walk me through the alpha-beta pruning algorithm used in this course."_                | Topic isn't in this NLP corpus — alpha-beta is classical AI / game-tree search. The system should refuse rather than confabulate. (RLHF was an earlier candidate for this row but turned out to be covered in [8-more-post-training.pdf](CS584_NLP_SLIDES/8-more-post-training.pdf); the system correctly answers RLHF questions, so it's not a refusal test.) |
| **Metadata isolation**      | _"What's the late submission policy?"_                                                   | Tests whether retrieval surfaces the policy from a lecture deck (`L1_S13`, intro) or the project guidelines doc — both contain it. The harder isolation case is when an answer fabricates a related-but-fake policy and cites a guidelines chunk: the verifier strips it (see LIMITATION.md "verifier strip-smooth" example).                                                                                                              |

For each, the verifier output is inspected: every cited chunk should genuinely support the corresponding claim, and no claim should appear without a citation.

### Validated end-to-end

The system was tested against all five categories above using `benchmark.py`. Two evaluation modes:

**1. End-to-end accuracy on curated cases.** Each case has an expected tier (`pass` / `strip_smooth` / `refused`), expected source `chunk_id`(s), and required content patterns the final answer must match.

| # | Category | Query | Tier | Source in top-5 | Cited correctly | Required content |
|---|---|---|---|---|---|---|
| 1 | Single-source factual | _"What is the formula for scaled dot-product attention?"_ | ✅ pass | ✅ L6_S27 #1 | ✅ | ✅ softmax/√/d_k |
| 2 | Cross-lecture synthesis | _"How do word2vec embeddings relate to transformer inputs?"_ | ✅ pass | ✅ L4_S138, L6_S29 | ✅ | ✅ subword/positional |
| 3 | Diagram-grounded | _"Walk me through the seq2seq with attention diagram."_ | ✅ strip_smooth | ✅ L5_S95 | ✅ | ✅ encoder/decoder |
| 4 | Concept clarification | _"Why is the vanishing gradient a problem in RNNs?"_ | ✅ pass | ✅ L4_S54, L4_S52 | ✅ | ✅ chain rule |
| 5 | Out-of-corpus refusal | _"Walk me through alpha-beta pruning."_ | ✅ refused | n/a | n/a | ✅ refusal text |
| 6 | Metadata isolation (soft) | _"What's the late submission policy?"_ | ✅ pass | ✅ L1_S13 #1 | ✅ | ✅ 10%/20%/48hr |
| 7 | Metadata isolation (hard) | same query, `doc_types=["guidelines"]` constraint | ✅ refused | n/a | n/a | ✅ refusal text |

**Both behaviors of the metadata-isolation test are correct:** unconstrained, the system finds the policy where it actually lives (`L1_S13`); constrained to guidelines docs only, it honestly refuses since the policy text doesn't exist there. The hard-constraint pre-filter mechanism is validated working.

**2. Needle-in-haystack retrieval.** `benchmark.py` auto-discovers chunks with distinctive content (LaTeX formulas, percentages, year citations) and generates a query for each from its longest distinctive sentence. Then verifies the chunk gets retrieved in top-5 / top-10 / top-20. Tests retrieval-only quality without involving generator or verifier.

This split (curated end-to-end + auto needle) gives both depth (semantic synthesis on hand-picked queries) and breadth (raw retrieval coverage on dozens of randomly-chosen distinctive chunks). Run with:

```bash
python benchmark.py                 # both modes
python benchmark.py --mode e2e
python benchmark.py --mode needle --needle-k 20 --save results.json
```

## Project Layout

```
.
├── CS584_NLP_SLIDES/        # test corpus (17 PDFs)
├── ingest.py                # PDF → VLM → slide/page chunks → contextual prepend → indices
├── tutor.py                 # query → decompose → hybrid retrieve → rerank → generate → verify
├── retrieval.py             # hybrid retrieval + RRF + reranker wrapper
├── chunking.py              # slide/page chunking with metadata + lecture-context prepend
├── prompts.py               # extraction, lecture-summary, decomposition, generation, verification
├── benchmark.py             # end-to-end + needle-in-haystack accuracy benchmark
└── data/                    # built indices (faiss, bm25 pickle, chunks parquet)
```
