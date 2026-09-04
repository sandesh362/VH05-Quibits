# MVP_SCOPE.md

Brief §18. Tags: **[C]** **[A]** **[R]** **[U]**.

**MVP definition:** the smallest system that credibly demonstrates *grounded, machine-scoped,
evidence-graded troubleshooting with a working memory loop* — and that survives a live demo.

---

## 1. IN SCOPE — the 16 required capabilities **[C]**

| # | Capability | Definition of done | Demo beat |
|---|---|---|---|
| 1 | Local manual upload | PDF up to 100 MB, assigned to a model, async job with visible progress | Upload live |
| 2 | PDF text extraction | Page-accurate text + layout + section hints via PyMuPDF | Chunk count shown |
| 3 | OCR fallback | Auto-triggered on text-poor pages; OCRmyPDF; per-page confidence | Upload a scan |
| 4 | Local embeddings | Ollama `nomic-embed-text`, batched, dimension-verified | Health page |
| 5 | Qdrant retrieval | 2 collections, payload indexes, deterministic IDs, verified counts | Admin stats |
| 6 | Machine/model filtering | Mandatory server-side filter + post-retrieval assertion | The E-041 two-model scenario |
| 7 | Grounded RAG answers | Structured response contract, evidence separated into 4 lanes | The main screen |
| 8 | Page-level citations | Server-resolved page + section, clickable to a rendered page image **[R]** | **Click a citation** |
| 9 | Clarification questions | Ambiguous machine/model/code → question + one-tap options | Unscoped `E-041` |
| 10 | Refusal on insufficient evidence | Threshold gate + informative refusal object | **The refusal beat** |
| 11 | Machine registration | Models + physical machines, unique asset tags | Setup screen |
| 12 | Incident creation | From a conversation or standalone; AI suggestion snapshotted separately | "Log this incident" |
| 13 | Technician-confirmed resolution | Actions with outcomes; explicit confirmation gate; then embedded | Resolve, then re-ask |
| 14 | Similar incident retrieval | Tiered, status-weighted, honest labels including failed fixes | The history lane |
| 15 | Basic maintenance history | CRUD + time-windowed, non-causal surfacing | The maintenance lane |
| 16 | React web interface | Login, machines, manuals+jobs, troubleshoot, incidents, timeline, health | All of it |

**Plus, non-negotiable supporting scope:** auth with 4 roles; audit logging; the background job
system with restart recovery; the health page; Docker Compose + seed + preflight; a small golden
evaluation set **[R]**.

---

## 2. IN SCOPE IF TIME PERMITS (ranked by value/effort) **[R]**

| Rank | Feature | Effort | Why it earns its place |
|---|---|---|---|
| 1 | Page-image citation preview with highlight | S | Turns "plausible" into "verified" in one click. Highest demo ROI in the entire list. |
| 2 | Golden set + metrics slide | M | Answers "how do you know it works?" with numbers |
| 3 | Cross-encoder reranking | M | Best pure-quality gain for symptom queries |
| 4 | Recurring-failure detection | S | Real maintenance-manager value, one aggregation |
| 5 | QR/asset-tag machine selection | S | Makes it feel like a real shop-floor tool |
| 6 | Answer feedback (👍/👎) | S | Feeds the evaluation story |
| 7 | Streaming responses | M | Perceived latency only |
| 8 | Manual chunk inspector (admin) | S | Great for debugging *and* for showing judges the internals |
| 9 | Export incident report | S | Manager value |
| 10 | High-contrast shop-floor theme | S | Persona credibility |

---

## 3. OUT OF SCOPE — postponed, with reasons **[C]**

| Feature | Why it waits |
|---|---|
| **Voice assistant** | The genuine use case (gloved hands, noise) is real, but shop-floor noise makes local STT accuracy poor, and it adds Whisper + audio pipeline + a new failure surface. It improves *input convenience*, not answer trustworthiness — which is the thing being judged. Revisit after grounding is proven. |
| **Multilingual speech** | Compounds the above with per-language models, plus multilingual embeddings and OCR packs. Only worth it once the corpus language question (**Q1**) is settled and the core works. |
| **Advanced analytics dashboards** | Charts of MTBF/MTTR need months of data; with seeded demo data they are decorative, and judges recognise fake charts instantly. The machine timeline already delivers the insight that matters. |
| **Complex workflow automation** (approvals, escalation chains, SLAs) | This is CMMS territory. It adds state machines and roles without improving a single answer. The existing incident state machine is the minimum that supports the memory loop. |
| **Predictive maintenance** | Requires sensor time-series and failure labels that do not exist here. Doing it on this data would be statistically dishonest — the opposite of the product's grounding thesis. |
| **Real-time IoT/PLC integration** | OPC-UA/Modbus connectivity, a time-series store, and plant network access. Enormous scope, and a wrong live reading is a safety issue. Great *phase 2 product*, terrible MVP. |
| **Computer-vision diagnosis** | A separate ML problem needing labelled fault images. Zero synergy with the RAG core. |
| **Multi-tenant enterprise billing** | No tenants, no billing, and (**Q2**) tenancy would touch every collection and every filter. Deliberately deferred, with the filter object designed so it can be added cleanly. |
| **Kubernetes deployment** | One machine. Compose is correct. K8s would consume a day and demo *worse*. |
| **Complex event streaming (Kafka)** | Nothing to stream. A few jobs an hour. Mongo-backed jobs are sufficient and simpler to explain. |
| **Fine-tuning a local model** | Days of work, needs training data, and a fine-tune cannot fix grounding — retrieval quality can. Wrong lever. |
| **Graph knowledge base** (components/causal graph) | Genuinely interesting for root-cause reasoning, but it needs a curated ontology per machine type. Post-MVP research. |
| **Mobile native app** | The responsive web UI covers the tablet case. |
| **SSO/LDAP/MFA** | Enterprise integration with no MVP demo value; local auth is sufficient for a trusted LAN. |
| **Offline-first sync / PWA** | The whole system is already local; the browser is on the same LAN. Solves a problem we do not have. |
| **CMMS import connectors** | **[U]** A7 assumes no CMMS. A CSV import is a 1-hour add if you *do* have data — ask before building. |
| **Automatic incident creation from chat** | Would pollute the evidence corpus with idle questions. Human intent must gate what becomes memory. |
| **LLM-written incident summaries for embedding** | Would inject inference into the evidence corpus, contradicting the core principle. Deterministic templates instead. |

---

## 4. Explicit non-goals (never, not just "later")

1. A general-purpose chatbot — off-topic questions are refused by design.
2. A certified safety system — the OEM manual and plant procedure remain authoritative.
3. Any cloud dependency, including "optional" fallbacks **[C]**.
4. Auto-closing incidents or auto-confirming fixes **[C]**.
5. Asserting that maintenance *caused* a fault **[C]**.
6. Cross-machine-model answer mixing **[C]**.

---

## 5. MVP cut lines (what to sacrifice, in order, if you run out of time)

**[R]** Decide this *now*, while calm — not at 3 a.m. on demo eve.

| Cut order | Sacrifice | Keep instead |
|---|---|---|
| 1 | Cross-encoder reranking | Hybrid retrieval is enough |
| 2 | Streaming | A spinner with honest stage text |
| 3 | Maintenance *editing* UI | Seeded maintenance data + read-only display |
| 4 | Manual metadata editing | Set correctly at upload |
| 5 | Audit-log **viewer** UI | Keep the audit *writes*; show them in `mongosh` if asked |
| 6 | User management UI | Seeded users; role switching via seeded logins |
| 7 | Machine timeline UI | Incident list + maintenance list separately |
| 8 | Job cancellation UI | Retry only |
| **NEVER CUT** | Citations · refusal · clarification · model filtering · incident confirmation gate · evidence separation | These *are* the product |

---

## 6. What "done" looks like for the MVP

A judge can, unassisted, in under 8 minutes:
1. Log in as a technician.
2. Pick machine `LINE2-INJ-03` and ask about `E-041`.
3. See four visually distinct evidence lanes, click a citation, and land on the real manual page.
4. Ask the same code with **no** machine selected and get a clarification listing two different
   meanings across models.
5. Ask about something not in any manual and get an informative refusal — not a fabrication.
6. Log an incident, record the actual action, confirm the resolution.
7. Re-ask the original question and see the new confirmed fix appear as historical evidence.
8. Watch Ollama get stopped and the system degrade honestly instead of breaking.

If all eight work reliably, the MVP is complete. Anything that does not serve those eight steps
is a candidate for the cut list.
