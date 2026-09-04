# Industrial Troubleshooting & Maintenance Intelligence Platform

**Working name:** `machine-mind` (placeholder — rename freely)

A fully local, grounded troubleshooting assistant for industrial maintenance technicians.
It combines **machine manuals**, **machine context**, **past incidents**, and **maintenance
history** into a retrieval-augmented answer that always says *where every claim came from* —
and refuses to answer when it cannot.

> **Status: Phase 1 — Infrastructure Foundation complete.**
> All three services start, report real dependency health, and are covered by tests.
> **No product feature is implemented yet** — no auth, no upload, no PDF processing, no
> embeddings, no RAG, no chat. Do not assume a feature exists; the home page reads its
> capability table live from the backend, and every flag is `false`.

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

## Quick start

Requires **Node 20+**, **Python 3.11+**, and **Docker** (with Compose v2).

```bash
# 1. Install dependencies
npm install
npm run build:shared

cd ai-service && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt && cd ..

# 2. Configure - then generate three secrets with: openssl rand -hex 32
cp .env.example .env

# 3. Check your machine is ready
./scripts/preflight.sh

# 4. Start the databases, then the services
docker compose up -d mongo qdrant
npm run dev

# 5. Verify
./scripts/verify-stack.sh
```

Open <http://localhost:5173>.

Or run everything in containers:

```bash
docker compose up -d --build
```

Full instructions, including Ollama setup and OS-specific notes:
[`docs/LOCAL_SETUP.md`](docs/LOCAL_SETUP.md).

---

## What works today

| Capability | Status |
|---|---|
| Three services start cleanly | ✅ |
| Frontend calls the backend and renders live data | ✅ |
| Real dependency probes (Mongo, Qdrant, FastAPI, Ollama) | ✅ |
| Health + readiness + system-info on both services | ✅ |
| Structured logging with request correlation IDs | ✅ |
| Config validation that refuses placeholder secrets | ✅ |
| Docker Compose stack with healthchecks and named volumes | ✅ |
| 104 automated tests | ✅ |
| Anything AI-related | ❌ Phase 3+ |

The **Service status** page shows the true state of every dependency, including
failures — nothing is hardcoded to "healthy".

---

## Repository layout

```
.
├── README.md
├── docker-compose.yml         # mongo, qdrant, api, rag-service, web
├── .env.example               # every variable, documented
├── .dockerignore
├── package.json               # npm workspaces root
│
├── frontend/                  # React 18 + Vite + TypeScript
│   ├── index.html
│   ├── vite.config.ts         # dev proxy: /api -> Express
│   └── src/
│       ├── main.tsx           # entry point
│       ├── App.tsx            # routes
│       ├── layouts/           # app shell
│       ├── pages/             # home, service status, 404
│       ├── components/        # states, error boundary, status badge
│       ├── lib/               # api-client, useApi hook
│       └── styles/
│
├── backend/                   # Express + TypeScript
│   ├── src/
│   │   ├── server.ts          # startup + graceful shutdown
│   │   ├── app.ts             # middleware chain
│   │   ├── config/            # zod-validated env
│   │   ├── core/              # logger, ApiError
│   │   ├── middleware/        # request context, logging, errors
│   │   ├── db/                # mongo connection
│   │   ├── clients/           # real dependency probes
│   │   └── modules/           # health, system  (features go here)
│   └── tests/                 # 42 tests
│
├── ai-service/                # FastAPI + Python 3.11
│   ├── requirements.txt
│   ├── app/
│   │   ├── main.py            # app factory, exception handlers
│   │   ├── core/              # config, logging, errors, middleware
│   │   ├── clients/           # real dependency probes
│   │   ├── routers/           # health, ready, system/info
│   │   └── rag/               # EMPTY - Phase 3+
│   └── tests/                 # 47 tests
│
├── packages/shared/           # @itp/shared - types shared by TS services
├── infrastructure/docker/     # Dockerfiles + nginx.conf
├── scripts/                   # preflight, verify-stack, reset-data, backup
├── storage/                   # gitignored - uploads and artifacts
└── docs/                      # architecture and setup documentation
```

---

## Common commands

| Command | What it does |
|---|---|
| `npm run dev` | Start all three services with hot reload |
| `npm run dev:backend` | Express only |
| `npm run dev:frontend` | Vite only |
| `npm run dev:ai` | FastAPI only |
| `npm test` | Backend + frontend tests |
| `cd ai-service && .venv/bin/pytest` | Python tests |
| `npm run typecheck` | TypeScript across all workspaces |
| `docker compose up -d` | Start the container stack |
| `docker compose down` | Stop, **keeping** data |
| `docker compose down -v` | Stop and **delete** data |
| `./scripts/preflight.sh` | Check the machine before starting |
| `./scripts/verify-stack.sh` | Check the running stack |
| `./scripts/backup-data.sh` | Snapshot Mongo, Qdrant, and files |
| `./scripts/reset-data.sh` | Guarded destructive reset |

---

## Phase 1 documentation

| Document | Contents |
|---|---|
| [`docs/LOCAL_SETUP.md`](docs/LOCAL_SETUP.md) | Install, configure, run, verify, OS notes |
| [`docs/ARCHITECTURE_OVERVIEW.md`](docs/ARCHITECTURE_OVERVIEW.md) | What was actually built and why |
| [`docs/SERVICE_CONTRACTS.md`](docs/SERVICE_CONTRACTS.md) | Every endpoint with real responses |
| [`docs/TROUBLESHOOTING_LOCAL_SETUP.md`](docs/TROUBLESHOOTING_LOCAL_SETUP.md) | Symptom-to-fix guide |

---

## Next step

Phase 1 is complete and awaiting review. **Phase 2 (authentication and the data
layer) will not start without explicit approval.**
