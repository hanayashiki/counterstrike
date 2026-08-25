/**
 * The HUD looks its elements up by id and throws if one is missing, which would
 * take the whole client down at boot. Nothing else checks that the markup and
 * the TypeScript agree, so this does: it is a cheap stand-in for a browser test.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { WEAPONS, getWeapon } from '../src/shared/weapons';

const read = (relative: string): string =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');

const html = read('src/client/index.html');
const hudSource = read('src/client/hud.ts');
const mainSource = read('src/client/main.ts');
const css = read('src/client/styles.css');

const idsInMarkup = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1] as string));

function referencedIds(source: string): string[] {
  const ids = new Set<string>();
  for (const match of source.matchAll(/\bel(?:<[^>]+>)?\('([^']+)'\)/g))
    ids.add(match[1] as string);
  for (const match of source.matchAll(/getElementById\('([^']+)'\)/g)) ids.add(match[1] as string);
  return [...ids];
}

test('every element the HUD looks up exists in the markup', () => {
  const referenced = referencedIds(hudSource);
  assert.ok(referenced.length > 15, `only found ${referenced.length} HUD lookups; regex drifted?`);
  for (const id of referenced) {
    assert.ok(idsInMarkup.has(id), `hud.ts looks up #${id}, which is not in index.html`);
  }
});

test('every element main.ts looks up exists in the markup', () => {
  for (const id of referencedIds(mainSource)) {
    assert.ok(idsInMarkup.has(id), `main.ts looks up #${id}, which is not in index.html`);
  }
});

test('the HUD queries only selectors the markup provides', () => {
  for (const match of hudSource.matchAll(/querySelector\('([^']+)'\)/g)) {
    const selector = match[1] as string;
    // Only class and tag selectors are used; check the class names exist.
    for (const className of selector.matchAll(/\.([a-z-]+)/g)) {
      assert.ok(
        html.includes(`class="${className[1]}"`) ||
          html.includes(`${className[1]} `) ||
          css.includes(`.${className[1]}`),
        `selector ${selector} references .${className[1]}, which is nowhere in the markup or CSS`,
      );
    }
  }
});

test('the crosshair CSS variables the HUD sets are actually used', () => {
  for (const match of hudSource.matchAll(/setProperty\('(--[a-z-]+)'/g)) {
    const variable = match[1] as string;
    assert.ok(css.includes(variable), `hud.ts sets ${variable}, which no rule reads`);
  }
});

test('the menu offers only real weapons', () => {
  const weaponSection = html.slice(html.indexOf('id="menu-weapon"'));
  const options = [...weaponSection.slice(0, 500).matchAll(/data-value="(\d+)"/g)].map((m) =>
    Number(m[1]),
  );
  assert.ok(options.length >= 3, 'expected at least three primary choices');
  for (const id of options) {
    assert.ok(id >= 0 && id < WEAPONS.length, `menu offers weapon id ${id}, which does not exist`);
    assert.ok(getWeapon(id).name.length > 0);
  }
});

test('the menu team choices match the team ids the protocol uses', () => {
  const teamSection = html.slice(html.indexOf('id="menu-team"'));
  const values = [...teamSection.slice(0, 400).matchAll(/data-value="(-?\d+)"/g)].map((m) =>
    Number(m[1]),
  );
  assert.deepEqual(values, [-1, 0, 1], 'auto, red, blue');
});

test('the client entry point is referenced by the markup', () => {
  assert.ok(html.includes('./main.ts'), 'index.html must load the module entry point');
  assert.ok(html.includes('./styles.css'), 'index.html must load the stylesheet');
  assert.ok(html.includes('id="viewport"'), 'the renderer needs its canvas');
});
