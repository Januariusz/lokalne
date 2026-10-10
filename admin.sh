#!/usr/bin/env bash
# MobileLens - zasilenie świeżej bazy: konta (admin, moderator, reviewer, user) + marki i telefony.
#
#   bash admin.sh          tryb LOCAL (domyślny): backend z infra/docker-compose.local.yml (albo docker-compose.yml w repo lokalnym), http://localhost:8080
#   bash admin.sh prod     tryb PROD: serwer produkcyjny (VPS), https://mobilelens.duckdns.org
#
# Uruchamiaj z katalogu projektu (tam, gdzie leży infra/), po wcześniejszym `docker compose ... up -d --build`.
# Skrypt można uruchamiać wielokrotnie - istniejące konta, marki i telefony są pomijane.
#
# Zmienne (opcjonalne):
#   API_URL        adres API                      (LOCAL: http://localhost:8080, PROD: https://mobilelens.duckdns.org)
#   USER_PASSWORD  hasło wszystkich kont testowych (domyślnie Test1234!Admin)
#   COMPOSE_DIR    katalog z plikami docker-compose (domyślnie ./infra albo katalog skryptu)
set -euo pipefail

MODE="${1:-local}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_DIR="${COMPOSE_DIR:-$([ -f "$SCRIPT_DIR/infra/docker-compose.yml" ] && echo "$SCRIPT_DIR/infra" || echo "$SCRIPT_DIR")}"
case "$MODE" in
  local) API_URL="${API_URL:-http://localhost:8080}"
         # repo z osobnym plikiem lokalnym używa docker-compose.local.yml; w repo "lokalne" lokalny jest docker-compose.yml
         if [ -f "$COMPOSE_DIR/docker-compose.local.yml" ]; then COMPOSE_FILES=(-f docker-compose.local.yml); else COMPOSE_FILES=(); fi ;;
  prod)  API_URL="${API_URL:-https://mobilelens.duckdns.org}"; COMPOSE_FILES=() ;;
  *)     echo "Użycie: bash admin.sh [local|prod]" >&2; exit 2 ;;
esac
USER_PASSWORD="${USER_PASSWORD:-Test1234!Admin}"

# ── konta: e-mail|nazwa|rola ─────────────────────────────────────────────────
USERS=(
  "admin@test.com|Test Admin|admin"
  "admin2@test.com|Second Admin|admin"
  "moderator@test.com|Test Moderator|moderator"
  "reviewer@test.com|Test Reviewer|reviewer"
  "user@test.com|Test User|user"
)

# ── marki i telefony: marka|model|data premiery ──────────────────────────────
BRANDS=(Samsung Apple Google Xiaomi)
PHONES=(
  "Samsung|Galaxy S24 Ultra|2024-01-31"
  "Samsung|Galaxy S23|2023-02-17"
  "Apple|iPhone 15 Pro|2023-09-22"
  "Apple|iPhone 14|2022-09-16"
  "Google|Pixel 8 Pro|2023-10-12"
  "Google|Pixel 7|2022-10-13"
  "Xiaomi|Xiaomi 14|2023-10-26"
  "Xiaomi|13T Pro|2023-09-26"
)

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
ok()   { printf '    \033[32m+\033[0m %s\n' "$*"; }
skip() { printf '    \033[33m=\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mBŁĄD:\033[0m %s\n' "$*" >&2; exit 1; }

# ── wykonanie SQL w bazie (kontener api); DB_EXEC pozwala podmienić do testów ─
if [ -z "${DB_EXEC:-}" ]; then
  if docker info >/dev/null 2>&1; then DC=(docker compose); else DC=(sudo docker compose); fi
  db_exec() { (cd "$COMPOSE_DIR" && "${DC[@]}" ${COMPOSE_FILES[@]+"${COMPOSE_FILES[@]}"} exec -T api sqlite3 /app/data/db.sqlite "$1"); }
else
  db_exec() { $DB_EXEC "$1"; }
fi

# ── pomocnicze: JSON bez jq ──────────────────────────────────────────────────
json_field() { sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p" | head -1; }

log "Tryb: $MODE · API: $API_URL"
for _ in $(seq 1 30); do
  curl -fsS -m 3 "$API_URL/health" >/dev/null 2>&1 && break
  sleep 2
done
curl -fsS -m 5 "$API_URL/health" >/dev/null || die "API nie odpowiada pod $API_URL/health (tryb: $MODE). Czy kontenery działają? W trybie local: cd infra && docker compose -f docker-compose.local.yml up -d --build"

# ── 1. konta ─────────────────────────────────────────────────────────────────
log "Tworzę konta"
for row in "${USERS[@]}"; do
  IFS='|' read -r email name role <<<"$row"
  code=$(curl -s -o /tmp/admin_sh_resp -w '%{http_code}' -X POST "$API_URL/api/auth/sign-up/email" \
    -H 'Content-Type: application/json' \
    -d "{\"email\":\"$email\",\"password\":\"$USER_PASSWORD\",\"name\":\"$name\"}")
  if [ "$code" = "200" ]; then
    ok "konto $email"
  elif grep -qi 'already\|exists' /tmp/admin_sh_resp; then
    skip "konto $email już istnieje"
  else
    die "rejestracja $email: HTTP $code $(cat /tmp/admin_sh_resp)"
  fi
done

log "Nadaję role"
for row in "${USERS[@]}"; do
  IFS='|' read -r email name role <<<"$row"
  db_exec "UPDATE user SET role='$role' WHERE email='$email';"
  ok "$email -> $role"
done

# ── 2. logowanie admina (po nadaniu roli, żeby token miał aktualną rolę) ──────
log "Loguję się jako admin@test.com"
TOKEN=$(curl -s -X POST "$API_URL/api/auth/sign-in/email" -H 'Content-Type: application/json' \
  -d "{\"email\":\"admin@test.com\",\"password\":\"$USER_PASSWORD\"}" | json_field token)
[ -n "$TOKEN" ] || die "nie udało się zalogować jako admin@test.com (złe hasło? USER_PASSWORD)"
AUTH=(-H "Authorization: Bearer $TOKEN")

# ── 3. marki ─────────────────────────────────────────────────────────────────
log "Dodaję marki"
EXISTING_BRANDS=$(curl -s "$API_URL/api/brands")
for b in "${BRANDS[@]}"; do
  id=$(printf '%s' "$EXISTING_BRANDS" | sed -n "s/.*\"id\":\"\\([^\"]*\\)\",\"name\":\"$b\".*/\\1/p" | head -1)
  if [ -n "$id" ]; then
    skip "marka $b już istnieje"
  else
    id=$(curl -s -X POST "$API_URL/api/brands" "${AUTH[@]}" -H 'Content-Type: application/json' \
      -d "{\"name\":\"$b\"}" | json_field id)
    [ -n "$id" ] || die "nie udało się dodać marki $b"
    ok "marka $b"
  fi
  eval "BRAND_ID_$b=\"\$id\""
done

# ── 4. telefony (od razu zweryfikowane) ──────────────────────────────────────
log "Dodaję telefony"
EXISTING_PHONES=$(curl -s "$API_URL/api/smartphones?limit=50")
for row in "${PHONES[@]}"; do
  IFS='|' read -r brand model date <<<"$row"
  if printf '%s' "$EXISTING_PHONES" | grep -q "\"modelName\":\"$model\""; then
    skip "$brand $model już istnieje"
    continue
  fi
  bvar="BRAND_ID_$brand"; bid="${!bvar}"
  pid=$(curl -s -X POST "$API_URL/api/smartphones" "${AUTH[@]}" -H 'Content-Type: application/json' \
    -d "{\"brandId\":\"$bid\",\"modelName\":\"$model\",\"releaseDate\":\"$date\"}" | json_field id)
  [ -n "$pid" ] || die "nie udało się dodać telefonu $model"
  curl -s -o /dev/null -X PATCH "$API_URL/api/smartphones/$pid" "${AUTH[@]}" \
    -H 'Content-Type: application/json' -d '{}'
  ok "$brand $model (zweryfikowany)"
done

# ── podsumowanie ─────────────────────────────────────────────────────────────
log "Gotowe. Konta w bazie:"
db_exec "SELECT email || '  ' || role FROM user ORDER BY role, email;" | sed 's/^/    /'
log "Telefonów w katalogu: $(curl -s "$API_URL/api/smartphones?limit=1" | sed -n 's/.*"total":\([0-9]*\).*/\1/p')"
echo "    Hasło kont testowych: $USER_PASSWORD  (zmień przed oddaniem projektu)"
