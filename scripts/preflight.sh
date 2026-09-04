#!/usr/bin/env bash
#
# preflight.sh - check this machine can run the platform BEFORE you start it.
#
# Verifies tool versions, the .env file, port availability and Ollama.
# Exits non-zero if something is genuinely blocking.
#
#   ./scripts/preflight.sh

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'
FAILURES=0
WARNINGS=0

ok()   { echo "  ${GREEN}✓${RESET} $1"; }
warn() { echo "  ${YELLOW}!${RESET} $1"; WARNINGS=$((WARNINGS + 1)); }
bad()  { echo "  ${RED}✗${RESET} $1"; FAILURES=$((FAILURES + 1)); }
hint() { echo "    ${DIM}$1${RESET}"; }

section() { echo; echo "$1"; }

# --------------------------------------------------------------------------
section "Required tooling"

if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -v | sed 's/v\([0-9]*\).*/\1/')
  if [ "$NODE_MAJOR" -ge 20 ]; then
    ok "Node $(node -v)"
  else
    bad "Node $(node -v) is too old; v20 or newer is required"
    hint "Install from https://nodejs.org or use nvm: nvm install 20"
  fi
else
  bad "Node is not installed"
  hint "Install Node 20+ from https://nodejs.org"
fi

if command -v npm >/dev/null 2>&1; then
  ok "npm $(npm -v)"
else
  bad "npm is not installed"
fi

# Python: prefer python3, accept python.
PYTHON_BIN=""
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1; then PYTHON_BIN="$candidate"; break; fi
done

if [ -n "$PYTHON_BIN" ]; then
  PY_VERSION=$("$PYTHON_BIN" -c 'import sys; print("%d.%d" % sys.version_info[:2])')
  PY_OK=$("$PYTHON_BIN" -c 'import sys; print(1 if sys.version_info[:2] >= (3, 11) else 0)')
  if [ "$PY_OK" = "1" ]; then
    ok "Python $PY_VERSION"
  else
    bad "Python $PY_VERSION is too old; 3.11 or newer is required"
  fi
else
  bad "Python is not installed"
  hint "Install Python 3.11+ from https://python.org"
fi

# --------------------------------------------------------------------------
section "Docker (optional - only needed for the container workflow)"

if command -v docker >/dev/null 2>&1; then
  ok "docker $(docker --version | sed 's/Docker version //;s/,.*//')"
  if docker compose version >/dev/null 2>&1; then
    ok "docker compose $(docker compose version --short 2>/dev/null)"
  else
    warn "The 'docker compose' plugin was not found (legacy docker-compose is not supported)"
  fi
  if docker info >/dev/null 2>&1; then
    ok "Docker daemon is running"
  else
    warn "Docker is installed but the daemon is not running"
    hint "Start Docker Desktop, or: sudo systemctl start docker"
  fi
else
  warn "Docker is not installed - you can still run everything manually"
fi

# --------------------------------------------------------------------------
section "Configuration"

if [ -f .env ]; then
  ok ".env exists"

  # shellcheck disable=SC1091
  set -a; . ./.env 2>/dev/null; set +a

  for var in JWT_SECRET JWT_REFRESH_SECRET INTERNAL_SERVICE_TOKEN; do
    value="${!var:-}"
    if [ -z "$value" ]; then
      bad "$var is not set"
    elif [ "${#value}" -lt 32 ]; then
      bad "$var is shorter than the required 32 characters"
      hint "Generate one with: openssl rand -hex 32"
    elif printf '%s' "$value" | grep -qiE 'change_me|changeme|placeholder|your_|secret_here|xxx'; then
      bad "$var still contains a placeholder value"
      hint "Generate one with: openssl rand -hex 32"
    else
      ok "$var is set"
    fi
  done

  if [ -n "${JWT_SECRET:-}" ] && [ "${JWT_SECRET:-}" = "${JWT_REFRESH_SECRET:-}" ]; then
    bad "JWT_SECRET and JWT_REFRESH_SECRET must be different"
  fi

  if printf '%s' "${MONGODB_URI:-}" | grep -q 'mongodb+srv\|mongodb.net'; then
    bad "MONGODB_URI points at MongoDB Atlas; this project must run fully locally"
  fi
else
  bad ".env is missing"
  hint "Create it with: cp .env.example .env"
  hint "Then fill in the secrets: openssl rand -hex 32"
fi

# --------------------------------------------------------------------------
section "Port availability"

port_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -iTCP:"$1" -sTCP:LISTEN -n -P >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN
  else
    return 1
  fi
}

check_port() {
  if port_in_use "$1"; then
    warn "Port $1 ($2) is already in use"
    hint "Stop the other process, or change the port in .env"
  else
    ok "Port $1 ($2) is free"
  fi
}

check_port "${APP_PORT:-8080}" "Express API"
check_port "${RAG_SERVICE_PORT:-8000}" "FastAPI"
check_port "${WEB_PORT:-5173}" "frontend"
check_port "${MONGO_PORT:-27017}" "MongoDB"
check_port "${QDRANT_PORT:-6333}" "Qdrant"

# --------------------------------------------------------------------------
section "Ollama (host install)"

OLLAMA_URL="${OLLAMA_BASE_URL:-http://localhost:11434}"

if curl -fsS --max-time 3 "${OLLAMA_URL}/api/tags" >/dev/null 2>&1; then
  ok "Ollama is responding at ${OLLAMA_URL}"

  TAGS=$(curl -fsS --max-time 3 "${OLLAMA_URL}/api/tags" 2>/dev/null)

  if [ -n "${OLLAMA_CHAT_MODEL:-}" ]; then
    if printf '%s' "$TAGS" | grep -q "\"${OLLAMA_CHAT_MODEL%%:*}"; then
      ok "Chat model '${OLLAMA_CHAT_MODEL}' is installed"
    else
      warn "Chat model '${OLLAMA_CHAT_MODEL}' is NOT installed"
      hint "Pull it with: ollama pull ${OLLAMA_CHAT_MODEL}"
    fi
  else
    warn "OLLAMA_CHAT_MODEL is not set (fine for Phase 1; needed from Phase 5)"
  fi

  EMBED_MODEL="${OLLAMA_EMBEDDING_MODEL:-nomic-embed-text}"
  if printf '%s' "$TAGS" | grep -q "\"${EMBED_MODEL%%:*}"; then
    ok "Embedding model '${EMBED_MODEL}' is installed"
  else
    warn "Embedding model '${EMBED_MODEL}' is NOT installed (needed from Phase 4)"
    hint "Pull it with: ollama pull ${EMBED_MODEL}"
  fi
else
  warn "Ollama is not reachable at ${OLLAMA_URL} (not required for Phase 1)"
  hint "Install from https://ollama.com/download, then run: ollama serve"
fi

# --------------------------------------------------------------------------
echo
if [ "$FAILURES" -gt 0 ]; then
  echo "${RED}Preflight failed: ${FAILURES} blocking issue(s), ${WARNINGS} warning(s).${RESET}"
  exit 1
fi

if [ "$WARNINGS" -gt 0 ]; then
  echo "${YELLOW}Preflight passed with ${WARNINGS} warning(s).${RESET}"
  echo "${DIM}Warnings are safe to ignore for Phase 1.${RESET}"
  exit 0
fi

echo "${GREEN}Preflight passed. You are ready to start the stack.${RESET}"
