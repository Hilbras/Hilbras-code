/**
 * The Hilbras Code logo.
 *
 * PLACEHOLDER: the glyphs below are borrowed from kimi-code's welcome header
 * (apps/kimi-code/src/tui/components/chrome/welcome.ts in that project). They
 * are a stopgap, not an original mark. Kimi is a Moonshot AI trademark, and
 * shipping this in a competing product is a trademark risk, so it must be
 * replaced with an original logo before any public release.
 *
 * Two rows of single-column block glyphs, sized to sit beside the title in the
 * welcome box. Every glyph is one column wide, so `visibleWidth` counts each row
 * without wide-character handling.
 */

import { type ColorPalette, currentTheme, fg } from "./theme.ts";

/** Logo rows, unstyled. Exported so tests can assert the shape. */
export const LOGO_ROWS: readonly string[] = ["▐█▛█▛█▌", "▐█████▌"];

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
