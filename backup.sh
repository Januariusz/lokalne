#!/bin/sh

set -e


COMPOSE_DIR="/opt/mobilelens/infra"
SERVICE="api"

BACKUP_DIR="/opt/mobilelens/backups"
DATE=$(date +%Y-%m-%d)
DEST="$BACKUP_DIR/db-$DATE.sqlite"
TMP_IN_CONTAINER="/tmp/backup-$DATE.sqlite"

mkdir -p "$BACKUP_DIR"

cleanup() {

  docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T "$SERVICE" \
    rm -f "$TMP_IN_CONTAINER" || true
}
trap cleanup EXIT

docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T "$SERVICE" \
  sqlite3 /app/data/db.sqlite ".backup '$TMP_IN_CONTAINER'"

docker compose -f "$COMPOSE_DIR/docker-compose.yml" cp \
  "$SERVICE:$TMP_IN_CONTAINER" "$DEST"


if ! sqlite3 "$DEST" "PRAGMA integrity_check;" | grep -q "^ok$"; then
  echo "[$(date)] BŁĄD: kopia $DEST nie przeszła integrity_check — usuwam" >&2
  rm -f "$DEST"
  exit 1
fi


find "$BACKUP_DIR" -name "db-*.sqlite" -mtime +14 -delete

echo "[$(date)] Backup written to $DEST"

