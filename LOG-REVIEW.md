# Review of the logs

What the logs were checked for: **every sentence in the story traces to a chunk ID**, and anything that
came from the model's training data instead of the retrieved chunks is flagged.

How: the logs store every search (queries, retrieved chunk IDs, scores), every prompt sent and
every raw response. I rebuilt the text of every retrieved chunk from the logged prompts, then, for every
story sentence:

1. confirmed it carries at least one chunk ID, and that every ID was actually retrieved for one of the questions;
2. checked that every **name and number** in the sentence appears in the text of the chunks it cites,
   allowing for OCR breaks in the scanned books ("Eng land", "Ga- zette");
3. where a word was missing, searched all the chunks retrieved in the run to tell a citation slip (the
   fact is in another retrieved chunk) from outside knowledge (it is in no retrieved chunk);
4. read the story against its chunks for meaning errors a word match can't catch (wrong person, invented totals).

Corpus: 4 public-domain biographies from archive.org, **2,553 pages, 6,461 chunks** (Parton,
*Life and Times of Benjamin Franklin* vols. 1–2, 1864; *The Life of Benjamin Franklin, containing the
Autobiography, with notes and a continuation*; Fisher, *The True Benjamin Franklin*, 1899).

## Run 1: 2 books (1,511 pages): 38 sentences, 4 flagged by the model checker

Logs: [runs/run-1-logs.json](runs/run-1-logs.json)

| # | Sentence | Finding |
|---|---|---|
| 2 | His father, Josiah, "learned the trade of a silk-dyer…" | **Wrong person.** Chunk C3512 says this of Franklin's *uncle* Benjamin. The answer model moved it onto the father. Not training data. |
| 18 | "Franklin had three children: William, Francis Folger, and Sarah." | **Invented total.** The chunks name the children; none says "three". |
| 22 | "surrounded by his friends during his later years" | Checker false alarm: C1802 says "the aged Franklin at home… surrounded by his books, his apparatus, and his friends". |
| 29 | "invented a musical instrument called the Armonica" | Checker false alarm: C2782 has "— Invents a Musical Instrument, called the Armonica. —" in a chapter heading. |

Changes: the answer prompt now says to check *who* each snippet sentence is about (relatives share
names), and to make no totals a snippet doesn't state; the checker is told to read headings and ignore
OCR noise.

## Run 4: all 4 books: 73 sentences, model checker said 73/73 supported. It was wrong

Logs: [runs/run-4-logs.json](runs/run-4-logs.json)

My name/number check found 4 sentences with something the cited chunks don't say:

| # | Sentence | Not in the cited chunk | Source of the word |
|---|---|---|---|
| 1 | born in a house on Milk Street… **in Boston** | Boston | In C2184, retrieved for Q1 but not cited: citation slip |
| 42 | Franklin and **Peter** Collinson were correspondents… | Peter | **In no chunk retrieved for Q14: the model's training data** (it completed "Collinson" from memory) |
| 55 | Poor Richard's **Almanac** | Almanac | In C4616, retrieved but not cited: citation slip |
| 67 | lived in a new house **in Philadelphia** | Philadelphia (for the house) | The chunk only says Congress met in Philadelphia: **an inference from outside the text** |

Lesson: a model asked "is this supported?" waves through small additions such as a first name or a
title. Changes:
- The app now runs the same mechanical name/number check on every story sentence (`missingWords` in
  `lib/pipeline.js`) and flags it even when the model checker says "supported".
- Prompts now say: don't complete names or titles from memory, and cite every note sentence you merge.

## Run 5 (the handed-in story): 63 sentences: 60 supported, 3 flagged, 0 from training data

Story: [runs/story-run-5.md](runs/story-run-5.md) · live: https://biography-rag-1kep.onrender.com/#/run/5 ·
logs: [runs/run-5-logs.json](runs/run-5-logs.json)

All 63 sentences carry chunk IDs, all of them retrieved for that run. 20 of 20 questions were answered
from the sources. The 3 flags, checked one by one:

| # | Flagged word | Finding |
|---|---|---|
| 23 | "Deborah" | The cited chunk says "she"; Deborah Read is named in C4314, cited in the previous sentence. Citation slip, not training data. |
| 39 | "France" | The chunk says "the French people". Word-form false alarm. |
| 40 | "Pennsylvania" | The scan spells it "Peimsylvania". OCR false alarm. |

Reading the story against its chunks: lowercase claims checked by hand also hold ("Priestley, the
discoverer of oxygen" is C6122; "distinguished envoy to the court of France" is C6250; "William, died in
London, November, 1813" is C3527). Weaknesses that are not grounding errors: the story repeats a few points (the uncle as
first teacher appears in three sentences; William is introduced twice) because the writer uses every
note; and sentence 14's "self-taught… including French" smooths over the source's "could read French,
but could not speak it".

**Nothing in run 5 came from the model's training data.** Of the earlier flags, two (Peter, Philadelphia)
did; both kinds are now blocked by the prompt and caught by the word check.

## Canary test: "Not in the sources"

True things about Franklin that can't be in 1864–1899 books (logs: [runs/canary-logs.json](runs/canary-logs.json)):

| Question | Answer | Retrieved |
|---|---|---|
| On which U.S. banknote does Benjamin Franklin's portrait appear? (the $100 bill) | **Not in the sources.** | C5664, C5660, C5699, C1831, C5701, C2162, C5658, C5665 |
| Which actor played Benjamin Franklin in the 2024 television series Franklin? (Michael Douglas) | **Not in the sources.** | C5665, C4523, C3774, C1692, C49, C585, C2124, C4735 |

The model knew both answers and still answered from the snippets only.

## Cost

Ingesting 2,553 pages: $0.03 of embeddings. A full run (20 searches, 20 answers, story, check): $0.20–0.23.
A canary: $0.005.
