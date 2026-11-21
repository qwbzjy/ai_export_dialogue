/**
 * Key layout shared by the content script (writer) and the export page
 * (reader), plus cleanup.
 *
 * An export is a handful of small keys, never one big value: a conversation
 * with embedded images easily exceeds the 64 MiB message cap and would
 * double peak memory while being serialised.
 *
 *   exp:index            { [id]: createdAt } — lets cleanup find exports
 *                        without `storage.local.get(null)`, which would load
 *                        every conversation (images included) into memory
 *   exp:{id}:meta        small; written last so a partial export never opens
 *   exp:{id}:m:count     { count }
 *   exp:{id}:m:{n}       one per message
 *   exp:{id}:img:{n}     one per embedded image
 */

export const PREFIX = "exp:";
export const INDEX_KEY = `${PREFIX}index`;

export function exportKeys(id, { count = 0, imageCount = 0 } = {}) {
  const keys = [`${PREFIX}${id}:meta`, `${PREFIX}${id}:m:count`];
  for (let index = 0; index < count; index += 1) keys.push(`${PREFIX}${id}:m:${index}`);
  for (let index = 0; index < imageCount; index += 1) keys.push(`${PREFIX}${id}:img:${index}`);
  return keys;
}

export async function readIndex() {
  const stored = await chrome.storage.local.get(INDEX_KEY);
  const index = stored[INDEX_KEY];
  return index && typeof index === "object" ? index : {};
}

/** Registers (or refreshes) an export id. */
export async function touchIndex(id) {
  const index = await readIndex();
  index[id] = Date.now();
  await chrome.storage.local.set({ [INDEX_KEY]: index });
}

/** Removes every key of an export, using only its meta. Safe to repeat. */
export async function deleteExport(id) {
  if (!id) return;
  try {
    const metaKey = `${PREFIX}${id}:meta`;
    const meta = (await chrome.storage.local.get(metaKey))[metaKey];
    const keys = meta
      ? exportKeys(id, {
          count: meta.messageCount ?? 0,
          imageCount: meta.imageCount ?? 0,
        })
      : // No meta: fall back to the bare pair, which is always written.
        [`${PREFIX}${id}:meta`, `${PREFIX}${id}:m:count`];

    await chrome.storage.local.remove(keys);

    const index = await readIndex();
    if (id in index) {
      delete index[id];
      await chrome.storage.local.set({ [INDEX_KEY]: index });
    }
  } catch (error) {
    console.warn("[ai-exporter] cleanup failed", error);
  }
}

/**
 * Deletes exports whose page was never opened (the user closed the tab, or
 * the extension was reloaded mid-export).
 */
export async function sweepExports({ olderThanMs = 6 * 3600_000 } = {}) {
  try {
    const index = await readIndex();
    const stale = Object.keys(index).filter((id) => Date.now() - (index[id] ?? 0) > olderThanMs);
    for (const id of stale) await deleteExport(id);
  } catch (error) {
    console.warn("[ai-exporter] sweep failed", error);
  }
}