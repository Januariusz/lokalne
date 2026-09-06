#!/bin/bash

# setup-local.sh — konfiguracja testowych userów dla lokalnego dev

cd "$(dirname "$0")" || exit 1

echo "⏳ Czekam na API..."
sleep 10

echo "🗑️  Czyszczę stare testy..."
docker compose exec -T api sqlite3 /app/data/db.sqlite << 'EOF'
DELETE FROM user WHERE email LIKE '%@test.local';
EOF

echo "📝 Rejestruję admin..."
curl -s -X POST http://localhost/api/auth/sign-up/email \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@test.local","password":"AdminTest123!","name":"Admin Test"}' | jq '.user.email, .user.role'

echo "📝 Rejestruję reviewer..."
curl -s -X POST http://localhost/api/auth/sign-up/email \
  -H "Content-Type: application/json" \
  -d '{"email":"reviewer@test.local","password":"ReviewerTest123!","name":"Reviewer Test"}' | jq '.user.email, .user.role'

echo "📝 Rejestruję user..."
curl -s -X POST http://localhost/api/auth/sign-up/email \
  -H "Content-Type: application/json" \
  -d '{"email":"user@test.local","password":"UserTest123!","name":"User Test"}' | jq '.user.email, .user.role'

echo "🔧 Promocja do ról..."
docker compose exec -T api sqlite3 /app/data/db.sqlite << 'EOF'
UPDATE user SET role='admin' WHERE email='admin@test.local';
UPDATE user SET role='reviewer' WHERE email='reviewer@test.local';
EOF

echo ""
echo "✅ Setup complete!"
echo ""
echo "Admin:    admin@test.local / AdminTest123!"
echo "Reviewer: reviewer@test.local / ReviewerTest123!"
echo "User:     user@test.local / UserTest123!"
