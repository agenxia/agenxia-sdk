// Generate an HTML documentation page from an agent card
function esc(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
/**
 * Generate a complete HTML documentation page for an agent.
 */
export function generateDocs(card, baseUrl = "") {
    const methodsHtml = (card.methods ?? [])
        .map((m) => {
        const paramsRows = Object.entries(m.params ?? {})
            .map(([name, def]) => `<tr>
              <td><code>${esc(name)}</code></td>
              <td>${esc(def.type ?? "any")}</td>
              <td>${def.required ? '<span class="badge req">required</span>' : '<span class="badge opt">optional</span>'}</td>
              <td>${esc(def.description ?? "")}</td>
            </tr>`)
            .join("");
        const returnsRows = Object.entries(m.returns ?? {})
            .map(([name, def]) => `<tr>
              <td><code>${esc(name)}</code></td>
              <td>${esc(def.type ?? "any")}</td>
              <td>${esc(def.description ?? "")}</td>
            </tr>`)
            .join("");
        const exampleHtml = m.example
            ? `<div class="example">
            <h4>Example</h4>
            <div class="example-pair">
              <div>
                <h5>Request</h5>
                <pre><code>${esc(JSON.stringify(m.example.request, null, 2))}</code></pre>
              </div>
              <div>
                <h5>Response</h5>
                <pre><code>${esc(JSON.stringify(m.example.response, null, 2))}</code></pre>
              </div>
            </div>
          </div>`
            : "";
        return `
        <div class="method-card">
          <h3><code>${esc(m.name)}</code></h3>
          <p>${esc(m.description ?? "")}</p>
          ${paramsRows ? `<h4>Parameters</h4><table><thead><tr><th>Name</th><th>Type</th><th>Required</th><th>Description</th></tr></thead><tbody>${paramsRows}</tbody></table>` : ""}
          ${returnsRows ? `<h4>Returns</h4><table><thead><tr><th>Name</th><th>Type</th><th>Description</th></tr></thead><tbody>${returnsRows}</tbody></table>` : ""}
          ${exampleHtml}
        </div>`;
    })
        .join("");
    const endpointsHtml = (card.api ?? [])
        .map((ep) => `<tr>
          <td><span class="method-badge ${ep.method.toLowerCase()}">${esc(ep.method)}</span></td>
          <td><code>${esc(ep.path)}</code></td>
          <td>${esc(ep.description ?? "")}</td>
        </tr>`)
        .join("");
    const envVarsHtml = (card.env_vars ?? [])
        .map((v) => `<li><code>${esc(v)}</code></li>`)
        .join("");
    const configHtml = card.config && Object.keys(card.config).length > 0
        ? `<pre><code>${esc(JSON.stringify(card.config, null, 2))}</code></pre>`
        : '<p class="muted">No configuration defined.</p>';
    const firstMethod = (card.methods ?? [])[0];
    const curlExample = firstMethod?.example?.request
        ? `curl -X POST ${baseUrl || "http://localhost:3000"}/api/a2a \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(firstMethod.example.request)}'`
        : `curl ${baseUrl || "http://localhost:3000"}/health`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(card.name)} — API Documentation</title>
  <style>
    :root {
      --bg: #ffffff; --fg: #1a1a2e; --muted: #6b7280; --border: #e5e7eb;
      --card-bg: #f9fafb; --accent: #6366f1; --accent-light: #eef2ff;
      --code-bg: #f3f4f6; --success: #22c55e; --warning: #f59e0b;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #0f0f23; --fg: #e5e7eb; --muted: #9ca3af; --border: #374151;
        --card-bg: #1a1a2e; --accent: #818cf8; --accent-light: #1e1b4b;
        --code-bg: #1f2937; --success: #4ade80; --warning: #fbbf24;
      }
    }
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: var(--bg); color: var(--fg); line-height: 1.6; }
    .container { max-width: 900px; margin: 0 auto; padding: 2rem 1.5rem; }
    h1 { font-size: 2rem; margin-bottom: 0.25rem; }
    h1 + p { color: var(--muted); margin-bottom: 2rem; font-size: 1.1rem; }
    h2 { font-size: 1.4rem; margin: 2.5rem 0 1rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border); }
    h3 { font-size: 1.1rem; margin-bottom: 0.5rem; }
    h4 { font-size: 0.9rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin: 1rem 0 0.5rem; }
    h5 { font-size: 0.8rem; color: var(--muted); margin-bottom: 0.25rem; }
    p { margin-bottom: 0.75rem; }
    .muted { color: var(--muted); font-style: italic; }
    .badge-row { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 1rem; }
    .version-badge { display: inline-block; padding: 0.2rem 0.6rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; background: var(--accent-light); color: var(--accent); }
    .type-badge { display: inline-block; padding: 0.2rem 0.6rem; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; background: var(--card-bg); color: var(--muted); border: 1px solid var(--border); }
    table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; font-size: 0.9rem; }
    th { text-align: left; padding: 0.5rem 0.75rem; background: var(--card-bg); border: 1px solid var(--border); font-size: 0.8rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.03em; }
    td { padding: 0.5rem 0.75rem; border: 1px solid var(--border); }
    code { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.85em; background: var(--code-bg); padding: 0.15rem 0.35rem; border-radius: 4px; }
    pre { background: var(--code-bg); padding: 1rem; border-radius: 8px; overflow-x: auto; margin-bottom: 1rem; }
    pre code { background: none; padding: 0; font-size: 0.85rem; }
    .method-card { background: var(--card-bg); border: 1px solid var(--border); border-radius: 12px; padding: 1.5rem; margin-bottom: 1rem; }
    .method-badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 700; font-family: monospace; }
    .method-badge.get { background: #dcfce7; color: #166534; }
    .method-badge.post { background: #dbeafe; color: #1e40af; }
    .method-badge.put { background: #fef3c7; color: #92400e; }
    .method-badge.delete { background: #fee2e2; color: #991b1b; }
    @media (prefers-color-scheme: dark) {
      .method-badge.get { background: #14532d; color: #86efac; }
      .method-badge.post { background: #1e3a5f; color: #93c5fd; }
      .method-badge.put { background: #78350f; color: #fcd34d; }
      .method-badge.delete { background: #7f1d1d; color: #fca5a5; }
    }
    .badge { font-size: 0.7rem; padding: 0.1rem 0.4rem; border-radius: 4px; font-weight: 600; }
    .badge.req { background: #fee2e2; color: #991b1b; }
    .badge.opt { background: var(--card-bg); color: var(--muted); border: 1px solid var(--border); }
    @media (prefers-color-scheme: dark) {
      .badge.req { background: #7f1d1d; color: #fca5a5; }
    }
    .example-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    @media (max-width: 640px) { .example-pair { grid-template-columns: 1fr; } }
    ul { list-style: none; padding: 0; }
    ul li { padding: 0.25rem 0; }
    ul li code { font-size: 0.85rem; }
    footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--border); color: var(--muted); font-size: 0.8rem; text-align: center; }
  </style>
</head>
<body>
  <div class="container">
    <h1>${esc(card.name)}</h1>
    <p>${esc(card.description ?? "")}</p>

    <div class="badge-row">
      <span class="version-badge">v${esc(card.version ?? "1.0.0")}</span>
      <span class="type-badge">${esc(card.metadata?.type ?? card.type ?? "agent")}</span>
      <span class="type-badge">${esc(card.protocol ?? "a2a-1.0")}</span>
    </div>

    ${card.config && Object.keys(card.config).length > 0 ? `
    <h2>Configuration</h2>
    ${configHtml}
    ` : ""}

    <h2>Endpoints</h2>
    ${endpointsHtml ? `<table><thead><tr><th>Method</th><th>Path</th><th>Description</th></tr></thead><tbody>${endpointsHtml}</tbody></table>` : '<p class="muted">No endpoints detected.</p>'}

    ${methodsHtml ? `<h2>A2A Methods</h2>${methodsHtml}` : ""}

    ${envVarsHtml ? `<h2>Environment Variables</h2><ul>${envVarsHtml}</ul>` : ""}

    <h2>Quick Start</h2>
    <pre><code>${esc(curlExample)}</code></pre>

    <footer>Generated by Agenxia Platform</footer>
  </div>
</body>
</html>`;
}
//# sourceMappingURL=docs.js.map