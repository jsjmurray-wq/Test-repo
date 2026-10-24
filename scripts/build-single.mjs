// Inlines style.css, every ES module reachable from src/main.js, the manifest and the icons into
// one self-contained HTML file: dist/pool8.html. No dependencies.
//
// Each module is wrapped in its own function scope:
//   const __m_physics = (() => { const { TABLE } = __m_table; ...; return { World, simulateShot }; })();
// so modules may reuse private names. Modules must follow the style rule in docs/architecture.md.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');

const IMPORT_RE = /^\s*import\s*\{([^}]*)\}\s*from\s*['"]\.\/([\w-]+)\.js['"]\s*;?[ \t]*$/gm;
const EXPORT_RE = /^export\s+(async\s+function\*?|function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;

function loadModule(name, seen, order, stack) {
  if (seen.has(name)) return;
  if (stack.includes(name)) throw new Error(`circular import: ${[...stack, name].join(' -> ')}`);
  const file = join(srcDir, `${name}.js`);
  const code = readFileSync(file, 'utf8');
  if (/^\s*export\s+(default|\{|\*)/m.test(code)) throw new Error(`${name}.js: unsupported export form`);
  if (/^\s*import\s+(\*|[A-Za-z_$])/m.test(code) || /\bimport\(/.test(code)) {
    throw new Error(`${name}.js: unsupported import form`);
  }
  const deps = [];
  for (const m of code.matchAll(IMPORT_RE)) deps.push(m[2]);
  for (const d of deps) loadModule(d, seen, order, [...stack, name]);
  seen.add(name);
  order.push({ name, code });
}

function transform({ name, code }) {
  const exportsList = [];
  let body = code.replace(IMPORT_RE, (_, names, from) => {
    const spec = names
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => s.replace(/\s+as\s+/, ': '))
      .join(', ');
    return `const { ${spec} } = __m_${from.replace(/-/g, '_')};`;
  });
  body = body.replace(EXPORT_RE, (_, kind, id) => {
    exportsList.push(id);
    return `${kind} ${id}`;
  });
  const v = `__m_${name.replace(/-/g, '_')}`;
  return `// ---- src/${name}.js ----\nconst ${v} = (() => {\n${body}\nreturn { ${exportsList.join(', ')} };\n})();\n`;
}

function dataUrl(path, mime) {
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
}

export function build() {
  const order = [];
  loadModule('main', new Set(), order, []);
  const bundle = `"use strict";\n${order.map(transform).join('\n')}`;

  let html = readFileSync(join(root, 'index.html'), 'utf8');
  const css = readFileSync(join(root, 'style.css'), 'utf8');
  html = html.replace(/<link[^>]+href=["']style\.css["'][^>]*>/, () => `<style>\n${css}\n</style>`);
  html = html.replace(
    /<script\s+type=["']module["']\s+src=["']src\/main\.js["']\s*>\s*<\/script>/,
    () => `<script type="module">\n${bundle.replace(/<\/script/gi, '<\\/script')}\n</script>`,
  );

  // Icons and manifest as data URLs so the single file has no siblings.
  const icon180 = join(root, 'icons/icon-180.png');
  if (existsSync(icon180)) {
    const url180 = dataUrl(icon180, 'image/png');
    html = html.replace(/(<link[^>]+rel=["']apple-touch-icon["'][^>]+href=)["'][^"']+["']/, `$1"${url180}"`);
  }
  const manifestPath = join(root, 'manifest.webmanifest');
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.start_url = '.';
    // Only the small icon is embedded to keep the single file light; iOS uses apple-touch-icon anyway.
    if (existsSync(icon180)) {
      manifest.icons = [{ src: dataUrl(icon180, 'image/png'), sizes: '180x180', type: 'image/png' }];
    }
    const murl = `data:application/manifest+json;base64,${Buffer.from(JSON.stringify(manifest)).toString('base64')}`;
    html = html.replace(/(<link[^>]+rel=["']manifest["'][^>]+href=)["'][^"']+["']/, `$1"${murl}"`);
  }

  if (!html.includes('__m_main')) throw new Error('main module script tag not found in index.html');
  mkdirSync(join(root, 'dist'), { recursive: true });
  const out = join(root, 'dist/pool8.html');
  writeFileSync(out, html);
  const artifactOut = join(root, 'dist/pool8-artifact.html');
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
