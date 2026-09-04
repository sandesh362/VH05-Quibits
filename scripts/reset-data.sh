#!/usr/bin/env bash
#
# reset-data.sh - DESTRUCTIVE. Delete all local data and start clean.
#
# Removes the MongoDB volume, the Qdrant volume and uploaded files.
# Requires an explicit typed confirmation; there is no undo.
#
#   ./scripts/reset-data.sh              # interactive
#   ./scripts/reset-data.sh --yes        # skip the prompt (CI)
#   ./scripts/reset-data.sh --mongo-only # only the database

set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

RED=$'\033[31m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; DIM=$'\033[2m'; RESET=$'\033[0m'

SKIP_PROMPT=false
SCOPE="all"

for arg in "$@"; do
  case "$arg" in
    --yes|-y)     SKIP_PROMPT=true ;;
    --mongo-only) SCOPE="mongo" ;;
    --qdrant-only) SCOPE="qdrant" ;;
    --files-only) SCOPE="files" ;;
    *) echo "Unknown option: $arg"; exit 1 ;;
  esac
done

echo "${RED}WARNING: this deletes local data permanently.${RESET}"
echo
case "$SCOPE" in
  all)    echo "  Will delete: MongoDB data, Qdrant vectors, uploaded files" ;;
  mongo)  echo "  Will delete: MongoDB data only" ;;
  qdrant) echo "  Will delete: Qdrant vectors only" ;;
  files)  echo "  Will delete: uploaded and processed files only" ;;
esac
echo

if [ "$SKIP_PROMPT" = false ]; then
  printf "Type 'DELETE' to confirm: "
  read -r CONFIRMATION
  if [ "$CONFIRMATION" != "DELETE" ]; then
    echo "${GREEN}Cancelled. Nothing was deleted.${RESET}"
    exit 0
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "${YELLOW}Docker is not installed; only local files can be cleared.${RESET}"
  SCOPE="files"
fi

# Containers must be stopped before their volumes can be removed.
if command -v docker >/dev/null 2>&1 && [ "$SCOPE" != "files" ]; then
  echo "${DIM}Stopping the stack...${RESET}"
  docker compose down 2>/dev/null || true
fi

remove_volume() {
  local volume="$1"
  if docker volume inspect "$volume" >/dev/null 2>&1; then
    docker volume rm "$volume" >/dev/null && echo "  ${GREEN}✓${RESET} removed volume $volume"
  else
    echo "  ${DIM}-${RESET} volume $volume does not exist"
  fi
}

echo
case "$SCOPE" in
  all)
    remove_volume itp_mongo_data
    remove_volume itp_mongo_config
    remove_volume itp_qdrant_data
    remove_volume itp_storage_data
    ;;
  mongo)  remove_volume itp_mongo_data; remove_volume itp_mongo_config ;;
  qdrant) remove_volume itp_qdrant_data ;;
esac

# Clear files on the host bind path too, keeping the directory structure.
if [ "$SCOPE" = "all" ] || [ "$SCOPE" = "files" ]; then
  for dir in storage/manuals storage/processed storage/page-images storage/temporary; do
    if [ -d "$dir" ]; then
      find "$dir" -mindepth 1 ! -name '.gitkeep' -delete 2>/dev/null || true
      echo "  ${GREEN}✓${RESET} cleared $dir"
    fi
  done
fi

echo
echo "${GREEN}Reset complete.${RESET}"
echo "${DIM}Bring the stack back up with: docker compose up -d${RESET}"
