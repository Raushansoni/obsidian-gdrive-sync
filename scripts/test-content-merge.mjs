import { build } from "esbuild";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL("../src/sync/content-merge.ts", import.meta.url))],
  format: "esm",
  write: false,
});
const { mergeContent } = await import(
  "data:text/javascript;base64," + Buffer.from(outputFiles[0].contents).toString("base64")
);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function merge(path, base, local, remote) {
  const result = mergeContent(path, ...[base, local, remote].map((value) => encoder.encode(value)));
  return result && decoder.decode(result);
}

test("Markdown combines separate replacements and insertions while preserving CRLF", () => {
  const base = "heading\r\nfirst\r\nsecond\r\nthird";
  const local = "heading\r\nfirst local\r\nsecond\r\nthird";
  const remote = "heading\r\nfirst\r\nsecond\r\ninserted\r\nthird remote";
  const expected = "heading\r\nfirst local\r\nsecond\r\ninserted\r\nthird remote";
  assert.equal(merge("Note.md", base, local, remote), expected);
  assert.equal(merge("Note.md", base, remote, local), expected);
});

test("Markdown deduplicates shared edits and reports overlapping changes", () => {
  const base = "first\nsecond\nthird\n";
  assert.equal(merge("Note.md", base, "changed\nsecond\nthird\n", "changed\nsecond\nlast\n"),
    "changed\nsecond\nlast\n");
  assert.equal(merge("Note.md", base, "local\nsecond\nthird\n", "remote\nsecond\nthird\n"), null);
  assert.equal(merge("Note.md", base, "local\nfirst\nsecond\nthird\n", "remote\nfirst\nsecond\nthird\n"), null);
});

const card = (id, fields = {}) => ({ id, type: "text", text: id, x: 0, y: 0, width: 100, height: 100, ...fields });
const board = (nodes, edges) => JSON.stringify({ nodes, edges });

test("Canvas combines position, text, edges and concurrent node additions by ID", () => {
  const base = board([card("a"), card("b")]);
  const local = board([card("a", { x: 20 }), card("b"), card("c")], [{ id: "e", fromNode: "a", toNode: "c" }]);
  const remote = board([card("a", { text: "edited" }), card("b", { y: 50 }), card("d")]);
  const result = merge("Board.canvas", base, local, remote);
  assert.equal(result, merge("Board.canvas", base, remote, local));
  assert.deepEqual(JSON.parse(result), {
    nodes: [card("a", { text: "edited", x: 20 }), card("b", { y: 50 }), card("c"), card("d")],
    edges: [{ id: "e", fromNode: "a", toNode: "c" }],
  });
});

test("Canvas preserves an independent stacking order change and a card edit", () => {
  const base = board([card("a"), card("b")]);
  const local = board([card("b"), card("a")]);
  const remote = board([card("a"), card("b", { y: 10 })]);
  assert.deepEqual(JSON.parse(merge("Board.canvas", base, local, remote)).nodes, [
    card("b", { y: 10 }), card("a"),
  ]);
});

test("Canvas detects edit-delete, same-field edits and newly dangling edges", () => {
  const base = board([card("a"), card("b")]);
  const local = board([card("a")]);
  assert.equal(merge("Board.canvas", base, local, board([card("a"), card("b", { x: 20 })])), null);
  assert.equal(merge("Board.canvas", base, local,
    board([card("a"), card("b")], [{ id: "e", fromNode: "a", toNode: "b" }])), null);
  assert.equal(merge("Board.canvas", base, board([card("a"), card("b", { x: 40 })]),
    board([card("a"), card("b", { x: 20 })])), null);
});

test("Canvas rejects duplicate IDs and accepts omitted collections", () => {
  assert.equal(merge("Board.canvas", "{}", board([card("a"), card("a")]), "{}"), null);
  assert.deepEqual(JSON.parse(merge("Board.canvas", "{}", board([card("a")]), board([card("b")]))),
    { nodes: [card("a"), card("b")], edges: [] });
});

test("Canvas output is deterministic when nested objects have different key order", () => {
  const base = board([card("a")]);
  const local = board([card("a", { plugin: { b: 2, a: 1 }, x: 10 })]);
  const remote = board([card("a", { plugin: { a: 1, b: 2 }, y: 20 })]);
  assert.equal(merge("Board.canvas", base, local, remote), merge("Board.canvas", base, remote, local));
});

test("Canvas composes compatible concurrent stacking order edits and rejects cycles", () => {
  const a = card("a");
  const b = card("b");
  const c = card("c");
  const d = card("d");
  const base = board([a, b, c, d]);
  assert.deepEqual(JSON.parse(merge("Board.canvas", base, board([b, a, c, d]), board([a, b, d, c]))).nodes,
    [b, a, d, c]);
  assert.equal(merge("Board.canvas", base, board([b, a, c, d]), board([a, c, b, d])), null);
});
