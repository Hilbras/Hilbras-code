/**
 * The Hilbras Code logo.
 *
 * A two-line block "H", sized to sit beside the title in the welcome box. Every
 * glyph is a single-column block character, so `visibleWidth` counts each row
 * correctly without wide-character handling.
 */

import { fg } from "./theme.ts";
import { currentTheme } from "./theme.ts";
import type { ColorPalette } from "./theme.ts";

/** Logo rows, unstyled. Exported so tests can assert the shape. */
export const LOGO_ROWS: readonly string[] = ["██ ██", "█████"];

export function logoWidth(): number {
  return Math.max(...LOGO_ROWS.map((row) => [...row].length));
}

export interface LogoOptions {
  /** Overrides the theme palette, for tests. */
  palette?: ColorPalette;
}

/** The logo painted in the brand colour, rows padded to equal width. */
export function renderLogo(options: LogoOptions = {}): string[] {
  const palette = options.palette ?? currentTheme();
  const paint = fg(palette.primary);
  const width = logoWidth();
  return LOGO_ROWS.map((row) => paint(row.padEnd(width, " ")));
}

/** Plain (uncoloured) logo, for use as a fallback or in plain-text output. */
export function plainLogo(): string[] {
  const width = logoWidth();
  return LOGO_ROWS.map((row) => row.padEnd(width, " "));
}
