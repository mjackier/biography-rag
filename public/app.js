// From the Sources: a small single-page app (no framework).
const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtUsd = (x) => `$${Number(x || 0).toFixed(x < 0.1 ? 3 : 2)}`;
const when = (t) => new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
let config = null;

// ---------------------------------------------------------------- access code
const store = {
  get: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {}
  },
};
let code = store.get("access-code") || "";

function askCode() {
  return new Promise((resolve) => {
    const dlg = $("#codeDialog");
    $("#codeError").textContent = "";
    $("#codeInput").value = "";
    dlg.showModal();
    const done = (ok) => {
      $("#codeForm").onsubmit = null;
      $("#codeCancel").onclick = null;
      dlg.close();
      resolve(ok);
    };
    $("#codeCancel").onclick = () => done(false);
    $("#codeForm").onsubmit = async (e) => {
      e.preventDefault();
      const tryCode = $("#codeInput").value.trim();
      const r = await fetch("/api/check-code", { method: "POST", headers: { "x-access-code": tryCode } });
      if (!r.ok) return ($("#codeError").textContent = "That code isn't right.");
      code = tryCode;
      store.set("access-code", code);
      done(true);
    };
  });
}

async function api(method, url, body, { raw = false } = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", "x-access-code": code },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && data.needCode && attempt === 0) {
      if (await askCode()) continue;
      throw new Error("The access code is needed for this.");
    }
    if (!r.ok) throw Object.assign(new Error(data.error || `Error ${r.status}`), { data, status: r.status });
    return data;
  }
}

// ---------------------------------------------------------------- router
let timer = null;
async function route() {
  clearTimeout(timer);
  $("#chunkPanel").hidden = true;
  config ??= await api("GET", "/api/config");
  const h = location.hash.slice(1) || "/";
  let m;
  try {
    if ((m = h.match(/^\/c\/(\d+)/))) await collectionPage(Number(m[1]));
    else if ((m = h.match(/^\/run\/(\d+)(?:\/(\w+))?/))) await runPage(Number(m[1]), m[2] || "story");
    else await home();
  } catch (err) {
    view.innerHTML = `<p class="error">${esc(err.message)}</p><p><a href="#/">Back</a></p>`;
  }
}
addEventListener("hashchange", () => {
  route();
  view.focus({ preventScroll: true });
  scrollTo(0, 0);
});
route();

// ---------------------------------------------------------------- home: people
async function home() {
  const list = await api("GET", "/api/collections");
  view.innerHTML = `
    <h1>A life, told only from the sources</h1>
    <p class="muted" style="max-width:720px">Upload biographies of one person (text, HTML or PDF files, or links). They're cut into chunks, embedded and stored.
    Then 20 questions are asked against the chunks, each answered only from what was retrieved, and a story is woven from those answers.
    Every sentence carries the IDs of the chunks it came from, and a checker flags anything the sources don't say.</p>
    <section class="sheet">
      <h2>Start with a person</h2>
      <form id="newPerson" class="row">
        <input type="text" id="personName" class="grow" placeholder="e.g. Benjamin Franklin" maxlength="80" required aria-label="Person's name" />
        <button class="primary">Create</button>
      </form>
      <p class="error" id="newErr"></p>
    </section>
    ${
      list.length
        ? `<h2 style="margin-top:26px">People</h2><div class="people">${list
            .map(
              (c) => `<a class="person" href="#/c/${c.id}"><strong>${esc(c.person)}</strong>
              <span class="muted small">${c.documents} document${c.documents === 1 ? "" : "s"} · ${c.pages.toLocaleString()} pages · ${c.chunks.toLocaleString()} chunks</span></a>`
            )
            .join("")}</div>`
        : ""
    }`;
  $("#newPerson").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const c = await api("POST", "/api/collections", { person: $("#personName").value });
      location.hash = `#/c/${c.id}`;
    } catch (err) {
      $("#newErr").textContent = err.message;
    }
  });
}

// ---------------------------------------------------------------- a person's collection
async function collectionPage(id) {
  const c = await api("GET", `/api/collections/${id}`);
  const canaryDefault = store.get(`canary-${id}`) || "";
  view.innerHTML = `
    <p class="small"><a href="#/">All people</a></p>
    <h1>${esc(c.person)}</h1>
    <div class="stats">
      <div class="stat"><b>${c.documents.length}</b><span>documents</span></div>
      <div class="stat"><b>${c.pages.toLocaleString()}</b><span>pages ${c.pages >= 500 ? '<span class="badge ok">500+</span>' : ""}</span></div>
      <div class="stat"><b>${c.chunks.toLocaleString()}</b><span>chunks embedded</span></div>
    </div>

    <section class="sheet">
      <h2>1. The pages</h2>
      <div class="drop" id="drop" tabindex="0" role="button" aria-label="Add files">
        <strong>Drop files here or click to choose</strong><br />
        <span class="muted small">.txt, .md, .html or .pdf, as many as you like. PDFs are read page by page in your browser.</span>
        <input type="file" id="files" multiple accept=".txt,.md,.markdown,.html,.htm,.pdf,text/plain,text/html,application/pdf" hidden />
      </div>
      <h3>…or add links</h3>
      <p class="muted small" style="margin-top:-4px">One per line: web pages or plain-text books (Project Gutenberg's "Plain Text UTF-8" link, or an archive.org "FULL TEXT" file). Optional title first: <code>Title | https://…</code></p>
      <textarea id="urls" placeholder="https://www.gutenberg.org/cache/epub/20203/pg20203.txt"></textarea>
      <div class="row" style="margin-top:8px"><button class="primary" id="addUrls">Add links</button></div>
      <div id="addLog" class="small" aria-live="polite"></div>
      ${
        c.documents.length
          ? `<div class="wrap"><table style="margin-top:14px"><thead><tr><th>Document</th><th class="num">Pages</th><th class="num">Chunks</th><th class="num hide-sm">Skipped</th><th></th></tr></thead><tbody>
          ${c.documents
            .map(
              (d) => `<tr><td>${esc(d.name)}<br /><span class="muted small">${d.kind}${d.source && /^https?:/.test(d.source) ? ` · <a href="${esc(d.source)}" target="_blank" rel="noopener">source</a>` : ""} · ${d.chars.toLocaleString()} characters</span></td>
              <td class="num">${d.pages}</td><td class="num">${d.chunks}</td><td class="num hide-sm" title="index or contents pages left out">${d.skipped}</td>
              <td><button class="link" data-ren="${d.id}" data-name="${esc(d.name)}">Rename</button> · <button class="link" data-del="${d.id}">Remove</button></td></tr>`
            )
            .join("")}
          </tbody></table></div>
          <p class="muted small">For text and HTML a page is counted as 2,000 characters (about 350 words); PDFs keep their real pages. "Skipped" chunks were index or contents pages.</p>`
          : ""
      }
    </section>

    <section class="sheet">
      <h2>2. Ask the 20 questions and weave the story</h2>
      <p class="muted small">Each question is searched (meaning + exact words), answered only from the ${8} best chunks, or marked "not in the sources". Then the story is written from the answers and every sentence is checked against the chunks it cites. Takes 1–2 minutes.</p>
      <button class="primary" id="runAll" ${c.documents.length ? "" : "disabled"}>Run the 20 questions</button>
      <p class="error" id="runErr"></p>
      <h3>Canary test</h3>
      <p class="muted small" style="margin-top:-4px">Ask something true about ${esc(c.person)} that is <em>not</em> in these pages. The right answer is "not in the sources".</p>
      <div class="row"><input type="text" id="canary" class="grow" maxlength="300" value="${esc(canaryDefault)}" placeholder="e.g. On which U.S. banknote does {person}'s portrait appear?" />
      <button id="runCanary" ${c.documents.length ? "" : "disabled"}>Ask</button></div>
      <div id="canaryOut" aria-live="polite"></div>
    </section>

    ${
      c.runs.length
        ? `<section class="sheet"><h2>Runs</h2><div class="wrap"><table><thead><tr><th>Run</th><th>What</th><th>Status</th><th class="num">Cost</th></tr></thead><tbody>
        ${c.runs
          .map(
            (r) => `<tr><td><a href="#/run/${r.id}">#${r.id}</a> <span class="muted small">${when(r.created_at)}</span></td><td>${r.kind === "canary" ? "Canary question" : "20 questions + story"}</td>
            <td>${r.status === "done" ? '<span class="badge ok">done</span>' : r.status === "failed" ? `<span class="badge bad" title="${esc(r.error)}">failed</span>` : `<span class="badge warn">${esc(r.stage || "running")}</span>`}</td>
            <td class="num">${fmtUsd(r.usd)}</td></tr>`
          )
          .join("")}</tbody></table></div></section>`
        : ""
    }`;

  // files
  const drop = $("#drop");
  const pick = $("#files");
  drop.addEventListener("click", () => pick.click());
  drop.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && pick.click());
  drop.addEventListener("dragover", (e) => (e.preventDefault(), drop.classList.add("over")));
  drop.addEventListener("dragleave", () => drop.classList.remove("over"));
  drop.addEventListener("drop", (e) => {
    e.preventDefault();
    drop.classList.remove("over");
    addFiles(id, [...e.dataTransfer.files]);
  });
  pick.addEventListener("change", () => addFiles(id, [...pick.files]));
  $("#addUrls").addEventListener("click", () => {
    // One per line: "https://..." or "Title | https://..."
    const lines = $("#urls").value.split("\n").map((l) => l.trim()).filter(Boolean);
    const items = lines
      .map((l) => {
        const m = l.match(/^(?:(.*?)\s*\|\s*)?(https?:\/\/\S+)$/i);
        return m && { label: m[1] || m[2], body: async () => ({ url: m[2], ...(m[1] ? { title: m[1] } : {}) }) };
      })
      .filter(Boolean);
    if (!items.length) return ($("#addLog").innerHTML = '<p class="error">Paste at least one http(s) link.</p>');
    addItems(id, items);
  });
  view.querySelectorAll("[data-del]").forEach((b) =>
    b.addEventListener("click", async () => {
      if (!confirm("Remove this document and its chunks?")) return;
      await api("DELETE", `/api/collections/${id}/documents/${b.dataset.del}`);
      route();
    })
  );
  view.querySelectorAll("[data-ren]").forEach((b) =>
    b.addEventListener("click", async () => {
      const name = prompt("Name for this document (shown with every citation):", b.dataset.name);
      if (!name) return;
      await api("PATCH", `/api/collections/${id}/documents/${b.dataset.ren}`, { name });
      route();
    })
  );
  $("#runAll").addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      const run = await api("POST", `/api/collections/${id}/runs`, { kind: "full" });
      location.hash = `#/run/${run.id}`;
    } catch (err) {
      $("#runErr").textContent = err.message;
      e.target.disabled = false;
    }
  });
  $("#runCanary").addEventListener("click", async (e) => {
    const q = $("#canary").value.trim() || $("#canary").placeholder.replace(/^e\.g\. /, "");
    store.set(`canary-${id}`, q);
    e.target.disabled = true;
    $("#canaryOut").innerHTML = '<p class="muted">Searching and asking…</p>';
    try {
      let run = await api("POST", `/api/collections/${id}/runs`, { kind: "canary", question: q });
      while (run.status === "running") {
        await new Promise((r) => setTimeout(r, 1200));
        run = await api("GET", `/api/runs/${run.id}`);
      }
      const a = run.answers?.[0];
      $("#canaryOut").innerHTML = a
        ? `<div class="sheet" style="margin:12px 0 0"><p><strong>${esc(a.question)}</strong></p>
           <p>${a.found ? `<span class="badge bad">answered from the sources</span> ${renderSentences(a.sentences)}` : `<span class="badge ok">${esc(config.notInSources)}</span> The model refused to answer from memory.`}</p>
           <p class="ids">Retrieved chunks: ${a.retrieved.map((x) => `<button class="cite" data-chunk="${x}">C${x}</button>`).join(" ")} · <a href="#/run/${run.id}/logs">log</a></p></div>`
        : `<p class="error">${esc(run.error || "Failed.")}</p>`;
      wireCites($("#canaryOut"));
    } catch (err) {
      $("#canaryOut").innerHTML = `<p class="error">${esc(err.message)}</p>`;
    }
    e.target.disabled = false;
  });
}

// ---------------------------------------------------------------- uploading
let pdfjs = null;
async function loadPdfJs() {
  if (pdfjs) return pdfjs;
  await new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
    s.onload = resolve;
    s.onerror = () => reject(new Error("Couldn't load the PDF reader."));
    document.head.appendChild(s);
  });
  pdfjs = window.pdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  return pdfjs;
}

async function pdfPages(file, onPage) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Keep line breaks (hasEOL) so paragraphs survive; blank-ish gaps become paragraph breaks.
    let text = "";
    for (const item of content.items) text += item.str + (item.hasEOL ? "\n" : " ");
    pages.push(text.replace(/\n{2,}/g, "\n\n"));
    if (i % 10 === 0) onPage(i, doc.numPages);
  }
  return pages;
}

function addFiles(id, files) {
  addItems(
    id,
    files.map((f) => ({
      label: f.name,
      body: async (say) => {
        if (/\.pdf$/i.test(f.name) || f.type === "application/pdf") return { name: f.name, pages: await pdfPages(f, (i, n) => say(`reading page ${i} of ${n}`)) };
        return { name: f.name, text: await f.text() };
      },
    }))
  );
}

async function addItems(id, items) {
  const log = $("#addLog");
  log.innerHTML = "";
  let added = 0;
  for (const it of items) {
    const line = document.createElement("p");
    line.textContent = `${it.label}: preparing…`;
    log.appendChild(line);
    try {
      const body = await it.body((msg) => (line.textContent = `${it.label}: ${msg}…`));
      line.textContent = `${it.label}: chunking and embedding…`;
      const d = await api("POST", `/api/collections/${id}/documents`, JSON.stringify(body), { raw: true });
      line.innerHTML = `<span class="ok">✓</span> ${esc(d.name)}: ${d.pages} pages, ${d.chunks} chunks`;
      added++;
    } catch (err) {
      line.innerHTML = `<span class="error">✗ ${esc(it.label)}: ${esc(err.message)}</span>`;
    }
  }
  if (added) setTimeout(route, 900);
}

// ---------------------------------------------------------------- a run
const cites = (ids) => ids.map((x) => `<button class="cite" data-chunk="${x}" aria-label="chunk ${x}">C${x}</button>`).join("");
const renderSentences = (ss) => ss.map((s) => `${esc(s.text)}${cites(s.chunk_ids)}`).join(" ");

async function runPage(id, tab) {
  const run = await api("GET", `/api/runs/${id}`);
  const done = run.status !== "running";
  const answered = run.answers.filter((a) => a.found).length;
  const tabs = run.kind === "full" ? ["story", "answers", "logs"] : ["answers", "logs"];
  if (!tabs.includes(tab)) tab = tabs[0];
  const head = `
    <p class="small"><a href="#/c/${run.collection_id}">← ${esc(run.person)}</a></p>
    <h1>${run.kind === "canary" ? "Canary question" : `The life of ${esc(run.person)}`} <span class="muted small">run #${run.id}</span></h1>
    ${
      done
        ? run.status === "failed"
          ? `<p class="error">This run failed: ${esc(run.error)}</p>`
          : `<p class="muted small">${when(run.created_at)} · ${run.kind === "full" ? `${answered} of 20 questions answered from the sources, ${20 - answered} not in the sources · ` : ""}cost ${fmtUsd(run.usd)}</p>`
        : `<p><strong>${esc(run.stage || "Starting")}</strong></p><div class="progress"><i style="width:${Math.round(
            ((run.answers.length + (run.story ? 2 : 0) + (run.review ? 2 : 0)) / 24) * 100
          )}%"></i></div>`
    }
    <nav class="tabs">${tabs.map((t) => `<a href="#/run/${id}/${t}" class="${t === tab ? "on" : ""}">${{ story: "Story", answers: "The 20 answers", logs: "Logs" }[t]}</a>`).join("")}
      <a href="/api/runs/${id}/logs?download=1">Download logs (JSON)</a>${run.story ? ` <a href="/api/runs/${id}/story.md" target="_blank">Story as Markdown</a>` : ""}</nav>`;

  let body = "";
  if (tab === "story") body = storyHtml(run);
  else if (tab === "answers") body = answersHtml(run);
  else body = await logsHtml(run);
  view.innerHTML = head + body;
  wireCites(view);
  if (!done && tab !== "logs") timer = setTimeout(route, 2000);
}

function storyHtml(run) {
  if (!run.story) return `<section class="sheet"><p class="muted">The story is written after all 20 questions are answered.</p></section>`;
  const rev = new Map((run.review?.sentences || []).map((s) => [s.n, s]));
  const r = run.review;
  const summary = r
    ? `<div class="stats"><div class="stat"><b>${r.total}</b><span>sentences</span></div>
       <div class="stat"><b class="ok">${r.supported}</b><span>supported by their chunks</span></div>
       <div class="stat"><b style="color:var(--warn)">${r.partly + (r.names || 0)}</b><span>partly supported, or a name/number not in its chunks</span></div>
       <div class="stat"><b style="color:var(--bad)">${r.unsupported + r.uncited}</b><span>unsupported or uncited</span></div></div>
       <p class="muted small">Two checks per sentence: a model reads the full text of the chunks it cites, and a word check makes sure every name and number in the sentence appears in those chunks. Highlighted sentences contain something the cited chunks don't say: either it came from another chunk (a citation slip) or from the model's own knowledge.</p>`
    : `<p class="muted small">Checking every sentence…</p>`;
  return `<section class="sheet">${summary}</section>
    <article class="sheet story"><h2>${esc(run.story.title)}</h2>
    ${run.story.paragraphs
      .map(
        (p) =>
          `<p>${p.sentences
            .map((s) => {
              const v = rev.get(s.n);
              const flagged = v && !["supported", "unchecked"].includes(v.verdict);
              return `<span class="s ${flagged ? `flag ${v.verdict}` : ""}" ${flagged ? `title="${esc(v.verdict)}: ${esc(v.not_in_snippets)}"` : ""}>${esc(s.text)}${cites(s.chunk_ids)}${
                flagged ? `<span class="note">⚑ ${v.verdict === "names" ? `not in the cited chunks: ${esc(v.missing_words.join(", "))}` : `${esc(v.verdict)}${v.not_in_snippets ? `: “${esc(v.not_in_snippets)}” isn't in the cited chunks` : ""}${v.missing_words?.length ? ` (words: ${esc(v.missing_words.join(", "))})` : ""}`}</span>` : ""
              }</span>`;
            })
            .join(" ")}</p>`
      )
      .join("")}
    </article>
    ${
      run.answers.some((a) => !a.found)
        ? `<section class="sheet"><h3 style="margin-top:0">Skipped: not in the sources</h3><ul>${run.answers
            .filter((a) => !a.found)
            .map((a) => `<li>Q${a.n}. ${esc(a.question)}</li>`)
            .join("")}</ul></section>`
        : ""
    }`;
}

function answersHtml(run) {
  if (!run.answers.length) return `<section class="sheet"><p class="muted">No answers yet.</p></section>`;
  return `<section class="sheet"><ol class="answers" style="padding-left:1.2em">${run.answers
    .map(
      (a) => `<li value="${a.n || 0}"><div class="q">${esc(a.question)}</div>
      ${a.found ? `<div>${renderSentences(a.sentences)}</div>` : `<div class="nis">${esc(config.notInSources)}</div>`}
      <div class="ids">Retrieved: ${a.retrieved.length ? a.retrieved.map((x) => `C${x}`).join(", ") : "nothing"}</div></li>`
    )
    .join("")}</ol></section>`;
}

async function logsHtml(run) {
  const { logs } = await api("GET", `/api/runs/${run.id}/logs`);
  const label = { search: "Search", answer: "Answer", story: "Story", review: "Check" };
  return `<section class="sheet"><p class="muted small">Every query, the chunk IDs it retrieved (with their scores) and the exact prompt sent to the model. ${logs.length} entries.</p>
  ${logs
    .map((l) => {
      const d = l.data;
      let inner = "";
      if (l.step === "search")
        inner = `<div class="small"><b>Queries:</b> ${d.queries.map((q) => `“${esc(q)}”`).join(" · ")}</div>
        <div class="wrap"><table><thead><tr><th>Chunk</th><th>Document</th><th class="num">Page</th><th class="num">Cosine</th><th class="num">BM25</th></tr></thead><tbody>
        ${d.retrieved.map((h) => `<tr><td><button class="cite" data-chunk="${h.id}">C${h.id}</button></td><td>${esc(h.doc)}</td><td class="num">${h.page_from}</td><td class="num">${h.cos}</td><td class="num">${h.bm25}</td></tr>`).join("")}
        </tbody></table></div>`;
      else {
        inner = `${d.verdict ? `<div class="small"><b>Result:</b> ${d.verdict === "answered" ? '<span class="badge ok">answered</span>' : `<span class="badge">${esc(d.verdict)}</span>`} ${(d.dropped || []).length ? `<span class="badge bad">${d.dropped.length} sentence(s) dropped: no valid chunk ID</span>` : ""}</div>` : ""}
        <details><summary>Prompt sent (${esc(d.model)})</summary><pre>SYSTEM:\n${esc(d.prompt.system)}\n\nUSER:\n${esc(d.prompt.user)}</pre></details>
        <details><summary>Model's response</summary><pre>${esc(d.response)}</pre></details>
        <div class="muted small">${d.usage ? `${d.usage.prompt_tokens} in / ${d.usage.completion_tokens} out tokens · ` : ""}${fmtUsd(d.usd)}</div>`;
      }
      return `<div class="log ${l.step}"><div><strong>${label[l.step] || l.step}${l.qn ? ` · Q${l.qn}` : l.qn === 0 ? " · canary" : ""}</strong> ${esc(l.question)}</div>${inner}</div>`;
    })
    .join("")}</section>`;
}

// ---------------------------------------------------------------- chunk panel
function wireCites(root) {
  root.querySelectorAll("[data-chunk]").forEach((b) =>
    b.addEventListener("click", async (e) => {
      e.preventDefault();
      const panel = $("#chunkPanel");
      $("#chunkBody").innerHTML = '<p class="muted">Loading…</p>';
      panel.hidden = false;
      try {
        const c = await api("GET", `/api/chunks/${b.dataset.chunk}`);
        $("#chunkBody").innerHTML = `<div><span class="badge">C${c.id}</span> <strong>${esc(c.doc_name)}</strong></div>
          <div class="muted small">page ${c.page_from}${c.page_to !== c.page_from ? `–${c.page_to}` : ""} · chunk ${c.seq} of this document</div>
          <blockquote>${esc(c.text).replace(/\n\n/g, "<br /><br />")}</blockquote>`;
      } catch (err) {
        $("#chunkBody").innerHTML = `<p class="error">${esc(err.message)}</p>`;
      }
    })
  );
}
$("#chunkClose").addEventListener("click", () => ($("#chunkPanel").hidden = true));
addEventListener("keydown", (e) => e.key === "Escape" && ($("#chunkPanel").hidden = true));
