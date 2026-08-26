/**
 * Folds the built viewer into a single self-contained page: the JS bundle is
 * inlined, styles are inlined, and the document wrapper is dropped so the file
 * can be published as an Artifact (which supplies its own wrapper and forbids
 * any external request).
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

const dist = 'dist/viewer';
const html = readFileSync(`${dist}/index.html`, 'utf8');
const jsName = readdirSync(`${dist}/assets`).find((f) => f.endsWith('.js'));
if (!jsName) throw new Error('no bundle found - run the viewer build first');

// A `</script>` inside a string literal would close the tag early.
const js = readFileSync(`${dist}/assets/${jsName}`, 'utf8').replaceAll(
  '</script',
  String.raw`<\/script`,
);

const body = html
  .slice(html.indexOf('<body>') + 6, html.indexOf('</body>'))
  .replace(/<script[^>]*><\/script>/g, '')
  .trim();

const styles = readFileSync('src/viewer/styles.css', 'utf8');

// A single file has to carry its own assets: every model travels inline, and
// is parsed from the payload rather than fetched, because a sandboxed page will
// refuse a fetch even of a `data:` URI.
const models = {};
try {
  for (const file of readdirSync('src/client/public/models')) {
    if (!file.endsWith('.glb')) continue;
    const glb = readFileSync(`src/client/public/models/${file}`);
    models[file] = glb.toString('base64');
    console.log(`  inlined ${file} (${(glb.length / 1024 / 1024).toFixed(2)} MB)`);
  }
} catch {
  console.log('no models directory; the viewer will show procedural figures only');
}
const modelGlobal =
  Object.keys(models).length > 0
    ? `<script>globalThis.__MODELS__ = ${JSON.stringify(models)};</script>\n`
    : '';

const page = `<title>cs_grid — operator models</title>

<style>
${styles}</style>

${body}

${modelGlobal}<script type="module">
${js}
</script>
`;

writeFileSync('dist/viewer/standalone.html', page);
console.log(`packed -> dist/viewer/standalone.html (${(page.length / 1024).toFixed(0)} KB)`);
console.log(`open it with:  open ${process.cwd()}/dist/viewer/standalone.html`);
