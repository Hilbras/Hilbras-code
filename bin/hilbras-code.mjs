#!/usr/bin/env node
/**
 * npm entry point.
 *
 * Prefers the platform binary fetched by scripts/postinstall.mjs. When it is
 * absent (unsupported platform, skipped or failed download) this runs the
 * TypeScript source with Bun instead, so `npm i -g` always yields a working
 * command.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const ext = platform() === "win32" ? ".exe" : "";
const binary = join(pkgRoot, "bin", `hilbras-code-${platform()}-${arch()}${ext}`);

function run(command, args) {
  const child = spawn(command, args, { stdio: "inherit" });
  child.on("error", () => {
    if (command === "bun") {
      process.stderr.write(
        `hilbras-code: no prebuilt binary for ${platform()}-${arch()} and bun was not found.\n` +
          `Install bun (https://bun.sh), or download the release binary manually.\n`,
      );
      process.exit(1);
    }
    process.exit(1);
  });
  child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
}

if (existsSync(binary)) {
  run(binary, process.argv.slice(2));
} else {
  run("bun", [join(pkgRoot, "src", "cli.ts"), ...process.argv.slice(2)]);
}
