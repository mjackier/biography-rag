# From the Sources: a biography RAG

Upload pages about one person (text, HTML or PDF files, or links). The app chunks them, embeds them
and stores them, asks 20 questions against the store, and weaves a life story **only from the
retrieved snippets**. Every sentence carries the chunk IDs it came from, and a checker flags any
sentence the cited chunks don't support.

Live: https://biography-rag-1kep.onrender.com · Write-up: [WRITEUP.md](WRITEUP.md) · Story: [runs/story-run-5.md](runs/story-run-5.md) · Log review: [LOG-REVIEW.md](LOG-REVIEW.md)

## How it works

1. **Ingest** (`lib/ingest.js`). Project Gutenberg headers and footers are removed, HTML is turned into
   text, and hard-wrapped lines are joined into paragraphs. Index and contents pages are left out
   (they're mostly names and page numbers). PDFs are read page by page in the browser with pdf.js, so
   chunks keep their real page numbers; for text and HTML a page is 2,000 characters.
   Paragraphs are packed into chunks of about 1,100 characters, with about 220 characters of overlap.
2. **Embed and store** (`lib/openai.js`, `lib/store.js`). `text-embedding-3-small` (1,536 dimensions),
   stored as float32 bytes in Postgres (`bio_chunks`). No vector extension needed: a collection of a
   few thousand chunks is searched in memory in milliseconds.
3. **Retrieve** (`lib/search.js`). Each question is searched three ways: the question itself plus two
   generic phrasings (`lib/questions.js`, e.g. "{person}'s brothers and sisters"). Each phrasing is
   searched by embedding similarity and by BM25 keywords, and the lists are merged with reciprocal rank
   fusion. Top 8 chunks.
4. **Answer from the snippets only** (`lib/pipeline.js`). gpt-4.1 gets the question and the 8 snippets
   and must return JSON sentences, each with the chunk IDs that state it, or `found: false`. Sentences
   citing a chunk that wasn't retrieved are dropped. No sentence left = **"Not in the sources."**
5. **Weave the story** from the 20 answers. Every story sentence carries chunk IDs; questions that were
   not in the sources are skipped.
6. **Check every sentence**. A separate call gets each story sentence with the full text of the chunks
   it cites and labels it supported / partly / unsupported, quoting anything not in the chunks. Then a
   mechanical check makes sure every name and number in the sentence appears in those chunks (it caught
   additions the model checker missed; see LOG-REVIEW.md).
7. **Logs**. Every search (queries, retrieved chunk IDs and scores), every prompt sent and response
   received, the story and the check are stored in `bio_logs` and shown on the run's Logs tab
   (`/api/runs/:id/logs`).
8. **Canary**. Ask something true that isn't in the corpus. The right answer is "Not in the sources."

## Run it

```
cp .env.example .env    # OPENAI_API_KEY, DATABASE_URL (Postgres), ACCESS_CODE
npm install
npm start
```

Without `DATABASE_URL` it keeps everything in memory (fine for trying it out). Keys live only in the
environment (Render's environment group), never in the repo; `scripts/hooks/pre-commit` refuses a
commit containing anything key-shaped (`git config core.hooksPath scripts/hooks`).

Reading (stories, answers, logs) is public; adding pages and running questions needs the access code.
