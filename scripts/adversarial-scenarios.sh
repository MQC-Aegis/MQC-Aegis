#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://127.0.0.1:3000}"

hit() {
  local name="$1"
  local json="$2"
  echo
  echo "=== $name ==="
  curl -s -X POST "$BASE_URL/event" \
    -H "Content-Type: application/json" \
    -d "$json"
  echo
}

echo "Using: $BASE_URL"

# 1) Calm trusted user
hit "trusted-user-1" '{"type":"login","user":"trusted-user","attempts":1,"ip":"10.20.30.40","risk":18,"velocitySpike":false,"geoMismatch":false}'
hit "trusted-user-2" '{"type":"payment","user":"trusted-user","amount":1200,"ip":"10.20.30.40","risk":22,"velocitySpike":false,"geoMismatch":false}'
hit "trusted-user-3" '{"type":"login","user":"trusted-user","attempts":1,"ip":"10.20.30.40","risk":20,"velocitySpike":false,"geoMismatch":false}'

# 2) Borderline review
hit "borderline-review" '{"type":"payment","user":"borderline-review","amount":9000,"ip":"unknown","risk":58,"velocitySpike":false,"geoMismatch":false}'

# 3) MQC cluster divergence build-up
hit "mqc-cluster-1" '{"type":"payment","user":"cluster-user","amount":8000,"ip":"unknown","risk":55,"velocitySpike":false,"geoMismatch":false}'
sleep 1
hit "mqc-cluster-2" '{"type":"payment","user":"cluster-user","amount":9500,"ip":"unknown","risk":59,"velocitySpike":false,"geoMismatch":false}'
sleep 1
hit "mqc-cluster-3" '{"type":"payment","user":"cluster-user","amount":11000,"ip":"unknown","risk":63,"velocitySpike":false,"geoMismatch":false}'

# 4) Auth cascade / obvious bad actor
hit "auth-cascade" '{"type":"login","user":"auth-cascade-user","attempts":6,"ip":"unknown","risk":76,"velocitySpike":true,"geoMismatch":true}'

# 5) Repeat offender memory pressure
hit "repeat-offender-1" '{"type":"login","user":"repeat-offender","attempts":5,"ip":"unknown","risk":66,"velocitySpike":true,"geoMismatch":false}'
sleep 1
hit "repeat-offender-2" '{"type":"payment","user":"repeat-offender","amount":14000,"ip":"unknown","risk":68,"velocitySpike":false,"geoMismatch":false}'
sleep 1
hit "repeat-offender-3" '{"type":"login","user":"repeat-offender","attempts":4,"ip":"unknown","risk":64,"velocitySpike":false,"geoMismatch":true}'

# 6) Known user, new IP
hit "new-ip-on-known-user" '{"type":"login","user":"trusted-user","attempts":1,"ip":"172.16.10.55","risk":28,"velocitySpike":false,"geoMismatch":false}'

echo
echo "=== SUMMARY ==="
curl -s "$BASE_URL/api/summary"
echo
echo
echo "=== MQC STATS ==="
curl -s "$BASE_URL/api/mqc/stats"
echo
echo
echo "=== USER MEMORY ==="
curl -s "$BASE_URL/api/users/memory"
echo
