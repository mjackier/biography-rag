// Biography RAG: upload pages about one person, chunk + embed + store them, ask 20 questions,
// and weave a story from the retrieved snippets only. Node 20+, no framework; only dependency: pg.
import path from "node:path";
import dns from "node:dns/promises";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { createApp, HttpError, jsonBody, readBody } from "./lib/http.js";
import { logger, requestLogger } from "./lib/log.js";
import { openStore } from "./lib/store.js";
import { chunkDocument, htmlToText } from "./lib/ingest.js";
import { embed, hasKey, EMBED_MODEL, ANSWER_MODEL, STORY_MODEL, REVIEW_MODEL } from "./lib/openai.js";
import { invalidate } from "./lib/search.js";
import { runAll, runCanary, NOT_IN_SOURCES } from "./lib/pipeline.js";
import { QUESTIONS, fill } from "./lib/questions.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const ACCESS_CODE = process.env.ACCESS_CODE || process.env.GENERATE_PASSWORD || "";
const MAX_DOC_BYTES = 12 * 1024 * 1024;
const MAX_CHUNKS_PER_COLLECTION = Number(process.env.MAX_CHUNKS || 8000);

const store = await openStore();
// A run that was going when the server restarted will never finish.
if (store.q) await store.q("UPDATE bio_runs SET status = 'failed', error = 'The server restarted during this run.' WHERE status = 'running'");

const app = createApp();
app.use(requestLogger);

// Reading is public (the story and logs are handed in as links). Anything that spends money or
// changes data needs the access code.
function requireCode(req, _res, next) {
  if (!ACCESS_CODE) return next();
  if (String(req.get("x-access-code") || "") !== ACCESS_CODE) throw new HttpError(401, "Enter the access code first.", { extra: { needCode: true } });
  return next();
}

const loadCollection = async (req) => {
  const c = await store.getCollection(Number(req.params.id));
  if (!c) throw new HttpError(404, "No such collection.");
  return c;
};

app.get("/api/health", (_req, res) => res.json({ ok: true, openai: hasKey(), db: Boolean(store.q) }));

app.get("/api/config", (_req, res) =>
  res.json({
    needCode: Boolean(ACCESS_CODE),
    models: { embed: EMBED_MODEL, answer: ANSWER_MODEL, story: STORY_MODEL, review: REVIEW_MODEL },
    questions: QUESTIONS.map((q) => ({ n: q.n, q: q.q })),
    notInSources: NOT_IN_SOURCES,
  })
);

app.post("/api/check-code", requireCode, (_req, res) => res.json({ ok: true }));

app.get("/api/collections", async (_req, res) => res.json(await store.listCollections()));

app.post("/api/collections", requireCode, async (req, res) => {
  const { person } = await jsonBody(req);
  const name = String(person || "").trim().replace(/\s+/g, " ").slice(0, 80);
  if (name.length < 2) throw new HttpError(400, "Type the person's name.");
  res.json(await store.createCollection(name));
});

app.get("/api/collections/:id", async (req, res) => {
  const c = await loadCollection(req);
  const documents = await store.listDocuments(c.id);
  res.json({
    ...c,
    documents,
    pages: documents.reduce((s, d) => s + d.pages, 0),
    chunks: documents.reduce((s, d) => s + d.chunks, 0),
    runs: await store.listRuns(c.id),
  });
});

app.patch("/api/collections/:id", requireCode, async (req, res) => {
  const c = await loadCollection(req);
  const { person } = await jsonBody(req);
  const name = String(person || "").trim().replace(/\s+/g, " ").slice(0, 80);
  if (name.length < 2) throw new HttpError(400, "Type the person's name.");
  await store.renameCollection(c.id, name);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- adding documents
function privateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:127.") || v.startsWith("::ffff:10.") || v.startsWith("::ffff:192.168.");
}

// Fetches a public web page or text file (e.g. a Project Gutenberg book). Refuses private addresses.
async function fetchUrl(raw) {
  let url;
  try {
    url = new URL(String(raw).trim());
  } catch {
    throw new HttpError(400, "That isn't a web address.");
  }
  for (let hop = 0; hop < 4; hop++) {
    if (!/^https?:$/.test(url.protocol)) throw new HttpError(400, "Only http and https links can be added.");
    const addrs = await dns.lookup(url.hostname, { all: true }).catch(() => []);
    if (!addrs.length) throw new HttpError(400, `Couldn't find ${url.hostname}.`);
    if (addrs.some((a) => privateAddress(a.address))) throw new HttpError(400, "That address isn't on the public internet.");
    let res;
    try {
      res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(150000), headers: { "User-Agent": "biography-rag (student project)" } });
    } catch (err) {
      throw new HttpError(502, `Couldn't download ${url.hostname}: ${err.cause?.code || err.cause?.message || err.message}. Try again in a minute.`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location"), url);
      continue;
    }
    if (!res.ok) throw new HttpError(400, `The site answered ${res.status} for that link.`);
    const type = String(res.headers.get("content-type") || "");
    if (type.includes("pdf")) throw new HttpError(400, "For a PDF, download it and upload the file instead (the browser reads its pages).");
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_DOC_BYTES) throw new HttpError(413, "That page is too large (over 12 MB).");
    const text = buf.toString("utf8");
    const html = type.includes("html") || /^\s*<(!doctype|html)/i.test(text);
    const title = html ? (text.match(/<title[^>]*>([^<]+)/i)?.[1] || "").trim() : "";
    return { text: html ? htmlToText(text) : text, kind: html ? "html" : "text", name: title || decodeURIComponent(url.pathname.split("/").pop() || url.hostname), source: url.href };
  }
  throw new HttpError(400, "Too many redirects.");
}

const busy = new Set(); // collections currently ingesting or running

app.post("/api/collections/:id/documents", requireCode, async (req, res) => {
  const c = await loadCollection(req);
  const body = JSON.parse((await readBody(req, { limit: MAX_DOC_BYTES * 2 })).toString("utf8") || "{}");
  let doc;
  if (body.url) doc = await fetchUrl(body.url);
  else if (Array.isArray(body.pages)) doc = { pages: body.pages.map(String), kind: "pdf", name: body.name, source: body.name };
  else if (typeof body.text === "string") {
    const isHtml = /\.html?$/i.test(body.name || "") || /^\s*<(!doctype|html)/i.test(body.text);
    doc = { text: isHtml ? htmlToText(body.text) : body.text, kind: isHtml ? "html" : "text", name: body.name, source: body.name };
  } else throw new HttpError(400, "Send a file or a link.");
  const name = String(body.title || body.name || doc.name || "Untitled").slice(0, 200);
  const { pageCount, chars, chunks, skipped } = chunkDocument(doc);
  if (!chunks.length) throw new HttpError(400, `No readable text found in "${name}".`);
  const existing = (await store.listDocuments(c.id)).reduce((s, d) => s + d.chunks, 0);
  if (existing + chunks.length > MAX_CHUNKS_PER_COLLECTION) throw new HttpError(413, `This collection would have more than ${MAX_CHUNKS_PER_COLLECTION} chunks.`);
  const meter = { usd: 0 };
  const t0 = Date.now();
  const vecs = await embed(chunks.map((ch) => ch.text), meter);
  chunks.forEach((ch, i) => (ch.embedding = vecs[i]));
  const d = await store.addDocument(c.id, { name, source: doc.source, kind: doc.kind, pages: pageCount, chars, skipped, embedUsd: meter.usd }, chunks);
  invalidate(c.id);
  logger.info("document added", { collection: c.id, doc: d.id, pages: pageCount, chunks: chunks.length, skipped, ms: Date.now() - t0, usd: meter.usd });
  res.json(d);
});

app.patch("/api/collections/:id/documents/:docId", requireCode, async (req, res) => {
  const c = await loadCollection(req);
  const name = String((await jsonBody(req)).name || "").trim().slice(0, 200);
  if (!name) throw new HttpError(400, "Type a name.");
  await store.renameDocument(c.id, Number(req.params.docId), name);
  invalidate(c.id);
  res.json({ ok: true });
});

app.delete("/api/collections/:id/documents/:docId", requireCode, async (req, res) => {
  const c = await loadCollection(req);
  if (busy.has(c.id)) throw new HttpError(409, "Wait for the run to finish first.");
  await store.deleteDocument(c.id, Number(req.params.docId));
  invalidate(c.id);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- runs
app.post("/api/collections/:id/runs", requireCode, async (req, res) => {
  const c = await loadCollection(req);
  const { kind = "full", question = "" } = await jsonBody(req);
  const docs = await store.listDocuments(c.id);
  if (!docs.length) throw new HttpError(400, "Add some pages first.");
  if (!hasKey()) throw new HttpError(503, "The server has no OpenAI key.");
  if (kind === "canary") {
    const q = fill(String(question).trim(), c.person).slice(0, 300);
    if (q.length < 8) throw new HttpError(400, "Type the canary question.");
    const run = await store.createRun(c.id, c.person, "canary");
    runCanary(store, run, c.id, c.person, q);
    return res.json(run);
  }
  if (busy.has(c.id)) throw new HttpError(409, "A run is already going for this person.");
  busy.add(c.id);
  const run = await store.createRun(c.id, c.person, "full");
  runAll(store, run, c.id, c.person).finally(() => busy.delete(c.id));
  res.json(run);
});

app.get("/api/runs/:id", async (req, res) => {
  const run = await store.getRun(Number(req.params.id));
  if (!run) throw new HttpError(404, "No such run.");
  res.json(run);
});

app.get("/api/runs/:id/logs", async (req, res) => {
  const run = await store.getRun(Number(req.params.id));
  if (!run) throw new HttpError(404, "No such run.");
  const logs = await store.getLogs(run.id);
  if (req.query.download) res.set("Content-Disposition", `attachment; filename="run-${run.id}-logs.json"`);
  res.json({ run: { id: run.id, person: run.person, kind: run.kind, status: run.status, created_at: run.created_at, usd: run.usd }, logs });
});

// The story as Markdown, with chunk IDs after each sentence and the cited chunks listed at the end.
app.get("/api/runs/:id/story.md", async (req, res) => {
  const run = await store.getRun(Number(req.params.id));
  if (!run?.story) throw new HttpError(404, "No story for that run.");
  const review = new Map((run.review?.sentences || []).map((s) => [s.n, s]));
  const ids = [...new Set(run.story.paragraphs.flatMap((p) => p.sentences.flatMap((s) => s.chunk_ids)))].sort((a, b) => a - b);
  const chunks = await store.getChunks(ids);
  const flag = (s) => {
    const r = review.get(s.n);
    return r && r.verdict !== "supported" ? ` **[flag: ${r.verdict}${r.not_in_snippets ? ` — "${r.not_in_snippets}"` : ""}]**` : "";
  };
  const md = [
    `# ${run.story.title}`,
    "",
    `_${run.person} · run ${run.id} · ${new Date(run.created_at).toISOString().slice(0, 16).replace("T", " ")} UTC · every sentence ends with the chunk IDs it came from_`,
    "",
    ...run.story.paragraphs.map((p) => p.sentences.map((s) => `${s.text} [${s.chunk_ids.map((i) => `C${i}`).join(", ")}]${flag(s)}`).join(" ") + "\n"),
    "## Not in the sources",
    "",
    ...run.answers.filter((a) => !a.found).map((a) => `- Q${a.n}. ${a.question}`),
    "",
    "## Cited chunks",
    "",
    ...chunks.map((c) => `**C${c.id}** — ${c.doc_name}, p. ${c.page_from}${c.page_to !== c.page_from ? `–${c.page_to}` : ""}\n\n> ${c.text.replace(/\n+/g, "\n> ")}\n`),
  ].join("\n");
  res.set("Content-Type", "text/markdown; charset=utf-8").send(md);
});

app.get("/api/chunks/:id", async (req, res) => {
  const [c] = await store.getChunks([Number(req.params.id)]);
  if (!c) throw new HttpError(404, "No such chunk.");
  res.json(c);
});

app.static(path.join(ROOT, "public"), { maxAge: 300 });

app.listen(PORT, () => logger.info("listening", { port: PORT, db: Boolean(store.q), openai: hasKey() }));
process.on("unhandledRejection", (err) => logger.error("unhandled rejection", { error: err?.stack || String(err) }));
