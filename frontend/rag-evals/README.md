# RAG evaluation

A deterministic evaluation of **lexical tax-law retrieval** (`services/tax-retrieval.ts`) over the AY 2026-27 corpus
(`rag-corpus/ay-2026-27/`). It measures retrieval only: there is no LLM, no embeddings and no answer generation to
evaluate yet.

```
npm run rag:eval                        human-readable report
npm run rag:eval -- --json out.json     also write the machine-readable result ("-" = JSON only, on stdout)
npm run rag:eval -- --split dev         only the dev split (the one to tune against)
```

It is **read only** (a read-only transaction; it cannot ingest) and needs the database to hold the shipped corpus:
it checks this first and tells you to run `npm run rag:ingest` if not. It refuses to run if the frozen test set was
edited. Its exit code does not depend on the scores: **no pass thresholds are set yet**; it records a baseline.

## Layout

```
rag-evals/
  README.md                       this file
  ay-2026-27-v1/                  one directory per dataset version
    meta.json                     version, the corpus version it targets, dev/test membership, the test-set freeze
    gold-evidence.json            what counts as the right passage (46 definitions)
    cases.json                    the 56 cases
  baselines/
    ay-2026-27-eval-v1.baseline.json   the Phase 5B baseline (output of `npm run rag:eval -- --json`), kept as recorded
    ay-2026-27-eval-v1.phase-5c.json   the same run after the Phase 5C safety changes
lib/rag-eval/                     dataset.ts (schema + validation) · score.ts · aggregate.ts · stats.ts · run.ts · report.ts
                                  db-deps.ts (real retrieval + corpus preflight) · load-dataset.ts
scripts/rag-eval.ts               the CLI
tests/rag-eval-*.test.ts          dataset, metrics and runner tests
```

A dataset is bound to one corpus version. If the corpus changes (a new source, a re-chunk, a new corpus version),
the gold definitions must be re-checked (`checkDatasetAgainstCorpus` does this) and, if labels change, a **new
dataset version** is created; the old one is never edited.

## A case

```jsonc
{
  "id": "slb-02",                       // three letters/digits, dash, two digits
  "category": "slabs_regimes",
  "question": "…",
  "assessmentYear": "2026-27",          // the parameter passed to retrieval
  "questionAssessmentYears": ["2024-25"], // optional: years the question is really about, when different
  "expectedBehavior": "answer",         // answer | insufficient_evidence | route_to_engine | refuse_out_of_scope
  "split": "dev",                       // dev | test
  "review": { "status": "gold" },       // or { status: "provisional", priority, reason }
  "engineRequired": false,              // any figure in the answer must come from the deterministic engine
  "retrieval": { "expectation": "ok", "reasons": ["…"] },  // what retrieval ALONE should return (below)
  "expectedEvidence": [ { "anyOf": ["gold-id", "alternate-gold-id"] } ],  // scored; answer cases only
  "contextEvidence": ["gold-id"],       // cited in the notes as support; validated, NOT scored
  "distractorEvidence": ["gold-id"],    // passages that must not lead (lexical false friends)
  "forbiddenAuthorityTiers": ["statute", "notification_circular"],
  "requiredAuthorityTiers": ["statute"],// the claim needs this tier; guidance alone does not support it
  "expectedSectionResolutions": [ { "requested": "80CCD(1B)", "basis": "cited_in_passage", "resolvedTo": "80CCD(1B)", "clauseCovered": true } ],
  "tags": ["lexical", "paraphrase", "numbers"],
  "notes": "why the case belongs"
}
```

**Gold evidence is stable, never a database id.** A gold definition is `{ id, description, sourceKey, heading,
anchors[] }`: the source key, the deepest heading above the passage, and verbatim text that must all be inside it.
`chunkId` and `evidenceId` change with every re-ingest, so they appear nowhere in the dataset (a test enforces it).
A requirement in `expectedEvidence` is met by **any** of its alternatives (`anyOf`); a case with several requirements
needs all of them. An alternate exists only where the corpus really carries the same text in another passage (for
example the identical new-regime row in each age table).

### What retrieval alone is expected to do

`expectedBehavior` is what the *whole system* should do. Retrieval cannot decide every behaviour, so each case also
says what the retrieval layer, by itself, should return:

| `retrieval.expectation` | Meaning | Scored for |
|---|---|---|
| `ok` | The corpus can answer: evidence expected (every `answer` case). | recall, MRR, quote support, false-insufficient, distractors, section resolution |
| `insufficient_evidence` | The corpus has nothing supporting the claim asked. Returning evidence is a **false-ok**. `reasons` lists the acceptable typed reasons. | false-ok, typed-reason accuracy, distractors |
| `not_asserted` | Retrieval cannot prove the behaviour: `route_to_engine`, `refuse_out_of_scope`, and **partial-support** `insufficient_evidence` cases where returning the related guidance is legitimate. | safety checks only |

For `route_to_engine` and `refuse_out_of_scope` the harness does **not** pretend retrieval proves the final behaviour:
those cases contribute only to the hard-failure counts. Partial-support cases (the corpus has related but not
sufficient text) are also `not_asserted`; the report says how many cases are checked for safety only.

## Metrics

Every proportion is `k/n` with a 95% Wilson interval. **There is no single accuracy figure**, and none should be
quoted: the metrics measure different things on different subsets.

| Metric | What is counted |
|---|---|
| gold recall@1/3/5 | Pooled over the gold *requirements* of answer cases: how many were found in the top k. |
| cases fully covered @k | Answer cases where *every* requirement was found in the top k. |
| MRR | Mean reciprocal rank of the first gold passage over answer cases (0 if none). No interval. |
| quote support | Of the requirements that were retrieved, how many returned quotes contain all the gold anchor text. |
| false-insufficient rate | Answer cases that retrieval called `insufficient_evidence`. |
| false-ok rate | `insufficient_evidence` cases (retrieval expectation) that returned evidence. |
| typed-reason accuracy | Cases with an expected reason: insufficient **and** the right reason (right status, wrong reason is a failure). |
| distractor intrusion @1/3/5 | Cases with a distractor where one appears at rank 1 / in the top 3 / anywhere in the 5. A distractor in the top 3 is listed as a failure. |
| section-resolution accuracy | Named sections resolved with the expected basis (`indexed`, `cited_in_passage`, `parent_section`), target section and clause coverage. |

Pooled recall treats requirements of one multi-chunk case as independent, which they are not quite; read the
interval as a guide. The sets are small (single-digit `n` in many rows): read the interval, not the percentage.

## Hard safety failures

Reported explicitly for **every** case, provisional ones included:

| Failure | Meaning |
|---|---|
| `wrong_assessment_year_evidence` | Evidence for a year other than the one asked, or, when `questionAssessmentYears` is set, for a year the question is not about. Since Phase 5C retrieval itself refuses such questions, and a test keeps the labels and its year detector in agreement. |
| `non_verbatim_quote` | A quote that is not an exact slice of its stored passage (checked against the database row, not against the evidence object), is empty, exceeds 400 characters, or whose passage cannot be found or belongs to another source. |
| `forbidden_authority_tier_evidence` | Evidence from a tier in `forbiddenAuthorityTiers`. |
| `higher_tier_claim_supported_only_by_guidance` | The case's claim needs `statute` or `notification_circular` (`requiredAuthorityTiers`) and the evidence returned is official guidance only. |
| `answerable_case_unsupported_by_section_resolution` | An `answer` case came back `insufficient_evidence` with `section_not_in_corpus`. |
| `engine_required_numeric_answer_from_evidence` | An `engineRequired` case whose retrieval result carries anything but evidence (an answer, an amount). |

The last one can only be checked **structurally** at the retrieval layer: retrieval returns evidence and nothing
else, so it cannot produce a trusted figure. The real, answer-layer form of this gate cannot be evaluated until an
answer generator exists.

`forbiddenAuthorityTiers` is `statute` and `notification_circular` on almost every case because the corpus is
official guidance only: any evidence claiming those tiers would be fabricated. That default is tied to corpus version
`ay-2026-27-v1`; a corpus that adds statute text needs a new dataset version.

## Provisional cases

`review.status: "provisional"` marks a case that needs a **tax professional** (`must_review`, `low_priority`) or an
**owner decision** (`owner_decision`) before it can be a gold-standard label. There are 21. They are scored
identically but reported in their **own block and never in the primary score**, and their hard failures still show.
Nothing is silently excluded and nothing was promoted: a test pins the exact list from the discovery report.
Promoting a case to gold is a review outcome and a new dataset version.

## Dev/test discipline

- The split (22 dev / 34 test) is the discovery report's. Sibling cases that share a gold passage sit in the same split.
- **Tune only against dev.** Use `--split dev`. The test set is for looking, not tuning, and no gold label may ever be
  changed to fit an observed result.
- The test set is **frozen**: `meta.json` records a fingerprint of the 34 test cases (labels, but not the free-text
  `notes`) and of the gold definitions they cite. `loadEvalDataset` refuses a dataset whose fingerprint differs.
- Tests check that no test question or id appears in the retrieval code, the regression cases or any existing RAG test.
- The dataset is independent of the 19 developer-written regression cases in `rag-corpus/ay-2026-27/retrieval-tests.json`
  (a test checks no question repeats one).

**Known contamination.** `tests/rag-section-refs.test.ts` (the section-reference fix) contained the discovery report's
wording for `idx-04` and `idx-05` (and `idx-01`, a dev case). Those two test questions were reworded at creation,
before any result was observed; their sections and labels are unchanged. The fix still targeted those sections
(80CCD(1B), 80CCD(2), 80CCC, 80CCH, 24(b), 111A/112/112A, 115BAC(1A)), so the `idx-*`, `c80-01` and `sur-02`
section-resolution results are **weak held-out evidence** of that fix. See `meta.json` → `provenance`.

## Phase 5B baseline (2026-09-20, dataset `ay-2026-27-eval-v1`, corpus `ay-2026-27-v1`)

This is the baseline BEFORE the Phase 5C safety changes (next section), kept as recorded. The machine-readable record is
`baselines/ay-2026-27-eval-v1.baseline.json`; it, not this table, is the source of truth. Primary (gold, 35 cases) unless stated. `k/n [95% Wilson]`:

| Metric | Value |
|---|---|
| gold recall@1 / @3 / @5 (requirements) | 7/15 [24.8%, 69.9%] at each k |
| MRR (12 answer cases) | 0.583 |
| quote support (of retrieved gold) | 5/7 [35.9%, 91.8%] |
| false-insufficient rate | 5/12 [19.3%, 68.0%] |
| false-ok rate | 5/10 [23.7%, 76.3%] |
| typed-reason accuracy | 5/10 [23.7%, 76.3%] |
| distractor intrusion @1 / @3 / @5 | 1/6 [3.0%, 56.4%] |
| section-resolution accuracy | 4/4 [51.0%, 100%] |
| hard failures (all 56 cases) | 3 cases: `ayi-02` (wrong year), `ins-03`\*, `ins-04` (guidance for a statute/circular claim); \*provisional |

Dev and test are reported separately by the CLI; with `n` this small, do not compare them as percentages.

## Phase 5C: year and authority-tier safety (2026-09-20)

The baseline exposed two safety classes, both fixed at the retrieval contract (`services/tax-retrieval.ts`, with the
pure detectors in `lib/rag/question-scope.ts`). The corpus, the ranking, the recall and every dataset label are
unchanged; the dataset hash (`fc1a73f1a893…`) and the corpus manifest hash are identical before and after.

- **Assessment year.** A year the question names with an `AY` / `FY` / `assessment year` / `financial year` marker is compared
  with the requested one (an FY is converted: FY 2026-27 is AY 2027-28). On a mismatch retrieval returns
  `insufficient_evidence` with a typed `yearMismatch` and **no evidence**. The reason is `no_corpus_for_assessment_year` when the
  corpus holds nothing for the year the question names, and `assessment_year_mismatch` when it does hold it (the request
  contradicts itself).
- **Authority tier.** A question that demands the wording of the Act, what the Act or the statute says, or a notification or
  circular needs `statute` / `notification_circular` evidence. If the corpus holds none of that tier for the year, retrieval
  returns `insufficient_evidence` (`required_authority_tier_unavailable`) with `authorityTier: { required, available }`. If it
  does hold it, only that tier can be evidence. Guidance is never relabelled.

Results, `baselines/ay-2026-27-eval-v1.phase-5c.json` against the Phase 5B baseline. 53 of the 56 cases are byte-identical
apart from the two new result fields; three changed:

| Case | Before | After |
|---|---|---|
| `ayi-02` (AY 2024-25, dev) | `ok` with AY 2026-27 evidence: false-ok and **hard** `wrong_assessment_year_evidence` | refused (`no_corpus_for_assessment_year`, `yearMismatch`), no evidence, no failure |
| `ayi-03` (FY 2026-27, dev) | insufficient, `no_matching_passages` (by lexical luck) | refused for the year (`no_corpus_for_assessment_year`, `yearMismatch` stated `2027-28`) |
| `ins-04` (exact wording from the Act, test) | `ok` with guidance: false-ok and **hard** `higher_tier_claim_supported_only_by_guidance` | refused (`required_authority_tier_unavailable`), no evidence, no hard failure |

Hard failures across all 56 cases: **3 to 1** (`wrong_assessment_year_evidence` 1 to 0;
`higher_tier_claim_supported_only_by_guidance` 2 to 1). Primary false-ok moved 5/10 to 3/10 and typed-reason accuracy 5/10 to
6/10, as a direct consequence of those refusals; recall, MRR, quote support, false-insufficient, distractor intrusion and
section resolution are unchanged.

What this does not fix:

- `ins-03` (provisional) still shows the tier hard failure: its claim rests on a circular the **question never mentions**, so
  only an answer layer or a tax professional can know. The detector reads the question only, so ordinary guidance questions
  are untouched. `ayi-04` (the Income-tax Act, 2025) is likewise not seen by the tier detector. A test names both.
- The frozen label of `ins-04` lists `no_matching_passages` as its reason, which predates the new typed reason, so it still
  counts as a `wrong_reason` soft failure although it is now safe. Labels were not edited; a dataset v2 should list the new
  reasons (the dataset vocabulary already accepts them).
- Only marker-based years are read. A bare span ("in 2024-25"), a single year ("AY 2025") and "tax year" are not, because they
  are ambiguous and nothing is guessed from an arbitrary number.

## Limitations

- Retrieval layer only. Behaviour accuracy, routing, refusal, claim-level groundedness, citation validity and
  unsupported-detail rate need an answer layer that does not exist yet.
- Small `n`: 35 gold cases, of which 12 are answer cases and only 3 are gold answer cases in the test split.
  Wilson intervals are wide; single cases move rates by many points.
- 21 of 56 cases are provisional until a tax professional (or the owner) reviews them.
- The dataset targets one corpus version, and the corpus is official guidance only, so it cannot show statute-tier retrieval.
- `insufficient_evidence` expectations are what the *corpus* supports, decided from the source text before any run;
  a partial-support judgement (`not_asserted`) rests on the discovery report's reading of the passages.
- The wrong-year check uses `questionAssessmentYears`, a human-written label: retrieval itself never reads a year in
  the question text (a known, documented limit of the retrieval layer).
