import deepseek from "./deepseek.js";
import kimi from "./kimi.js";
import doubao from "./doubao.js";
import yuanbao from "./yuanbao.js";
import qwen from "./qwen.js";
import qianwen from "./qianwen.js";

export const SITES = [deepseek, kimi, doubao, yuanbao, qwen, qianwen];

export function siteForUrl(url) {
  try {
    return SITES.find((site) => site.match(url)) ?? null;
  } catch {
    return null;
  }
}

export function siteById(id) {
  return SITES.find((site) => site.id === id) ?? null;
}

export const SITE_LIST = SITES.map(({ id, name }) => ({ id, name }));