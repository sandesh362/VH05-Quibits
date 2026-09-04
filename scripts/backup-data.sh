#!/usr/bin/env bash
#
# backup-data.sh - snapshot MongoDB, Qdrant and uploaded files.
#
# Writes a timestamped folder under ./backups. Intended for taking a safety
# copy before a risky change or a demo.
#
#   ./scripts/backup-data.sh
#   ./scripts/backup-data.sh --output /path/to/dir

set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'

if [ -f .env ]; then set -a; . ./.env 2>/dev/null; set +a; fi

OUTPUT_ROOT="backups"
if [ "${1:-}" = "--output" ] && [ -n "${2:-}" ]; then OUTPUT_ROOT="$2"; fi

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
DEST="${OUTPUT_ROOT}/${TIMESTAMP}"
mkdir -p "$DEST"

echo "Backing up to ${DEST}"
echo

if ! command -v docker >/dev/null 2>&1; then
  echo "${YELLOW}Docker is not available; only local files will be backed up.${RESET}"
else
  # ----- MongoDB -----------------------------------------------------------
  if docker ps --format '{{.Names}}' | grep -q itp-mongo; then
    echo "${DIM}Dumping MongoDB...${RESET}"
    docker exec itp-mongo mongodump \
      --username "${MONGO_ROOT_USERNAME:-}" \
      --password "${MONGO_ROOT_PASSWORD:-}" \
      --authenticationDatabase admin \
      --db "${MONGO_DB_NAME:-itp}" \
      --archive="/tmp/mongo-${TIMESTAMP}.archive" --gzip >/dev/null 2>&1

    docker cp "itp-mongo:/tmp/mongo-${TIMESTAMP}.archive" "${DEST}/mongo.archive.gz" >/dev/null
    docker exec itp-mongo rm -f "/tmp/mongo-${TIMESTAMP}.archive" >/dev/null 2>&1 || true
    echo "  ${GREEN}✓${RESET} mongo.archive.gz"
  else
    echo "  ${YELLOW}!${RESET} the itp-mongo container is not running; skipped"
  fi

  # ----- Qdrant ------------------------------------------------------------
  # Copy the storage directory wholesale; Phase 1 has no collections yet, but
  # this keeps the script correct for later phases.
  if docker volume inspect itp_qdrant_data >/dev/null 2>&1; then
    echo "${DIM}Archiving Qdrant storage...${RESET}"
    docker run --rm \
      -v itp_qdrant_data:/source:ro \
      -v "$(pwd)/${DEST}":/backup \
      alpine tar czf /backup/qdrant-storage.tar.gz -C /source . 2>/dev/null
    echo "  ${GREEN}✓${RESET} qdrant-storage.tar.gz"
  else
    echo "  ${YELLOW}!${RESET} the Qdrant volume does not exist; skipped"
  fi
fi

# ----- Uploaded files ------------------------------------------------------
if [ -d storage ] && [ -n "$(find storage -type f ! -name '.gitkeep' 2>/dev/null | head -1)" ]; then
  echo "${DIM}Archiving uploaded files...${RESET}"
  tar czf "${DEST}/storage.tar.gz" storage 2>/dev/null
  echo "  ${GREEN}✓${RESET} storage.tar.gz"
else
  echo "  ${DIM}-${RESET} no uploaded files to archive"
fi

# ----- Manifest ------------------------------------------------------------
# Never record credentials in the manifest.
cat > "${DEST}/manifest.txt" <<EOF
Industrial Troubleshooting Platform - backup
Created:  $(date -u +"%Y-%m-%dT%H:%M:%SZ")
Host:     $(uname -s) $(uname -m)
Database: ${MONGO_DB_NAME:-itp}
Phase:    Phase 1 - Infrastructure Foundation

Restore MongoDB:
  docker exec -i itp-mongo mongorestore --username <user> --password <pass> \\
    --authenticationDatabase admin --archive --gzip < mongo.archive.gz

Restore Qdrant (stop the container first):
  docker run --rm -v itp_qdrant_data:/target -v "\$(pwd)":/backup alpine \\
    sh -c "rm -rf /target/* && tar xzf /backup/qdrant-storage.tar.gz -C /target"

Restore files:
  tar xzf storage.tar.gz -C /path/to/repo
EOF

echo
echo "${GREEN}Backup complete:${RESET} ${DEST}"
du -sh "$DEST" 2>/dev/null | sed 's/^/  /'
