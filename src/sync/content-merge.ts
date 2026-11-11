const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_CELLS = 2_000_000;
const MAX_CANVAS_ITEMS = 10_000;

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

export function mergeContent(
  path: string, base: Uint8Array, local: Uint8Array, remote: Uint8Array
): Uint8Array | null {
  const extension = /\.(md|canvas)$/i.exec(path)?.[1].toLowerCase();
  if (extension !== "md" && extension !== "canvas") return null;
  if (Math.max(base.length, local.length, remote.length) > MAX_CONTENT_BYTES) return null;
  try {
    const original = decoder.decode(base);
    const left = decoder.decode(local);
    const right = decoder.decode(remote);
    const merged = extension === "md"
      ? mergeMarkdown(original, left, right)
      : mergeCanvas(original, left, right);
    return merged === null ? null : encoder.encode(merged);
  } catch {
    return null;
  }
}

interface LineEdit {
  start: number;
  end: number;
  lines: string[];
}

function linesOf(text: string): string[] {
  return text.match(/[^\r\n]*(?:\r\n|\n|\r)|[^\r\n]+$/g) ?? [];
}

function sameList<T>(left: T[], right: T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** Keep the quadratic diff bounded and skip the unchanged prefix and suffix. */
function lineEdits(base: string[], changed: string[]): LineEdit[] | null {
  let start = 0;
  while (start < base.length && start < changed.length && base[start] === changed[start]) start++;
  let baseEnd = base.length;
  let changedEnd = changed.length;
  while (baseEnd > start && changedEnd > start && base[baseEnd - 1] === changed[changedEnd - 1]) {
    baseEnd--;
    changedEnd--;
  }
  const rows = baseEnd - start;
  const columns = changedEnd - start;
  if (!rows || !columns) {
    return rows || columns ? [{ start, end: baseEnd, lines: changed.slice(start, changedEnd) }] : [];
  }

  const width = columns + 1;
  if ((rows + 1) * width > MAX_DIFF_CELLS) return null;
  const lengths = new Uint32Array((rows + 1) * width);
  for (let row = rows - 1; row >= 0; row--) {
    for (let col = columns - 1; col >= 0; col--) {
      const cell = row * width + col;
      lengths[cell] = base[start + row] === changed[start + col]
        ? lengths[cell + width + 1] + 1
        : Math.max(lengths[cell + width], lengths[cell + 1]);
    }
  }

  const edits: LineEdit[] = [];
  let row = 0;
  let col = 0;
  let edit: LineEdit | null = null;
  while (row < rows || col < columns) {
    if (row < rows && col < columns && base[start + row] === changed[start + col]) {
      edit = null;
      row++;
      col++;
      continue;
    }
    if (!edit) {
      edit = { start: start + row, end: start + row, lines: [] };
      edits.push(edit);
    }
    const cell = row * width + col;
    if (row < rows && (col === columns || lengths[cell + width] >= lengths[cell + 1])) {
      edit.end++;
      row++;
    } else {
      edit.lines.push(changed[start + col]);
      col++;
    }
  }
  return edits;
}

function mergeMarkdown(base: string, left: string, right: string): string | null {
  if (left === right || right === base) return left;
  if (left === base) return right;
  const original = linesOf(base);
  const leftEdits = lineEdits(original, linesOf(left));
  const rightEdits = lineEdits(original, linesOf(right));
  if (!leftEdits || !rightEdits) return null;
  const edits = [...leftEdits, ...rightEdits].sort((a, b) => a.start - b.start || a.end - b.end);
  const result: string[] = [];
  let cursor = 0;
  let previous: LineEdit | undefined;
  for (const edit of edits) {
    if (previous?.start === edit.start && previous.end === edit.end) {
      if (!sameList(previous.lines, edit.lines)) return null;
      continue;
    }
    if (edit.start < cursor) return null;
    result.push(original.slice(cursor, edit.start).join(""), edit.lines.join(""));
    cursor = edit.end;
    previous = edit;
  }
  result.push(original.slice(cursor).join(""));
  return result.join("");
}

type Json = string | number | boolean | null | Json[] | JsonObject;
interface JsonObject { [key: string]: Json }
const CONFLICT = Symbol("merge conflict");

function isObject(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function property(value: JsonObject, key: string): Json | undefined {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function parseCanvas(text: string): JsonObject {
  const value: Json = JSON.parse(text.replace(/^\uFEFF/, ""), (_key, item) => {
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error("Invalid Canvas number");
    return item;
  });
  if (!isObject(value)) throw new Error("Invalid Canvas object");
  return value;
}

function equalJson(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => equalJson(value, b[index]));
  }
  if (!isObject(a) || !isObject(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => equalJson(a[key], property(b, key)));
}

function mergeValue(base: Json | undefined, left: Json | undefined, right: Json | undefined) {
  if (equalJson(left, right) || equalJson(right, base)) return left;
  if (equalJson(left, base)) return right;
  return CONFLICT;
}

function mergeFields(base: JsonObject, left: JsonObject, right: JsonObject, skip = new Set<string>()): JsonObject {
  const baseKeys = Object.keys(base);
  const additions = [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => property(base, key) === undefined).sort();
  const entries: [string, Json][] = [];
  for (const key of [...baseKeys, ...additions]) {
    if (skip.has(key)) continue;
    const value = mergeValue(property(base, key), property(left, key), property(right, key));
    if (value === CONFLICT) throw new Error("Overlapping Canvas edits");
    if (value !== undefined) entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}

function indexItems(value: Json | undefined): Map<string, JsonObject> {
  if (value === undefined) return new Map();
  if (!Array.isArray(value) || value.length > MAX_CANVAS_ITEMS) throw new Error("Invalid Canvas collection");
  const items = new Map<string, JsonObject>();
  for (const item of value) {
    if (!isObject(item) || typeof item.id !== "string" || !item.id || items.has(item.id)) {
      throw new Error("Invalid or duplicate Canvas ID");
    }
    items.set(item.id, item);
  }
  return items;
}

function mergeExistingOrder(base: string[], left: string[], right: string[]): string[] {
  if (sameList(left, base)) return right;
  if (sameList(right, base) || sameList(left, right)) return left;
  if (base.length * base.length > MAX_DIFF_CELLS) throw new Error("Canvas order merge is too large");

  const positions = (order: string[]) => new Map(order.map((id, index) => [id, index]));
  const basePosition = positions(base);
  const leftPosition = positions(left);
  const rightPosition = positions(right);
  function precedes(a: string, b: string): boolean {
    const before = basePosition.get(a)! < basePosition.get(b)!;
    const first = leftPosition.get(a)! < leftPosition.get(b)!;
    const second = rightPosition.get(a)! < rightPosition.get(b)!;
    return first === before ? second : first;
  }
  const order = [...base].sort((a, b) => a === b ? 0 : precedes(a, b) ? -1 : 1);
  // Composing two reorderings can introduce a cycle. Check every pair before
  // accepting the sort because a cyclic comparator has no valid result.
  for (let index = 0; index < order.length; index++) {
    for (let later = index + 1; later < order.length; later++) {
      if (!precedes(order[index], order[later])) throw new Error("Overlapping Canvas order edits");
    }
  }
  return order;
}

/** Preserve existing stacking order and each side's placement of new items. */
function mergeOrder(
  base: Map<string, JsonObject>, left: Map<string, JsonObject>, right: Map<string, JsonObject>,
  items: Map<string, JsonObject>
): string[] {
  const baseOrder = [...base.keys()].filter((id) => items.has(id));
  const leftOrder = [...left.keys()].filter((id) => items.has(id));
  const rightOrder = [...right.keys()].filter((id) => items.has(id));
  const leftExisting = leftOrder.filter((id) => base.has(id));
  const rightExisting = rightOrder.filter((id) => base.has(id));
  const existing = mergeExistingOrder(baseOrder, leftExisting, rightExisting);

  const outgoing = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();
  for (const id of items.keys()) {
    outgoing.set(id, new Set());
    indegree.set(id, 0);
  }
  function addConstraints(order: string[], existingOnly: boolean): void {
    for (let index = 1; index < order.length; index++) {
      const from = order[index - 1];
      const to = order[index];
      if (!existingOnly && base.has(from) && base.has(to)) continue;
      const next = outgoing.get(from)!;
      if (next.has(to)) continue;
      next.add(to);
      indegree.set(to, indegree.get(to)! + 1);
    }
  }
  addConstraints(existing, true);
  addConstraints(leftOrder, false);
  addConstraints(rightOrder, false);

  const ready = [...items.keys()].filter((id) => indegree.get(id) === 0).sort();
  for (let index = 0; index < ready.length; index++) {
    for (const next of [...outgoing.get(ready[index])!].sort()) {
      const remaining = indegree.get(next)! - 1;
      indegree.set(next, remaining);
      if (remaining === 0) ready.push(next);
    }
  }
  if (ready.length !== items.size) throw new Error("Incompatible Canvas item placement");
  return ready;
}

function mergeItems(
  base: Map<string, JsonObject>, left: Map<string, JsonObject>, right: Map<string, JsonObject>
): JsonObject[] {
  const items = new Map<string, JsonObject>();
  for (const id of new Set([...base.keys(), ...left.keys(), ...right.keys()])) {
    const before = base.get(id);
    const first = left.get(id);
    const second = right.get(id);
    let value = mergeValue(before, first, second);
    if (value === CONFLICT) {
      if (!before || !first || !second) throw new Error("Overlapping Canvas item edits");
      if (first.type !== second.type) throw new Error("Conflicting Canvas item types");
      value = mergeFields(before, first, second);
    }
    if (isObject(value)) items.set(id, value);
  }
  return mergeOrder(base, left, right, items).map((id) => items.get(id)!);
}

function validateEdges(nodes: Map<string, JsonObject>, edges: Iterable<JsonObject>): void {
  for (const edge of edges) {
    if (typeof edge.fromNode !== "string" || !nodes.has(edge.fromNode) ||
        typeof edge.toNode !== "string" || !nodes.has(edge.toNode)) {
      throw new Error("Canvas edge refers to a missing node");
    }
  }
}

function mergeCanvas(base: string, left: string, right: string): string {
  const originals = [base, left, right].map((text) => {
    const board = parseCanvas(text);
    const nodes = indexItems(property(board, "nodes"));
    const edges = indexItems(property(board, "edges"));
    validateEdges(nodes, edges.values());
    return { board, nodes, edges };
  });
  const [before, first, second] = originals;
  const nodes = mergeItems(before.nodes, first.nodes, second.nodes);
  const edges = mergeItems(before.edges, first.edges, second.edges);
  validateEdges(new Map(nodes.map((node) => [node.id as string, node])), edges);
  const fields = mergeFields(before.board, first.board, second.board, new Set(["nodes", "edges"]));
  const board = { nodes, edges, ...fields };
  return JSON.stringify(board, (_key, value: Json) =>
    isObject(value) && value !== board
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]))
      : value, "\t") + "\n";
}
