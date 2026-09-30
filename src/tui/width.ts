/**
 * ANSI-aware width measurement and truncation.
 *
 * The welcome box has to align its right border exactly, and the content it
 * wraps is coloured. Measuring with `.length` is wrong for both reasons, so
 * these helpers strip escape sequences and count East Asian wide characters as
 * two columns — the same rules `string-width` applies.
 */

export const RESET = "[0m";

const ANSI_SOURCE = "\\u001B\\[[0-9;?]*[A-Za-z]";
const ANSI_GLOBAL = new RegExp(ANSI_SOURCE, "g");
const ANSI_STICKY = new RegExp(ANSI_SOURCE, "y");

export function stripAnsi(text: string): string {
  return text.replace(ANSI_GLOBAL, "");
}

export function charWidth(code: number): number {
  if (code === 0) return 0;
  if (code < 0x20) return 0;
  if (code >= 0x7f && code < 0xa0) return 0;
  // Combining marks and zero-width formatting characters.
  if (code >= 0x0300 && code <= 0x036f) return 0;
  if (code >= 0x200b && code <= 0x200f) return 0;
  if (code >= 0xfe00 && code <= 0xfe0f) return 0;
  return isWide(code) ? 2 : 1;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0x303e) ||
    (code >= 0x3041 && code <= 0x33ff) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xa000 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x2fffd) ||
    (code >= 0x30000 && code <= 0x3fffd)
  );
}

export function visibleWidth(text: string): number {
  let width = 0;
  for (const char of stripAnsi(text)) {
    width += charWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

export function padToWidth(text: string, width: number): string {
  const missing = width - visibleWidth(text);
  return missing > 0 ? text + " ".repeat(missing) : text;
}

interface Clipped {
  text: string;
  truncated: boolean;
  colored: boolean;
}

/** Cut `text` to `maxWidth` visible columns, preserving any escape sequences. */
function clipToWidth(text: string, maxWidth: number): Clipped {
  if (maxWidth <= 0) return { text: "", truncated: text.length > 0, colored: false };

  let width = 0;
  let used = "";
  let truncated = false;
  let colored = false;
  let i = 0;

  while (i < text.length) {
    ANSI_STICKY.lastIndex = i;
    const match = ANSI_STICKY.exec(text);
    if (match && match.index === i) {
      used += match[0];
      colored = true;
      i += match[0].length;
      continue;
    }

    const code = text.codePointAt(i) ?? 0;
    const char = String.fromCodePoint(code);
    const charWidthValue = charWidth(code);
    if (width + charWidthValue > maxWidth) {
      truncated = true;
      break;
    }
    used += char;
    width += charWidthValue;
    i += char.length;
  }

  return { text: used, truncated, colored };
}

/**
 * Truncate to `maxWidth` visible columns, appending an ellipsis when text was
 * actually cut. Colour is reset after the ellipsis so it stays visible.
 */
export function truncateToWidth(text: string, maxWidth: number, ellipsis = "…"): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;

  const ellipsisWidth = visibleWidth(ellipsis);
  if (ellipsisWidth >= maxWidth) {
    const clipped = clipToWidth(text, maxWidth);
    return clipped.truncated && clipped.colored ? clipped.text + RESET : clipped.text;
  }

  const clipped = clipToWidth(text, maxWidth - ellipsisWidth);
  const out = `${clipped.text}${ellipsis}`;
  return clipped.truncated && clipped.colored ? out + RESET : out;
}
