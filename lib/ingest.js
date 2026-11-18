// Turning an uploaded document into clean text with page numbers, then into overlapping chunks.
//
// A "page" is a real page for PDFs (the browser extracts text page by page with pdf.js). For plain
// text and HTML there are no pages, so a page is counted as 2,000 characters (about 350 words,
// a typical printed book page). Every chunk remembers the pages it came from.

export const PAGE_CHARS = 2000;
const TARGET = Number(process.env.CHUNK_CHARS || 1100); // ~250 tokens
const MAX = 1600;
const OVERLAP = 220; // characters carried over from the end of the previous chunk

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };

export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style|noscript|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|blockquote|tr|section|article)>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e.toLowerCase()] ?? m;
    });
}

// Project Gutenberg files carry a licence header and footer that are not part of the book.
export function stripBoilerplate(text) {
  let t = text.replace(/\r\n?/g, "\n");
  const start = t.search(/\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG[^\n]*\*\*\*/i);
  if (start >= 0) t = t.slice(t.indexOf("\n", start) + 1);
  const end = t.search(/\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG/i);
  if (end >= 0) t = t.slice(0, end);
  const endOld = t.search(/End of (the )?Project Gutenberg'?s/i);
  if (endOld >= 0) t = t.slice(0, endOld);
  return t;
}

// Paragraphs: blank-line separated; hard-wrapped lines inside a paragraph are joined.
export function paragraphs(text) {
  return text
    .split(/\n\s*\n+/)
    .map((p) =>
      p
        .replace(/\[Illustration[^\]]*\]/gi, " ")
        .replace(/-[ \t]*\n\s*(\p{Ll})/gu, "$1") // words hyphenated across lines
        .replace(/\s*\n\s*/g, " ")
        .replace(/[ \t ]+/g, " ")
        .replace(/_([^_]+)_/g, "$1") // Gutenberg _italics_
        .replace(/(\p{Ll})- (\p{Ll})/gu, "$1$2") // scanned books: "Ga- zette" (line-break hyphen left by OCR)
        .trim()
    )
    .filter((p) => p.length > 1);
}

// Index pages and tables of contents are mostly names and page numbers; they'd match every query.
export function isJunk(text) {
  const t = text.replace(/\s+/g, " ");
  if (t.length < 40) return true;
  const digits = (t.match(/\d/g) || []).length;
  const sep = (t.match(/[,;]/g) || []).length;
  const words = t.split(" ").length;
  if ((digits + sep) / t.length > 0.12) return true; // "Abbott, 23, 45; Adams, 112, ..."
  if (/^(contents|index|list of illustrations)\b/i.test(t) && digits > 10) return true;
  if (words < 8) return true;
  return false;
}

function sentences(p) {
  const parts = p.match(/[^.!?]+(?:[.!?]+["’”')\]]*|$)\s*/g) || [p];
  return parts.map((s) => s.trim()).filter(Boolean);
}

// input: { text } (pages counted by characters) or { pages: [text of page 1, page 2, ...] } (PDF).
// Returns { text, pageCount, chunks: [{ seq, text, page_from, page_to, chars }], skipped }.
export function chunkDocument(input) {
  // Build one normalized text with a page number for every paragraph.
  const paras = []; // { text, page }
  if (Array.isArray(input.pages)) {
    input.pages.forEach((pageText, i) => {
      for (const p of paragraphs(stripBoilerplate(String(pageText || "")))) paras.push({ text: p, page: i + 1 });
    });
  } else {
    let offset = 0;
    for (const p of paragraphs(stripBoilerplate(String(input.text || "")))) {
      paras.push({ text: p, page: Math.floor(offset / PAGE_CHARS) + 1 });
      offset += p.length + 2;
    }
  }
  const totalChars = paras.reduce((s, p) => s + p.text.length + 2, 0);
  const pageCount = Array.isArray(input.pages) ? input.pages.length : Math.max(1, Math.ceil(totalChars / PAGE_CHARS));

  // Leave out index / contents paragraphs ("Abbott, 23, 45; Adams, 112, ..."): they mention
  // everything and would match every query.
  let skippedParas = 0;
  const kept = paras.filter((p) => {
    const t = p.text;
    const dense = ((t.match(/\d/g) || []).length + (t.match(/[,;]/g) || []).length) / t.length;
    if (t.length > 60 && dense > 0.16) return !++skippedParas;
    return true;
  });

  // Split long paragraphs into sentence groups so no unit is bigger than MAX.
  const units = [];
  for (const p of kept) {
    if (p.text.length <= MAX) {
      units.push(p);
      continue;
    }
    let buf = "";
    for (const s of sentences(p.text)) {
      if (buf && buf.length + s.length + 1 > TARGET) {
        units.push({ text: buf, page: p.page });
        buf = "";
      }
      buf = buf ? `${buf} ${s}` : s.length > MAX ? s.slice(0, MAX) : s;
    }
    if (buf) units.push({ text: buf, page: p.page });
  }

  const chunks = [];
  let skipped = 0;
  let cur = [];
  let len = 0;
  const flush = () => {
    if (!cur.length) return;
    const text = cur.map((u) => u.text).join("\n\n");
    if (isJunk(text)) skipped++;
    else chunks.push({ seq: chunks.length + 1, text, page_from: cur[0].page, page_to: cur[cur.length - 1].page, chars: text.length });
    // Overlap: carry the last sentences of this chunk into the next one, so a fact split across
    // the boundary is still whole in one of them.
    const last = cur[cur.length - 1];
    const tail = sentences(last.text);
    let carry = "";
    while (tail.length && carry.length < OVERLAP) carry = `${tail.pop()} ${carry}`.trim();
    cur = carry && carry.length < last.text.length ? [{ text: carry, page: last.page, carried: true }] : [];
    len = cur.reduce((s, u) => s + u.text.length, 0);
  };
  for (const u of units) {
    if (len && len + u.text.length > TARGET) flush();
    cur.push(u);
    len += u.text.length + 2;
  }
  if (cur.some((u) => !u.carried)) flush();
  return { pageCount, chars: totalChars, chunks, skipped: skipped + skippedParas };
}
