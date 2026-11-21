/**
 * Turns message images into data URLs so the exported file is self-contained.
 *
 * Order of attempts, cheapest first:
 *  1. The page's own fetch (same-origin images only).
 *  2. The service worker with host permissions (works for cross-origin CDNs
 *     and sends cookies, which chat image URLs usually require).
 *  3. Give up and keep the original URL, which the export page renders as a
 *     link — never a broken image.
 */

const MAX_WIDTH = 1600;
const MAX_TOTAL_BYTES = 60 * 1024 * 1024;

async function download(url) {
  try {
    const response = await fetch(url, { credentials: "include" });
    if (response.ok) return await response.blob();
  } catch {
    /* CORS or auth; try the proxy below */
  }

  const proxied = await chrome.runtime.sendMessage({ type: "IMAGE_FETCH", url });
  if (!proxied?.ok || !proxied.dataUrl) throw new Error("image fetch failed");
  return proxied.dataUrl;
}

/** Downscales to at most MAX_WIDTH and re-encodes as JPEG/PNG to keep files sane. */
async function shrink(source) {
  const blob =
    typeof source === "string" ? await (await fetch(source)).blob() : source;

  if (blob.size < 120 * 1024 && !/^image\/(png|jpeg|webp|gif)/.test(blob.type)) {
    return blobToDataUrl(blob);
  }

  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_WIDTH / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const type = blob.type === "image/png" || blob.type === "image/gif" ? "image/png" : "image/jpeg";
  const dataUrl = canvas.toDataURL(type, 0.85);
  canvas.width = 0;
  canvas.height = 0;
  return dataUrl;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * @param {Array<{ src: string }>} images
 * @returns {Promise<{ images: Array<{alt: string, dataUri: string|null, url: string}>,
 *                     warnings: string[] }>}
 */
export async function embedImages(images, { onProgress } = {}) {
  const output = [];
  const warnings = [];
  const seen = new Map();
  let total = 0;

  for (let index = 0; index < images.length; index += 1) {
    const { src, alt } = images[index];
    onProgress?.({ done: index + 1, total: images.length });

    if (!src) continue;
    if (seen.has(src)) {
      output.push({ ...seen.get(src), alt: alt || seen.get(src).alt });
      continue;
    }

    let record = { url: src, dataUri: null, alt: alt ?? "" };

    if (/^data:image\//i.test(src)) {
      record.dataUri = src;
    } else if (total < MAX_TOTAL_BYTES) {
      try {
        const shrunk = await shrink(await download(src));
        const dataUri = typeof shrunk === "string" ? shrunk : await blobToDataUrl(shrunk);
        const bytes = Math.floor((dataUri.length - dataUri.indexOf(",") - 1) * 0.75);
        if (bytes > 0 && total + bytes <= MAX_TOTAL_BYTES) {
          record.dataUri = dataUri;
          total += bytes;
        } else {
          warnings.push("图片总量已超过 60MB，后续图片保留为链接。");
        }
      } catch {
        warnings.push("部分图片无法下载，已保留原链接。");
      }
    } else {
      record.dataUri = null;
    }

    seen.set(src, record);
    output.push(record);
  }

  return { images: output, warnings: [...new Set(warnings)] };
}

/** Collects image descriptors from a cleaned message node. */
export function imagesFromNode(node) {
  return [...(node?.querySelectorAll("img") ?? [])].map((img) => ({
    src: img.getAttribute("data-original-src") ?? img.getAttribute("src") ?? "",
    alt: img.getAttribute("alt") ?? "",
  }));
}