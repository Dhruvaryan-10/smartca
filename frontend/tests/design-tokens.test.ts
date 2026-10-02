// Design-token tests. Pure — reads app/globals.css as text; no browser.
// Guards the foundation in docs/design/tokens.md: text
// pairings meet WCAG AA in both themes, the two dark blocks never drift,
// and every Tailwind colour utility points at a token that exists.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const css = readFileSync(join(__dirname, "..", "app", "globals.css"), "utf8");

/** Declarations of the first rule whose selector is exactly `selector`. */
function block(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `missing rule: ${selector}`);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  const tokens = new Map<string, string>();
  for (const match of css.slice(open + 1, close).matchAll(/(--[\w-]+):\s*([^;]+);/g)) {
    tokens.set(match[1], match[2].trim());
  }
  return tokens;
}

const light = block(":root");
const dark = block(':root[data-theme="dark"]');
const darkMedia = block(':root:not([data-theme="light"])');

function luminance(hex: string): number {
  assert.match(hex, /^#[0-9a-f]{6}$/i, `expected a hex colour, got ${hex}`);
  const n = Number.parseInt(hex.slice(1), 16);
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const SURFACES = ["--background", "--surface", "--surface-elevated", "--surface-sunken"];
const TEXT = [
  "--foreground", "--foreground-secondary", "--foreground-muted", "--primary",
  "--success", "--warning", "--danger", "--info", "--income", "--expense", "--tax",
];

for (const [name, theme] of [["light", light], ["dark", dark]] as const) {
  test(`${name}: every text colour reaches 4.5:1 on every surface`, () => {
    for (const fg of TEXT) {
      for (const bg of SURFACES) {
        const ratio = contrast(theme.get(fg)!, theme.get(bg)!);
        assert.ok(ratio >= 4.5, `${fg} on ${bg} is ${ratio.toFixed(2)}:1`);
      }
    }
  });

  test(`${name}: filled buttons and field edges are legible`, () => {
    const onPrimary = contrast(theme.get("--primary-foreground")!, theme.get("--primary")!);
    assert.ok(onPrimary >= 4.5, `primary-foreground on primary is ${onPrimary.toFixed(2)}:1`);
    const onDanger = contrast(theme.get("--danger-foreground")!, theme.get("--danger")!);
    assert.ok(onDanger >= 4.5, `danger-foreground on danger is ${onDanger.toFixed(2)}:1`);
    // WCAG 1.4.11: control boundaries need 3:1 against adjacent colours.
    for (const bg of SURFACES) {
      const ratio = contrast(theme.get("--field-border")!, theme.get(bg)!);
      assert.ok(ratio >= 3, `field-border on ${bg} is ${ratio.toFixed(2)}:1`);
    }
  });

  test(`${name}: categorical chart colours reach 3:1 on the surface`, () => {
    for (const series of ["--chart-4", "--chart-5", "--chart-6"]) {
      const ratio = contrast(theme.get(series)!, theme.get("--surface")!);
      assert.ok(ratio >= 3, `${series} on surface is ${ratio.toFixed(2)}:1`);
    }
  });
}

test("the explicit and OS-preference dark blocks are identical", () => {
  assert.deepEqual([...darkMedia.entries()], [...dark.entries()]);
});

test("light and dark define the same palette tokens", () => {
  assert.deepEqual([...dark.keys()].sort(), [...light.keys()].sort());
});

test("every Tailwind colour utility resolves to a defined token", () => {
  const defined = new Set<string>();
  for (const match of css.matchAll(/^\s*(--[\w-]+):/gm)) defined.add(match[1]);
  const theme = css.slice(css.indexOf("@theme inline {"));
  const refs = [...theme.matchAll(/--color-[\w-]+:\s*var\((--[\w-]+)\)/g)].map((m) => m[1]);
  assert.ok(refs.length > 30, "expected the colour roles to be mapped");
  for (const ref of refs) assert.ok(defined.has(ref), `--color-* points at undefined ${ref}`);
});

test("reduced motion collapses every duration token", () => {
  const all = new Set<string>();
  for (const match of css.matchAll(/(--duration-[\w-]+):\s*\d/g)) all.add(match[1]);
  assert.ok(all.size >= 5, "expected the duration scale to be defined");
  const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
  for (const token of all) assert.match(reduced, new RegExp(`${token}:\\s*0\\.01ms`), `${token} not reduced`);
});
