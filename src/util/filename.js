const ILLEGAL = /[\\/:*?"<>|]/g;
const CONTROL = /[\u0000-\u001f\u007f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/** Pads a number to two digits. */
function pad(value) {
  return String(value).padStart(2, "0");
}

/**
 * A timestamp for filenames: 20261120-1730.
 * Kept local (not UTC) so it matches what the user sees.
 */
export function fileStamp(date = new Date()) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("") + "-" + [pad(date.getHours()), pad(date.getMinutes())].join("");
}

/**
 * Strips characters that Windows/macOS reject, collapses whitespace and
 * trims trailing dots/spaces. Chinese is kept as-is. The result is capped
 * at 80 characters because a filename is limited to 255 bytes on Windows
 * and CJK takes 3 bytes per character in UTF-8.
 */
export function sanitizeName(name, fallback = "untitled") {
  let cleaned = String(name ?? "")
    .replace(CONTROL, "")
    .replace(ILLEGAL, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");

  if (!cleaned) cleaned = fallback;
  if (RESERVED.test(cleaned)) cleaned = `${cleaned}_`;
  if (cleaned.length > 80) cleaned = cleaned.slice(0, 80).trim();

  return cleaned || fallback;
}

/** {site}-{title}-{stamp}.{ext} */
export function exportFileName({ siteName, title, ext, date = new Date() }) {
  return `${sanitizeName(siteName, "chat")}-${sanitizeName(title)}-${fileStamp(date)}.${ext}`;
}