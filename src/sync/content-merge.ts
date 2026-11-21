const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_CELLS = 2_000_000;
const MAX_CANVAS_ITEMS = 10_000;

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();

export function mergeContent(
  path: string, base: Uint8Array, local: Uint8Array, remote: Uint8Array
): Uint8Array | null {
  const extension = /\.(md|canvas|json)$/i.exec(path)?.[1].toLowerCase();
  if (extension !== "md" && extension !== "canvas" && extension !== "json") return null;
  if (Math.max(base.length, local.length, remote.length) > MAX_CONTENT_BYTES) return null;
  try {
    const original = decoder.decode(base);
    const left = decoder.decode(local);
    const right = decoder.decode(remote);
    const merged = extension === "md"
      ? mergeMarkdown(original, left, right)
      : extension === "canvas"
        ? mergeCanvas(original, left, right)
        : mergeJson(original, left, right);
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

interface NormalizedLines {
  lines: string[];
  trailingNewline: boolean;
}

function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

function detectEol(base: string, left: string, right: string): "\r\n" | "\n" {
  const crlfCount = (s: string) => (s.match(/\r\n/g) ?? []).length;
  const lfOnlyCount = (s: string) => (s.match(/(?<!\r)\n/g) ?? []).length;
  const baseCrlf = crlfCount(base);
  const baseLf = lfOnlyCount(base);
  if (baseCrlf > 0 || baseLf > 0) return baseCrlf >= baseLf ? "\r\n" : "\n";
  return crlfCount(left) > 0 && crlfCount(right) > 0 ? "\r\n" : "\n";
}

function splitNormalized(text: string): NormalizedLines {
  if (!text) return { lines: [], trailingNewline: false };
  const trailingNewline = text.endsWith("\n");
  const body = trailingNewline ? text.slice(0, -1) : text;
  return { lines: body.split("\n"), trailingNewline };
}

function joinLines(lines: string[], trailingNewline: boolean, eol: "\r\n" | "\n"): string {
  if (!lines.length) return trailingNewline ? eol : "";
  return lines.join(eol) + (trailingNewline ? eol : "");
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

  const eol = detectEol(base, left, right);
  const normBase = normalizeEol(base);
  const normLeft = normalizeEol(left);
  const normRight = normalizeEol(right);

  // Pure line-ending differences across platforms (Windows CRLF vs Android/macOS LF)
  // are never real content conflicts.
  if (normLeft === normRight || normRight === normBase) {
    const parsed = splitNormalized(normLeft);
    return joinLines(parsed.lines, parsed.trailingNewline, eol);
  }
  if (normLeft === normBase) {
    const parsed = splitNormalized(normRight);
    return joinLines(parsed.lines, parsed.trailingNewline, eol);
  }

  const baseParsed = splitNormalized(normBase);
  const leftParsed = splitNormalized(normLeft);
  const rightParsed = splitNormalized(normRight);
  const original = baseParsed.lines;

  const leftEdits = lineEdits(original, leftParsed.lines);
  const rightEdits = lineEdits(original, rightParsed.lines);
  if (!leftEdits || !rightEdits) return null;

  const edits = [...leftEdits, ...rightEdits].sort((a, b) => a.start - b.start || a.end - b.end);
  const mergedLines: string[] = [];
  let cursor = 0;
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i];
    // Coalesce identical-span edits from both sides.
    if (i + 1 < edits.length && edits[i + 1].start === edit.start && edits[i + 1].end === edit.end) {
      const next = edits[i + 1];
      if (sameList(edit.lines, next.lines)) {
        i++;
      } else if (edit.start === edit.end && edit.start === original.length && original.length > 0) {
        // Pure concurrent appends at EOF (e.g. Daily Notes, bullet lists, logs):
        // combine both blocks in a deterministic canonical order so every device
        // converges identically without creating a conflict file.
        if (edit.start < cursor) return null;
        const firstText = edit.lines.join("\n");
        const secondText = next.lines.join("\n");
        const ordered = firstText <= secondText
          ? [...edit.lines, ...next.lines]
          : [...next.lines, ...edit.lines];
        mergedLines.push(...original.slice(cursor, edit.start), ...ordered);
        cursor = edit.end;
        i++;
        continue;
      } else {
        return null;
      }
    }
    if (edit.start < cursor) return null;
    mergedLines.push(...original.slice(cursor, edit.start), ...edit.lines);
    cursor = edit.end;
  }
  mergedLines.push(...original.slice(cursor));

  const trailingNewline =
    leftParsed.trailingNewline === rightParsed.trailingNewline
      ? leftParsed.trailingNewline
      : leftParsed.trailingNewline === baseParsed.trailingNewline
        ? rightParsed.trailingNewline
        : rightParsed.trailingNewline === baseParsed.trailingNewline
          ? leftParsed.trailingNewline
          : true;

  return joinLines(mergedLines, trailingNewline, eol);
}

type Json = string | number | boolean | null | Json[] | JsonObject;
interface JsonObject { [key: string]: Json }
const CONFLICT = Symbol("merge conflict");

function isObject(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPrimitive(value: Json): value is string | number | boolean | null {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function property(value: JsonObject, key: string): Json | undefined {
  return Object.prototype.hasOwnProperty.call(value, key) ? value[key] : undefined;
}

function parseJsonStrict(text: string): Json {
  return JSON.parse(text.replace(/^\uFEFF/, ""), (_key, item) => {
    if (typeof item === "number" && !Number.isFinite(item)) throw new Error("Invalid JSON number");
    return item;
  }) as Json;
}

function parseCanvas(text: string): JsonObject {
  const value = parseJsonStrict(text);
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

function uniquePrimitiveKeys(arr: Json[]): string[] | null {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    if (!isPrimitive(item)) return null;
    const key = `${typeof item}:${String(item)}`;
    if (seen.has(key)) return null;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function mergePrimitiveArray(base: Json[], left: Json[], right: Json[]): Json[] | typeof CONFLICT {
  const baseKeys = uniquePrimitiveKeys(base);
  const leftKeys = uniquePrimitiveKeys(left);
  const rightKeys = uniquePrimitiveKeys(right);
  if (!baseKeys || !leftKeys || !rightKeys) return CONFLICT;

  const baseSet = new Set(baseKeys);
  const leftSet = new Set(leftKeys);
  const rightSet = new Set(rightKeys);

  const byKey = new Map<string, Json>();
  baseKeys.forEach((k, i) => byKey.set(k, base[i]));
  leftKeys.forEach((k, i) => byKey.set(k, left[i]));
  rightKeys.forEach((k, i) => byKey.set(k, right[i]));

  // Keep surviving base elements in original order (deleted on either side -> removed).
  const out: Json[] = [];
  const emitted = new Set<string>();
  for (let i = 0; i < baseKeys.length; i++) {
    const key = baseKeys[i];
    if (leftSet.has(key) && rightSet.has(key)) {
      out.push(base[i]);
      emitted.add(key);
    }
  }
  // Deterministically append newly added items from both sides.
  const added = [...new Set([
    ...leftKeys.filter((k) => !baseSet.has(k)),
    ...rightKeys.filter((k) => !baseSet.has(k)),
  ])].sort();
  for (const key of added) {
    if (emitted.has(key)) continue;
    emitted.add(key);
    out.push(byKey.get(key)!);
  }
  return out;
}

function mergeJsonDeep(
  base: Json | undefined, left: Json | undefined, right: Json | undefined
): Json | undefined | typeof CONFLICT {
  const direct = mergeValue(base, left, right);
  if (direct !== CONFLICT) return direct;
  if (isObject(left) && isObject(right) && (base === undefined || isObject(base))) {
    const baseObj = base ?? {};
    const baseKeys = Object.keys(baseObj);
    const additions = [...new Set([...Object.keys(left), ...Object.keys(right)])]
      .filter((key) => property(baseObj, key) === undefined).sort();
    const entries: [string, Json][] = [];
    for (const key of [...baseKeys, ...additions]) {
      const merged = mergeJsonDeep(property(baseObj, key), property(left, key), property(right, key));
      if (merged === CONFLICT) return CONFLICT;
      if (merged !== undefined) entries.push([key, merged]);
    }
    return Object.fromEntries(entries);
  }
  if (Array.isArray(base) && Array.isArray(left) && Array.isArray(right)) {
    return mergePrimitiveArray(base, left, right);
  }
  return CONFLICT;
}

function detectJsonIndent(text: string): string | number | undefined {
  const match = /\n([ \t]+)"/.exec(text);
  return match ? match[1] : undefined;
}

function mergeJson(base: string, left: string, right: string): string | null {
  if (left === right || right === base) return left;
  if (left === base) return right;
  const baseVal = parseJsonStrict(base);
  const leftVal = parseJsonStrict(left);
  const rightVal = parseJsonStrict(right);
  const merged = mergeJsonDeep(baseVal, leftVal, rightVal);
  if (merged === CONFLICT || merged === undefined) return null;
  const indent = detectJsonIndent(base) ?? 2;
  const trailingNewline = base.endsWith("\n") || left.endsWith("\n") || right.endsWith("\n");
  const eol = detectEol(base, left, right);
  const serialized = JSON.stringify(merged, null, indent).replace(/\n/g, eol);
  return trailingNewline ? serialized + eol : serialized;
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
