import * as esbuild from "esbuild";
import { cp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.dirname(new URL(import.meta.url).pathname);
const out = path.join(root, "dist");
const watch = process.argv.includes("--watch");

/* Bundling note: Turndown and its GFM plugin must use the *.browser.es.js
 * entries; the default ones `require('@mixmark-io/domino')`, which esbuild
 * cannot resolve. The export file is Markdown, so Turndown (DOM → Markdown,
 * used only for the DOM-fallback path) is the only heavy runtime dependency
 * left — there is no PDF renderer, no KaTeX and no highlight.js. */

const browserOnly = {
  name: "browser-only-entries",
  setup(build) {
    build.onResolve({ filter: /^turndown$/ }, () => ({
      path: path.join(root, "node_modules/turndown/lib/turndown.browser.es.js"),
    }));
    build.onResolve({ filter: /^turndown-plugin-gfm$/ }, () => ({
      path: path.join(root, "node_modules/turndown-plugin-gfm/lib/turndown-plugin-gfm.browser.es.js"),
    }));
  },
};

const common = {
  bundle: true,
  format: "iife",
  target: ["chrome111"],
  platform: "browser",
  legalComments: "none",
  plugins: [browserOnly],
  logLevel: "info",
};

const jobs = [
  { entryPoints: ["src/content/main.js"], outfile: "dist/content.js", ...common },
  { entryPoints: ["src/background.js"], outfile: "dist/background.js", ...common },
  { entryPoints: ["src/export/export.js"], outfile: "dist/export/export.js", ...common },
  { entryPoints: ["src/popup/popup.js"], outfile: "dist/popup/popup.js", ...common },
];

async function copyStatic() {
  await mkdir(path.join(out, "export"), { recursive: true });
  await mkdir(path.join(out, "popup"), { recursive: true });

  for (const [from, to] of [
    ["src/manifest.json", "dist/manifest.json"],
    ["src/export/export.html", "dist/export/export.html"],
    ["src/export/styles.css", "dist/export/styles.css"],
    ["src/popup/popup.html", "dist/popup/popup.html"],
    ["src/popup/popup.css", "dist/popup/popup.css"],
  ]) {
    const source = path.join(root, from);
    if (existsSync(source)) await cp(source, path.join(root, to));
  }
}

async function build() {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  await copyStatic();

  if (watch) {
    const contexts = await Promise.all(jobs.map((job) => esbuild.context(job)));
    await Promise.all(contexts.map((ctx) => ctx.watch()));
    console.log("[build] watching…");
    return;
  }

  await Promise.all(jobs.map((job) => esbuild.build(job)));
  const manifestPath = path.join(out, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  console.log("[build] done → dist/");
}

build().catch((error) => {
  console.error(error);
  process.exit(1);
});