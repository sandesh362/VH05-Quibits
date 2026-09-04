# Local Setup Guide

Everything runs on your machine. No cloud account, API key, or internet-hosted AI
service is required or used.

There are **two ways to run the stack**. Pick one:

| | **Manual** (recommended for development) | **Docker Compose** (recommended for the demo) |
|---|---|---|
| What runs where | Node and Python on your host; Mongo + Qdrant in Docker | Everything in containers except Ollama |
| Hot reload | Yes | No (rebuild required) |
| Needs Docker | Only for Mongo and Qdrant | Yes, for everything |
| Start command | `npm run dev` | `docker compose up -d` |

---

## 1. Required software

| Software | Minimum version | Check with | Where to get it |
|---|---|---|---|
| Node.js | 20.0 | `node -v` | <https://nodejs.org> (or `nvm install 20`) |
| npm | 10.0 | `npm -v` | ships with Node |
| Python | 3.11 | `python3 --version` | <https://python.org> |
| Docker Engine | 24.0 | `docker --version` | <https://docs.docker.com/get-docker/> |
| Docker Compose | v2 (plugin) | `docker compose version` | ships with Docker Desktop |
| Ollama | 0.1.30 | `ollama --version` | <https://ollama.com/download> |
| git | any | `git --version` | <https://git-scm.com> |

> **Node 20 is a hard requirement.** The backend uses the built-in `fetch` and
> `AbortSignal.timeout`, which are not available in Node 16 or 18 without flags.

> **Compose v2 only.** Use `docker compose` (a space), not the legacy
> `docker-compose` binary. The file uses v2 syntax such as
> `depends_on.condition`.

Verify everything at once:

```bash
./scripts/preflight.sh
```

This checks versions, your `.env`, port availability, and Ollama, then tells you
exactly what to fix. It exits non-zero only on genuinely blocking problems.

---

## 2. Get the code and install dependencies

```bash
git clone <your-repo-url> industrial-troubleshooting-platform
cd industrial-troubleshooting-platform
```

### Node dependencies (root, backend, frontend, shared)

This is an npm workspaces monorepo — **one install at the root** covers all three
Node packages:

```bash
npm install
```

Then build the shared types package. The backend and frontend both import it, so
this must happen before either can typecheck or build:

```bash
npm run build:shared
```

### Python dependencies (FastAPI service)

Always use a virtual environment so these packages don't collide with your system
Python:

```bash
cd ai-service
python3 -m venv .venv

# Activate it:
source .venv/bin/activate          # macOS / Linux
# .venv\Scripts\activate           # Windows PowerShell

pip install --upgrade pip
pip install -r requirements-dev.txt   # runtime + test/lint tools
cd ..
```

> `requirements.txt` holds runtime dependencies only (what the Docker image
> installs). `requirements-dev.txt` includes it and adds pytest and ruff.

---

## 3. Configure environment variables

```bash
cp .env.example .env
```

`.env` is git-ignored and must never be committed. `.env.example` is the
documented template — every variable is listed there with whether it is required
and what its default is.

### Generate the three required secrets

The services **refuse to start** with placeholder secrets. This is deliberate: a
weak default secret that silently works is how demo credentials reach production.

```bash
# Run this three times and paste each result into .env
openssl rand -hex 32
```

```ini
JWT_SECRET=<first generated value>
JWT_REFRESH_SECRET=<second, must differ from JWT_SECRET>
INTERNAL_SERVICE_TOKEN=<third>
```

No Windows `openssl`? Use:

```powershell
python -c "import secrets; print(secrets.token_hex(32))"
```

### Set the database password

```ini
MONGO_ROOT_USERNAME=itp_root
MONGO_ROOT_PASSWORD=<choose a local password>
MONGODB_URI=mongodb://itp_root:<same password>@localhost:27017/itp?authSource=admin
```

> The password appears twice — in `MONGO_ROOT_PASSWORD` (which initialises the
> container) and inside `MONGODB_URI` (which the app connects with). They must
> match. In the Docker workflow, Compose builds the URI for you from the two
> `MONGO_*` variables, so only those need to be right.

### Everything else has a working default

You can leave the rest of `.env` untouched for Phase 1. The variables that matter
most:

| Variable | Default | Meaning |
|---|---|---|
| `APP_PORT` | `8080` | Express API port |
| `RAG_SERVICE_PORT` | `8000` | FastAPI port |
| `WEB_PORT` | `5173` | Frontend port |
| `OLLAMA_CHAT_MODEL` | *(empty)* | Intentionally blank — see §4 |
| `LOG_LEVEL` | `info` | Set to `debug` for verbose logs |

---

## 4. Install and verify Ollama

Ollama runs **on your host**, not in Docker. GPU passthrough in containers is
platform-specific and fragile; a host install is faster and is what a judge will
already have.

### Install

| OS | Command |
|---|---|
| macOS | `brew install ollama` or download from <https://ollama.com/download> |
| Linux | `curl -fsSL https://ollama.com/install.sh \| sh` |
| Windows | Download the installer from <https://ollama.com/download> |

### Start the server

```bash
ollama serve
```

On macOS and Windows the desktop app starts this automatically. On Linux with
systemd: `sudo systemctl enable --now ollama`.

### Verify it responds

```bash
curl http://localhost:11434/api/tags
```

A JSON object (even with an empty `models` array) means Ollama is running.

### Pull models

**Phase 1 does not require any model.** Nothing calls Ollama yet. Pull these when
you reach the phases that need them:

```bash
# Embeddings - needed from Phase 4  (~275 MB)
ollama pull nomic-embed-text

# Chat model - needed from Phase 5. Pick one that fits your hardware:
ollama pull llama3.1:8b       # ~4.7 GB, needs ~8 GB RAM
ollama pull qwen2.5:7b        # ~4.7 GB, good instruction following
ollama pull phi3.5            # ~2.2 GB, for constrained machines
```

Then record your choice in `.env`:

```ini
OLLAMA_CHAT_MODEL=llama3.1:8b
```

> **`OLLAMA_CHAT_MODEL` is empty by default on purpose.** The platform must never
> pretend a model exists. While it is blank, the status page reports Ollama as
> *not configured* rather than claiming success. Test a model directly with:
>
> ```bash
> ollama run llama3.1:8b "Reply with the single word: ready"
> ```

---

## 5. Start the databases

Both workflows need Mongo and Qdrant. Start just those two:

```bash
docker compose up -d mongo qdrant
```

Confirm both are healthy (this can take ~20 seconds on first run):

```bash
docker compose ps
```

Look for `(healthy)` in the STATUS column.

---

## 6a. Run manually (development workflow)

From the repository root, start all three services at once:

```bash
npm run dev
```

This runs the Express API, the FastAPI service, and the Vite dev server together
with colour-coded, prefixed logs. Or start them in separate terminals:

```bash
npm run dev:backend     # Express on :8080
npm run dev:ai          # FastAPI on :8000
npm run dev:frontend    # Vite on :5173
```

> `npm run dev:ai` calls the interpreter in `ai-service/.venv`, so you do **not**
> need to activate the venv first.

Open <http://localhost:5173>.

---

## 6b. Run with Docker Compose (demo workflow)

```bash
docker compose up -d --build
```

First build takes several minutes. Afterwards:

```bash
docker compose ps          # all five services, health status
docker compose logs -f api # follow one service
```

Open <http://localhost:5173>. In this mode nginx serves the frontend **and**
proxies `/api` to the Express container, so the whole demo lives on one URL.

### Startup order

Compose handles ordering via `depends_on` + healthchecks:

```
mongo (healthy) ─┐
                 ├──> api ──> web
qdrant (started)─┴──> rag-service
```

The API waits for Mongo to pass its healthcheck. Qdrant only needs to have
started, since Phase 1 never queries it.

---

## 7. Verify every service

Run the automated check:

```bash
./scripts/verify-stack.sh
```

Or check each one by hand:

### Express API

```bash
curl http://localhost:8080/api/v1/health   | python3 -m json.tool
curl http://localhost:8080/api/v1/ready    | python3 -m json.tool
curl http://localhost:8080/api/v1/system/info | python3 -m json.tool
```

`/health` returns 200 whenever the process is alive. `/ready` returns **200** only
when every required dependency is up, and **503** otherwise — that 503 is correct
behaviour, not a bug.

### FastAPI service

```bash
curl http://localhost:8000/internal/v1/health | python3 -m json.tool
curl http://localhost:8000/internal/v1/ready  | python3 -m json.tool
```

Interactive API docs (development only): <http://localhost:8000/docs>

### MongoDB

```bash
docker exec -it itp-mongo mongosh -u itp_root -p --authenticationDatabase admin
```

```javascript
db.adminCommand("ping")   // { ok: 1 }
show dbs
```

Phase 1 creates no collections, so `itp` may not appear until data is written.
That is expected.

### Qdrant

```bash
curl http://localhost:6333/readyz              # readiness
curl http://localhost:6333/collections | python3 -m json.tool
```

The collections list is **empty** in Phase 1. No collection is created, because
the embedding dimension cannot be known until a model is chosen and measured.

Qdrant also has a web dashboard: <http://localhost:6333/dashboard>

### Ollama

```bash
curl http://localhost:11434/api/tags | python3 -m json.tool
```

### Frontend

Open <http://localhost:5173>. The home page shows a green **Connected** badge if
it reached the API. The **Service status** page lists every dependency with its
real probe result.

---

## 8. Run the tests

```bash
npm test                                   # backend + frontend
npm run test --workspace @itp/backend      # backend only  (42 tests)
npm run test --workspace @itp/frontend     # frontend only (15 tests)

cd ai-service && .venv/bin/pytest           # FastAPI only  (47 tests)
```

Lint and typecheck:

```bash
npm run typecheck
cd ai-service && .venv/bin/ruff check .
```

---

## 9. Stopping, resetting, and backing up

### Stop, keeping all data

```bash
docker compose down
```

Named volumes survive. Your database is still there when you `up` again.

### Stop and delete all data (intentional reset)

```bash
docker compose down -v
```

The `-v` flag removes the named volumes. **This is irreversible.**

Or use the guarded script, which requires you to type `DELETE`:

```bash
./scripts/reset-data.sh              # everything
./scripts/reset-data.sh --mongo-only # just the database
```

### Back up before something risky

```bash
./scripts/backup-data.sh
```

Writes a timestamped folder under `./backups/` with a Mongo dump, a Qdrant
archive, uploaded files, and restore instructions.

---

## 10. OS-specific notes

### macOS

- Apple Silicon: all images used (`mongo:7`, `qdrant`, `node:20-alpine`,
  `python:3.11-slim`, `nginx:alpine`) publish arm64 builds. No emulation needed.
- Ollama uses the GPU automatically via Metal.
- `host.docker.internal` already resolves inside containers.
- If port 5000 conflicts appear elsewhere, note AirPlay Receiver holds it;
  this project does not use 5000.

### Linux

- `host.docker.internal` does **not** exist natively. The compose file maps it via
  `extra_hosts: host.docker.internal:host-gateway`, which needs Docker 20.10+.
- To avoid `sudo docker`, add yourself to the docker group and re-login:
  ```bash
  sudo usermod -aG docker $USER && newgrp docker
  ```
- Ollama as a service: `sudo systemctl enable --now ollama`.
- NVIDIA GPU: install `nvidia-container-toolkit` only if you later containerise
  Ollama. Host Ollama picks up CUDA on its own.
- Files created inside containers are owned by the container user. Both app
  images run as a non-root user (uid 1000 / 1001) to keep `storage/` writable.

### Windows

- **Use WSL2.** Clone the repo *inside* the WSL filesystem (`~/projects/...`),
  not under `/mnt/c/`. Filesystem watching across the Windows/Linux boundary is
  slow and breaks hot reload.
- Enable Docker Desktop's WSL2 integration for your distro.
- Line endings: the shell scripts require LF. Prevent Git from rewriting them:
  ```bash
  git config --global core.autocrlf input
  ```
  If a script fails with `bad interpreter: /bin/bash^M`, fix it with
  `dos2unix scripts/*.sh`.
- Ollama installs as a Windows application and listens on `localhost:11434`,
  reachable from WSL2 and from containers via `host.docker.internal`.
- Use PowerShell or WSL, not `cmd.exe`, for the `openssl`/`python` one-liners.

---

## 11. What is *not* set up yet

Phase 1 builds the foundation only. These deliberately do not exist:

- No collections in MongoDB and no schema
- No collections in Qdrant and no embedding dimension chosen
- No authentication, no users, no login
- No file upload, no PDF processing, no OCR
- No embeddings, no vector search, no RAG, no chat

The **Implementation status** table on the home page reflects this, reading its
values from the backend rather than a hardcoded list.

---

Stuck? See [TROUBLESHOOTING_LOCAL_SETUP.md](./TROUBLESHOOTING_LOCAL_SETUP.md).
