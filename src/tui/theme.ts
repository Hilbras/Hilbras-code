/**
 * Colour palette and ANSI helpers for the TUI.
 *
 * Tokens are semantic hex values rather than raw ANSI codes so the palette can
 * be swapped without touching components. Colour degrades automatically: when
 * stdout is not a TTY, or NO_COLOR is set, every helper returns plain text.
 */

import { RESET, stripAnsi } from "./width.ts";

export interface ColorPalette {
  /** Brand colour: box borders, the logo, the title. */
  primary: string;
  /** Secondary highlight. */
  accent: string;
  /** Default body text. */
  text: string;
  /** Emphasised text. */
  textStrong: string;
  /** Secondary, dimmed text. */
  textDim: string;
  /** Faintest text: hints, placeholders. */
  textMuted: string;
  /** Box and pane borders. */
  border: string;
  /** Success marks and completed states. */
  success: string;
  /** Warnings and unset values. */
  warning: string;
  /** Errors. */
  error: string;
}

export const darkColors: ColorPalette = {
  primary: "#4FA8FF",
  accent: "#5BC0BE",
  text: "#E0E0E0",
  textStrong: "#F5F5F5",
  textDim: "#888888",
  textMuted: "#6B6B6B",
  border: "#5A5A5A",
  success: "#4EC87E",
  warning: "#E8A838",
  error: "#E85454",
};

export const lightColors: ColorPalette = {
  primary: "#1565C0",
  accent: "#00838F",
  text: "#1A1A1A",
  textStrong: "#000000",
  textDim: "#5A5A5A",
  textMuted: "#808080",
  border: "#C0C0C0",
  success: "#1B7F3B",
  warning: "#A86800",
  error: "#C62828",
};

export type ThemeName = "dark" | "light";

let current: ColorPalette = darkColors;

/** True when the terminal can render truecolor. */
function colorEnabled(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") return false;
  if (process.env.FORCE_COLOR !== undefined && process.env.FORCE_COLOR !== "0") return true;
  if (process.env.TERM === "dumb") return false;
  return process.stdout.isTTY === true;
}

export function setTheme(name: ThemeName): void {
  current = name === "light" ? lightColors : darkColors;
}

export function currentTheme(): ColorPalette {
  return current;
}

export function setPalette(palette: ColorPalette): void {
  current = palette;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match?.[1]) return null;
  const value = Number.parseInt(match[1], 16);
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

export function fg(hex: string): (text: string) => string {
  if (!colorEnabled()) return (text: string) => text;
  const rgb = hexToRgb(hex);
  if (!rgb) return (text: string) => text;
  return (text: string) => `[38;2;${rgb.r};${rgb.g};${rgb.b}m${text}${RESET}`;
}

export function bold(text: string): string {
  return colorEnabled() ? `[1m${text}${RESET}` : text;
}

export function dimText(text: string): string {
  return colorEnabled() ? `[2m${text}${RESET}` : text;
}

/** True when the string contains no colour escapes, i.e. it is safe to measure. */
export function isPlain(text: string): boolean {
  return stripAnsi(text) === text;
}
