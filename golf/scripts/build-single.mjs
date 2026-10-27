// Inlines style.css, every ES module reachable from src/main.js, the manifest and the icons into
// one self-contained HTML file: dist/golf.html (plus dist/golf-artifact.html for a claude.ai
// Artifact). No dependencies.
//
// Each module is wrapped in its own function scope:
//   const __m_physics = (() => { const { SURF } = __m_constants; ...; return { simulateShot }; })();
// so modules may reuse private names. Modules must follow the style rule in docs/architecture.md.
//
// Usage: node scripts/build-single.mjs
// build(overrides) merges overrides into CONFIG (tests use { entry, outDir }).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- CONFIG
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..'); // golf/
export const CONFIG = Object.freeze({
  root: ROOT,
  srcDir: 'src', // every module lives directly in here
  entry: 'main', // src/<entry>.js; the <script type="module" src="src/..."> tag is replaced
  html: 'index.html',
  css: 'style.css',
  manifest: 'manifest.webmanifest',
  icon: 'icons/icon-180.png', // apple-touch-icon + the only manifest icon in the single file
  outDir: 'dist',
  out: 'golf.html',
  artifactOut: 'golf-artifact.html',
});

const IMPORT_RE = /^\s*import\s*\{([^}]*)\}\s*from\s*['"]\.\/([\w-]+)\.js['"]\s*;?[ \t]*$/gm;
const EXPORT_RE = /^export\s+(async\s+function\*?|function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

function loadModule(srcDir, name, seen, order, stack) {
  if (seen.has(name)) return;
  if (stack.includes(name)) throw new Error(`circular import: ${[...stack, name].join(' -> ')}`);
  const file = join(srcDir, `${name}.js`);
  const code = readFileSync(file, 'utf8');
  if (/^\s*export\s+(default|\{|\*)/m.test(code)) throw new Error(`${name}.js: unsupported export form`);
  if (/^\s*import\s+(\*|[A-Za-z_$])/m.test(code) || /\bimport\(/.test(code)) {
    throw new Error(`${name}.js: unsupported import form`);
  }
  if (/^\s*await\s/m.test(code)) throw new Error(`${name}.js: top-level await is not supported`);
  const deps = [];
  for (const m of code.matchAll(IMPORT_RE)) deps.push(m[2]);
  for (const d of deps) loadModule(srcDir, d, seen, order, [...stack, name]);
  seen.add(name);
  order.push({ name, code });
}

const modVar = (name) => `__m_${name.replace(/-/g, '_')}`;

function transform({ name, code }) {
  const exportsList = [];
  let body = code.replace(IMPORT_RE, (_, names, from) => {
    const spec = names
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/\s+as\s+/, ': '))
      .join(', ');
    return `const { ${spec} } = ${modVar(from)};`;
  });
  body = body.replace(EXPORT_RE, (_, kind, id) => {
    exportsList.push(id);
    return `${kind} ${id}`;
  });
  return `// ---- src/${name}.js ----\nconst ${modVar(name)} = (() => {\n${body}\nreturn { ${exportsList.join(', ')} };\n})();\n`;
}

function dataUrl(path, mime) {
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
}

export function build(overrides = {}) {
  const C = { ...CONFIG, ...overrides };
  const at = (p) => (isAbsolute(p) ? p : join(C.root, p));
  const order = [];
  loadModule(at(C.srcDir), C.entry, new Set(), order, []);
  const bundle = `"use strict";\n${order.map(transform).join('\n')}`;

  let html = readFileSync(at(C.html), 'utf8');
  const css = readFileSync(at(C.css), 'utf8');
  html = html.replace(/<link[^>]+href=["']style\.css["'][^>]*>/, () => `<style>\n${css}\n</style>`);
  const scriptRe = new RegExp(
    `<script\\s+type=["']module["']\\s+src=["']${C.srcDir}/${C.entry}\\.js["']\\s*>\\s*</script>`,
  );
  if (!scriptRe.test(html)) throw new Error(`${C.html}: <script type="module" src="${C.srcDir}/${C.entry}.js"> not found`);
  html = html.replace(scriptRe, () => `<script type="module">\n${bundle.replace(/<\/script/gi, '<\\/script')}\n</script>`);

  // Icons and manifest as data URLs so the single file has no siblings.
  const icon = at(C.icon);
  if (existsSync(icon)) {
    const url = dataUrl(icon, 'image/png');
    html = html.replace(/(<link[^>]+rel=["']apple-touch-icon["'][^>]+href=)["'][^"']+["']/, `$1"${url}"`);
  }
  const manifestPath = at(C.manifest);
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.start_url = '.';
    // Only the small icon is embedded to keep the single file light; iOS uses apple-touch-icon anyway.
    if (existsSync(icon)) manifest.icons = [{ src: dataUrl(icon, 'image/png'), sizes: '180x180', type: 'image/png' }];
    const murl = `data:application/manifest+json;base64,${Buffer.from(JSON.stringify(manifest)).toString('base64')}`;
    html = html.replace(/(<link[^>]+rel=["']manifest["'][^>]+href=)["'][^"']+["']/, `$1"${murl}"`);
  }

  if (!html.includes(modVar(C.entry))) throw new Error('entry module missing from the bundle');
  const outDir = at(C.outDir);
  mkdirSync(outDir, { recursive: true });
  const out = join(outDir, C.out);
  writeFileSync(out, html);
  const artifactOut = join(outDir, C.artifactOut);
  writeFileSync(artifactOut, artifactPage(html));
  return { out, artifactOut, modules: order.map((m) => m.name), bytes: Buffer.byteLength(html) };
}

// Variant for a claude.ai Artifact: the host wraps the page in its own doctype/html/head/body
// skeleton (with a viewport meta) and blocks the manifest fetch, so only the page content goes in.
function artifactPage(html) {
  const head = html.slice(html.indexOf('<head>') + 6, html.indexOf('</head>'));
  const bodyOpen = html.match(/<body[^>]*>/);
  const body = html.slice(bodyOpen.index + bodyOpen[0].length, html.lastIndexOf('</body>'));
  const pick = (re) => (head.match(re) || [''])[0];
  const title = pick(/<title>[\s\S]*?<\/title>/);
  const icon = pick(/<link[^>]+rel=["']icon["'][^>]*>/);
  const theme = pick(/<meta[^>]+name=["']theme-color["'][^>]*>/);
  const style = pick(/<style>[\s\S]*?<\/style>/);
  const script = pick(/<script type="module">[\s\S]*<\/script>/);
  if (!title || !style || !script) throw new Error('artifact build: missing title, style or script');
  // Set the layout before first paint (ui.applyLayout() takes over once the module runs).
  const layout =
    '<script>(function(){var a=innerWidth/Math.max(1,innerHeight);' +
    "document.body.dataset.layout=a>=1.25?'landscape':a<=0.8?'portrait':'square';})();</script>";
  return [title, icon, theme, style, layout, body.trim(), script, ''].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = build();
  console.log(`wrote ${r.out} (${(r.bytes / 1024).toFixed(1)} KB) and ${r.artifactOut}; modules: ${r.modules.join(', ')}`);
}
