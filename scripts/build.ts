/**
 * Cross-platform build: `bun build --compile` per target.
 *
 * `bun build --compile` embeds the Bun runtime, so the artifact runs on a
 * machine with no Node and no Bun installed. That is the whole reason the
 * stack is Bun and not Node.
 */
import { $ } from "bun";

interface Target {
  name: string;
  bunTarget: string;
}

const TARGETS: Target[] = [
  { name: "linux-x64", bunTarget: "bun-linux-x64" },
  { name: "linux-arm64", bunTarget: "bun-linux-arm64" },
  { name: "darwin-x64", bunTarget: "bun-darwin-x64" },
  { name: "darwin-arm64", bunTarget: "bun-darwin-arm64" },
  { name: "windows-x64", bunTarget: "bun-windows-x64" },
];

const args = process.argv.slice(2);
const all = args.includes("--all") || process.env.HILBRAS_BUILD_ALL === "1";
const requested = args.find((arg) => !arg.startsWith("-"));

const host = `${process.platform}-${process.arch}`;
const targets = all ? TARGETS : TARGETS.filter((t) => t.name === (requested ?? host));

if (targets.length === 0) {
  console.error(`unknown target "${requested}". known: ${TARGETS.map((t) => t.name).join(", ")}`);
  process.exit(1);
}

await Bun.write(
  ".gitignore",
  await Bun.file(".gitignore")
    .text()
    .catch(() => "node_modules\ndist\n*.log\n"),
);

for (const target of targets) {
  const outfile =
    target.name === "windows-x64"
      ? `bin/hilbras-code-${target.name}.exe`
      : `bin/hilbras-code-${target.name}`;
  console.log(`building ${outfile} (${target.bunTarget})`);
  await $`bun build src/cli.ts --compile --target ${target.bunTarget} --outfile ${outfile}`.quiet();
}

console.log(`\nbuilt ${targets.length} binary/binar${targets.length === 1 ? "y" : "ies"}`);
