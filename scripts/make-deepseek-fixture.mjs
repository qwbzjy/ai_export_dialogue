/**
 * Regenerates test/fixtures/deepseek-history.json.
 *
 * DeepSeek's payload nests `biz_data` as a JSON *string*, so the fixture has
 * to be produced by serialising twice; writing it by hand invites escaping
 * mistakes. Run: node scripts/make-deepseek-fixture.mjs
 */

import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const bizData = {
  chat_session: { current_message_id: "m3" },
  chat_messages: [
    { message_id: "m0", parent_id: null, role: "USER", content: "什么是二分查找？" },
    // A regenerated answer that is no longer on the active branch.
    { message_id: "m1", parent_id: "m0", role: "ASSISTANT", content: "旧分支的回答" },
    { message_id: "m2", parent_id: "m0", role: "USER", content: "给个 Python 例子" },
    {
      message_id: "m3",
      parent_id: "m2",
      role: "ASSISTANT",
      thinking_content: "先想一下复杂度\\(O(\\log n)\\)。",
      fragments: [
        { type: "THINK", content: "先想一下复杂度\\(O(\\log n)\\)。" },
        {
          type: "RESPONSE",
          content:
            "复杂度是 \\(O(\\log n)\\)[citation:1]。\n\n" +
            "```python\n" +
            "def bisect(xs, target):\n" +
            "    lo, hi = 0, len(xs) - 1\n" +
            "    while lo <= hi:\n" +
            "        mid = (lo + hi) // 2\n" +
            "        if xs[mid] == target:\n" +
            "            return mid\n" +
            "        if xs[mid] < target:\n" +
            "            lo = mid + 1\n" +
            "        else:\n" +
            "            hi = mid - 1\n" +
            "    return -1\n",
        },
        {
          type: "SEARCH",
          cite_index: 1,
          url: "https://example.com/binary-search",
          title: "二分查找 - 维基百科",
        },
      ],
    },
  ],
};

const payload = { code: 0, data: { biz_data: JSON.stringify(bizData) } };

mkdirSync(path.join(root, "test/fixtures"), { recursive: true });
writeFileSync(
  path.join(root, "test/fixtures/deepseek-history.json"),
  JSON.stringify(payload, null, 2) + "\n",
);
console.log("wrote test/fixtures/deepseek-history.json");