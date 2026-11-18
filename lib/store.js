// Storage. Postgres (DATABASE_URL) in production; an in-memory store when there's no database
// (local tests). Tables are prefixed bio_ so they can share a database with other apps.
//
// Embeddings are stored as raw float32 bytes (BYTEA). Search happens in the app: a collection of a
// few thousand chunks fits in memory (1,536 floats x 2,000 chunks = 12 MB), and cosine similarity
// over all of them takes a few milliseconds, so no vector extension is needed.

const SCHEMA = `
CREATE TABLE IF NOT EXISTS bio_collections (
  id         SERIAL PRIMARY KEY,
  person     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bio_documents (
  id            SERIAL PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES bio_collections(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  source        TEXT NOT NULL DEFAULT '',      -- file name or URL
  kind          TEXT NOT NULL DEFAULT 'text',  -- text | html | pdf
  pages         INTEGER NOT NULL DEFAULT 0,
  chars         INTEGER NOT NULL DEFAULT 0,
  chunks        INTEGER NOT NULL DEFAULT 0,
  skipped       INTEGER NOT NULL DEFAULT 0,
  embed_usd     DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bio_chunks (
  id            SERIAL PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES bio_collections(id) ON DELETE CASCADE,
  document_id   INTEGER NOT NULL REFERENCES bio_documents(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  page_from     INTEGER NOT NULL,
  page_to       INTEGER NOT NULL,
  text          TEXT NOT NULL,
  embedding     BYTEA NOT NULL
);
CREATE INDEX IF NOT EXISTS bio_chunks_coll_idx ON bio_chunks(collection_id);
CREATE TABLE IF NOT EXISTS bio_runs (
  id            SERIAL PRIMARY KEY,
  collection_id INTEGER NOT NULL REFERENCES bio_collections(id) ON DELETE CASCADE,
  person        TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'full',  -- full | canary
  status        TEXT NOT NULL DEFAULT 'running',
  stage         TEXT NOT NULL DEFAULT '',
  answers       JSONB NOT NULL DEFAULT '[]',
  story         JSONB,
  review        JSONB,
  error         TEXT NOT NULL DEFAULT '',
  usd           DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS bio_logs (
  id         SERIAL PRIMARY KEY,
  run_id     INTEGER NOT NULL REFERENCES bio_runs(id) ON DELETE CASCADE,
  step       TEXT NOT NULL,          -- search | answer | story | review
  qn         INTEGER,                -- question number (1-20, 0 = canary)
  question   TEXT NOT NULL DEFAULT '',
  data       JSONB NOT NULL,         -- queries, retrieved chunk ids + scores, prompt, response, model, cost
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bio_logs_run_idx ON bio_logs(run_id, id);
`;

const toBytes = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
const fromBytes = (buf) => {
  const copy = Buffer.from(buf); // aligned copy
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
};

export class PgStore {
  constructor(url) {
    this.url = url;
  }
  async init() {
    const { default: pg } = await import("pg");
    const local = /localhost|127\.0\.0\.1/.test(this.url);
    this.pool = new pg.Pool({ connectionString: this.url, ssl: local ? false : { rejectUnauthorized: false }, max: 5 });
    await this.pool.query(SCHEMA);
  }
  q(text, params) {
    return this.pool.query(text, params);
  }
  async createCollection(person) {
    return (await this.q("INSERT INTO bio_collections (person) VALUES ($1) RETURNING *", [person])).rows[0];
  }
  async getCollection(id) {
    return (await this.q("SELECT * FROM bio_collections WHERE id = $1", [id])).rows[0] || null;
  }
  async renameCollection(id, person) {
    await this.q("UPDATE bio_collections SET person = $2 WHERE id = $1", [id, person]);
  }
  async listCollections() {
    return (
      await this.q(`SELECT c.*, COALESCE(SUM(d.pages),0)::int AS pages, COALESCE(SUM(d.chunks),0)::int AS chunks, COUNT(d.id)::int AS documents
        FROM bio_collections c LEFT JOIN bio_documents d ON d.collection_id = c.id GROUP BY c.id ORDER BY c.id DESC`)
    ).rows;
  }
  async listDocuments(collectionId) {
    return (await this.q("SELECT * FROM bio_documents WHERE collection_id = $1 ORDER BY id", [collectionId])).rows;
  }
  async addDocument(collectionId, doc, chunks) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const d = (
        await client.query(
          `INSERT INTO bio_documents (collection_id, name, source, kind, pages, chars, chunks, skipped, embed_usd)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
          [collectionId, doc.name, doc.source || "", doc.kind || "text", doc.pages, doc.chars, chunks.length, doc.skipped || 0, doc.embedUsd || 0]
        )
      ).rows[0];
      for (let i = 0; i < chunks.length; i += 200) {
        const part = chunks.slice(i, i + 200);
        const vals = [];
        const params = [];
        part.forEach((c, j) => {
          const b = j * 7;
          vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7})`);
          params.push(collectionId, d.id, c.seq, c.page_from, c.page_to, c.text, toBytes(c.embedding));
        });
        await client.query(`INSERT INTO bio_chunks (collection_id, document_id, seq, page_from, page_to, text, embedding) VALUES ${vals.join(",")}`, params);
      }
      await client.query("COMMIT");
      return d;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }
  async renameDocument(collectionId, docId, name) {
    await this.q("UPDATE bio_documents SET name = $3 WHERE id = $1 AND collection_id = $2", [docId, collectionId, name]);
  }
  async deleteDocument(collectionId, docId) {
    await this.q("DELETE FROM bio_documents WHERE id = $1 AND collection_id = $2", [docId, collectionId]);
  }
  async loadChunks(collectionId) {
    const { rows } = await this.q(
      `SELECT c.id, c.document_id, c.seq, c.page_from, c.page_to, c.text, c.embedding, d.name AS doc_name
         FROM bio_chunks c JOIN bio_documents d ON d.id = c.document_id WHERE c.collection_id = $1 ORDER BY c.id`,
      [collectionId]
    );
    return rows.map((r) => ({ ...r, embedding: fromBytes(r.embedding) }));
  }
  async getChunks(ids) {
    if (!ids.length) return [];
    const { rows } = await this.q(
      `SELECT c.id, c.document_id, c.collection_id, c.seq, c.page_from, c.page_to, c.text, d.name AS doc_name, d.source
         FROM bio_chunks c JOIN bio_documents d ON d.id = c.document_id WHERE c.id = ANY($1::int[])`,
      [ids]
    );
    return rows;
  }
  async createRun(collectionId, person, kind) {
    return (await this.q("INSERT INTO bio_runs (collection_id, person, kind) VALUES ($1,$2,$3) RETURNING *", [collectionId, person, kind])).rows[0];
  }
  async updateRun(id, fields) {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
    const vals = keys.map((k) => (fields[k] !== null && typeof fields[k] === "object" && !(fields[k] instanceof Date) ? JSON.stringify(fields[k]) : fields[k]));
    await this.q(`UPDATE bio_runs SET ${sets} WHERE id = $1`, [id, ...vals]);
  }
  async getRun(id) {
    return (await this.q("SELECT * FROM bio_runs WHERE id = $1", [id])).rows[0] || null;
  }
  async listRuns(collectionId) {
    return (
      await this.q(
        "SELECT id, collection_id, person, kind, status, stage, usd, created_at, finished_at, error FROM bio_runs WHERE collection_id = $1 ORDER BY id DESC LIMIT 50",
        [collectionId]
      )
    ).rows;
  }
  async addLog(runId, entry) {
    await this.q("INSERT INTO bio_logs (run_id, step, qn, question, data) VALUES ($1,$2,$3,$4,$5)", [
      runId,
      entry.step,
      entry.qn ?? null,
      entry.question || "",
      JSON.stringify(entry.data || {}),
    ]);
  }
  async getLogs(runId) {
    return (await this.q("SELECT * FROM bio_logs WHERE run_id = $1 ORDER BY id", [runId])).rows;
  }
}

// Same interface, kept in memory (used for local tests when there's no DATABASE_URL).
export class MemoryStore {
  async init() {
    this.t = { collections: [], documents: [], chunks: [], runs: [], logs: [] };
    this.ids = { collections: 0, documents: 0, chunks: 0, runs: 0, logs: 0 };
  }
  add(table, row) {
    const r = { id: ++this.ids[table], created_at: new Date().toISOString(), ...row };
    this.t[table].push(r);
    return r;
  }
  async createCollection(person) {
    return this.add("collections", { person });
  }
  async getCollection(id) {
    return this.t.collections.find((c) => c.id === Number(id)) || null;
  }
  async renameCollection(id, person) {
    const c = await this.getCollection(id);
    if (c) c.person = person;
  }
  async listCollections() {
    return [...this.t.collections].reverse().map((c) => {
      const docs = this.t.documents.filter((d) => d.collection_id === c.id);
      return { ...c, documents: docs.length, pages: docs.reduce((s, d) => s + d.pages, 0), chunks: docs.reduce((s, d) => s + d.chunks, 0) };
    });
  }
  async listDocuments(collectionId) {
    return this.t.documents.filter((d) => d.collection_id === Number(collectionId));
  }
  async addDocument(collectionId, doc, chunks) {
    const d = this.add("documents", {
      collection_id: Number(collectionId),
      name: doc.name,
      source: doc.source || "",
      kind: doc.kind || "text",
      pages: doc.pages,
      chars: doc.chars,
      chunks: chunks.length,
      skipped: doc.skipped || 0,
      embed_usd: doc.embedUsd || 0,
    });
    for (const c of chunks) this.add("chunks", { collection_id: Number(collectionId), document_id: d.id, seq: c.seq, page_from: c.page_from, page_to: c.page_to, text: c.text, embedding: c.embedding });
    return d;
  }
  async renameDocument(collectionId, docId, name) {
    const d = this.t.documents.find((x) => x.id === Number(docId) && x.collection_id === Number(collectionId));
    if (d) d.name = name;
  }
  async deleteDocument(collectionId, docId) {
    this.t.documents = this.t.documents.filter((d) => !(d.id === Number(docId) && d.collection_id === Number(collectionId)));
    this.t.chunks = this.t.chunks.filter((c) => c.document_id !== Number(docId));
  }
  async loadChunks(collectionId) {
    return this.t.chunks
      .filter((c) => c.collection_id === Number(collectionId))
      .map((c) => ({ ...c, doc_name: this.t.documents.find((d) => d.id === c.document_id)?.name }));
  }
  async getChunks(ids) {
    return this.t.chunks
      .filter((c) => ids.includes(c.id))
      .map(({ embedding, ...c }) => {
        const d = this.t.documents.find((x) => x.id === c.document_id);
        return { ...c, doc_name: d?.name, source: d?.source };
      });
  }
  async createRun(collectionId, person, kind) {
    return this.add("runs", { collection_id: Number(collectionId), person, kind, status: "running", stage: "", answers: [], story: null, review: null, error: "", usd: 0, finished_at: null });
  }
  async updateRun(id, fields) {
    Object.assign(this.t.runs.find((r) => r.id === Number(id)), JSON.parse(JSON.stringify(fields)));
  }
  async getRun(id) {
    const r = this.t.runs.find((x) => x.id === Number(id));
    return r ? JSON.parse(JSON.stringify(r)) : null;
  }
  async listRuns(collectionId) {
    return this.t.runs.filter((r) => r.collection_id === Number(collectionId)).reverse().map(({ answers, story, review, ...r }) => r);
  }
  async addLog(runId, entry) {
    this.add("logs", { run_id: Number(runId), step: entry.step, qn: entry.qn ?? null, question: entry.question || "", data: JSON.parse(JSON.stringify(entry.data || {})) });
  }
  async getLogs(runId) {
    return this.t.logs.filter((l) => l.run_id === Number(runId));
  }
}

export async function openStore() {
  const s = process.env.DATABASE_URL ? new PgStore(process.env.DATABASE_URL) : new MemoryStore();
  await s.init();
  return s;
}
