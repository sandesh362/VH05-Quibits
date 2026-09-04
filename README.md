README.md. 



# Industrial Troubleshooting & Maintenance Intelligence Platform

**Working name:** `machine-mind` (placeholder — rename freely)

A fully local, grounded troubleshooting assistant for industrial maintenance technicians.
It combines **machine manuals**, **machine context**, **past incidents**, and **maintenance
history** into a retrieval-augmented answer that always says *where every claim came from* —
and refuses to answer when it cannot.

> **Status: Phase 0 — Analysis & Architecture only.**
> This repository currently contains **documentation only**. No application code has been
> written. Do not assume any feature exists.

---

## Non-negotiable constraints

| Constraint | Detail |
|---|---|
| Fully local | No cloud AI API, no hosted vector DB, no external AI service |
| AI runtime | Ollama (host or container) |
| Vector DB | Qdrant (local container) |
| Database | MongoDB Community Edition (local container) |
| Frontend | React + Vite |
| API backend | Node.js + Express |
| AI / document service | Python + FastAPI |
| Architecture style | Modular monolith per service; exactly **two** application services (Express, FastAPI). No Kafka, no Kubernetes, no Redis in MVP. |

---

## Documentation index

Read in this order.

| # | Document | What it answers |
|---|---|---|
| 1 | [`docs/PRODUCT_REQUIREMENTS.md`](docs/PRODUCT_REQUIREMENTS.md) | What problem, for whom, what's in/out, roles, judging risk |
| 2 | [`docs/SYSTEM_ARCHITECTURE.md`](docs/SYSTEM_ARCHITECTURE.md) | Components, ownership boundaries, deployment, workflows A–W |
| 3 | [`docs/MODULE_BREAKDOWN.md`](docs/MODULE_BREAKDOWN.md) | All 28 modules: purpose, I/O, rules, failure modes, MVP flag |
| 4 | [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) | MongoDB collections, fields, indexes, examples |
| 5 | [`docs/QDRANT_DESIGN.md`](docs/QDRANT_DESIGN.md) | Vector collections, payloads, filters, re-index strategy |
| 6 | [`docs/RAG_PIPELINE.md`](docs/RAG_PIPELINE.md) | 21-stage pipeline, response contract, incident memory, maintenance intelligence |
| 7 | [`docs/API_CONTRACTS.md`](docs/API_CONTRACTS.md) | Express public API + FastAPI internal API, background jobs |
| 8 | [`docs/SECURITY_AND_RELIABILITY.md`](docs/SECURITY_AND_RELIABILITY.md) | 22-point security review + hallucination/failure matrix |
| 9 | [`docs/MVP_SCOPE.md`](docs/MVP_SCOPE.md) | Strict in/out list with justification |
| 10 | [`docs/DEVELOPMENT_ROADMAP.md`](docs/DEVELOPMENT_ROADMAP.md) | Phases 1–12 with acceptance gates |
| 11 | [`docs/ACCEPTANCE_CRITERIA.md`](docs/ACCEPTANCE_CRITERIA.md) | Measurable, testable criteria |
| 12 | [`docs/OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md) | Unknowns needing your decision |

---

## The one idea that makes this not-a-PDF-chatbot

Every sentence the assistant produces is tagged with an **evidence class**:

```
MANUAL        — printed in an official manual for THIS machine model, with page number
HISTORY       — a past incident on this machine/model, with resolution status
TECHNICIAN    — a human wrote it down, but nobody verified it
MAINTENANCE   — a maintenance record, temporally correlated, NOT causally proven
INFERENCE     — the LLM reasoned it; no document says this
```

The UI renders these differently, the prompt forbids mixing them, and a post-generation
**citation validator** deletes or downgrades any claim whose citation does not resolve to a
real chunk on a real page. An AI suggestion is never stored as a repair; only a technician's
confirmed action is.

---

## Repository layout (planned — not yet created)

```
.
├── README.md
├── docs/                     # this phase
├── docker-compose.yml        # Phase 1
├── .env.example              # Phase 1
├── infra/                    # Phase 1 — init scripts, seed, backup
├── frontend/                 # Phase 9  — React + Vite
├── backend/                  # Phase 2  — Node + Express (modular monolith)
├── ai-service/               # Phase 3  — Python + FastAPI
└── storage/                  # gitignored — PDFs, OCR output, artifacts
```

## Next step

Review the docs, answer [`docs/OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md) (at minimum the
five **BLOCKING** items), then approve Phase 1. **Phase 1 will not start automatically.**
