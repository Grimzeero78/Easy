import type { NextConfig } from "next";

/**
 * Two build modes:
 *
 * 1. Default (sandbox / local dev): full Next.js server — API routes run with
 *    Prisma (SQLite), sharp-based image pipeline and z-ai vision engine.
 *
 * 2. NEXT_PUBLIC_CF_MODE=1: static export for Cloudflare Workers deployment.
 *    - output: "export" emits a fully static SPA to ./out
 *    - pageExtensions is narrowed to *.prod.tsx so the API route handlers are
 *      NOT compiled into the export (the Cloudflare Worker implements /api)
 *    - images are unoptimized (no Next image server in a static export)
 *    - distDir moved to .next-cf so a CF build never disturbs the running dev server
 *
 * When NEXT_PUBLIC_CF_MODE is set, the client bundle moves the image quality
 * gate, enhancement and annotation cropping into the browser (see
 * src/lib/client-image.ts) because Cloudflare Workers have no sharp/canvas.
 */
const isCfExport = process.env.NEXT_PUBLIC_CF_MODE === "1";

const nextConfig: NextConfig = isCfExport
  ? {
      output: "export",
      images: { unoptimized: true },
      pageExtensions: ["prod.tsx", "prod.ts"],
      distDir: ".next-cf",
      typescript: { ignoreBuildErrors: true },
      reactStrictMode: false,
    }
  : {
      output: "standalone",
      /* Document-processing libraries rely on dynamic CJS internals (streams, zip,
         font loading) that break when bundled — load them at runtime instead. */
      serverExternalPackages: ["exceljs", "pdfkit", "docx", "sharp", "fontkit"],
      /* config options here */
      typescript: {
        ignoreBuildErrors: true,
      },
      reactStrictMode: false,
    };

export default nextConfig;
