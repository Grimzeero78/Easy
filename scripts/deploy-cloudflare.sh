#!/usr/bin/env bash
# One-command Cloudflare deployment for DocuExtract.
# Usage: CLOUDFLARE_API_TOKEN=<valid token> bash scripts/deploy-cloudflare.sh
#
# Steps:
#   1. Verifies the token against the Cloudflare API
#   2. Builds the static SPA export (NEXT_PUBLIC_CF_MODE=1)
#   3. Copies it into cloudflare/public-dist
#   4. Deploys the Worker (API + static assets in one URL)
set -euo pipefail
cd "$(dirname "$0")/.."

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "ERROR: set CLOUDFLARE_API_TOKEN=<token> before running this script"
  exit 1
fi

echo "== 1/4 Verifying Cloudflare token =="
VERIFY=$(curl -s -X GET "https://api.cloudflare.com/client/v4/user/tokens/verify" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
echo "$VERIFY" | grep -q '"success":true' || {
  echo "ERROR: token verification failed: $VERIFY"
  exit 1
}
echo "token OK"

echo "== 2/4 Building static SPA (CF mode) =="
NEXT_PUBLIC_CF_MODE=1 npx next build

echo "== 3/4 Copying dist into cloudflare/public-dist =="
rm -rf cloudflare/public-dist
cp -r .next-cf cloudflare/public-dist

echo "== 4/4 Deploying Worker =="
cd cloudflare
[ -d node_modules ] || npm install --no-audit --no-fund
CLOUDFLARE_API_TOKEN="$CLOUDFLARE_API_TOKEN" npx wrangler deploy

echo "Deploy complete. Smoke test:"
echo "  BASE=https://docuextract.dev078.workers.dev bash scripts/smoke-test-cloudflare.sh"
