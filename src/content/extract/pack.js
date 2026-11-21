/**
 * Writes an export into chrome.storage.local in small keys. The key layout
 * lives in util/export-store.js, which the export page reads with.
 */

import { PREFIX, touchIndex } from "../../util/export-store.js";

export function newExportId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export async function packExport({ id, meta, messages }) {
  const entries = {};
  const imageRefs = [];

  entries[`${PREFIX}${id}:m:count`] = { count: messages.length };

  messages.forEach((message, index) => {
    const images = (message.images ?? []).map((image) => {
      if (!image.dataUri) return { ...image, ref: null };
      const imageKey = `${PREFIX}${id}:img:${imageRefs.length}`;
      entries[imageKey] = image.dataUri;
      imageRefs.push(imageKey);
      return { ...image, ref: imageKey };
    });

    entries[`${PREFIX}${id}:m:${index}`] = { ...message, images };
  });

  // Meta last: the export page only opens what it can fully read.
  entries[`${PREFIX}${id}:meta`] = {
    __isMeta: true,
    createdAt: Date.now(),
    id,
    imageCount: imageRefs.length,
    ...meta,
  };

  await chrome.storage.local.set(entries);
  await touchIndex(id);
  return { id, messageCount: messages.length, imageCount: imageRefs.length };
}