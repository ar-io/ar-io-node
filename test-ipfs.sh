#!/bin/bash
# End-to-end IPFS integration test script
# Run this after starting the gateway with IPFS_ENABLED=true and Kubo running

GATEWAY_URL="${1:-http://localhost:4000}"
KUBO_URL="${2:-http://localhost:8080}"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[0;33m'
NC='\033[0m'

pass=0
fail=0

test_case() {
  local name="$1"
  local expected_status="$2"
  local url="$3"
  local extra_args="${4:-}"

  local result
  result=$(curl -s -o /tmp/ipfs-test-body -w "%{http_code}" --max-time 30 $extra_args "$url" 2>&1)

  if [ "$result" = "$expected_status" ]; then
    echo -e "  ${GREEN}PASS${NC} $name (HTTP $result)"
    ((pass++))
  else
    echo -e "  ${RED}FAIL${NC} $name — expected $expected_status, got $result"
    echo "       URL: $url"
    echo "       Body: $(head -c 200 /tmp/ipfs-test-body)"
    ((fail++))
  fi
}

test_body_contains() {
  local name="$1"
  local expected_text="$2"
  local url="$3"

  local body
  # -L: a path-style /ipfs/{CID} 302-redirects to its sandbox subdomain when
  # ARNS_ROOT_HOSTS is set; without following, we'd match the redirect body.
  body=$(curl -sL --max-time 30 "$url" 2>&1)
  local status=$?

  if echo "$body" | grep -q "$expected_text"; then
    echo -e "  ${GREEN}PASS${NC} $name"
    ((pass++))
  else
    echo -e "  ${RED}FAIL${NC} $name — body doesn't contain '$expected_text'"
    echo "       Body: $(echo "$body" | head -c 200)"
    ((fail++))
  fi
}

test_header() {
  local name="$1"
  local header="$2"
  local expected_value="$3"
  local url="$4"

  local actual
  actual=$(curl -s -I --max-time 30 "$url" 2>&1 | grep -i "^$header:" | head -1 | sed 's/^[^:]*: //' | tr -d '\r')

  # An empty expected_value means "header must be present" — grep -qi "" would
  # match anything (even a missing header), so require a non-empty actual value.
  if { [ -z "$expected_value" ] && [ -n "$actual" ]; } ||
    { [ -n "$expected_value" ] && echo "$actual" | grep -qi "$expected_value"; }; then
    echo -e "  ${GREEN}PASS${NC} $name ($actual)"
    ((pass++))
  else
    echo -e "  ${RED}FAIL${NC} $name — expected header '$header' to contain '$expected_value', got '$actual'"
    ((fail++))
  fi
}

echo "========================================="
echo " AR.IO IPFS Integration — E2E Tests"
echo "========================================="
echo ""
echo "Gateway: $GATEWAY_URL"
echo "Kubo:    $KUBO_URL"
echo ""

# --- Pre-flight: ensure Kubo is running ---
echo "--- Pre-flight ---"
kubo_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "$KUBO_URL/ipfs/QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn" 2>&1)
if [ "$kubo_status" = "000" ]; then
  echo -e "  ${RED}FAIL${NC} Kubo not reachable at $KUBO_URL"
  exit 1
fi
echo -e "  ${GREEN}OK${NC} Kubo is reachable"

# Add test content to Kubo
echo ""
echo "--- Adding test content to Kubo ---"
FILE_CID=$(echo "Hello from AR.IO IPFS integration test!" | docker exec -i ar-io-node-kubo-1 ipfs add -q 2>&1)
echo "  File CID: $FILE_CID"

DIR_CID=$(docker exec ar-io-node-kubo-1 sh -c '
  mkdir -p /tmp/e2e-test
  echo "<!DOCTYPE html><html><body><h1>E2E Test</h1></body></html>" > /tmp/e2e-test/index.html
  echo "subfile content" > /tmp/e2e-test/sub.txt
  ipfs add -r -q /tmp/e2e-test | tail -1
' 2>&1)
echo "  Dir CID:  $DIR_CID"
echo ""

# --- Test 1: Path-based single file ---
echo "--- Path-based access ---"
test_body_contains "GET /ipfs/{CID} serves file content" \
  "Hello from AR.IO IPFS integration test" \
  "$GATEWAY_URL/ipfs/$FILE_CID"

# --- Test 2: Path-based directory with path ---
test_body_contains "GET /ipfs/{CID}/index.html serves directory file" \
  "E2E Test" \
  "$GATEWAY_URL/ipfs/$DIR_CID/index.html"

test_body_contains "GET /ipfs/{CID}/sub.txt serves subfile" \
  "subfile content" \
  "$GATEWAY_URL/ipfs/$DIR_CID/sub.txt"

# --- Test 3: Invalid CID ---
test_case "GET /ipfs/invalid-cid returns 400" \
  "400" \
  "$GATEWAY_URL/ipfs/not-a-valid-cid"

# --- Test 4: Response headers ---
echo ""
echo "--- Response headers ---"
test_header "Cache-Control is immutable" \
  "cache-control" "immutable" \
  "$GATEWAY_URL/ipfs/$FILE_CID"

test_header "X-Ipfs-Path header present" \
  "x-ipfs-path" "/ipfs/" \
  "$GATEWAY_URL/ipfs/$FILE_CID"

test_header "X-Cache header present" \
  "x-cache" "" \
  "$GATEWAY_URL/ipfs/$FILE_CID"

test_header "Content-Type is set" \
  "content-type" "" \
  "$GATEWAY_URL/ipfs/$FILE_CID"

# --- Test 5: CIDv0 redirect to CIDv1 subdomain ---
echo ""
echo "--- CIDv0 redirect ---"
redirect_location=$(curl -s -o /dev/null -w "%{redirect_url}" --max-time 10 "$GATEWAY_URL/ipfs/$FILE_CID" 2>&1)
if echo "$redirect_location" | grep -q "ipfs"; then
  echo -e "  ${GREEN}PASS${NC} CIDv0 redirects to CIDv1 subdomain ($redirect_location)"
  ((pass++))
elif [ -z "$redirect_location" ]; then
  echo -e "  ${YELLOW}SKIP${NC} No redirect (CID may already be v1 or no ARNS_ROOT_HOST)"
else
  echo -e "  ${YELLOW}INFO${NC} Redirect: $redirect_location"
fi

# --- Test 6: Second request should be cached ---
echo ""
echo "--- Caching ---"
# First request (cache miss)
curl -s -o /dev/null "$GATEWAY_URL/ipfs/$FILE_CID" 2>/dev/null
# Second request (should be cache hit)
cache_header=$(curl -s -I --max-time 10 "$GATEWAY_URL/ipfs/$FILE_CID" 2>&1 | grep -i "^x-cache:" | sed 's/^[^:]*: //' | tr -d '\r')
echo -e "  ${GREEN}INFO${NC} X-Cache on second request: ${cache_header:-'(not set)'}"

# --- Summary ---
echo ""
echo "========================================="
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}"
echo "========================================="

exit $fail
