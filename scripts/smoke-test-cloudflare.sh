#!/usr/bin/env bash
# End-to-end smoke test for the deployed DocuExtract Cloudflare Worker.
# Usage: BASE=https://docuextract.dev078.workers.dev bash scripts/smoke-test-cloudflare.sh
set -euo pipefail

BASE="${BASE:-https://docuextract.dev078.workers.dev}"
DOC=/home/z/my-project/scripts/testdocs/student-register.png
BAD=/home/z/my-project/scripts/testdocs/bad-dark-blurry.jpg
TMP=/tmp/smoke-docuextract
mkdir -p "$TMP"

say() { echo; echo "== $1 =="; }

say "1. Health: GET /api"
curl -s -m 30 "$BASE/api" | tee "$TMP/health.json"; echo

say "2. Frontend: GET / (title check)"
curl -s -m 30 "$BASE/" | grep -o "<title>[^<]*</title>" || echo "NO TITLE"

say "3. Create job"
JOB=$(curl -s -m 30 -X POST "$BASE/api/jobs" -H "Content-Type: application/json" \
  -d '{"title":"Smoke test class register","mode":"general"}')
echo "$JOB"
JOBID=$(echo "$JOB" | python3 -c "import sys,json; print(json.load(sys.stdin)['job']['id'])")

say "4. Upload good page (browser-quality JSON attached, like the CF client sends)"
GOOD=$(curl -s -m 60 -X POST "$BASE/api/jobs/$JOBID/pages" \
  -F "file=@$DOC;type=image/png" \
  -F "fileName=student-register.png" \
  -F 'quality={"blurScore":180.5,"brightness":171.2,"contrast":52.7,"width":1400,"height":900,"darkFraction":0.02,"brightFraction":0.05,"verdict":"pass","issues":[]}')
echo "$GOOD"
PAGEID=$(echo "$GOOD" | python3 -c "import sys,json; print(json.load(sys.stdin)['page']['id'])")

say "5. Serve page image"
curl -s -m 30 -o "$TMP/page.jpg" -w "HTTP %{http_code} type=%{content_type} bytes=%{size_download}\n" "$BASE/api/pages/$PAGEID/image"

say "6. AI extraction on the good page (may take up to 2-3 min)"
curl -s -m 300 -X POST "$BASE/api/pages/$PAGEID/extract" -H "Content-Type: application/json" -d '{}' | tee "$TMP/extract.json" | head -c 900; echo

say "7. Job detail (fields + report)"
curl -s -m 60 "$BASE/api/jobs/$JOBID" > "$TMP/detail.json"
python3 - "$TMP/detail.json" << 'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
print("job.status:", d["job"]["status"])
print("pages:", len(d["pages"]), "| fields:", len(d["fields"]), "| rows:", d["report"]["totalRows"])
print("report.summary:", d["report"]["summary"][:2])
print("sample field:", {k: d["fields"][0][k] for k in ("columnName", "value", "confidence")} if d["fields"] else None)
EOF

say "8. Export xlsx + csv + pdf + json"
for FMT in xlsx csv pdf json; do
  EXP=$(curl -s -m 120 -X POST "$BASE/api/jobs/$JOBID/export" -H "Content-Type: application/json" -d "{\"format\":\"$FMT\"}")
  EXPID=$(echo "$EXP" | python3 -c "import sys,json; print(json.load(sys.stdin)['export']['id'])" 2>/dev/null || echo "")
  if [ -n "$EXPID" ]; then
    curl -s -m 60 -o "$TMP/export.$FMT" -w "$FMT: HTTP %{http_code} bytes=%{size_download}\n" "$BASE/api/exports/$EXPID/download"
  else
    echo "$FMT FAILED: $EXP"
  fi
done
python3 - << 'EOF'
for f, magic in (("xlsx", b"PK"), ("pdf", b"%PDF"), ("csv", None), ("json", b"{")):
    try:
        head = open(f"/tmp/smoke-docuextract/export.{f}", "rb").read(4)
        ok = magic is None or head.startswith(magic)
        print(f, "magic ok" if ok else f"BAD MAGIC: {head!r}")
    except Exception as e:
        print(f, "missing", e)
EOF

say "9. Quality gate: upload flagged-fail image then try to extract (expect 403)"
BADRES=$(curl -s -m 60 -X POST "$BASE/api/jobs/$JOBID/pages" \
  -F "file=@$BAD;type=image/jpeg" \
  -F "fileName=bad-dark-blurry.jpg" \
  -F 'quality={"blurScore":12.0,"brightness":38.0,"contrast":10.0,"width":900,"height":600,"darkFraction":0.7,"brightFraction":0.0,"verdict":"fail","issues":[{"code":"too-dark","severity":"fail","message":"Image is too dark."}]}')
echo "$BADRES"
BADPAGE=$(echo "$BADRES" | python3 -c "import sys,json; print(json.load(sys.stdin)['page']['id'])")
curl -s -m 60 -X POST "$BASE/api/pages/$BADPAGE/extract" -H "Content-Type: application/json" -d '{}' -w "\nHTTP %{http_code}\n" | head -c 400

say "10. Patch a field, list dashboard, delete job"
FIRSTFIELD=$(python3 -c "import json; d=json.load(open('$TMP/detail.json')); print(d['fields'][0]['id'])")
curl -s -m 60 -X PATCH "$BASE/api/fields/$FIRSTFIELD" -H "Content-Type: application/json" \
  -d '{"value":"PATCHED-BY-TEST"}' | head -c 200; echo
curl -s -m 60 "$BASE/api/jobs" | python3 -c "import sys,json; d=json.load(sys.stdin); print('dashboard jobs:', len(d['jobs']), [ (j['title'], j['pageCount'], j['recordCount']) for j in d['jobs'][:3]])"
curl -s -m 60 -X DELETE "$BASE/api/jobs/$JOBID"; echo " <- delete job"

say "SMOKE TEST COMPLETE"
