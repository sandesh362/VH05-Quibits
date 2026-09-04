# OPEN_QUESTIONS.md

Questions I could not answer from your brief. **Blocking** items affect architecture or the data
model and should be answered before Phase 1. Others can be decided during their phase.

Each has my **recommended default** — if you say nothing, I will proceed with that and note it
as an assumption.

---

## BLOCKING — answer before Phase 1

### Q1 — What language(s) are the manuals in? 🔴
**Why it blocks:** determines the embedding model (`nomic-embed-text` is English-centric;
`bge-m3` is multilingual), the Tesseract language packs baked into the AI image, and text
normalisation. A wrong OCR language pack produces confident garbage — worse than no OCR.
**Options:** (a) English only · (b) English + one Indian language (Hindi/Marathi) · (c) English +
Japanese/German/Chinese (common for OEM machine manuals) · (d) Mixed/unknown.
**My default:** (a) English only; `nomic-embed-text`; Tesseract `eng`.

### Q2 — Single plant / single tenant? 🔴
**Why it blocks:** multi-tenancy requires `tenant_id` on **every** collection and **every**
Qdrant filter. Retrofitting it later is a large, error-prone change touching the security core.
**Options:** (a) Single plant, all users see all machines · (b) Multiple sites, users scoped to a
site · (c) True multi-tenant.
**My default:** (a) — with the filter object designed so (b) is a contained addition later.

### Q3 — Who may confirm an incident resolution? 🔴
See `PRODUCT_REQUIREMENTS.md` §13.4. **Why it blocks:** it changes the incident state machine,
the permission matrix, and the demo script (one login vs two).
**Options:** (a) The technician who did the work (manager can override) · (b) Manager/admin only
· (c) Configurable flag, default (a).
**My default:** (c) — implement `INCIDENT_CONFIRMATION_MODE`, ship with `self`, demo either.

### Q4 — May the system answer from incident history when no manual evidence exists? 🔴
Contradiction **X3**: requirement 14 says refuse without manual evidence; requirement 19 says use
historical incidents. **Why it blocks:** it adds/removes the `answered_from_history` status and
changes the refusal gate.
**Options:** (a) Yes, capped at `medium` confidence with a clear "no manual evidence" notice ·
(b) No — always refuse without manual evidence · (c) Yes, but only for **confirmed** incidents on
the **same physical machine**.
**My default:** (c) — the safest useful middle ground, and it makes a strong demo.

### Q5 — What hardware will run the demo? 🔴
**Why it blocks:** determines the generation model size (3B vs 7B vs 14B), the latency budget,
OCR throughput, and how much of the corpus must be pre-indexed.
**Please tell me:** CPU, RAM, GPU + VRAM, OS.
**My default assumption:** a 16 GB RAM laptop, **no usable GPU** → `qwen2.5:7b-instruct`
quantised, small context, pre-indexed corpus, expect ~8–15 s answers.

---

## HIGH — answer before the relevant phase

### Q6 — Do you have real machine manuals to test with? (Phase 3)
Real OEM PDFs (especially scanned ones) behave nothing like clean synthetic PDFs. Chunking
quality cannot be tuned without them.
**Default:** assume 2–3 real manuals will be available by Phase 3; if not, I will source public
OEM manuals (e.g. Haas, Siemens, Fanuc) as fixtures.

### Q7 — Is there an existing CMMS/maintenance dataset to import? (Phase 8)
**A7** assumes no. A CSV import is ~1 hour if you have data; seeding is required either way for a
convincing demo.
**Default:** manual entry + seeded demo data.

### Q8 — Should cross-**model** incident retrieval be allowed? (Phase 7)
Contradiction **X2**. Retrieving "same fault on a sibling model" is often the most valuable
signal, but it conflicts with the "never mix machines" rule.
**Options:** (a) Never · (b) Same model only · (c) Same machine *type*, off by default, with a
visible warning and a rank penalty.
**Default:** (c), flag `CROSS_MODEL_HISTORY=false` in the MVP — implemented but disabled, so you
can enable it live if a judge asks.

### Q9 — May a `viewer` ask read-only AI questions? (Phase 2)
Generation costs local compute and creates stored artefacts; but blocking it makes the role feel
broken.
**Default:** no (strictly read-only). Trivial to flip.

### Q10 — Expected corpus size and manual sizes? (Phase 4)
Drives batch sizes, RAM, and whether quantisation is needed.
**Default [A3]:** ≤ 20 manuals, ≤ 500 pages each, ≤ 50 MB each, ≤ 30k chunks total.

### Q11 — How many concurrent users during the demo? (Phase 10)
**Default [A5]:** 1–5. This is what justifies no queue broker and a 2-worker pool.

### Q12 — Is a rendered page-image citation preview wanted? (Phase 9)
It is my highest-ROI optional recommendation (it *proves* grounding in one click), costs ~half a
day, and adds disk usage for cached images.
**Default:** yes, build it — cut it only under time pressure.

---

## MEDIUM — decide during the phase

| # | Question | My default |
|---|---|---|
| Q13 | Generation model choice | `qwen2.5:7b-instruct`; decide after the Phase 5 measurement |
| Q14 | Chunk size / overlap | 700 / 120 tokens, tuned in Phase 4.5 |
| Q15 | Refusal score threshold | 0.45 cosine, calibrated on the golden set |
| Q16 | Maintenance lookback window | 90 days |
| Q17 | Incident recency half-life | 180 days |
| Q18 | Incident action edit window | 24 hours |
| Q19 | Retain PDFs after manual deletion? | Yes, 30 days |
| Q20 | Audit log retention | 365 days for `info`; security events forever |
| Q21 | Enable the cross-encoder reranker? | Only if Phase 5 finishes early |
| Q22 | Streaming responses? | No for the MVP |
| Q23 | Nginx container for the frontend? | Yes — one demo URL, no CORS |
| Q24 | Mongo as a single-node replica set? | Yes — free, and unlocks transactions |
| Q25 | Qdrant full-text payload index vs a Mongo text mirror for ARM 2 | Try Qdrant first (Phase 4) |
| Q26 | Manual `scope: "machine"` in the UI? | Field exists; UI deferred |
| Q27 | Machine-model merge tool | Post-MVP; prevent duplicates instead |
| Q28 | Printed-page label vs PDF page index | Capture both; cite the printed one when available |

---

## Contradictions in the brief that need your ruling

Summarised from `PRODUCT_REQUIREMENTS.md` §14.4 — the three that genuinely need **you**:

| # | Contradiction | My proposed resolution | Need your OK? |
|---|---|---|---|
| **X3** | Refuse without manual evidence (req 14) vs use incident history (req 19) | `answered_from_history`, confirmed + same-machine only, capped at medium confidence | **YES — Q4** |
| **X2** | Never mix machines (req 12) vs retrieve similar incidents (req 19) | Manuals never cross models; incidents may widen to same-model; same-type is off by default | **YES — Q8** |
| **X1** | Manuals belong to models vs the real need for machine-specific documents | `Manual.scope = model \| machine`; model-scope is MVP | Recommended, low risk |
| X4 | Maintain conversation context vs never trust an old AI answer | Prior AI turns used for coreference only, never as evidence | No — clearly correct |
| X5 | Compose-everything vs host Ollama | Configurable base URL, both modes supported | No |
| X6 | Qdrant incident vectors vs Mongo as source of truth | Mongo authoritative; Qdrant always rebuildable | No |
| X7 | No microservices vs two services | Language boundary, not a domain boundary; both are modular monoliths | No |
| X8 | Section-level citations vs unstructured scans | Section is best-effort/nullable; page is mandatory | No |
| X9 | Audit "must record" vs Mongo has no immutability | Append-only + no mutation API + optional hash chain; honestly tamper-*evident* | No |

---

## Assumptions I will proceed with unless corrected

All are tagged **[A]** throughout the documents; the material ones are consolidated in
`PRODUCT_REQUIREMENTS.md` §14.2 (A1–A12). The highest-impact ones:

1. **A1** Single tenant, all users see all machines (→ Q2).
2. **A2** English manuals (→ Q1).
3. **A5** Single-node deployment, 1–5 concurrent users → no queue broker, in-process workers.
4. **A6** No guaranteed GPU → conservative model sizing, measure in Phase 4 (→ Q5).
5. **A9** A 5–8 minute judged demo → drives the Phase 12 script.
6. **A12** Advisory system, not a certified safety instrument → a persistent UI disclaimer.

If any of these is wrong, tell me which — several would change the architecture, and it is far
cheaper to change it now than in Phase 7.
