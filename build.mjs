// Baut Schach-Anki.
//   node build.mjs            → dist/          eigenständige Website (GitHub Pages, installierbar)
//   node build.mjs artifact   → dist-artifact/ Version für das claude.ai-Artefakt
import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, readdirSync, rmSync } from 'fs';

const target = process.argv[2] === 'artifact' ? 'artifact' : 'web';
const WEB = target === 'web';
const out = WEB ? 'dist' : 'dist-artifact';
const version = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// Supabase nur in der Website; claude.ai bekommt einen Platzhalter, Tests einen Nachbau
const cloudFile = process.env.MOCK_CLOUD ? 'cloud-mock.js' : WEB ? 'cloud.js' : 'cloud-stub.js';
const cloudPlugin = {
  name: 'cloud',
  setup(b) { b.onResolve({ filter: /^\.\/cloud\.js$/ }, () => ({ path: new URL('./src/' + cloudFile, import.meta.url).pathname })); },
};
const res = await build({
  entryPoints: ['src/app.js'], bundle: true, minify: true, format: 'iife', write: false, target: 'es2020',
  define: { __WEB__: String(WEB) }, plugins: [cloudPlugin],
});
const js = res.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const cgCss = ['base', 'brown', 'cburnett'].map((n) => readFileSync(`node_modules/chessground/assets/chessground.${n}.css`, 'utf8')).join('\n');
const css = cgCss + '\n' + readFileSync('src/styles.css', 'utf8');

const pwaHead = WEB ? `
<meta name="theme-color" content="#16130f">
<meta name="description" content="Schacheröffnungen mit Karteikarten-Prinzip lernen – mit Eröffnungsdatenbank, Stockfish und Sparring.">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" type="image/png" sizes="192x192" href="icons/icon-192.png">
<link rel="apple-touch-icon" href="icons/icon-192.png">` : '';

const html = `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Schach-Anki</title>${pwaHead}
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
${css}
</style>
</head>
<body>
<header class="top">
  <button id="logo" aria-label="Zur Übersicht"><span class="mark">♞</span><span class="word">Schach-Anki</span></button>
  <nav class="mainnav"><button data-view="home" class="on">Training</button><button data-view="spar">Sparring</button></nav>
  <span class="spacer"></span>
  <span id="save-state"></span>
  <span id="storage" class="status"></span>${WEB ? '\n  <button id="account-btn" class="btn small account-btn">Anmelden</button>' : ''}
  <button id="settings-btn" class="icon-btn" title="Einstellungen" aria-label="Einstellungen">⚙</button>
</header>
<main id="main"></main>
<script>
${js}
</script>
</body>
</html>
`;
writeFileSync(`${out}/index.html`, html);

// Engine
mkdirSync(`${out}/engine`, { recursive: true });
for (const f of ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm', 'stockfish-19-asm.js']) copyFileSync('node_modules/stockfish/bin/' + f, `${out}/engine/${f}`);

// Eröffnungsdatenbank und Namen
mkdirSync(`${out}/db`, { recursive: true });
for (const f of readdirSync('public/db')) copyFileSync('public/db/' + f, `${out}/db/${f}`);

if (WEB) {
  mkdirSync(`${out}/icons`, { recursive: true });
  for (const f of readdirSync('public/icons')) copyFileSync('public/icons/' + f, `${out}/icons/${f}`);
  copyFileSync('public/manifest.webmanifest', `${out}/manifest.webmanifest`);
  writeFileSync(`${out}/sw.js`, readFileSync('src/sw.js', 'utf8').replace('__VERSION__', version));
  writeFileSync(`${out}/.nojekyll`, '');
}
console.log(`${target}: ${out}/index.html ${(html.length / 1024).toFixed(1)} KB, Version ${version}`);
