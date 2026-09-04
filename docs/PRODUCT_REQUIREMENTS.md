# PRODUCT_REQUIREMENTS.md

Phase 0 deliverable. Product analysis, scope, roles.

**Legend used throughout all documents:**

| Tag | Meaning |
|---|---|
| **[C]** | **Confirmed** — explicitly stated in your brief |
| **[A]** | **Assumption** — my inference, plausible, *not* confirmed by you |
| **[R]** | **Recommendation** — optional, my professional advice |
| **[U]** | **Unknown** — needs your decision (tracked in `OPEN_QUESTIONS.md`) |

Nothing tagged **[A]** should be treated as a requirement until you confirm it.

---

## 1. What problem the application solves

### 1.1 The real-world pain

When an industrial machine stops, the cost is measured in **downtime per minute**, not in
convenience. The technician standing in front of a halted CNC machine, injection moulder, or
packaging line at 02:40 has a fault code on an HMI panel and a set of very bad options:

1. **The manual is a 900-page PDF** (often a scan of a 1998 print run) on a shared drive, in
   a folder named `MANUALS_FINAL_v2_USE_THIS`. Ctrl-F fails because the PDF has no text layer.
2. **Error code lookup tables are inconsistent.** `E-041` means "servo overload" on one model
   and "door interlock" on the sibling model from the same manufacturer.
3. **Institutional memory lives in one senior technician's head.** "Oh, that one — it's the
   loose ground strap behind the panel, happens every monsoon." That knowledge retires.
4. **Past repair records, if they exist, are unsearchable** — paper job cards, a shared Excel
   file, or free-text tickets in a CMMS nobody indexes.
5. **Maintenance history is disconnected from troubleshooting.** Nobody notices that the fault
   started three days after a bearing replacement.
6. **Generic LLM chatbots are actively dangerous here.** They will confidently invent a torque
   spec. In an industrial context, a wrong instruction is a safety incident, not a bad UX.

### 1.2 The problem statement

> Technicians cannot rapidly retrieve *trustworthy, machine-specific, evidence-backed*
> troubleshooting guidance, because the three knowledge sources they need — the manual, what
> happened last time, and what was recently serviced — are siloed, unsearchable, and
> unverifiable.

### 1.3 What this system is

A **local, evidence-graded retrieval and reasoning layer** over three corpora:

| Corpus | Source | Authority level |
|---|---|---|
| Manuals | OEM PDFs, per machine model | Highest — printed engineering fact |
| Incident history | Past faults + what the technician *actually did* | Medium — depends on confirmation status |
| Maintenance history | Service events, part replacements, calibrations | Contextual — correlation, never causation |

Its differentiator is **not** answering. It is **grounding, separation of evidence classes,
and disciplined refusal.**

### 1.4 What this system is explicitly not

- Not a CMMS/EAM replacement (no work order scheduling, no spare-part inventory, no costing).
- Not a SCADA/PLC/IoT integration (no live telemetry in MVP).
- Not a general-purpose chatbot.
- Not a certified safety system. **[A]** It is a decision-support aid; the technician and
  the OEM manual remain authoritative. This must be stated in the UI. See §6.

---

## 2. Primary users

### 2.1 Persona 1 — Maintenance Technician (PRIMARY, ~80% of usage) **[A]**

| Attribute | Detail |
|---|---|
| Context | On the shop floor, machine is down, supervisor is asking for an ETA |
| Device | **[U]** Likely a rugged tablet or shared shop-floor PC. Possibly a phone. Affects UI density. |
| Hands | Often gloved, sometimes dirty. Large tap targets matter. |
| Expertise | High mechanical/electrical skill; low patience for software |
| Trust posture | **Skeptical.** Will discard the tool permanently after one confidently wrong answer. |
| Needs | (a) What does this code mean *on this machine*? (b) What did we do last time? (c) Show me the page so I can verify. |
| Success metric | Time-to-first-actionable-step, and whether the cited page was actually correct |

**Design consequence:** The citation is not a footnote — it is the product. "Page 412, §7.3"
with a link to the exact page is what converts skepticism into use.

### 2.2 Persona 2 — Maintenance Manager / Supervisor **[A]**

Cares about: recurring failures, whether incidents get closed properly, whether the team logs
actions, which machines are problem children. Reviews and confirms incident resolutions.
Uses the machine timeline more than the chat.

### 2.3 Persona 3 — Administrator / Reliability Engineer **[A]**

Sets the system up. Uploads manuals, registers models and machines, manages users, watches
processing jobs and system health. Low frequency, high privilege.

### 2.4 Persona 4 — Viewer (auditor, trainee, plant manager, QA) **[A]**

Read-only. Present mainly so that "read access ≠ write access" is enforced from day one.

### 2.5 Persona 5 — The hackathon judge (real, don't pretend otherwise)

Cares about: does it work live, is it genuinely local, is the RAG honest, is the data model
serious, does it refuse when it should. Optimise the demo for **the refusal moment** and
**the citation click-through** — see §10.

---

## 3. The user's current workflow (as-is) **[A — inferred, validate with a real technician]**

```
Alarm on HMI: "E-041"
        │
        ├─ 1. Does the technician recognise it?  ──yes──► fix from memory ──► (nothing recorded)
        │        no
        ▼
   2. Ask the nearest senior technician  ──available──► verbal advice ──► (nothing recorded)
        │ not available / night shift
        ▼
   3. Find the manual: shared drive / OEM portal / physical binder in the cabinet
        │  (5–30 min; may fail entirely for old machines)
        ▼
   4. Ctrl-F "E-041"  ──scanned PDF, no text layer──► manual page-by-page scan of index
        │
        ▼
   5. Read the fault table → generic cause list ("check wiring, check sensor")
        │
        ▼
   6. Trial and error on the floor
        │
        ▼
   7. Fixed? ──► maybe write a line on a paper job card / CMMS free-text ticket
                 ("checked wiring, ok now") — unsearchable, no root cause, no parts noted
        │
        ▼
   8. Same fault recurs in 6 weeks on the same machine → the entire loop repeats from step 1,
      because step 7 produced nothing retrievable.
```

**Diagnosis of the as-is:** the loop has **no memory**. Steps 3–4 are pure search latency
(the biggest fixable cost), and step 7 is a broken write path (the biggest fixable *value*
loss). Any solution that fixes only step 3–4 is a PDF chatbot. Fixing step 7 and feeding it
back into step 1 is the actual product.

---

## 4. How the proposed application improves the workflow (to-be)

```
Alarm: "E-041" on Machine LINE2-INJ-03
        │
        ▼
   1. Open app → machine already selected (from scan/QR/dropdown) → type "E-041"
        │        (machine context locked: model = Toshiba EC180SX; only its manuals searched)
        ▼
   2. System returns, in one screen, four SEPARATED blocks:
        ├─ MANUAL EVIDENCE      "E-041 = Servo overload, injection axis" — Manual v3, p.412 §7.3 [open page]
        ├─ HISTORICAL EVIDENCE  "3 prior incidents on THIS machine. 2× CONFIRMED resolved by
        │                        cleaning the servo cooling filter (Tech: R. Nair, 2026-03-11).
        │                        1× TEMPORARY fix (reset only) — recurred in 4 days."
        ├─ MAINTENANCE CONTEXT  "Servo drive replaced 6 days ago (WO-2291). Temporal proximity
        │                        noted — NOT established as the cause."
        └─ AI INFERENCE         "Given the recent drive swap and the filter history, checking
                                 drive parameter set before the filter may save time." (flagged
                                 as inference, no citation, explicitly unverified)
        ▼
   3. Technician acts. Records the ACTUAL action taken (not the AI's suggestion).
        ▼
   4. Marks status: RESOLVED_CONFIRMED / UNRESOLVED / TEMPORARY / RECURRING.
      Requires explicit confirmation — the system never self-declares a fix.
        ▼
   5. That incident is embedded and becomes retrievable evidence for the next person,
      carrying its resolution status forever.
```

| Step | As-is cost | To-be cost | Mechanism |
|---|---|---|---|
| Find manual content | 5–30 min, often fails | < 10 s | OCR + embedding + page-accurate retrieval |
| Correct code interpretation | Ambiguous across models | Deterministic | Hard metadata filter on `machine_model_id` |
| Access tribal knowledge | Only if the right person is awake | Always | Incident memory with confirmation status |
| Notice maintenance correlation | Almost never | Automatic surfacing | Time-windowed maintenance retrieval |
| Capture new knowledge | Lost | Structured + embedded | Incident action + confirmation workflow |

**The compounding effect:** unlike a PDF chatbot, this system gets measurably better every
time it is used, because step 4 writes back into the retrieval corpus.

---

## 5. What the system MUST do

All items below are **[C] confirmed** — they restate your requirements 1–22, grouped and made
testable. `AC-nn` refers to `ACCEPTANCE_CRITERIA.md`.

### 5.1 Asset & content management
| ID | Requirement |
|---|---|
| MUST-01 | Register machine **models** (manufacturer, model name, machine type) as first-class entities |
| MUST-02 | Register **physical machines**, each referencing exactly one model, with a unique asset tag |
| MUST-03 | Upload multiple PDF manuals; associate each with a machine **model** (not a physical machine) |
| MUST-04 | Process both digital-text and scanned/image PDFs |
| MUST-05 | Extract text preserving **page number** and structural hints (headings, tables, fault-code tables) |

### 5.2 Retrieval & AI
| ID | Requirement |
|---|---|
| MUST-06 | Generate embeddings **locally via Ollama**; no external service |
| MUST-07 | Store vectors in **locally running Qdrant** |
| MUST-08 | Support **exact error-code** lookup AND **natural-language symptom** search |
| MUST-09 | Answer via RAG grounded in retrieved evidence |
| MUST-10 | Every factual claim carries a citation: manual → section → page |
| MUST-11 | **Never mix evidence across machine models** (hard filter, not a prompt instruction) |
| MUST-12 | Ask a clarification question when machine/model is ambiguous |
| MUST-13 | **Refuse** when retrieved evidence is insufficient — refusal is a first-class success state |
| MUST-14 | Maintain conversation context across follow-up turns |

### 5.3 Memory
| ID | Requirement |
|---|---|
| MUST-15 | Store troubleshooting incidents, linked to a physical machine where possible |
| MUST-16 | Store the **actual actions performed by technicians**, stored separately from AI suggestions |
| MUST-17 | Store resolution status ∈ {resolved_confirmed, unresolved, recurring, temporarily_resolved} |
| MUST-18 | Retrieve similar historical incidents during future troubleshooting |
| MUST-19 | Store machine maintenance history |
| MUST-20 | Use relevant maintenance history as **supporting, non-causal** context |
| MUST-21 | Visibly distinguish: manual evidence \| historical evidence \| maintenance context \| AI inference |
| MUST-22 | Never treat a prior AI answer or an unconfirmed incident as authoritative |
| MUST-23 | An incident may only reach `resolved_confirmed` through an explicit human action |
| MUST-24 | Deleted manuals must become immediately unsearchable (Mongo *and* Qdrant) |
| MUST-25 | Failed processing jobs must be visible, traceable, and re-runnable |
| MUST-26 | Audit log for security- and integrity-relevant changes |

---

## 6. What the system MUST NOT do

| ID | Prohibition | Why |
|---|---|---|
| NOT-01 | Must not answer from LLM parametric knowledge when retrieval is empty | This is the single failure that kills credibility. Empty retrieval → refusal, always. |
| NOT-02 | Must not present AI inference with the same visual/semantic weight as manual evidence | Core product promise (MUST-21) |
| NOT-03 | Must not cite a page number that does not exist in the referenced manual | Validator must drop/downgrade it (`AC-09`) |
| NOT-04 | Must not return content from another machine model | Post-filter assertion in addition to the pre-filter |
| NOT-05 | Must not auto-mark any incident resolved (no "looks fixed", no timeout-based closure) | MUST-23 |
| NOT-06 | Must not claim causation from maintenance temporal proximity | May state correlation with explicit hedging only |
| NOT-07 | Must not obey instructions embedded in manual text or in retrieved incident text | Prompt injection; treat retrieved content as **data**, never as instruction |
| NOT-08 | Must not call any cloud/hosted AI or vector service, ever, including "just for fallback" | Hard constraint **[C]** |
| NOT-09 | Must not silently degrade when Ollama/Qdrant is down | Must show an explicit, honest service-status error |
| NOT-10 | Must not delete data physically on user "delete" for auditable entities | Soft delete + audit (exception: manual vectors, which are hard-deleted — see MUST-24) |
| NOT-11 | Must not store passwords recoverably, or log secrets/tokens/full prompts with credentials | Security baseline |
| NOT-12 | Must not present itself as a certified safety authority | Persistent UI disclaimer **[R]**: *"Decision support only. Verify against the OEM manual and your plant's LOTO procedure before acting."* |
| NOT-13 | Must not let a technician mark their own incident resolved *and* have it outrank a manual | Evidence priority is fixed; manual outranks history |
| NOT-14 | Must not perform destructive re-index without preserving the ability to recover the source PDF | Source PDF is the system of record |

---

## 7. MVP-essential features

Full detail in `MVP_SCOPE.md`. Summary — 16 items, all **[C]**:

| # | Feature | Why non-negotiable |
|---|---|---|
| 1 | Auth (login, JWT, 4 roles) | Everything else needs an actor for audit |
| 2 | Machine model CRUD | The filter key that makes RAG safe |
| 3 | Physical machine CRUD | Incident/maintenance anchor |
| 4 | Manual upload (PDF, multi-file, → model) | Corpus entry point |
| 5 | PyMuPDF text + layout extraction with page fidelity | Citation foundation |
| 6 | OCR fallback (auto-triggered on low text density) | Demo-critical: real manuals are scans |
| 7 | Structure-aware chunking (fault-code tables kept intact) | Biggest quality lever in the whole system |
| 8 | Local embeddings via Ollama | Hard constraint |
| 9 | Qdrant indexing with rich payload | Retrieval substrate |
| 10 | **Hybrid retrieval** (exact code/lexical + vector) with metadata pre-filter | Vector-only fails on `E-041` vs `E-042` |
| 11 | RAG with strict JSON response contract | Enables validation & rendering |
| 12 | Citation validation (page & chunk existence check) | Anti-hallucination |
| 13 | Clarification + refusal logic | The trust differentiator |
| 14 | Conversation persistence + follow-up rewriting | Usability |
| 15 | Incident lifecycle: create → AI suggestion → **actual action** → explicit confirmation → embed | The moat |
| 16 | Maintenance records + time-windowed surfacing (non-causal) | Third evidence class |
| 17 | React UI: login, machines, manual upload + job status, troubleshoot chat with 4 evidence panes, incident form, machine timeline | Demo surface |
| 18 | Health page (Ollama/Qdrant/Mongo up-down) | Judges love it; you need it during the demo |

---

## 8. Optional features (build only if time remains)

| Feature | Value | Cost | Verdict |
|---|---|---|---|
| Cross-encoder reranker (local, e.g. `bge-reranker-base` via ONNX/Ollama) | High precision gain | Medium | **[R]** Do it if Phase 5 finishes early — biggest quality/effort ratio |
| Page-image thumbnail of the cited page in the UI | Very high demo impact; instant verification | Low (PyMuPDF renders it already) | **[R] Strongly recommended** — cheap, and it *proves* grounding to judges |
| QR / asset-tag scan to select a machine | High realism | Low-medium | **[R]** Nice demo beat |
| Recurring-failure detection (same code, same machine, N times in T days) | Manager value | Low (a Mongo aggregation) | **[R]** Cheap intelligence |
| Manual version comparison / supersede | Real-world necessary | Medium | Optional — model the field now, implement later |
| Export incident report as PDF/Markdown | Manager value | Low | Optional |
| Answer feedback (👍/👎 + reason) → evaluation set | Great for the "we measured it" slide | Low | **[R]** |
| Small golden evaluation set (30–50 Q/A with expected page) + scoring script | Judges: "how do you know it works?" | Medium | **[R] Recommended** — a real differentiator |
| Streaming token output | Perceived latency | Low-medium | Optional |
| Dark mode / shop-floor high-contrast theme | Persona fit | Low | Optional |

---

## 9. Postponed features (explicitly out — see `MVP_SCOPE.md` §3 for full reasoning)

Voice assistant · multilingual speech · advanced analytics dashboards · workflow automation ·
predictive maintenance · real-time IoT/PLC integration · computer-vision diagnosis ·
multi-tenant billing · Kubernetes · event streaming (Kafka) · mobile native apps ·
fine-tuning a local model · graph knowledge base · offline-first sync · SSO/LDAP.

Common reason: each adds a *new* failure surface without strengthening the core claim
("grounded, machine-scoped, evidence-graded answers"). Several (predictive maintenance, IoT,
CV) also require data you do not have.

---

## 10. What makes this impressive to hackathon judges

Ranked by impact per unit of effort:

1. **The refusal demo.** Ask about a machine with no manual. The system says: *"I cannot
   answer. No manual for Model X contains information about this symptom. Nearest evidence
   scored 0.31, below the 0.45 threshold. Suggested next action: upload the electrical
   schematic supplement, or log this as an incident for a senior technician."* Almost no
   hackathon RAG project does this. **Rehearse this as a deliberate demo beat, not an accident.**
2. **The click-through citation.** Answer says "p.412 §7.3" → click → the rendered page image
   appears with the region highlighted. This converts "plausible demo" into "verified system."
3. **The four-lane evidence UI.** Manual / History / Maintenance / Inference visually
   separated with distinct colour and iconography, and an explicit "AI inference — unverified"
   badge. Show a judge that the AI's own guess is visually *demoted*.
4. **The memory loop, demonstrated live.** Run the same query twice — once before logging an
   incident, once after. The second answer includes "1 confirmed prior fix on this machine."
   This is the single clearest proof that it is not a PDF chatbot.
5. **The disambiguation moment.** Same error code `E-041` on two different models → the system
   *asks which machine* rather than guessing. Then show the two different answers.
6. **Genuine offline proof.** Disconnect Wi-Fi on stage, keep answering. Then `docker stop
   ollama` and show the graceful, honest degradation (retrieval still works, generation is
   disabled with a clear message) — that is engineering maturity.
7. **OCR on a real scan.** Upload a visibly photocopied/skewed manual page live and retrieve
   from it.
8. **Measured, not claimed.** One slide: 40-question golden set, retrieval hit@5, citation
   validity rate, refusal precision/recall. Numbers beat adjectives.

## 11. What would make it unreliable or easy to reject

| Rejection trigger | Prevention |
|---|---|
| One confidently wrong answer during the demo | Refusal thresholds tuned conservatively; rehearse on a frozen corpus |
| Fabricated page number spotted by a judge who clicks | Citation validator + page-existence assertion (`AC-09`) |
| Cross-machine leakage ("that's the other model's procedure") | Hard Qdrant pre-filter + post-retrieval assertion + a test |
| 60-second answer latency on stage | Pre-warm Ollama, cap context, small model, pre-indexed corpus, measured budget |
| "This is just LangChain + a PDF" | Lead with the incident-memory loop and evidence grading, not the chat box |
| Uploading a manual takes 8 minutes with a frozen UI | Async job + progress; **pre-index the demo corpus**, upload only a small manual live |
| Demo dies because Ollama wasn't warm / model not pulled | Health page checked before starting; models pulled and warmed in a pre-flight script |
| It secretly calls the internet | Be able to prove it: run with network disabled |
| Data model is a toy (one `documents` collection) | The 11-collection model in `DATA_MODEL.md` is itself a differentiator; show the ER diagram |
| Answers are vague generic maintenance advice | Structure-aware chunking of fault-code tables; show a *specific* torque value / part number |
| Can't explain security | One slide from `SECURITY_AND_RELIABILITY.md` |

## 12. Where the highest engineering attention must go

Ranked. Spend your effort here; everything else is CRUD.

| Rank | Area | Why it is the risk | Mitigation summary |
|---|---|---|---|
| 1 | **Chunking of technical manuals** | Fault-code tables split mid-row destroy the primary use case. Naïve 512-token splitting *will* fail on manuals. | Layout-aware extraction; keep table rows atomic; one chunk per fault-code entry where detectable; parent-page context attached |
| 2 | **Hybrid retrieval for error codes** | Embeddings cannot distinguish `E-041` from `E-042`. Vector-only search is *guaranteed* to fail here. | Regex code extraction + exact lexical match path with a score floor/boost, merged with vector results |
| 3 | **Metadata filtering discipline** | A single missing filter = cross-machine contamination = product-invalidating | Filter injected server-side in FastAPI, never client-supplied; post-retrieval assertion; dedicated test |
| 4 | **Refusal / confidence calibration** | Too strict = useless demo; too loose = dangerous. This is a *tuning* problem, budget real time. | Multi-signal gate (top score, score gap, code-match, coverage) with a tunable config; golden set to calibrate |
| 5 | **Citation validation** | LLMs invent page numbers under pressure | Machine-checkable: every citation must map to a `chunk_id` that was actually in the context AND whose page matches; else drop the claim |
| 6 | **OCR quality & triggering** | Bad OCR silently poisons the whole corpus | Per-page text-density heuristic; OCR confidence score stored; low-confidence pages flagged and down-weighted, visible in UI |
| 7 | **Incident evidence semantics** | The whole "not a chatbot" claim lives here; getting the status model wrong is a product bug, not a code bug | Explicit state machine, separate `IncidentAction` collection, confirmation required, status carried into the vector payload and into ranking |
| 8 | **Prompt injection from documents** | A manual (or a malicious upload) containing "ignore previous instructions" | Retrieved text is delimited, escaped, and declared as untrusted data; instruction-pattern scanner; output schema validation as the backstop |
| 9 | **Async job reliability & restart recovery** | Half-indexed manual after a crash = silently wrong answers | Job state machine in Mongo, idempotent stages, deterministic point IDs, stale-job reaper on boot |
| 10 | **Local performance budget** | Hackathon laptop, no GPU guarantee | Measure early (Phase 4); choose model size accordingly; cap chunks-in-context; batch embeddings |

---

## 13. User roles and authorization

### 13.1 Model choice

**[R] Recommendation: flat RBAC with 4 roles, one role per user, enforced by Express
middleware. No per-resource ACLs, no permission tables, no groups in the MVP.**

Reasoning: the plant is a single tenant with a shared machine fleet; technicians legitimately
need access to *all* machines (you get sent to whichever line is down). Building
resource-level ACLs would add real complexity for zero MVP value. The expansion path is kept
open by storing the permission decision in a single `permissions.js` policy map keyed by
`(role, action)` rather than scattering `if (role === 'admin')` through the codebase — later,
swap the map for a policy engine and add an optional `siteId`/`departmentId` scope field
(reserved in the schema now, unused in MVP).

### 13.2 Role definitions

| Role | One-line charter |
|---|---|
| `admin` | Runs the system: users, models, machines, manuals, everything |
| `manager` | Owns maintenance quality: confirms resolutions, manages maintenance records, corrects bad data |
| `technician` | Does the work: troubleshoots, logs incidents and actual actions, proposes resolution |
| `viewer` | Reads only |

### 13.3 Permission matrix

`✓` allowed · `✗` denied · `own` = only records they created · `—` = n/a

| Capability | admin | manager | technician | viewer |
|---|:--:|:--:|:--:|:--:|
| **View** |
| Machines, models, manuals (metadata) | ✓ | ✓ | ✓ | ✓ |
| Download / view manual PDF pages | ✓ | ✓ | ✓ | ✓ |
| Incidents (all) | ✓ | ✓ | ✓ | ✓ |
| Maintenance records | ✓ | ✓ | ✓ | ✓ |
| Machine timeline | ✓ | ✓ | ✓ | ✓ |
| Own conversations | ✓ | ✓ | ✓ | ✓ |
| **Others'** conversations | ✓ | ✓ | ✗ | ✗ |
| Users list | ✓ | ✓ (read) | ✗ | ✗ |
| Audit log | ✓ | ✓ (read) | ✗ | ✗ |
| System health & job queue | ✓ | ✓ | ✓ (basic) | ✗ |
| **Create** |
| Machine model | ✓ | ✓ | ✗ | ✗ |
| Machine | ✓ | ✓ | ✗ | ✗ |
| **Upload manual** | ✓ | ✓ | ✗ | ✗ |
| Conversation / ask questions | ✓ | ✓ | ✓ | ✗ |
| Incident | ✓ | ✓ | ✓ | ✗ |
| Incident action (what I actually did) | ✓ | ✓ | ✓ | ✗ |
| Maintenance record | ✓ | ✓ | ✓ | ✗ |
| User | ✓ | ✗ | ✗ | ✗ |
| **Update** |
| Machine / model info | ✓ | ✓ | ✗ | ✗ |
| Manual metadata (title, version, model link) | ✓ | ✓ | ✗ | ✗ |
| Trigger manual re-index | ✓ | ✓ | ✗ | ✗ |
| Own incident (while `open`/`in_progress`) | ✓ | ✓ | own | ✗ |
| Any incident | ✓ | ✓ | ✗ | ✗ |
| Own incident action (≤ 24 h, **[A]** window) | ✓ | ✓ | own | ✗ |
| **Mark incident `resolved_confirmed`** | ✓ | ✓ | **see §13.4** | ✗ |
| Reopen / correct a closed incident | ✓ | ✓ | ✗ | ✗ |
| Maintenance record | ✓ | ✓ | own (≤24 h) | ✗ |
| Own profile / password | ✓ | ✓ | ✓ | ✓ |
| Other users' roles | ✓ | ✗ | ✗ | ✗ |
| **Delete** (soft unless noted) |
| Manual (soft + **hard** vector purge) | ✓ | ✓ | ✗ | ✗ |
| Machine / model (only if no dependents) | ✓ | ✗ | ✗ | ✗ |
| Incident (soft + vector purge) | ✓ | ✓ | ✗ | ✗ |
| Maintenance record (soft) | ✓ | ✓ | ✗ | ✗ |
| Own conversation (soft) | ✓ | ✓ | own | ✗ |
| User (soft / deactivate) | ✓ | ✗ | ✗ | ✗ |
| Audit log entries | ✗ | ✗ | ✗ | ✗ |

### 13.4 The one genuinely important policy decision — who confirms a fix

**[U] BLOCKING QUESTION.** Two defensible options:

- **Option A (recommended for MVP, and for the demo):** a technician may set
  `resolved_confirmed` for an incident **they personally worked on**, because they are the
  one with first-hand knowledge; a manager may override or reopen. Simple, matches reality on
  a night shift, and keeps the demo to one login.
- **Option B (stricter):** technician sets `resolution_proposed`; only a `manager`/`admin`
  promotes it to `resolved_confirmed`. Better governance, produces a two-actor demo,
  but adds a second login to the demo flow and can leave incidents stuck pending.

**[R]** Implement **A**, but store the fields needed for B from day one
(`confirmed_by`, `confirmed_at`, `confirmation_method`) and put the choice behind a config
flag `INCIDENT_CONFIRMATION_MODE = self | supervisor`. Then you can demo either. This
satisfies MUST-23 in both modes because *some* human explicitly confirms.

### 13.5 Cross-cutting authorization rules

1. **Deny by default.** Every route declares a required capability; an unmapped route is 403.
2. Authorization is enforced **only in Express**. FastAPI is not internet-facing and trusts a
   signed internal call (see `SECURITY_AND_RELIABILITY.md` §4) — but it still validates that
   the `machine_model_id` filter is present and non-empty on every search.
3. The UI hides forbidden actions, but the server is the enforcement point. Hidden ≠ denied.
4. Every state-changing action writes an `AuditLog` entry with actor, before/after, and reason
   where applicable.
5. `viewer` is genuinely read-only, including AI queries — **[A]** rationale: generation costs
   local GPU and produces stored artefacts. **[U]** Confirm: should a viewer be allowed to ask
   read-only questions? Cheap to allow.

---

## 14. Requirement classification summary

### 14.1 Confirmed (from your brief)
Everything in §5 and §6 (MUST-01…26, NOT-01…14); the technology stack; the module list; the
workflow list; the collection list; the phase sequence; "no cloud"; "no implementation code
this phase"; the evidence-separation principle; "AI suggestion ≠ confirmed repair".

### 14.2 Assumptions I am making (please confirm or correct)
| # | Assumption | Impact if wrong |
|---|---|---|
| A1 | Single plant / single tenant; all users see all machines | Would require tenant scoping on every collection and every Qdrant filter — significant rework, so decide now |
| A2 | Manuals are English **[U]** | Embedding model choice and OCR language packs change |
| A3 | Manual size ≤ ~500 pages, ≤ ~50 MB, corpus ≤ ~20 manuals for the demo | Drives batch sizes and timing budget |
| A4 | Machines are identified by an asset tag known to the technician | Otherwise you need a machine-detection UX |
| A5 | Deployment is one laptop/workstation, single user concurrency ~1–5 | Justifies no Redis, no queue broker, in-process workers |
| A6 | GPU availability is *not* guaranteed | Forces conservative model sizing; measure in Phase 4 |
| A7 | No existing CMMS to integrate; maintenance data is entered manually or seeded | An import path would otherwise be MVP |
| A8 | "Section" means a heading path extracted heuristically, not an OEM-authored ID | Affects citation precision expectations |
| A9 | Judges will see a ~5–8 minute demo | Drives the demo script in Phase 12 |
| A10 | Technician self-confirmation is acceptable (see §13.4) | Changes the incident state machine |
| A11 | Incident action edit window of 24 h | Trivial to change |
| A12 | The system is advisory, not a certified safety instrument | Legal/UX disclaimer requirement |

### 14.3 Optional recommendations (mine, not requirements)
Page-image citation preview · cross-encoder reranking · golden evaluation set · QR machine
selection · recurring-failure detection · answer feedback capture · `INCIDENT_CONFIRMATION_MODE`
flag · configurable evidence-priority weights.

### 14.4 Contradictions and gaps found in the brief

| # | Issue | Resolution proposed |
|---|---|---|
| X1 | §1.4 "associate manuals with specific machine **models**" vs. the practical need to attach a machine-specific document (a site wiring modification, a retrofit note) | Model `Manual.scope = 'model' \| 'machine'` with `machine_model_id` **or** `machine_id`. Model-scope is MVP; machine-scope field exists but is optional. Retrieval filter becomes `model_id = X OR machine_id = Y`. |
| X2 | Requirement 12 "avoid mixing information between different machines" vs. requirement 19 "retrieve similar historical incidents" — cross-*model* incident retrieval is often the most valuable signal (same failure on a sibling model) | Keep manuals strictly model-filtered (never cross). Allow incident retrieval to widen to same-model, and *optionally* same machine-type with an explicit, visible "different model" warning and a rank penalty. Cross-model is **off by default**, config-flagged. **[U] Confirm.** |
| X3 | "Refuse when manuals lack evidence" (14) vs. "use historical incidents" (19) — what if history has the answer but the manual does not? | Answer is permitted, `answer_status = "answered_from_history"`, `confidence` capped at `medium`, and the UI states "no manual evidence found; this is based on N confirmed past repairs." Pure refusal only when *all* evidence classes are empty. This needs your explicit blessing. |
| X4 | "Maintain conversation context" vs. "never blindly trust an old AI answer" — prior assistant turns are in the context window | Prior AI turns are used **only** for query rewriting/coreference resolution, never as evidence. They are excluded from the grounding context. |
| X5 | "Docker Compose for everything" vs. "Ollama may run on host" — container→host networking differs across OSes | Ollama URL is a config var; document `host.docker.internal` (macOS/Windows) and `--add-host=host.docker.internal:host-gateway` (Linux). Support both modes from Phase 1. |
| X6 | Qdrant `incident_history` vectors vs. Mongo as source of truth — dual-write consistency | Mongo is authoritative. Qdrant is a derived index, always rebuildable from Mongo by a re-index job. Never store data only in Qdrant. |
| X7 | "No microservices unnecessarily" vs. two services (Express + FastAPI) | Justified: language boundary, not a domain boundary. Two services, both internally modular monoliths. No further splitting. Documented in `SYSTEM_ARCHITECTURE.md` §2. |
| X8 | Requirement 11 wants "section" citations, but many scanned manuals have no reliable heading structure | Section is best-effort and nullable; page number is mandatory. UI shows section only when present. |
| X9 | Audit log "must record important changes" but MongoDB CE has no immutability | Append-only collection, no update/delete routes, **[R]** optional daily hash-chain checkpoint. Note honestly that this is tamper-evident, not tamper-proof, without WORM storage. |

### 14.5 Unknowns requiring your decision
Consolidated in `OPEN_QUESTIONS.md`. The five **BLOCKING** ones:
**Q1** manual language(s) · **Q2** single-tenant confirmation · **Q3** confirmation authority
(§13.4) · **Q4** answer-from-history-only allowed? (X3) · **Q5** hardware/GPU available for
the demo.
