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

const page = `<title>cs_grid — operator models</title>

<style>
${styles}</style>

${body}

<script type="module">
${js}
</script>
`;

writeFileSync('dist/viewer/standalone.html', page);
console.log(`packed -> dist/viewer/standalone.html (${(page.length / 1024).toFixed(0)} KB)`);
