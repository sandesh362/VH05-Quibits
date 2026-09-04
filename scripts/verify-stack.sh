#!/usr/bin/env bash
#
# verify-stack.sh - prove the running stack actually works.
#
# Calls every health endpoint and each dependency directly, then prints a
# summary. Run it AFTER starting the services.
#
#   ./scripts/verify-stack.sh

set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

if [ -f .env ]; then set -a; . ./.env 2>/dev/null; set +a; fi

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'
FAILURES=0

API_BASE="http://localhost:${APP_PORT:-8080}${API_PREFIX:-/api/v1}"
RAG_BASE="http://localhost:${RAG_SERVICE_PORT:-8000}${RAG_API_PREFIX:-/internal/v1}"
WEB_URL="http://localhost:${WEB_PORT:-5173}"
QDRANT="${QDRANT_URL:-http://localhost:6333}"
OLLAMA="${OLLAMA_BASE_URL:-http://localhost:11434}"

ok()   { echo "  ${GREEN}✓${RESET} $1"; }
bad()  { echo "  ${RED}✗${RESET} $1"; FAILURES=$((FAILURES + 1)); }
warn() { echo "  ${YELLOW}!${RESET} $1"; }
hint() { echo "    ${DIM}$1${RESET}"; }

# Pretty-print JSON when python is available.
pp() { python3 -m json.tool 2>/dev/null || cat; }

echo "Verifying the stack"
echo "${DIM}API ${API_BASE}${RESET}"

# --------------------------------------------------------------------------
echo
echo "Express API"

if RESPONSE=$(curl -fsS --max-time 10 "${API_BASE}/health" 2>/dev/null); then
  ok "GET /health responded"
  echo "$RESPONSE" | pp | sed 's/^/    /'
else
  bad "GET /health failed - the Express API is not running"
  hint "Start it with: npm run dev:backend"
fi

# /ready returns 503 when a dependency is down, which is correct behaviour,
# so -f would be wrong here. Capture the body and the status separately.
READY_BODY=$(curl -sS --max-time 30 -w '\n%{http_code}' "${API_BASE}/ready" 2>/dev/null)
READY_CODE=$(printf '%s' "$READY_BODY" | tail -n1)
READY_JSON=$(printf '%s' "$READY_BODY" | sed '$d')

if [ "$READY_CODE" = "200" ]; then
  ok "GET /ready → 200 (all required dependencies up)"
elif [ "$READY_CODE" = "503" ]; then
  warn "GET /ready → 503 (a required dependency is down)"
else
  bad "GET /ready → ${READY_CODE:-no response}"
fi

if [ -n "$READY_JSON" ]; then
  echo "$READY_JSON" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)["data"]
except Exception:
    sys.exit(0)
MARKS = {
    "ok": "\033[32m" + chr(10003) + "\033[0m",
    "degraded": "\033[33m!\033[0m",
    "disabled": "\033[2m-\033[0m",
}
for c in data.get("checks", []):
    mark = MARKS.get(c["status"], "\033[31m" + chr(10007) + "\033[0m")
    name = c["name"]
    status = c["status"]
    req = "required" if c.get("required") else "optional"
    line = "    %s %-14s %-9s (%s)" % (mark, name, status, req)
    err = c.get("error")
    if err:
        line += "  " + err[:60]
    print(line)
' 2>/dev/null
fi

if curl -fsS --max-time 10 "${API_BASE}/system/info" >/dev/null 2>&1; then
  ok "GET /system/info responded"
else
  bad "GET /system/info failed"
fi

# The error contract must hold.
NOT_FOUND=$(curl -sS --max-time 10 "${API_BASE}/definitely-not-a-route" 2>/dev/null)
if printf '%s' "$NOT_FOUND" | grep -q '"success": *false' && \
   printf '%s' "$NOT_FOUND" | grep -q 'NOT_FOUND'; then
  ok "Unknown routes return the standard error envelope"
else
  bad "Unknown routes do not return the expected error envelope"
fi

# --------------------------------------------------------------------------
echo
echo "FastAPI RAG service"

if curl -fsS --max-time 10 "${RAG_BASE}/health" >/dev/null 2>&1; then
  ok "GET /health responded"
  if curl -fsS --max-time 20 "${RAG_BASE}/ready" >/dev/null 2>&1; then
    ok "GET /ready responded"
  else
    warn "GET /ready reported not-ready (expected while dependencies are down)"
  fi
  if curl -fsS --max-time 10 "${RAG_BASE}/system/info" >/dev/null 2>&1; then
    ok "GET /system/info responded"
  else
    bad "GET /system/info failed"
  fi
else
  bad "The FastAPI service is not running"
  hint "Start it with: npm run dev:ai"
fi

# --------------------------------------------------------------------------
echo
echo "Dependencies"

if curl -fsS --max-time 5 "${QDRANT}/readyz" >/dev/null 2>&1 || \
   curl -fsS --max-time 5 "${QDRANT}/" >/dev/null 2>&1; then
  ok "Qdrant is reachable at ${QDRANT}"
else
  warn "Qdrant is not reachable at ${QDRANT} (not required for Phase 1)"
  hint "Start it with: docker compose up -d qdrant"
fi

if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' 2>/dev/null | grep -q itp-mongo; then
  if docker exec itp-mongo mongosh --quiet --eval 'db.adminCommand("ping").ok' >/dev/null 2>&1; then
    ok "MongoDB responds to ping"
  else
    bad "The MongoDB container is running but not responding"
  fi
else
  warn "The itp-mongo container is not running (see the /ready output above for the API's view)"
  hint "Start it with: docker compose up -d mongo"
fi

if curl -fsS --max-time 5 "${OLLAMA}/api/tags" >/dev/null 2>&1; then
  ok "Ollama is reachable at ${OLLAMA}"
else
  warn "Ollama is not reachable at ${OLLAMA} (not required for Phase 1)"
fi

# --------------------------------------------------------------------------
echo
echo "Frontend"

if curl -fsS --max-time 10 "${WEB_URL}" >/dev/null 2>&1; then
  ok "The frontend is serving at ${WEB_URL}"
  # In the Docker workflow nginx also proxies the API.
  if curl -fsS --max-time 10 "${WEB_URL}${API_PREFIX:-/api/v1}/health" >/dev/null 2>&1; then
    ok "The frontend proxies ${API_PREFIX:-/api/v1} to the API"
  else
    warn "The frontend is not proxying the API (normal if you opened the built bundle directly)"
  fi
else
  warn "The frontend is not serving at ${WEB_URL}"
  hint "Start it with: npm run dev:frontend"
fi

# --------------------------------------------------------------------------
echo
if [ "$FAILURES" -gt 0 ]; then
  echo "${RED}${FAILURES} check(s) failed.${RESET}"
  echo "${DIM}See docs/TROUBLESHOOTING_LOCAL_SETUP.md${RESET}"
  exit 1
fi

echo "${GREEN}All required checks passed.${RESET}"
