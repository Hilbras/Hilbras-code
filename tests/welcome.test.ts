import { describe, expect, test } from "bun:test";
import { LOGO_ROWS, logoWidth, plainLogo } from "../src/tui/logo.ts";
import { darkColors } from "../src/tui/theme.ts";
import { TITLE, type WelcomeInfo, renderWelcome } from "../src/tui/welcome.ts";
import { padToWidth, stripAnsi, truncateToWidth, visibleWidth } from "../src/tui/width.ts";

const info: WelcomeInfo = {
  version: "0.1.0",
  workspace: "/home/gin/work/project",
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  isLoggedOut: false,
};

const render = (width: number, override: Partial<WelcomeInfo> = {}) =>
  renderWelcome({ ...info, ...override }, { width, palette: darkColors });

/** Every rendered line must be exactly `width` columns once colour is removed. */
function assertBoxIntegrity(lines: string[], width: number) {
  const box = lines.filter((line) => /[╭│╰]/.test(stripAnsi(line)));
  for (const line of box) {
    expect(visibleWidth(line)).toBe(width);
  }
}

describe("width helpers", () => {
  test("visibleWidth ignores ANSI escapes", () => {
    expect(visibleWidth("[38;2;79;168;255mhello[0m")).toBe(5);
  });

  test("visibleWidth counts wide characters as two columns", () => {
    expect(visibleWidth("日本")).toBe(4);
    expect(visibleWidth("abc")).toBe(3);
  });

  test("truncateToWidth leaves short text untouched", () => {
    expect(truncateToWidth("hello", 10)).toBe("hello");
  });

  test("truncateToWidth clips and appends an ellipsis", () => {
    const out = truncateToWidth("abcdefghij", 5);
    expect(visibleWidth(out)).toBe(5);
    expect(stripAnsi(out)).toBe("abcd…");
  });

  test("truncateToWidth never exceeds the budget for coloured text", () => {
    const coloured = "[38;2;79;168;255mabcdefghij[0m";
    const out = truncateToWidth(coloured, 5);
    expect(visibleWidth(out)).toBe(5);
    expect(stripAnsi(out)).toBe("abcd…");
    // The reset must survive so colour does not bleed into the border.
    expect(out).toContain("[0m");
  });

  test("truncateToWidth handles a budget smaller than the ellipsis", () => {
    expect(visibleWidth(truncateToWidth("abcdef", 1))).toBeLessThanOrEqual(1);
  });

  test("padToWidth pads to an exact visible width", () => {
    expect(visibleWidth(padToWidth("ab", 5))).toBe(5);
    expect(visibleWidth(padToWidth("[31mab[0m", 5))).toBe(5);
  });
});

describe("logo", () => {
  test("has two rows of equal visible width", () => {
    expect(LOGO_ROWS).toHaveLength(2);
    const widths = LOGO_ROWS.map((row) => visibleWidth(row));
    expect(new Set(widths).size).toBe(1);
  });

  test("rows read as a capital H", () => {
    // Two separated stems on top, a solid bar below.
    expect(stripAnsi(LOGO_ROWS[0] ?? "")).toBe("██ ██");
    expect(stripAnsi(LOGO_ROWS[1] ?? "")).toBe("█████");
  });

  test("plainLogo pads every row to the same width", () => {
    const rows = plainLogo();
    const widths = rows.map((row) => visibleWidth(row));
    expect(new Set(widths).size).toBe(1);
    expect(widths[0]).toBe(logoWidth());
  });
});

describe("renderWelcome", () => {
  test("draws a closed box at a normal width", () => {
    const lines = render(60);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("╭");
    expect(text).toContain("╰");
    assertBoxIntegrity(lines, 60);
  });

  test("shows the title, and the title is the Hilbras one", () => {
    const lines = render(60).map(stripAnsi);
    expect(TITLE).toBe("Welcome to Hilbras Code!");
    expect(lines.some((line) => line.includes(TITLE))).toBe(true);
    expect(lines.some((line) => line.includes("Kimi"))).toBe(false);
  });

  test("includes the logo rows", () => {
    const lines = render(60).map(stripAnsi);
    for (const row of plainLogo()) {
      expect(lines.some((line) => line.includes(row.trimEnd()))).toBe(true);
    }
  });

  test("lists the real session facts", () => {
    const text = render(60).map(stripAnsi).join("\n");
    expect(text).toContain("Directory:");
    expect(text).toContain("/home/gin/work/project");
    expect(text).toContain("Provider:");
    expect(text).toContain("anthropic");
    expect(text).toContain("Model:");
    expect(text).toContain("Version:");
    expect(text).toContain("0.1.0");
  });

  test("omits the MCP row when no summary is supplied", () => {
    expect(render(60).map(stripAnsi).join("\n")).not.toContain("MCP:");
  });

  test("shows the MCP row when a summary is supplied", () => {
    const text = render(60, { mcpSummary: "2 servers" }).map(stripAnsi).join("\n");
    expect(text).toContain("MCP:");
    expect(text).toContain("2 servers");
  });

  test("label values line up in one column", () => {
    const lines = render(60).map(stripAnsi);
    const rows = lines.filter((line) => /Directory:|Provider:|Model:|Version:/.test(line));
    expect(rows).toHaveLength(4);

    // Every value must start at the same visible offset. Padding is what
    // achieves this, so a duplicated or unpadded label shows up as a mismatch.
    const valueOffsets = rows.map((line) => {
      const match = /(Directory|Provider|Model|Version):/.exec(line);
      if (!match) throw new Error(`no label in: ${line}`);
      return line.indexOf(`${match[1]}:`) + 11;
    });
    expect(new Set(valueOffsets).size).toBe(1);
  });

  test("no label is rendered twice", () => {
    const text = render(60).map(stripAnsi).join("\n");
    for (const label of ["Directory:", "Provider:", "Model:", "Version:"]) {
      const occurrences = text.split(label).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  test("the value follows its label directly, with no separator", () => {
    const lines = render(60).map(stripAnsi);
    const modelRow = lines.find((line) => line.includes("Model:"));
    expect(modelRow).toContain("Model:     claude-sonnet-4-5");
  });

  test("a long workspace path is clipped, and the box survives", () => {
    const long = `/very/long/path/${"segment/".repeat(40)}project`;
    const lines = render(60, { workspace: long });
    const text = lines.map(stripAnsi).join("\n");
    expect(text).toContain("…");
    expect(text).not.toContain(long);
    assertBoxIntegrity(lines, 60);
  });

  test("a long model name is clipped without breaking the border", () => {
    const lines = render(50, { model: "some/extremely-long-model-identifier-that-keeps-going" });
    assertBoxIntegrity(lines, 50);
  });

  test("falls back to a compact layout on a narrow terminal", () => {
    const lines = render(20);
    const text = lines.map(stripAnsi).join("\n");
    expect(text).not.toContain("╭");
    expect(text).not.toContain("│");
    // At 20 columns the title cannot fit whole; it must still start with it.
    expect(text).toContain("Welcome to Hilbras");
    // And no stray label may leak into the model row.
    expect(text).not.toContain("Directory:");
  });

  test("a narrow terminal still shows the title whole when it fits", () => {
    // The title is 25 columns, so the box needs ~31 before truncation.
    const text = render(40).map(stripAnsi).join("\n");
    expect(text).toContain(TITLE);
  });

  test("every line fits the requested width", () => {
    for (const width of [24, 30, 40, 60, 80, 120]) {
      for (const line of render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  test("logged-out state warns instead of showing a model", () => {
    const text = render(60, { isLoggedOut: true }).map(stripAnsi).join("\n");
    expect(text).toContain("No API key");
    expect(text).toContain("not set");
  });

  test("a zero-width request does not throw", () => {
    expect(() => renderWelcome(info, { width: 0, palette: darkColors })).not.toThrow();
  });
});
