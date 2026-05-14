const { readFileSync, writeFileSync } = require("fs");
const { join } = require("path");

const root = join(__dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf-8"));

if (manifest.version !== pkg.version) {
  manifest.version = pkg.version;
  writeFileSync(join(root, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Synced manifest.json version to ${pkg.version}`);
}
