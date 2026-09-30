#!/usr/bin/env node
/**
 * npm entry point.
 *
 * Prefers the platform-specific compiled binary published alongside this
 * package, and falls back to running the TypeScript source with Bun when the
 * binary for this platform is not present (which is the case for a plain
 * `npm i` from a git checkout).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { arch, platform } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");

const target = `${platform()}-${arch()}`;
const binary = join(pkgRoot, "bin", `hilbras-code-${target}`);

if (existsSync(binary)) {
  const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  const entry = join(pkgRoot, "src", "cli.ts");
  const child = spawn("bun", [entry, ...process.argv.slice(2)], { stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", () => {
    process.stderr.write(
      `hilbras-code: no prebuilt binary for ${target} and bun was not found.\n` +
        `Install bun (https://bun.sh) or download the release binary for your platform.\n`,
    );
    process.exit(1);
  });
}
