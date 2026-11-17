# DocuExtract — AI Document Understanding & Data Extraction

**Take a picture → Mark what you need → AI extracts → You verify → Export clean data.**

DocuExtract is not an OCR demo — it is a production-oriented document understanding platform built to eliminate repetitive manual data entry. It reads photographs, scans, screenshots and PDFs of student registers, receipts, cash sheets, stock records and forms, and turns them into clean, structured, verified datasets.

**Live deployment (Cloudflare):** https://docuextract.dev078.workers.dev

---

## What it does

| Capability | How it works |
| --- | --- |
| Capture or upload | Phone camera, photos (JPG/PNG/WebP), scans, screenshots, multi-page PDFs (each PDF page becomes an ordered page) |
| Image quality gate | Every image is measured for blur (variance of Laplacian), brightness, contrast, exposure and resolution. **Blurry / dark / unreadable pictures are blocked and must be retaken — never silently processed** |
| AI image understanding | A vision-language model reads the document under strict extraction rules (see below) |
| Marking & annotation engine | Draw rectangles, circles or freehand marks directly on the page; optional labels. Marks are extraction instructions — the AI reads zoomed crops of each marked region |
| Natural-language instructions | "Extract all student names and registration numbers", "Find duplicate registration numbers", "Give me all the transaction IDs"… |
| Cashier & financial mode | Specialized prompt for receipts/transactions: Transaction ID, Amount, Date, Payment Reference, Description, Customer Name — amounts and IDs transcribed exactly |
| Confidence-based verification | Every cell carries a confidence score; uncertain/missing/low-confidence cells are flagged and editable in the workspace, with alternatives for ambiguous characters (O vs 0, 5 vs S) |
| Data integrity engine | Missing values stay missing (never guessed) · duplicate record detection across pages · visible-vs-extracted record count mismatch detection · per-page processing report |
| Export | `.xlsx` (including filling uploaded Excel templates), `.csv`, `.pdf`, `.docx`, `.txt`, `.json` — with the processing report included |
| Multi-page batches | Page order preserved, consolidated dataset across pages, user-controlled deletion of any job/page/export |

## The 10 product rules (enforced by code and prompts)

1. Never guess unreadable text — missing values stay missing.
2. Never invent information.
3. Never silently omit a visible record — count mismatches are flagged.
4. Keep row/column relationships — each record's fields come from one visual row.
5. Respect user annotations as extraction instructions.
6. Mark uncertain values and offer alternatives instead of picking silently.
7. Preserve the structure of uploaded templates.
8. Support multi-page documents and large batches.
9. Let the user correct anything before export.
10. Always produce a processing report.

## Architecture

Two deployable modes share the same UI and the same API contract:

```
┌────────────────────────────────────────────────────────────────────┐
│                      Next.js 16 frontend (SPA)                     │
│   Dashboard · New Extraction · Workspace (annotator + verify) ·    │
│   Export panel — shadcn/ui, Tailwind 4, Zustand                    │
└───────────────▲───────────────────────────────────▲────────────────┘
                │ (sandbox/local mode)              │ (CF_MODE=1 static export)
┌───────────────┴───────────────┐   ┌───────────────┴────────────────┐
│  Next.js API routes (Node)    │   │  Cloudflare Worker (Hono)      │
│  Prisma + SQLite              │   │  Cloudflare KV                 │
│  sharp image pipeline         │   │  browser-side image pipeline   │
│  z-ai glm-4.6v vision engine  │   │  Workers AI vision engine      │
│  exceljs/pdfkit/docx exports  │   │  SheetJS/pdf-lib/docx exports  │
└───────────────────────────────┘   └────────────────────────────────┘
```

### Mode 1 — Sandbox / local (full server)

```bash
bun install
bun run db:push        # Prisma + SQLite
bun run dev            # http://localhost:3000
```

- Server-side quality gate, enhancement (sharp) and annotation cropping
- Vision extraction via `z-ai-web-dev-sdk` (glm-4.6v) — returns cell-level bounding boxes
- Exports via exceljs / pdfkit / docx (full template styling preserved)

### Mode 2 — Cloudflare (one Worker = backend + hosting)

```bash
# 1. Build the static SPA export
NEXT_PUBLIC_CF_MODE=1 npx next build          # outputs to .next-cf/
cp -r .next-cf cloudflare/public-dist

# 2. Deploy the Worker (API + static assets in one URL)
cd cloudflare
npm install
npx wrangler deploy
```

Infrastructure (created once, see `cloudflare/wrangler.jsonc`):
- **Workers KV namespace** — jobs, pages, fields, exports, templates (images ≤ 25 MB per value)
- **Workers AI binding** — vision model via `vars.VISION_MODEL` (default `@cf/meta/llama-3.2-11b-vision-instruct`; swap for any Workers AI vision model without code changes)
- **Assets** — the exported SPA with SPA fallback; the Worker handles `/api/*` first (`run_worker_first`)

Cloudflare-specific design notes:
- **No sharp / no Node canvas on Workers** → the browser runs the quality gate (same metrics and thresholds as the server engine), produces the enhanced reading copy, and crops annotated regions before upload (`src/lib/client-image.ts`, activated by `NEXT_PUBLIC_CF_MODE=1`)
- **Workers AI vision accepts one image per call** → annotated pages are extracted with one call per marked-region crop + one light meta call for document type / record counts; crop bboxes are mapped back to full-page coordinates
- **Composite IDs** (`{jobId}~…`) let every request resolve its owning job in O(1) KV reads
- Dashboard lists are denormalized into index keys so the UI needs at most a few KV reads per view
- Llama models need a one-time license acceptance per account: `GET /api/ai-license` once

## Repository layout

```
src/app/                  Next.js App Router (UI + API routes for mode 1)
  ├─ page.tsx / layout.tsx            sandbox entry points
  ├─ page.prod.tsx / layout.prod.tsx  CF export entry points (pageExtensions trick)
  └─ api/                             jobs, pages, extract, fields, exports, templates
src/components/           dashboard, new-extraction, workspace, export-panel,
                          annotator, data-table, report-panel (+ shadcn/ui)
src/lib/                  quality (server), vision (server), report, exporters (server),
                          client-image (browser pipeline), types, store
prisma/                   SQLite schema (jobs, pages, fields, exports, templates)
cloudflare/               Cloudflare Worker deployment
  ├─ src/index.ts           Hono API — same contract as the Next API routes
  ├─ src/kvstore.ts         KV data layer (O(1) reads, denormalized indexes)
  ├─ src/report.ts          verification engine (port of src/lib/report.ts)
  ├─ src/vision.ts          Workers AI extraction engine
  ├─ src/exporters.ts       SheetJS / pdf-lib / docx exporters
  └─ wrangler.jsonc         bindings, KV id, model var
scripts/                  test documents + smoke test for the live deployment
```

## API contract (identical in both modes)

| Method & path | Purpose |
| --- | --- |
| `POST /api/jobs` | create extraction job (`{title, mode}`) |
| `GET /api/jobs` | dashboard list with counts |
| `GET/PATCH/DELETE /api/jobs/:id` | full detail (pages, fields, report) / update / cascade delete |
| `POST /api/jobs/:id/pages` | upload page (FormData; CF mode adds browser-computed `quality` + `enhanced`) |
| `GET /api/pages/:id/image?variant=enhanced\|original` | page image |
| `PATCH/DELETE /api/pages/:id` | save annotations / delete page (+ re-index) |
| `POST /api/pages/:id/extract` | AI extraction (CF mode may send `{crops:[{label,dataUrl,x,y,w,h}]}`) |
| `PATCH /api/fields/:id` | human verification: correct a value or accept an alternative |
| `POST /api/jobs/:id/export` | generate file (`{format, templateId?, columns?}`) |
| `GET /api/exports`, `GET /api/exports/:id/download`, `DELETE /api/exports/:id` | export history / download / delete |
| `GET/POST /api/templates`, `DELETE /api/templates/:id` | saved column sets and Excel templates |
| `GET /api/ai-license` | one-time Workers AI model license bootstrap |

## Smoke test

```bash
BASE=https://docuextract.dev078.workers.dev bash scripts/smoke-test-cloudflare.sh
```

Covers: health, SPA serving, job creation, page upload, image serving, real AI
extraction, verification report, xlsx/csv/pdf/json export (with file-signature
checks), the quality-gate 403 path, field patching and cleanup.

## Known limitations / notes

- The Cloudflare deployment uses `llama-3.2-11b-vision-instruct` (Workers AI free tier). It is noticeably weaker than the sandbox glm-4.6v engine: for dense tables it may under-extract rows — **the verification engine flags this as a count mismatch instead of losing records silently**, which is exactly the intended behavior. Swap `VISION_MODEL` for a stronger available vision model to improve extraction.
- Cell bounding boxes are model-dependent: the CF vision model usually cannot localize cells (bboxes stay `null`); the sandbox engine returns them.
- Excel template filling on Cloudflare (SheetJS) preserves template structure and header formatting but not full cell styling; the sandbox exceljs pipeline does.
- Cloudflare KV free tier: ~1,000 writes/day (≈100+ page uploads/day), eventually-consistent reads. D1/R2 are drop-in upgrades if the account enables them.
- No authentication in this MVP — the deployment is open. Add Cloudflare Access or an auth layer before exposing sensitive workflows.

## Security notes

- No secrets are committed: `.env`, `db/`, build outputs and local artifacts are git-ignored; Cloudflare/GitHub tokens are only ever provided as environment variables at deploy time.
- If you shared any API token in chat while setting this up, **rotate it** after the initial deployment (Cloudflare dashboards → API Tokens; GitHub → Settings → Developer settings → Fine-grained tokens).
