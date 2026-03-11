/**
 * Post-build script: reads the Vite-built dashboard/dist/index.html
 * and inlines all referenced CSS and JS files to produce a single self-contained HTML.
 * Then generates a TypeScript module that exports the HTML as a string constant.
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = resolve(__dirname, '..', 'dashboard', 'dist');
const distHtml = resolve(distDir, 'index.html');
const outFile = resolve(__dirname, '..', 'src', 'dashboard-html.ts');

let html;
try {
  html = readFileSync(distHtml, 'utf-8');
} catch (err) {
  console.error('ERROR: dashboard/dist/index.html not found. Run vite build first.');
  process.exit(1);
}

// Find and inline CSS <link> tags
html = html.replace(
  /<link\s+rel="stylesheet"\s+crossorigin\s+href="([^"]+)">/g,
  (match, href) => {
    const cssPath = resolve(distDir, href.replace(/^\/admin\//, ''));
    try {
      const css = readFileSync(cssPath, 'utf-8');
      return `<style>${css}</style>`;
    } catch {
      console.warn(`WARNING: Could not inline CSS: ${cssPath}`);
      return match;
    }
  }
);

// Find and inline JS <script> tags
html = html.replace(
  /<script\s+type="module"\s+crossorigin\s+src="([^"]+)"><\/script>/g,
  (match, src) => {
    const jsPath = resolve(distDir, src.replace(/^\/admin\//, ''));
    try {
      const js = readFileSync(jsPath, 'utf-8');
      return `<script type="module">${js}</script>`;
    } catch {
      console.warn(`WARNING: Could not inline JS: ${jsPath}`);
      return match;
    }
  }
);

// Escape backticks and ${} in the HTML for template literal
const escaped = html.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

const tsSource = `// AUTO-GENERATED - do not edit. Run "npm run build:dashboard" to regenerate.
export const DASHBOARD_HTML = \`${escaped}\`;
`;

writeFileSync(outFile, tsSource, 'utf-8');
const sizeKb = (Buffer.byteLength(html, 'utf-8') / 1024).toFixed(1);
console.log(`Dashboard HTML inlined to ${outFile} (${sizeKb} KB)`);

if (parseFloat(sizeKb) > 200) {
  console.warn(`WARNING: Dashboard HTML exceeds 200KB budget (${sizeKb} KB)`);
}
