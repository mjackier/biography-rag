// Hybrid search over one collection: embeddings (meaning) + BM25 (exact words: names, places,
// dates), merged with reciprocal rank fusion. Each question is searched with several phrasings.
import { embed } from "./openai.js";

const STOP = new Set(
  "a an and are as at be been but by did do does for from had has have he her hers him his how i if in into is it its me my no not of on or our she so than that the their them then there these they this to too was we were what when where which who whom why will with would you your about after again all also any because before being both can could each few further here just more most other over same should some such through under until up very while".split(
    " "
  )
);

export function tokens(text) {
  return (String(text).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[a-z0-9]+/g) || [])
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}
function stem(w) {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

class Bm25 {
  constructor(docs) {
    this.k1 = 1.4;
    this.b = 0.75;
    this.tf = docs.map((d) => {
      const m = new Map();
      for (const t of tokens(d)) m.set(t, (m.get(t) || 0) + 1);
      return m;
    });
    this.len = this.tf.map((m) => [...m.values()].reduce((s, x) => s + x, 0));
    this.avg = this.len.reduce((s, x) => s + x, 0) / (this.len.length || 1);
    this.df = new Map();
    for (const m of this.tf) for (const t of m.keys()) this.df.set(t, (this.df.get(t) || 0) + 1);
    this.N = docs.length;
  }
  scores(query) {
    const q = [...new Set(tokens(query))];
    const out = new Float64Array(this.N);
    for (const t of q) {
      const df = this.df.get(t);
      if (!df) continue;
      const idf = Math.log(1 + (this.N - df + 0.5) / (df + 0.5));
      for (let i = 0; i < this.N; i++) {
        const f = this.tf[i].get(t);
        if (!f) continue;
        out[i] += (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * this.len[i]) / this.avg));
      }
    }
    return out;
  }
}

const cache = new Map(); // collectionId -> { chunks, bm25 }
export const invalidate = (collectionId) => cache.delete(Number(collectionId));

async function index(store, collectionId) {
  const key = Number(collectionId);
  if (!cache.has(key)) {
    const chunks = await store.loadChunks(key);
    cache.set(key, { chunks, bm25: new Bm25(chunks.map((c) => `${c.text}`)) });
  }
  return cache.get(key);
}

const rankOf = (scores, n) =>
  [...scores.keys()]
    .filter((i) => scores[i] > 0)
    .sort((a, b) => scores[b] - scores[a])
    .slice(0, n);

// queries: strings. Returns the top k chunks with their scores, best first.
export async function search(store, collectionId, queries, { k = 8, meter } = {}) {
  const { chunks, bm25 } = await index(store, collectionId);
  if (!chunks.length) return [];
  const vecs = await embed(queries, meter);
  const fused = new Map(); // chunk index -> { rrf, cos, bm25 }
  const bump = (i, rank, field, value) => {
    const e = fused.get(i) || { rrf: 0, cos: 0, bm25: 0 };
    e.rrf += 1 / (60 + rank);
    e[field] = Math.max(e[field], value);
    fused.set(i, e);
  };
  queries.forEach((q, qi) => {
    const v = vecs[qi];
    const cos = new Float64Array(chunks.length);
    for (let i = 0; i < chunks.length; i++) {
      const e = chunks[i].embedding;
      let s = 0;
      for (let d = 0; d < e.length; d++) s += e[d] * v[d];
      cos[i] = s;
    }
    rankOf(cos, 40).forEach((i, r) => bump(i, r + 1, "cos", cos[i]));
    const bs = bm25.scores(q);
    rankOf(bs, 40).forEach((i, r) => bump(i, r + 1, "bm25", bs[i]));
  });
  return [...fused.entries()]
    .sort((a, b) => b[1].rrf - a[1].rrf)
    .slice(0, k)
    .map(([i, s]) => ({
      id: chunks[i].id,
      doc: chunks[i].doc_name,
      document_id: chunks[i].document_id,
      page_from: chunks[i].page_from,
      page_to: chunks[i].page_to,
      text: chunks[i].text,
      cos: +s.cos.toFixed(4),
      bm25: +s.bm25.toFixed(3),
      rrf: +s.rrf.toFixed(5),
    }));
}
