import * as esbuild from "esbuild";
import { copyFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

async function main() {
  await esbuild.build({
    entryPoints: [join(root, "src", "plugin", "main.ts")],
    outfile: join(root, "dist", "plugin", "main.js"),
    bundle: true,
    platform: "node",
    target: "es2022",
    format: "cjs",
    external: ["obsidian"],
    sourcemap: "inline",
    treeShaking: true,
  });

  const manifestDest = join(root, "dist", "plugin", "manifest.json");
  const manifestSrc = join(root, "manifest.json");
  if (!existsSync(dirname(manifestDest))) {
    mkdirSync(dirname(manifestDest), { recursive: true });
  }
  copyFileSync(manifestSrc, manifestDest);

  console.log("Plugin built: dist/plugin/main.js + manifest.json");
}

main().catch((err) => {
  console.error("Build failed:", err);
  process.exit(1);
});
