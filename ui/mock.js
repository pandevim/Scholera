// mock.js — offline mock backend, used when API_BASE is empty.
// Mirrors the shape of the real /pdfs, /ask and /page endpoints.

window.MOCK_PDFS = [
  { doc_id: "L1", filename: "1-intro.pdf",            title: "Lecture 1: Course Intro" },
  { doc_id: "L2", filename: "2-classical-nlp.pdf",    title: "Lecture 2: Classical NLP" },
  { doc_id: "L3", filename: "3-language-models.pdf",  title: "Lecture 3: Language Models" },
  { doc_id: "L4", filename: "4-word-embeddings.pdf",  title: "Lecture 4: Word Embeddings" },
  { doc_id: "L5", filename: "5-rnn-lstm.pdf",         title: "Lecture 5: RNNs & LSTMs" },
  { doc_id: "L6", filename: "6-transformers.pdf",     title: "Lecture 6: Transformers" },
  { doc_id: "L7", filename: "7-pretrained-lms.pdf",   title: "Lecture 7: Pretrained LMs" },
  { doc_id: "L8", filename: "8-retrieval-rag.pdf",    title: "Lecture 8: Retrieval & RAG" },
  { doc_id: "L9", filename: "9-evaluation.pdf",       title: "Lecture 9: Evaluation" },
];

// Keyed by lowercase trimmed query. Matched loosely (substring includes).
window.MOCK_RESPONSES = [
  {
    match: ["scaled dot-product attention", "attention formula", "scaled dot product"],
    payload: {
      query: "What is the formula for scaled dot-product attention?",
      tier: "pass",
      sub_queries: ["scaled dot-product attention formula", "softmax attention transformer"],
      answer:
        "The formula for scaled dot-product attention is\n\n$$\\text{Attention}(Q, K, V) = \\text{softmax}\\!\\left(\\frac{QK^\\top}{\\sqrt{d_k}}\\right) V$$\n\n[L6_S27]. The dot products grow large in magnitude for high $d_k$, so the inputs to the softmax become extreme and gradients vanish; dividing by $\\sqrt{d_k}$ controls this scale [L6_S27]. The same projection is applied independently across each *head* before being concatenated [L6_S49].",
      retrieved: [
        { chunk_id: "L6_S27", doc_id: "L6", page_num: 27, lecture_title: "Lecture 6: Transformers", score: 0.97 },
        { chunk_id: "L6_S49", doc_id: "L6", page_num: 49, lecture_title: "Lecture 6: Transformers", score: 0.83 },
        { chunk_id: "L6_S31", doc_id: "L6", page_num: 31, lecture_title: "Lecture 6: Transformers", score: 0.71 },
      ],
      verdicts: [
        { sentence: "Formula sentence.",      cited_chunk_id: "L6_S27", verdict: "YES" },
        { sentence: "Scale-control sentence.",cited_chunk_id: "L6_S27", verdict: "YES" },
        { sentence: "Multi-head sentence.",   cited_chunk_id: "L6_S49", verdict: "YES" },
      ],
    },
  },
  {
    match: ["word2vec", "embedding", "transformer input"],
    payload: {
      query: "How do word2vec embeddings relate to transformer inputs?",
      tier: "strip_smooth",
      sub_queries: [
        "word2vec embedding training objective",
        "transformer input embedding layer",
        "static vs contextual embeddings",
      ],
      answer:
        "Word2vec produces a single, **static** vector per token by training a shallow network to predict context words (skip-gram) or the center word (CBOW) [L4_S138]. Transformer inputs begin from a similar lookup table — a learned embedding matrix indexed by token id — but those vectors are then **summed** with positional encodings and passed through self-attention layers, so the representation that leaves the first block is already context-dependent [L6_S29]. In practice, modern pretrained transformers learn this embedding layer end-to-end, and the resulting token vectors recover most of the analogical structure that word2vec made famous, while also resolving polysemy that a static table cannot [L7_S20].",
      retrieved: [
        { chunk_id: "L4_S138", doc_id: "L4", page_num: 138, lecture_title: "Lecture 4: Word Embeddings", score: 0.91 },
        { chunk_id: "L6_S29",  doc_id: "L6", page_num: 29,  lecture_title: "Lecture 6: Transformers",     score: 0.88 },
        { chunk_id: "L7_S20",  doc_id: "L7", page_num: 20,  lecture_title: "Lecture 7: Pretrained LMs",   score: 0.82 },
        { chunk_id: "L4_S141", doc_id: "L4", page_num: 141, lecture_title: "Lecture 4: Word Embeddings", score: 0.74 },
      ],
      verdicts: [
        { sentence: "Word2vec sentence.",  cited_chunk_id: "L4_S138", verdict: "YES" },
        { sentence: "Transformer input.",  cited_chunk_id: "L6_S29",  verdict: "YES" },
        { sentence: "Pretrained recover.", cited_chunk_id: "L7_S20",  verdict: "PARTIAL" },
      ],
      stripped_count: 1,
    },
  },
  {
    match: ["purple flowers", "textbook", "landscape"],
    payload: {
      query: "Which textbook in this course features a landscape with purple flowers?",
      tier: "pass",
      sub_queries: ["course textbook cover purple flowers"],
      answer:
        "That's *Deep Learning* by Goodfellow, Bengio and Courville — its cover is a landscape painting with a field of purple flowers, and slide 7 of the intro lists it as the recommended textbook for the course [L1_S7].",
      retrieved: [
        { chunk_id: "L1_S7", doc_id: "L1", page_num: 7, lecture_title: "Lecture 1: Course Intro", score: 0.95 },
      ],
      verdicts: [{ sentence: "Textbook.", cited_chunk_id: "L1_S7", verdict: "YES" }],
    },
  },
  {
    match: ["late submission", "late policy", "deadline"],
    payload: {
      query: "What's the late submission policy?",
      tier: "pass",
      sub_queries: ["late submission policy course"],
      answer:
        "Assignments lose **10%** of their grade per day for the first 24 hours late, and **20%** per day after that, up to a hard cutoff of **48 hours** past the deadline — beyond that, submissions receive a zero [L1_S13]. Extensions for documented reasons should be requested via the course instructor at least 24h ahead.",
      retrieved: [
        { chunk_id: "L1_S13", doc_id: "L1", page_num: 13, lecture_title: "Lecture 1: Course Intro", score: 0.93 },
      ],
      verdicts: [{ sentence: "Policy.", cited_chunk_id: "L1_S13", verdict: "YES" }],
    },
  },
  {
    match: ["alpha-beta", "pruning", "minimax"],
    payload: {
      query: "Walk me through the alpha-beta pruning algorithm used in this course.",
      tier: "refused",
      sub_queries: ["alpha-beta pruning algorithm"],
      answer:
        "I couldn't find this topic in the course materials — alpha-beta pruning is a game-tree search technique, and this course only covers natural language processing. You may be thinking of a different course's notes.",
      retrieved: [],
      verdicts: [],
    },
  },
];

// Mock content for the slide preview pane, keyed by chunk_id.
window.MOCK_SLIDES = {
  L6_S27: {
    title: "Scaled Dot-Product Attention",
    body: [
      { kind: "text", text: "Compute attention scores between every query and every key, normalize, and use them as weights over values:" },
      { kind: "math", tex: "\\text{Attention}(Q,K,V) = \\text{softmax}\\!\\left(\\frac{QK^\\top}{\\sqrt{d_k}}\\right) V" },
      { kind: "text", text: "The scaling factor √d_k prevents the dot products from growing too large as dimensionality increases, which would saturate the softmax and kill the gradient." },
      { kind: "bullets", items: ["Q, K, V ∈ ℝ^{n × d_k}", "Output ∈ ℝ^{n × d_v}", "Softmax taken row-wise"] },
    ],
  },
  L6_S49: {
    title: "Multi-Head Attention",
    body: [
      { kind: "text", text: "Run h independent attention 'heads' in parallel on linear projections of Q, K, V; concatenate the outputs and project back to model dimension." },
      { kind: "math", tex: "\\text{MultiHead}(Q,K,V) = \\text{Concat}(\\text{head}_1,\\dots,\\text{head}_h)\\,W^O" },
      { kind: "bullets", items: ["Each head learns a different sub-space", "h = 8 in the original paper", "d_k = d_v = d_model / h"] },
    ],
  },
  L6_S31: {
    title: "Why Scaling Matters",
    body: [
      { kind: "text", text: "Without the 1/√d_k factor, large d_k pushes the dot products into regions where softmax is nearly one-hot." },
      { kind: "bullets", items: ["Gradient vanishes for non-max keys", "Training becomes unstable", "Empirically: scaled variant converges faster"] },
    ],
  },
  L6_S29: {
    title: "Transformer Input Embeddings",
    body: [
      { kind: "text", text: "Token ids index into a learned embedding matrix E ∈ ℝ^{|V| × d_model}." },
      { kind: "text", text: "Positional encodings are added (not concatenated) to give the model a sense of order:" },
      { kind: "math", tex: "x_t = E[\\text{tok}_t] + \\text{PE}(t)" },
      { kind: "bullets", items: ["E is shared with the output projection (weight tying)", "PE can be sinusoidal or learned"] },
    ],
  },
  L4_S138: {
    title: "word2vec — Skip-gram",
    body: [
      { kind: "text", text: "Train a shallow network to predict context words from a center word, learning a single dense vector per token." },
      { kind: "math", tex: "\\mathcal{L} = -\\sum_{t} \\sum_{-c \\le j \\le c, j \\ne 0} \\log p(w_{t+j} \\mid w_t)" },
      { kind: "bullets", items: ["Static: one vector per token, regardless of context", "Captures analogies: king − man + woman ≈ queen", "Trained on raw text, no labels"] },
    ],
  },
  L4_S141: {
    title: "Limitations of Static Embeddings",
    body: [
      { kind: "bullets", items: ["Polysemy: 'bank' has one vector for both senses", "Out-of-vocabulary: unseen tokens have no representation", "No syntactic context", "Solved by contextual models (ELMo, BERT, …)"] },
    ],
  },
  L7_S20: {
    title: "Contextual Embeddings",
    body: [
      { kind: "text", text: "Pretrained transformers produce token representations that are functions of the entire input." },
      { kind: "bullets", items: ["Same surface form, different vector per context", "Recovers most of word2vec's analogical structure", "Outperforms static embeddings on every downstream NLP task"] },
    ],
  },
  L1_S7: {
    title: "Recommended Textbook",
    body: [
      { kind: "text", text: "Deep Learning — Ian Goodfellow, Yoshua Bengio, Aaron Courville (MIT Press, 2016)." },
      { kind: "text", text: "Cover image: a landscape painting with a field of purple flowers." },
      { kind: "bullets", items: ["Free online: deeplearningbook.org", "Chs. 6, 10 are most relevant to this course"] },
    ],
  },
  L1_S13: {
    title: "Late Submission Policy",
    body: [
      { kind: "bullets", items: [
        "10% deduction per day, days 0–1",
        "20% deduction per day, after day 1",
        "Hard cutoff at 48h past deadline",
        "Extensions: request ≥24h ahead via the course instructor",
      ] },
    ],
  },
};

// Suggested starter queries shown on the empty state.
window.SUGGESTED_QUERIES = [
  "What is the formula for scaled dot-product attention?",
  "How do word2vec embeddings relate to transformer inputs?",
  "What's the late submission policy?",
  "Which textbook in this course features a landscape with purple flowers?",
];
