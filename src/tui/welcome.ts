/**
 * The welcome panel shown at the top of an interactive session.
 *
 * Renders a round-bordered box containing the logo, the title, and a labelled
 * info block. Every line is truncated to the terminal's visible width so a long
 * path clips with an ellipsis instead of breaking the right border.
 */

import { logoWidth, renderLogo } from "./logo.ts";
import { type ColorPalette, bold, currentTheme, fg } from "./theme.ts";
import { padToWidth, truncateToWidth, visibleWidth } from "./width.ts";

export const TITLE = "Welcome to Hilbras Code!";

/** Below this width the box is dropped for a compact layout. */
const MIN_BOX_WIDTH = 24;

const BORDER_PAD = "  ";

export interface WelcomeInfo {
  version: string;
  workspace: string;
  provider: string;
  model: string;
  /** Rendered only when present; MCP support is not in every build. */
  mcpSummary?: string;
  /** True when no API key resolved, which changes the hint text. */
  isLoggedOut: boolean;
}

export interface RenderOptions {
  width: number;
  /** Overrides the theme palette, for tests. */
  palette?: ColorPalette;
}

/**
 * Label column width, so every value starts at the same offset. One space of
 * breathing room after the colon keeps the longest label from touching its value.
 */
const LABEL_WIDTH = 11;

export function renderWelcome(info: WelcomeInfo, options: RenderOptions): string[] {
  const palette = options.palette ?? currentTheme();
  const width = Math.max(0, Math.trunc(options.width));
  const paint = fg(palette.primary);

  if (width < MIN_BOX_WIDTH) {
    return renderCompact(info, width, palette);
  }

  const innerWidth = Math.max(1, width - 4);
  const logo = renderLogo({ palette });
  const logoW = logoWidth();
  const gap = "  ";
  const textWidth = Math.max(4, innerWidth - logoW - gap.length);

  const title = truncateToWidth(bold(fg(palette.primary)(TITLE)), textWidth);
  const hint = truncateToWidth(
    fg(palette.textDim)(info.isLoggedOut ? hintLoggedOut() : hintReady()),
    textWidth,
  );

  const header = [`${logo[0] ?? ""}${gap}${title}`, `${logo[1] ?? ""}${gap}${hint}`];

  const rows: [string, string][] = [
    ["Directory:", info.workspace],
    ["Provider:", info.provider],
    ["Model:", info.isLoggedOut ? fg(palette.warning)("not set") : info.model],
    ["Version:", info.version],
  ];
  if (info.mcpSummary) rows.push(["MCP:", info.mcpSummary]);

  const infoLines = rows.map(
    ([key, value]) =>
      `${bold(fg(palette.textDim)(key))}${padToWidth("", LABEL_WIDTH - key.length)}${value}`,
  );

  const content = [...header, "", ...infoLines];

  const lines: string[] = [
    "",
    paint(`╭${"─".repeat(Math.max(0, width - 2))}╮`),
    paint(`│${" ".repeat(Math.max(0, width - 2))}│`),
  ];

  for (const line of content) {
    lines.push(boxLine(line, innerWidth, palette));
  }

  lines.push(paint(`│${" ".repeat(Math.max(0, width - 2))}│`));
  lines.push(paint(`╰${"─".repeat(Math.max(0, width - 2))}╯`));
  lines.push("");

  return lines.map((line) => truncateToWidth(line, width));
}

function renderCompact(info: WelcomeInfo, width: number, palette: ColorPalette): string[] {
  // The label column only makes sense if the value still fits beside it.
  // Below that, drop the padding rather than clip the value away.
  const modelValue = info.isLoggedOut ? fg(palette.warning)("not set") : info.model;
  const modelLabel = bold(fg(palette.textDim)("Model:"));
  const gap = padToWidth("", LABEL_WIDTH - "Model:".length);
  const padded = `${modelLabel}${gap}${modelValue}`;
  const modelLine = visibleWidth(padded) <= width ? padded : `${modelLabel} ${modelValue}`;

  const rows = [
    "",
    bold(fg(palette.primary)(TITLE)),
    fg(palette.textDim)(info.isLoggedOut ? hintLoggedOut() : hintReady()),
    modelLine,
  ];
  return rows.map((line) => truncateToWidth(line, width));
}

function boxLine(content: string, innerWidth: number, palette: ColorPalette): string {
  const border = fg(palette.primary);
  const truncated = truncateToWidth(content, innerWidth - BORDER_PAD.length);
  const padding = " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated)));
  return `${border("│")}${BORDER_PAD}${truncated}${padding}${border("│")}`;
}

/** Hint shown when a provider and model are configured. */
function hintReady(): string {
  return "Type a task, or /help for help information.";
}

function hintLoggedOut(): string {
  return "No API key found. Set one, or use a local runtime.";
}
