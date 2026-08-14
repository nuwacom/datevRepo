// lib/html.ts
// Minimal inline HTML pages for the browser-facing OAuth routes.

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function htmlPage(title: string, bodyHtml: string, status = 200): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: ui-sans-serif, system-ui, -apple-system, sans-serif; background: #f4f6f8;
         color: #11151c; display: flex; min-height: 100vh; align-items: center;
         justify-content: center; margin: 0; }
  .card { background: #fff; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,.08);
          max-width: 560px; padding: 32px 40px; line-height: 1.6; }
  h1 { font-size: 20px; margin-top: 0; }
  code { background: #f4f6f8; padding: 2px 6px; border-radius: 4px; }
  .muted { color: #64748b; font-size: 14px; }
  a { color: #2563eb; }
</style>
</head>
<body><div class="card"><h1>${escapeHtml(title)}</h1>${bodyHtml}</div></body>
</html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
