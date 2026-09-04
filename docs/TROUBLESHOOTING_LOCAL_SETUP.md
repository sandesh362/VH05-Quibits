# Troubleshooting Local Setup

Start here:

```bash
./scripts/preflight.sh      # before starting: versions, .env, ports, Ollama
./scripts/verify-stack.sh   # after starting: every endpoint and dependency
```

Between them they diagnose most problems. The rest of this document covers
specific failures.

---

## Startup failures

### `Configuration validation failed` and the service exits

This is intentional. The service refuses to start with invalid configuration
rather than failing confusingly later. Read the printed list — every problem is
reported at once.

Common causes:

| Message | Fix |
|---|---|
| `JWT_SECRET must be at least 32 characters` | `openssl rand -hex 32` and paste the result |
| `JWT_SECRET contains a placeholder value` | You left `change_me_...` in `.env` |
| `JWT_REFRESH_SECRET must differ from JWT_SECRET` | Generate a **second** distinct value |
| `INTERNAL_SERVICE_TOKEN is required` | Generate a third value |
| `MONGODB_URI must not point at MongoDB Atlas` | This project runs fully locally; use the local URI |

### `Error: Cannot find module '@itp/shared'`

The shared types package has not been compiled:

```bash
npm run build:shared
```

Run this after every fresh `npm install` and after editing
`packages/shared/src/`.

### `EADDRINUSE: address already in use :::8080`

Something already holds the port.

```bash
# Find it
lsof -iTCP:8080 -sTCP:LISTEN     # macOS / Linux
netstat -ano | findstr :8080     # Windows

# Then either kill it, or change the port in .env:
APP_PORT=8081
```

The same applies to 8000 (FastAPI), 5173 (frontend), 27017 (Mongo), 6333 (Qdrant).

### `ModuleNotFoundError: No module named 'fastapi'`

The virtual environment is not active, or dependencies were installed globally.

```bash
cd ai-service
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r requirements-dev.txt
```

`npm run dev:ai` calls `.venv`'s interpreter directly, so it works without
activation — provided the venv exists.

### The FastAPI service exits immediately with no message

Its config validation writes to stderr and exits `1`. Run it in the foreground to
see why:

```bash
cd ai-service && .venv/bin/python -m uvicorn app.main:app --port 8000
```

---

## Connection problems

### The frontend shows "Cannot reach the API"

Work outward from the API:

```bash
# 1. Is Express even up?
curl http://localhost:8080/api/v1/health

# 2. Is the Vite proxy forwarding?
curl http://localhost:5173/api/v1/health
```

- **Step 1 fails** → the backend is not running. `npm run dev:backend`.
- **Step 1 works, step 2 fails** → the proxy target is wrong. Check
  `VITE_DEV_PROXY_TARGET` in `.env` and restart Vite; `vite.config.ts` is read
  only at startup.
- **Both work but the browser fails** → hard-reload (Ctrl/Cmd+Shift+R) to clear a
  cached bundle.

### `Blocked request. This host is not allowed`

Vite's dev server rejects unknown `Host` headers. You are reaching it through a
hostname other than localhost (a container, a tunnel, a remote machine).

Add the hostname to `.env`:

```ini
VITE_ALLOWED_HOSTS=my-host.example.com
# or, to disable the check entirely in a trusted local environment:
VITE_ALLOWED_HOSTS=true
```

Restart the dev server. This affects the **dev server only** — nginx serves
production and ignores it.

### The status page shows MongoDB `down` with `ECONNREFUSED`

Mongo is not running or not reachable.

```bash
docker compose ps                    # is itp-mongo up and (healthy)?
docker compose up -d mongo           # start it
docker compose logs mongo            # if it keeps restarting
```

Note the API takes ~8 seconds to report this, which is
`MONGO_CONNECT_TIMEOUT_MS` elapsing. That is the connection timeout, not a hang.

### MongoDB `Authentication failed`

`MONGODB_URI` and `MONGO_ROOT_PASSWORD` disagree, or the volume was initialised
with a different password.

**The root user is created only on the first start of an empty volume.** Changing
`MONGO_ROOT_PASSWORD` later has no effect on an existing volume.

```bash
# Confirm both values match, including authSource=admin:
grep -E 'MONGO_ROOT_PASSWORD|MONGODB_URI' .env

# If you changed the password, reset the volume (DESTROYS DATA):
docker compose down
docker volume rm itp_mongo_data
docker compose up -d mongo
```

### Qdrant shows `down` but the container is running

```bash
curl http://localhost:6333/readyz
docker compose logs qdrant
```

If `curl` works from the host but the API cannot reach it, the URL is wrong for
the context: containers must use `http://qdrant:6333`, host processes
`http://localhost:6333`. Compose sets the container value for you.

### Ollama shows `down`

```bash
curl http://localhost:11434/api/tags
```

- Empty reply → Ollama is not running. Start it with `ollama serve`
  (Linux: `sudo systemctl start ollama`).
- Works from the host but containers report it down → containers cannot use
  `localhost`. Confirm `OLLAMA_BASE_URL_DOCKER=http://host.docker.internal:11434`
  and, on Linux, that Docker is 20.10+ so `host-gateway` resolves.

This is **not an error in Phase 1** — nothing calls Ollama yet.

### Ollama shows `degraded` — "model not installed"

Ollama is running, but `OLLAMA_CHAT_MODEL` names a model you have not pulled.
This is an honest report, not a bug.

```bash
ollama list                    # what you actually have
ollama pull llama3.1:8b        # get the one you configured
```

Or clear `OLLAMA_CHAT_MODEL` in `.env` until you reach Phase 5.

---

## Docker problems

### `docker compose` says `no configuration file provided`

Run it from the repository root, where `docker-compose.yml` lives.

### `docker-compose: command not found`

You need Compose **v2**, invoked as `docker compose` (a space, not a hyphen). It
ships with Docker Desktop and as the `docker-compose-plugin` package on Linux.

### A container is stuck `unhealthy` or restarting

```bash
docker compose ps
docker compose logs --tail=50 <service>
docker inspect --format='{{json .State.Health}}' itp-mongo | python3 -m json.tool
```

Mongo needs ~20 s on first start to initialise; its healthcheck has a matching
`start_period`, so allow that before treating it as broken.

### `The api container cannot reach mongo`

Inside the Compose network, use **service names**, never `localhost`. Compose
already sets `MONGODB_URI` to `mongodb://...@mongo:27017/...`. Do not override it
with a `localhost` URI in `.env` — `.env` values are used for the manual
workflow, and the compose file supplies container-appropriate ones.

Confirm both containers share the network:

```bash
docker network inspect itp-net
```

### The build fails with `npm ci` errors

Usually a stale or missing lockfile:

```bash
npm install          # regenerate package-lock.json
docker compose build --no-cache api
```

### The build is extremely slow or the context is huge

Check that `.dockerignore` is present at the repository root. Without it, Docker
uploads `node_modules`, `.venv`, and `storage/` into the build context.

---

## Test failures

### Backend tests fail with a Mongo connection error

They should not — the suite is written to run without Mongo, and asserts that
readiness honestly reports it as down. If you see a real connection error rather
than an assertion failure, a test is reaching a database it should be mocking.

### `pytest` reports `DID NOT RAISE`

A config test is picking up a variable that `conftest.py` exported for the app
fixture. Use `monkeypatch.delenv(...)` to isolate the variable under test — see
`test_rejects_missing_token` for the pattern.

### Frontend tests fail with `Cannot find module '@itp/shared'`

```bash
npm run build:shared
```

### Type errors mentioning two different `vite` versions

Two copies of Vite are installed (usually a root copy plus a nested one). This
repo pins Vite 5 to match vitest 2:

```bash
rm -rf frontend/node_modules node_modules package-lock.json
npm install
```

---

## Data management

### Inspect the database

```bash
docker exec -it itp-mongo mongosh -u itp_root -p --authenticationDatabase admin
```

```javascript
show dbs
use itp
show collections      // empty in Phase 1 - expected
db.stats()
```

### Inspect Qdrant

```bash
curl http://localhost:6333/collections | python3 -m json.tool   # empty in Phase 1
```

Dashboard: <http://localhost:6333/dashboard>

### Stop without losing data

```bash
docker compose down          # volumes are preserved
```

### Reset everything intentionally

```bash
./scripts/reset-data.sh      # guarded: you must type DELETE
docker compose down -v       # same effect, no prompt
```

### Back up first

```bash
./scripts/backup-data.sh
```

---

## Platform-specific

### Windows: `bad interpreter: /bin/bash^M`

Git converted the scripts to CRLF line endings.

```bash
dos2unix scripts/*.sh
git config --global core.autocrlf input
```

### Windows: hot reload does not fire

The repo is on `/mnt/c/`. Move it into the WSL2 filesystem (`~/projects/...`);
file-change events do not cross the Windows/Linux boundary reliably.

### Linux: `permission denied` writing to `storage/`

Containers run as a non-root user. Fix ownership on the host:

```bash
sudo chown -R $USER:$USER storage/
```

### Linux: `Cannot connect to the Docker daemon`

```bash
sudo systemctl start docker
sudo usermod -aG docker $USER && newgrp docker    # avoid needing sudo
```

### macOS: containers cannot reach Ollama

`host.docker.internal` works out of the box on Docker Desktop. Verify Ollama is
listening on all interfaces rather than only loopback:

```bash
OLLAMA_HOST=0.0.0.0 ollama serve
```

---

## Getting more detail

Raise the log level and restart:

```ini
LOG_LEVEL=debug
```

Then follow the logs:

```bash
docker compose logs -f api rag-service    # Docker
# or read the terminal output in the manual workflow
```

Every log line carries a `requestId`. Grep for one to trace a single request
across both services:

```bash
docker compose logs | grep req_b563b649-3291-4957-b067-b60fdc6165c8
```

If a response looks wrong, the `requestId` in the error body is the same one in
the logs.
