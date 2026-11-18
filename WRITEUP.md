# Write-up: a life story from the sources only

Mattan Jackier · MCON 368 · https://biography-rag-1kep.onrender.com · https://github.com/mjackier/biography-rag

## What I built

A web app where you name a person, upload pages about them, and get their life story built only from
those pages:

- **Upload any collection of pages.** Text, Markdown, HTML or PDF files (PDFs are read page by page in the
  browser, so citations keep real page numbers), or links (web pages, Gutenberg or archive.org full
  texts). Gutenberg licence text, index pages and tables of contents are left out. It works for any person;
  nothing is specific to Franklin.
- **Chunk, embed, store.** Paragraphs are packed into ~1,100-character chunks with ~220 characters of
  overlap, embedded with OpenAI `text-embedding-3-small`, and stored in Postgres with their document and
  page numbers.
- **The 20 queries.** Each question (`{person}` filled in) is searched three ways: the question plus two
  generic phrasings, each by meaning (cosine similarity) and by exact words (BM25), merged by reciprocal
  rank fusion. The extra phrasings are generic ("{person}'s brothers and sisters"), so no model knowledge
  steers retrieval.
- **Snippets are the only source.** gpt-4.1 answers each question from its top 8 chunks only, returning
  sentences that each carry chunk IDs, or `found: false`. A sentence citing a chunk that wasn't retrieved
  is dropped; nothing left means **"Not in the sources."** and the story skips that question.
- **The story** is woven from the 20 answers; every sentence keeps its chunk IDs (click one to read the
  chunk, its book and page).
- **Every sentence is checked twice:** a model reads the cited chunks and judges supported / partly /
  unsupported, and a mechanical check makes sure every name and number appears in those chunks.
  Flagged sentences are highlighted in the story.
- **Logs:** every query, the chunk IDs it retrieved with scores, the full prompt sent and the raw response
  are stored per run and shown on the run's Logs tab (and downloadable as JSON).
- **Canary:** a box to ask anything; the right answer to something not in the corpus is "Not in the sources."

## Test corpus

Benjamin Franklin: 4 public-domain biographies loaded by link from archive.org (Project Gutenberg was
down for maintenance that day): Parton's *Life and Times* vols. 1–2 (1864), the Sparks edition of the
*Autobiography* with its continuation, and Fisher's *The True Benjamin Franklin* (1899). **2,553 pages,
6,461 chunks**, $0.03 to embed.

## What the review of the logs found

Full details: [LOG-REVIEW.md](LOG-REVIEW.md). In short:
- **Run 1:** one sentence moved a fact from Franklin's uncle onto his father; one invented a total
  ("three children"). Neither was training data, but I fixed the prompts for both.
- **Run 4:** the model checker passed all 73 sentences, but my own name/number check found 4 with words
  the cited chunks don't contain. Two were citation slips (the fact was in another retrieved chunk). Two
  came from the model: the first name "Peter" in "Peter Collinson", and an inferred "in Philadelphia". So
  I added the mechanical check to the app and told the model not to complete names from memory.
- **Run 5 (handed in):** 63 sentences, all cited, 60 supported. The 3 flags are a citation slip
  ("Deborah"), a word form (French → France) and an OCR spelling ("Peimsylvania"). **Nothing from
  training data.**
- **Canary:** "On which U.S. banknote does Franklin's portrait appear?" and "Which actor played Franklin in
  the 2024 series *Franklin*?" both came back **"Not in the sources."**

## What I learned

- An LLM asked "is this supported?" is too lenient for small additions; a dumb word check caught what it missed.
- Most "hallucination" in RAG isn't invention: it's facts moving between people or between chunks.
  Citing per sentence makes that visible.
- Scanned books are noisy (OCR); the checks have to tolerate it or they cry wolf.

## Weaknesses

- The story repeats points when several answers overlap.
- The word check only covers capitalized names and numbers; lowercase claims rely on the model checker.
- Page numbers for text files are estimated (2,000 characters per page); PDFs keep real pages.

## Hand-in links

- Live site: https://biography-rag-1kep.onrender.com
- GitHub (no keys in it): https://github.com/mjackier/biography-rag
- The story: https://biography-rag-1kep.onrender.com/#/run/5 · [runs/story-run-5.md](runs/story-run-5.md)
- Logs: [runs/](runs/) (run 5, run 4, run 1, canaries) · live: https://biography-rag-1kep.onrender.com/#/run/5/logs
- Log review: [LOG-REVIEW.md](LOG-REVIEW.md)
