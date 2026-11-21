/**
 * Request helpers shared by the site adapters.
 *
 * The content script runs in the page, so `fetch` is same-origin: cookies
 * are sent automatically and CORS is not in the way. When a host is not
 * reachable that way (qianwen's API host), fall back to the service
 * worker, which fetches from the extension origin with host permissions.
 */

export class ExtractionError extends Error {
  constructor(message, code = "unknown") {
    super(message);
    this.name = "ExtractionError";
    this.code = code;
  }
}

/** localStorage access can throw (storage blocked) or be empty (HttpOnly cookie). */
export function readLocalStorage(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Tokens are sometimes stored as a plain string, a JSON string, or a JSON
 * object wrapping it. Unwraps all three shapes.
 */
export function parseToken(raw, keys = ["value", "token", "access_token", "accessToken"]) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const find = (node, depth = 0) => {
      if (depth > 3 || node == null) return null;
      if (typeof node === "string") return node.trim() || null;
      if (typeof node !== "object") return null;
      for (const key of keys) {
        const found = find(node[key], depth + 1);
        if (found) return found;
      }
      return null;
    };
    return find(parsed);
  } catch {
    return raw.trim() || null;
  }
}

/**
 * Same-origin fetch. `credentials: 'include'` is explicit so the behaviour
 * does not depend on the site's fetch defaults.
 */
export async function fetchJson(pathOrUrl, init = {}) {
  const url = pathOrUrl instanceof URL ? pathOrUrl.href : String(pathOrUrl);
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    headers: { Accept: "application/json", ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { ok: response.ok, status: response.status, json, text };
}

/** Fetches through the service worker (extension origin + host permissions). */
export async function proxyFetch({ url, method = "GET", headers, body }) {
  const result = await chrome.runtime.sendMessage({
    type: "API_FETCH",
    url,
    method,
    headers,
    body,
  });
  if (!result?.ok && result?.status == null) {
    throw new ExtractionError(result?.error ?? "代理请求失败", "proxy");
  }
  let json = null;
  try {
    json = result.text ? JSON.parse(result.text) : null;
  } catch {
    json = null;
  }
  return { ok: result.ok, status: result.status, json, text: result.text };
}

/**
 * Direct first, proxy second. Direct keeps the page's cookie partition and
 * SameSite behaviour, which is what the site's own SPA relies on.
 */
export async function fetchFromHost(url, init = {}) {
  try {
    return await fetchJson(url, init);
  } catch (error) {
    if (error instanceof ExtractionError) throw error;
    return proxyFetch({ url, ...init });
  }
}

/**
 * Re-runs `run` once if the site answers 401 — tokens rotate mid-session
 * and a stale read is the most common cause. `run` is expected to re-read
 * the token itself, so nothing is cached across attempts.
 */
export async function withAuthRetry(run) {
  const first = await run();
  if (first?.status === 401 || first?.status === 403) {
    const second = await run();
    if (second?.status === 401 || second?.status === 403) {
      throw new ExtractionError("未登录或登录已失效", "auth");
    }
    return second;
  }
  return first;
}

/**
 * The query string of a request the page itself already made. Doubao and
 * Qianwen reject hand-built parameters (device ids, one-shot anti-bot
 * fields, `ut`), so reusing the page's own request is the only reliable way.
 */
export function findPageRequestQuery(pathSuffix) {
  const entries = performance.getEntriesByType("resource");
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const name = entries[index]?.name;
    if (!name) continue;
    try {
      const url = new URL(name);
      if (url.pathname.endsWith(pathSuffix) && url.search) return url.search;
    } catch {
      /* ignore malformed entries */
    }
  }
  return null;
}

/** The last request the page made to a path, as a URL (for method/headers hints). */
export function findPageRequestUrl(pathSuffix) {
  const entries = performance.getEntriesByType("resource");
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const name = entries[index]?.name;
    if (!name) continue;
    try {
      if (new URL(name).pathname.endsWith(pathSuffix)) return name;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}