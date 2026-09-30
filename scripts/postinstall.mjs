/**
 * postinstall: fetch the compiled binary for this platform, if one was published.
 *
 * The npm tarball ships only the launcher, not an 80MB binary per platform.
 * This downloads the matching release asset into bin/ and leaves the launcher
 * to exec it. When no asset exists (for example an unpublished platform, or an
 * offline install) the launcher falls back to running the TypeScript source
 * with Bun, so the package still works either way.
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

const pkg = require("../package.json");
const REPO = "Hilbras/Hilbras-code";
const RELEASE = process.env.HILBRAS_CODE_VERSION ?? `v${pkg.version}`;

const TARGETS = {
  "linux-x64": { asset: "hilbras-code-linux-x64", ext: "" },
  "linux-arm64": { asset: "hilbras-code-linux-arm64", ext: "" },
  "darwin-x64": { asset: "hilbras-code-darwin-x64", ext: "" },
  "darwin-arm64": { asset: "hilbras-code-darwin-arm64", ext: "" },
  "win32-x64": { asset: "hilbras-code-windows-x64.exe", ext: ".exe" },
};

async function main() {
  if (process.env.HILBRAS_CODE_SKIP_DOWNLOAD === "1") {
    console.log("[hilbras-code] download skipped (HILBRAS_CODE_SKIP_DOWNLOAD=1)");
    return;
  }

  const target = TARGETS[`${process.platform}-${process.arch}`];
  if (!target) {
    console.log(
      `[hilbras-code] no prebuilt binary for ${process.platform}-${process.arch}; ` +
        `hilbras-code will run with Bun.`,
    );
    return;
  }

  const binDir = join(dirname(new URL(import.meta.url).pathname), "..", "bin");
  const outfile = join(binDir, `hilbras-code-${process.platform}-${process.arch}${target.ext}`);

  try {
    await mkdir(binDir, { recursive: true });

    const url =
      `https://github.com/${REPO}/releases/download/${RELEASE}/${target.asset}`;
    const response = await fetch(url, { redirect: "follow" });

    if (!response.ok) {
      // 404 simply means this version has no asset for the platform yet.
      console.log(
        `[hilbras-code] no release asset for ${RELEASE} (${process.platform}-${process.arch}); ` +
          `hilbras-code will run with Bun.`,
      );
      return;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(outfile, bytes);
    if (target.ext === "") await chmod(outfile, 0o755);

    console.log(`[hilbras-code] installed ${target.asset} (${(bytes.length / 1e6).toFixed(1)} MB)`);
  } catch (error) {
    // A failed download must never fail the install: the Bun fallback works.
    console.log(
      `[hilbras-code] could not download the binary (${error instanceof Error ? error.message : String(error)}); ` +
        `hilbras-code will run with Bun.`,
    );
  }
}

await main();
