import { build, context } from "esbuild";
import { cpSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outdir = path.join(__dirname, "dist");
const watch = process.argv.includes("--watch");

// Static files are copied as-is into dist/ next to the bundled JS so the
// whole dist/ folder can be loaded directly as an unpacked extension.
const staticFiles = [
  ["manifest.json", "manifest.json"],
  ["src/content.css", "content.css"],
  ["src/popup/popup.html", "popup.html"],
  ["src/popup/popup.css", "popup.css"],
];

function copyStaticFiles() {
  for (const [from, to] of staticFiles) {
    cpSync(path.join(__dirname, from), path.join(outdir, to));
  }
}

function prepareOutdir() {
  if (existsSync(outdir)) {
    rmSync(outdir, { recursive: true, force: true });
  }
  mkdirSync(outdir, { recursive: true });
}

const buildOptions = {
  entryPoints: {
    content: path.join(__dirname, "src/content.ts"),
    "network-interceptor": path.join(__dirname, "src/network-interceptor.ts"),
    popup: path.join(__dirname, "src/popup/popup.ts"),
  },
  outdir,
  bundle: true,
  format: "iife",
  target: ["chrome110"],
  sourcemap: true,
  logLevel: "info",
};

prepareOutdir();
copyStaticFiles();

if (watch) {
  const ctx = await context(buildOptions);
  await ctx.watch();
  console.log("Watching for changes... (static files are only copied once per run)");
} else {
  await build(buildOptions);
}
