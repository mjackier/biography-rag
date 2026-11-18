// OpenAI over plain fetch (no SDK): embeddings and JSON chat. OPENAI_BASE_URL lets local tests use a fake.
import { logger } from "./log.js";

const BASE = () => (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const KEY = () => process.env.OPENAI_API_KEY || "";
export const hasKey = () => Boolean(KEY());

export const EMBED_MODEL = process.env.EMBED_MODEL || "text-embedding-3-small"; // 1536 dimensions
export const ANSWER_MODEL = process.env.ANSWER_MODEL || "gpt-4.1";
export const STORY_MODEL = process.env.STORY_MODEL || "gpt-4.1";
export const REVIEW_MODEL = process.env.REVIEW_MODEL || "gpt-4.1";
export const QUERY_MODEL = process.env.QUERY_MODEL || "gpt-4.1-mini";

// USD per 1M tokens: [input, output]
const PRICES = {
  "text-embedding-3-small": [0.02, 0],
  "text-embedding-3-large": [0.13, 0],
  "gpt-4.1": [2, 8],
  "gpt-4.1-mini": [0.4, 1.6],
  "gpt-4.1-nano": [0.1, 0.4],
  "gpt-4o": [2.5, 10],
  "gpt-4o-mini": [0.15, 0.6],
};
export function costOf(model, usage) {
  const p = PRICES[model] || [2, 8];
  const inp = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
  const out = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
  return (inp * p[0] + out * p[1]) / 1e6;
}

// A small gate so a run of 20 questions can't exceed what the account allows at once.
let active = 0;
const waiting = [];
const MAX = () => Number(process.env.OPENAI_MAX_CONCURRENCY || 8);
async function slot() {
  if (active < MAX()) return void active++;
  await new Promise((r) => waiting.push(r));
  active++;
}
function release() {
  active--;
  waiting.shift()?.();
}

async function call(path, body) {
  if (!hasKey()) throw Object.assign(new Error("The server has no OpenAI key."), { status: 503 });
  for (let attempt = 1; ; attempt++) {
    await slot();
    let res, json;
    try {
      res = await fetch(`${BASE()}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${KEY()}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(process.env.OPENAI_TIMEOUT_MS || 120000)),
      });
      json = await res.json().catch(() => null);
    } catch (err) {
      release();
      if (attempt < 4) {
        await new Promise((r) => setTimeout(r, 800 * attempt));
        continue;
      }
      throw Object.assign(new Error(`OpenAI unreachable: ${err.message}`), { status: 502 });
    }
    release();
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const wait = Number(res.headers.get("retry-after")) * 1000 || 1500 * attempt;
      logger.warn("openai retry", { path, status: res.status, attempt });
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      throw Object.assign(new Error(`OpenAI ${res.status}: ${json?.error?.message || "error"}`), { status: 502 });
    }
    return json;
  }
}

// texts -> Float32Array[] (unit length), batched.
export async function embed(texts, meter) {
  const out = [];
  let usd = 0;
  for (let i = 0; i < texts.length; i += 96) {
    const batch = texts.slice(i, i + 96).map((t) => t.slice(0, 24000));
    const json = await call("/embeddings", { model: EMBED_MODEL, input: batch });
    usd += costOf(EMBED_MODEL, json.usage);
    for (const d of json.data.sort((a, b) => a.index - b.index)) {
      const v = Float32Array.from(d.embedding);
      let n = 0;
      for (const x of v) n += x * x;
      n = Math.sqrt(n) || 1;
      for (let k = 0; k < v.length; k++) v[k] /= n;
      out.push(v);
    }
  }
  if (meter) meter.usd = (meter.usd || 0) + usd;
  return out;
}

// Chat that must answer with JSON matching `schema`. Returns { data, usage, usd, model, raw }.
export async function chatJSON({ model, system, user, schema, name = "answer", temperature = 0 }) {
  const json = await call("/chat/completions", {
    model,
    temperature,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_schema", json_schema: { name, strict: true, schema } },
  });
  const raw = json.choices?.[0]?.message?.content || "";
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error("The model didn't return valid JSON."), { status: 502 });
  }
  return { data, usage: json.usage, usd: costOf(model, json.usage), model, raw };
}
