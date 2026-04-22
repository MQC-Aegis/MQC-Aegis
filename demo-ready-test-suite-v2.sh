#!/usr/bin/env bash

BASE_URL="${1:-http://localhost:3000}"

echo "=================================================="
echo " SignalDesk demo-ready test suite v2"
echo " Base URL: $BASE_URL"
echo "=================================================="
echo

step() {
  echo
  echo "--------------------------------------------------"
  echo "$1"
  echo "--------------------------------------------------"
}

pause() {
  sleep "${1:-1}"
}

step "0. Health check"
curl -s "$BASE_URL/health"
echo
pause 1

step "1. Initial summary"
curl -s "$BASE_URL/api/summary" | jq
echo
pause 1

step "2. Baseline normal login"
curl -s -X POST "$BASE_URL/event" \
  -H "Content-Type: application/json" \
  -d '{
    "type":"login",
    "user":"demo-normal-1",
    "attempts":1,
    "ip":"192.168.1.10",
    "risk":12,
    "velocitySpike":false
  }'
echo
pause 1

step "3. Baseline normal payment"
curl -s -X POST "$BASE_URL/event" \
  -H "Content-Type: application/json" \
  -d '{
    "type":"payment",
    "user":"demo-normal-1",
    "amount":199,
    "ip":"192.168.1.10",
    "risk":18,
    "geoMismatch":false
  }'
echo
pause 1

step "4. Review-case login (should lean manual_review)"
curl -s -X POST "$BASE_URL/event" \
  -H "Content-Type: application/json" \
  -d '{
    "type":"login",
    "user":"demo-review-1",
    "attempts":4,
    "ip":"unknown",
    "risk":68,
    "velocitySpike":true
  }'
echo
pause 1

step "5. Critical login attack (should go high/critical)"
curl -s -X POST "$BASE_URL/event" \
  -H "Content-Type: application/json" \
  -d '{
    "type":"login",
    "user":"attacker-demo-1",
    "attempts":9,
    "ip":"unknown",
    "risk":94,
    "velocitySpike":true
  }'
echo
pause 1

step "6. Critical payment attack (should strongly prefer block)"
curl -s -X POST "$BASE_URL/event" \
  -H "Content-Type: application/json" \
  -d '{
    "type":"payment",
    "user":"attacker-demo-1",
    "amount":18000,
    "ip":"unknown",
    "risk":96,
    "geoMismatch":true
  }'
echo
pause 1

step "7. Multi-signal escalation on same actor"
curl -s -X POST "$BASE_URL/event" \
  -H "Content-Type: application/json" \
  -d '{
    "type":"login",
    "user":"attacker-demo-1",
    "attempts":7,
    "ip":"unknown",
    "risk":88,
    "velocitySpike":true
  }'
echo
pause 1

curl -s -X POST "$BASE_URL/event" \
  -H "Content-Type: application/json" \
  -d '{
    "type":"payment",
    "user":"attacker-demo-1",
    "amount":9500,
    "ip":"unknown",
    "risk":91,
    "geoMismatch":true
  }'
echo
pause 1

step "8. Geo anomaly without huge amount (good for nuanced review)"
curl -s -X POST "$BASE_URL/event" \
  -H "Content-Type: application/json" \
  -d '{
    "type":"payment",
    "user":"traveler-demo-1",
    "amount":850,
    "ip":"foreign-exit-node",
    "risk":73,
    "geoMismatch":true
  }'
echo
pause 1

step "9. Velocity anomaly burst"
for i in 1 2 3 4 5; do
  curl -s -X POST "$BASE_URL/event" \
    -H "Content-Type: application/json" \
    -d "{
      \"type\":\"login\",
      \"user\":\"burst-user-1\",
      \"attempts\":$i,
      \"ip\":\"unknown\",
      \"risk\":$((60 + i * 5)),
      \"velocitySpike\":true
    }"
  echo
  sleep 0.4
done
pause 1

step "10. Pull incidents"
curl -s "$BASE_URL/api/incidents" | jq
echo
pause 1

step "11. Pull actions"
curl -s "$BASE_URL/api/actions" | jq
echo
pause 1

step "12. Pull AI/deterministic summary"
curl -s "$BASE_URL/api/summary" | jq
echo
pause 1

step "13. Optional insights endpoint"
curl -s -X POST "$BASE_URL/api/insights" \
  -H "Content-Type: application/json" \
  -d '{}' | jq
echo

echo
echo "=================================================="
echo " Done."
echo "=================================================="
