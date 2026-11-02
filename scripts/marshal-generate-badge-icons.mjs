#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildGeneratedIconAssets,
  GENERATED_ICON_PATHS,
  writeGeneratedIconAssets,
} from "./lib/generated-icon-assets.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  console.log("Generating Marshal icon assets...\n");
  const assets = await buildGeneratedIconAssets(root);
  await writeGeneratedIconAssets(root, assets);
  for (const relativePath of GENERATED_ICON_PATHS) console.log(`  ✓ ${relativePath}`);
  console.log(`\nDone! ${assets.size} Marshal icon assets regenerated.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
