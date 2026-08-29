import { describe, expect, it } from "vitest";
import { normalizeNotionId } from "../src/shared/ids.js";
import { stringifyCanonical } from "../src/snapshot/canonical-json.js";

describe("canonical JSON", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(
      stringifyCanonical({ z: 1, a: { y: 2, x: 3 }, order: [3, 1, 2] }),
    ).toBe(
      '{\n  "a": {\n    "x": 3,\n    "y": 2\n  },\n  "order": [\n    3,\n    1,\n    2\n  ],\n  "z": 1\n}\n',
    );
  });

  it("normalizes raw IDs and Notion URLs", () => {
    const id = "248104cd-477e-80fd-b757-e945d38000bd";
    expect(normalizeNotionId(id.replaceAll("-", ""))).toBe(id);
    expect(
      normalizeNotionId(
        `https://www.notion.so/Title-${id.replaceAll("-", "")}?v=abc`,
      ),
    ).toBe(id);
  });
});
