/**
 * Reading an export back out of chrome.storage.local.
 *
 * Keys are fetched in small batches: `get(null)` would pull every export the
 * user ever made into memory, images included.
 */

import { PREFIX, deleteExport, sweepExports } from "../util/export-store.js";

export { deleteExport, sweepExports };

export async function readExport(id) {
  if (!id || !/^[a-z0-9-]+$/i.test(id)) throw new Error("导出数据不存在");

  const metaKey = `${PREFIX}${id}:meta`;
  const metaResult = await chrome.storage.local.get(metaKey);
  const meta = metaResult[metaKey];
  if (!meta) throw new Error("导出数据已过期或被清理，请重新导出");

  const countKey = `${PREFIX}${id}:m:count`;
  const countResult = await chrome.storage.local.get(countKey);
  const count = countResult[countKey]?.count ?? 0;

  const batchSize = 8;
  const messages = [];

  for (let start = 0; start < count; start += batchSize) {
    const keys = [];
    for (let index = start; index < Math.min(start + batchSize, count); index += 1) {
      keys.push(`${PREFIX}${id}:m:${index}`);
    }
    const result = await chrome.storage.local.get(keys);
    for (const key of keys) {
      const message = result[key];
      if (message) messages.push(message);
    }
  }

  const imageKeys = messages.flatMap((message) =>
    (message.images ?? []).map((image) => image.ref).filter(Boolean),
  );

  for (let start = 0; start < imageKeys.length; start += batchSize) {
    const keys = imageKeys.slice(start, start + batchSize);
    const result = await chrome.storage.local.get(keys);
    for (const message of messages) {
      for (const image of message.images ?? []) {
        if (image.ref && keys.includes(image.ref)) {
          image.dataUri = result[image.ref] ?? null;
          delete image.ref;
        }
      }
    }
  }
  for (const message of messages) {
    for (const image of message.images ?? []) delete image.ref;
  }

  return {
    id,
    site: meta.site,
    siteName: meta.siteName,
    title: meta.title,
    url: meta.url,
    exportedAt: meta.exportedAt,
    source: meta.source,
    warnings: meta.warnings ?? [],
    messages,
  };
}