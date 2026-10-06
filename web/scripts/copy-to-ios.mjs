// Copies the web build into the iOS app, which loads it from its bundle
// (ios/MyLegacyTape/dist). Run through `npm run build:ios`.
import { cpSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const target = resolve(web, "../ios/MyLegacyTape/dist");

// Hashed bundle names change on every build, so clear the old ones first.
rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(join(web, "dist"), target, { recursive: true });
console.log(`copied ${readdirSync(target).length} entries to ${target}`);
