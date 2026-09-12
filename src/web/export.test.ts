import { test } from "node:test";
import assert from "node:assert/strict";
import { csv } from "./export";

test("CSV export quotes commas, quotes, and newlines safely", () => {
  assert.equal(
    csv([{ name: 'A, "Prime"', note: "line1\nline2", empty: null }]),
    'name,note,empty\r\n"A, ""Prime""","line1\nline2",\r\n',
  );
});
