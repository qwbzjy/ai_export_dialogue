/**
 * DOM-fallback helpers shared by the site adapters.
 *
 * Almost every chat UI is a flat list of message rows, one per turn, where
 * the assistant rows are the only ones that contain a rendered Markdown
 * body. That single fact is enough to recover roles without relying on
 * hashed class names: find the ancestor whose *children* are the rows, then
 * tag each row by whether it holds a Markdown body.
 */

/**
 * @param {string} bodySelector  selector that only assistant rows contain
 * @param {ParentNode} [root]
 * @returns {{rows: Element[], rowOf: (node: Element) => Element|null}}
 */
export function rowLayout(bodySelector, root = document) {
  const bodies = [...root.querySelectorAll(bodySelector)];
  if (!bodies.length) return { rows: [], rowOf: () => null };

  // Climb while the parent still holds every body we found, i.e. until the
  // node is the list container itself.
  let node = bodies[0];
  while (
    node.parentElement &&
    node.parentElement !== document.body &&
    node.parentElement.querySelectorAll(bodySelector).length === bodies.length &&
    node.querySelectorAll(bodySelector).length < bodies.length
  ) {
    node = node.parentElement;
  }

  const rows = [...node.children].filter((child) => child.nodeType === 1);
  const rowOf = (element) => {
    let current = element;
    while (current && current !== node) {
      if (current.parentElement === node) return current;
      current = current.parentElement;
    }
    return null;
  };

  return { rows, rowOf };
}

/** Rows tagged by role using an explicit selector for each side. */
export function rowsByRole({ userSelector, assistantSelector, root = document }) {
  const rows = [...root.querySelectorAll(`${userSelector}, ${assistantSelector}`)].filter(
    (row, index, all) => !all.some((other) => other !== row && other.contains(row)),
  );
  return rows
    .map((row) => ({
      row,
      role: row.matches(assistantSelector) || row.querySelector(assistantSelector) ? "assistant" : "user",
    }))
    .filter((entry) => entry.row);
}

/**
 * Turns a thinking/reasoning block into a `<details>` the export page knows
 * how to render in each mode (details for Markdown, open for print, plain
 * div for the image PDF). `alreadyOpen` content is copied as-is.
 */
export function wrapThinking(thinkingNodes, { title = "思考过程" } = {}) {
  if (!thinkingNodes?.length) return null;
  const details = document.createElement("details");
  details.className = "thinking";
  details.setAttribute("data-thinking", "1");
  const summary = document.createElement("summary");
  summary.textContent = title;
  details.appendChild(summary);
  for (const node of thinkingNodes) {
    if (!node) continue;
    const wrapper = document.createElement("div");
    wrapper.className = "thinking-body";
    wrapper.appendChild(node.cloneNode(true));
    details.appendChild(wrapper);
  }
  return details;
}

/**
 * Expands collapsed "thinking" panels so their text is in the DOM when we
 * snapshot. Sites hide the reasoning behind their own toggle; we click the
 * closest collapsed toggle and give the UI a moment to render.
 *
 * Content is only trusted if it is actually there afterwards — a host that
 * stays empty is reported so the export can say reasoning was not captured
 * instead of silently dropping it.
 */
export async function expandThinking(hosts, { delayMs = 150 } = {}) {
  let clicked = 0;
  const stillEmpty = [];

  for (const host of hosts) {
    if (!host) continue;
    if (host.textContent.trim() && host.getBoundingClientRect().height > 0) continue;

    const scope = host.closest("[class*='card'], [class*='Card'], [class*='think'], [class*='Think']") ?? host;
    const toggle =
      [...scope.querySelectorAll("[aria-expanded='false'], [class*='expand'], [class*='Expand']")].find(
        (node) => !node.closest("details[data-thinking]"),
      ) ?? null;

    if (toggle) {
      toggle.click();
      clicked += 1;
    } else {
      stillEmpty.push(host);
    }
  }

  if (clicked) await new Promise((resolve) => setTimeout(resolve, delayMs));
  return { clicked, stillEmpty };
}

/**
 * Builds messages from rows without touching the live page: each result is a
 * detached wrapper holding a clone of the role's body plus a cloned thinking
 * block. The collector cleans and serialises the wrapper.
 */
export function messagesFromRows(rows, { bodySelector, thinkingSelectors = [], userSelector } = {}) {
  const output = [];
  for (const { row, role } of rows) {
    const thinkingHosts = thinkingSelectors
      .flatMap((selector) => [...row.querySelectorAll(selector)])
      .filter((node) => !node.closest("details"));

    const source =
      (bodySelector && row.querySelector(bodySelector)) ??
      (userSelector && row.querySelector(userSelector)) ??
      row;

    const wrapper = document.createElement("div");
    wrapper.appendChild(source.cloneNode(true));

    if (thinkingHosts.length) {
      const details = wrapThinking(thinkingHosts);
      if (details) wrapper.appendChild(details);
    }

    output.push({ role, node: wrapper });
  }
  return output;
}