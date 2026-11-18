// A run: 20 questions -> retrieve -> answer from snippets only -> weave the story -> check every
// sentence against the chunks it cites. Every step is logged (queries, chunk IDs, the full prompt
// sent, the model's raw response, cost) in bio_logs.
import { QUESTIONS, fill, canaryQuestion } from "./questions.js";
import { search } from "./search.js";
import { chatJSON, ANSWER_MODEL, STORY_MODEL, REVIEW_MODEL } from "./openai.js";
import { logger } from "./log.js";

export const NOT_IN_SOURCES = "Not in the sources.";
const TOP_K = Number(process.env.TOP_K || 8);

const cite = (c) => `[C${c.id}] (${c.doc}, p. ${c.page_from === c.page_to ? c.page_from : `${c.page_from}-${c.page_to}`})\n${c.text}`;

// ---------------------------------------------------------------- answering one question
const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["found", "sentences"],
  properties: {
    found: { type: "boolean" },
    sentences: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "chunk_ids"],
        properties: { text: { type: "string" }, chunk_ids: { type: "array", items: { type: "integer" } } },
      },
    },
  },
};

export const answerSystem = (person) => `You answer one question about ${person} using ONLY the source snippets the user gives you. Each snippet starts with its ID, like [C123].

Rules:
- Use only what the snippets say. Add nothing you know from anywhere else: no dates, places, names, numbers, reasons or background, even if you are sure it is true and even if a snippet seems to leave it out.
- Biographies mention many people. Only use a snippet for what it says about ${person}.
- Every sentence lists the IDs of the snippets that state it (chunk_ids: the numbers only, e.g. 123).
- If the snippets do not answer the question, set "found" to false and "sentences" to []. Don't guess, and don't answer a different question instead.
- A partial answer is fine: say only the part the snippets support.
- Write 2 to 5 plain sentences. You may quote short phrases from the snippets. If snippets disagree, say so and cite both.`;

async function answerQuestion(store, run, collectionId, person, item, meter) {
  const question = fill(item.q, person);
  const queries = [question, ...item.also.map((a) => fill(a, person))];
  const t0 = Date.now();
  const hits = await search(store, collectionId, queries, { k: TOP_K, meter });
  await store.addLog(run.id, {
    step: "search",
    qn: item.n,
    question,
    data: { queries, retrieved: hits.map(({ text, ...h }) => h), ms: Date.now() - t0 },
  });
  if (!hits.length) {
    return { n: item.n, question, found: false, answer: NOT_IN_SOURCES, sentences: [], retrieved: [] };
  }
  const system = answerSystem(person);
  const user = `Question: ${question}\n\nSource snippets:\n\n${hits.map(cite).join("\n\n")}`;
  const r = await chatJSON({ model: ANSWER_MODEL, system, user, schema: ANSWER_SCHEMA, name: "answer" });
  meter.usd += r.usd;
  const allowed = new Set(hits.map((h) => h.id));
  const dropped = [];
  const sentences = [];
  for (const s of r.data.sentences || []) {
    const ids = [...new Set((s.chunk_ids || []).filter((id) => allowed.has(id)))];
    if (!ids.length) dropped.push({ text: s.text, reason: "no valid chunk ID", chunk_ids: s.chunk_ids });
    else sentences.push({ text: s.text.trim(), chunk_ids: ids });
  }
  const found = Boolean(r.data.found) && sentences.length > 0;
  await store.addLog(run.id, {
    step: "answer",
    qn: item.n,
    question,
    data: {
      model: r.model,
      prompt: { system, user },
      response: r.raw,
      kept: found ? sentences : [],
      dropped,
      verdict: found ? "answered" : "not in the sources",
      usage: r.usage,
      usd: +r.usd.toFixed(5),
    },
  });
  return {
    n: item.n,
    question,
    found,
    answer: found ? sentences.map((s) => s.text).join(" ") : NOT_IN_SOURCES,
    sentences: found ? sentences : [],
    retrieved: hits.map((h) => h.id),
  };
}

// ---------------------------------------------------------------- the story
const STORY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "paragraphs"],
  properties: {
    title: { type: "string" },
    paragraphs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sentences"],
        properties: { sentences: ANSWER_SCHEMA.properties.sentences },
      },
    },
  },
};

export const storySystem = (person) => `You write the life story of ${person} for a general reader, woven ONLY from the research notes the user gives you. The notes answer 20 questions; every note sentence carries the IDs of the source snippets that support it, like [C123].

Rules:
- Use only facts that are in the notes. Add nothing from your own knowledge: no extra dates, places, names, numbers, causes, feelings or judgments. Short connecting words are fine ("Later,", "Meanwhile,").
- Every sentence you write carries, in chunk_ids, the snippet IDs of the note sentences it uses. Copy the IDs exactly; never cite an ID that isn't in the notes.
- Skip every question marked NOT IN THE SOURCES. Don't mention that anything is missing.
- Tell it in the order of a life where the notes allow it: birth and family, childhood and schooling, work, adventures and dangers, marriage and children, friends and rivals, achievements and travels, habits, death and memory.
- Don't invent dialogue. Quote only words that are quoted in the notes.
- 6 to 12 paragraphs. The title is a short phrase about ${person}.`;

function notesFor(answers) {
  return answers
    .map((a) =>
      a.found
        ? `Q${a.n}. ${a.question}\n${a.sentences.map((s) => `- ${s.text} [${s.chunk_ids.map((id) => `C${id}`).join(", ")}]`).join("\n")}`
        : `Q${a.n}. ${a.question}\nNOT IN THE SOURCES`
    )
    .join("\n\n");
}

async function writeStory(store, run, person, answers, meter) {
  const system = storySystem(person);
  const user = `Research notes about ${person}:\n\n${notesFor(answers)}`;
  const r = await chatJSON({ model: STORY_MODEL, system, user, schema: STORY_SCHEMA, name: "story", temperature: 0.3 });
  meter.usd += r.usd;
  const allowed = new Set(answers.flatMap((a) => a.sentences.flatMap((s) => s.chunk_ids)));
  let n = 0;
  const paragraphs = (r.data.paragraphs || []).map((p) => ({
    sentences: p.sentences.map((s) => {
      const ids = [...new Set((s.chunk_ids || []).filter((id) => allowed.has(id)))];
      const badIds = (s.chunk_ids || []).filter((id) => !allowed.has(id));
      return { n: ++n, text: s.text.trim(), chunk_ids: ids, bad_ids: badIds };
    }),
  }));
  await store.addLog(run.id, {
    step: "story",
    question: "Weave the story",
    data: { model: r.model, prompt: { system, user }, response: r.raw, usage: r.usage, usd: +r.usd.toFixed(5) },
  });
  return { title: r.data.title, paragraphs };
}

// ---------------------------------------------------------------- checking every sentence
const REVIEW_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["n", "verdict", "not_in_snippets"],
        properties: {
          n: { type: "integer" },
          verdict: { type: "string", enum: ["supported", "partly", "unsupported"] },
          not_in_snippets: { type: "string" },
        },
      },
    },
  },
};

export const reviewSystem = `You check sentences of a story against the source snippets they cite. For each numbered sentence you get the full text of the snippets it cites.

Verdicts:
- "supported": every fact in the sentence (people, places, dates, numbers, events, causes) is stated in, or follows directly from, the cited snippets.
- "partly": the main point is there, but some detail is not in the cited snippets.
- "unsupported": the main claim is not in the cited snippets.

Judge ONLY against the snippets shown, never against what you know to be true: a true fact that isn't in the snippets is still "partly" or "unsupported". Rewording, summarizing and connecting words are fine.
In not_in_snippets, quote the words that are not backed by the snippets (empty string if supported).`;

async function reviewStory(store, run, story, meter) {
  const sentences = story.paragraphs.flatMap((p) => p.sentences);
  const results = new Map();
  for (const s of sentences) if (!s.chunk_ids.length) results.set(s.n, { n: s.n, verdict: "uncited", not_in_snippets: s.text });
  const toCheck = sentences.filter((s) => s.chunk_ids.length);
  const chunkText = new Map((await store.getChunks([...new Set(toCheck.flatMap((s) => s.chunk_ids))])).map((c) => [c.id, c]));
  for (let i = 0; i < toCheck.length; i += 8) {
    const group = toCheck.slice(i, i + 8);
    const user = group
      .map(
        (s) =>
          `Sentence ${s.n}: ${s.text}\nCited snippets:\n${s.chunk_ids
            .map((id) => `[C${id}] ${chunkText.get(id)?.text || "(missing)"}`)
            .join("\n\n")}`
      )
      .join("\n\n---\n\n");
    const r = await chatJSON({ model: REVIEW_MODEL, system: reviewSystem, user, schema: REVIEW_SCHEMA, name: "review" });
    meter.usd += r.usd;
    for (const x of r.data.results || []) if (group.some((s) => s.n === x.n)) results.set(x.n, x);
    await store.addLog(run.id, {
      step: "review",
      question: `Check sentences ${group[0].n}-${group[group.length - 1].n}`,
      data: { model: r.model, prompt: { system: reviewSystem, user }, response: r.raw, usage: r.usage, usd: +r.usd.toFixed(5) },
    });
  }
  const list = sentences.map((s) => results.get(s.n) || { n: s.n, verdict: "unchecked", not_in_snippets: "" });
  const count = (v) => list.filter((x) => x.verdict === v).length;
  return {
    sentences: list,
    total: list.length,
    supported: count("supported"),
    partly: count("partly"),
    unsupported: count("unsupported"),
    uncited: count("uncited"),
  };
}

// ---------------------------------------------------------------- runs
async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i], i);
      }
    })
  );
  return out;
}

export async function runAll(store, run, collectionId, person) {
  const meter = { usd: 0 };
  const answers = [];
  try {
    await store.updateRun(run.id, { stage: "Asking the 20 questions" });
    await pool(QUESTIONS, 5, async (item) => {
      const a = await answerQuestion(store, run, collectionId, person, item, meter);
      answers.push(a);
      answers.sort((x, y) => x.n - y.n);
      await store.updateRun(run.id, { answers, usd: meter.usd, stage: `Asking the 20 questions (${answers.length} of 20 done)` });
    });
    await store.updateRun(run.id, { stage: "Weaving the story from the answers" });
    const story = await writeStory(store, run, person, answers, meter);
    await store.updateRun(run.id, { story, usd: meter.usd, stage: "Checking every sentence against its chunks" });
    const review = await reviewStory(store, run, story, meter);
    await store.updateRun(run.id, { review, usd: meter.usd, status: "done", stage: "Done", finished_at: new Date() });
  } catch (err) {
    logger.error("run failed", { run: run.id, error: err.message });
    await store.updateRun(run.id, { status: "failed", error: err.message, usd: meter.usd, answers, finished_at: new Date() });
  }
}

export async function runCanary(store, run, collectionId, person, text) {
  const meter = { usd: 0 };
  try {
    await store.updateRun(run.id, { stage: "Asking the canary question" });
    const a = await answerQuestion(store, run, collectionId, person, canaryQuestion(text), meter);
    await store.updateRun(run.id, { answers: [a], usd: meter.usd, status: "done", stage: "Done", finished_at: new Date() });
  } catch (err) {
    await store.updateRun(run.id, { status: "failed", error: err.message, usd: meter.usd, finished_at: new Date() });
  }
}
