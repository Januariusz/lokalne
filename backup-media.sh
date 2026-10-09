
set -e
COMPOSE_DIR="/opt/mobilelens/infra"
BACKUP_DIR="/opt/mobilelens/backups"
DEST="$BACKUP_DIR/media-$(date +%Y-%m-%d).tar"

mkdir -p "$BACKUP_DIR"
docker compose -f "$COMPOSE_DIR/docker-compose.yml" exec -T api tar cf - -C /app/storage files private > "$DEST"
find "$BACKUP_DIR" -name "media-*.tar" -mtime +28 -delete
echo "[$(date)] Media backup written to $DEST ($(du -h "$DEST" | cut -f1))"
