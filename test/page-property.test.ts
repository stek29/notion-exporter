import { describe, expect, it } from "vitest";
import { needsIndividualPropertyRetrieval } from "../src/exporter/page-property.js";

describe("page property completion", () => {
  it("uses embedded simple properties", () => {
    for (const type of [
      "checkbox",
      "date",
      "files",
      "formula",
      "multi_select",
      "number",
      "select",
      "status",
      "url",
    ]) {
      expect(
        needsIndividualPropertyRetrieval({ id: type, type, [type]: null }),
      ).toBe(false);
    }
  });

  it("retrieves only potentially truncated paginated properties", () => {
    expect(
      needsIndividualPropertyRetrieval({
        id: "relation",
        type: "relation",
        relation: [],
        has_more: false,
      }),
    ).toBe(false);
    expect(
      needsIndividualPropertyRetrieval({
        id: "relation",
        type: "relation",
        relation: [],
        has_more: true,
      }),
    ).toBe(true);
    expect(
      needsIndividualPropertyRetrieval({
        id: "people",
        type: "people",
        people: Array.from({ length: 24 }, (_, id) => ({ id })),
      }),
    ).toBe(false);
    expect(
      needsIndividualPropertyRetrieval({
        id: "people",
        type: "people",
        people: Array.from({ length: 25 }, (_, id) => ({ id })),
      }),
    ).toBe(true);
  });

  it("expands mention-heavy rich text and always expands rollups", () => {
    expect(
      needsIndividualPropertyRetrieval({
        id: "title",
        type: "title",
        title: [{ type: "text", text: { content: "Complete" } }],
      }),
    ).toBe(false);
    expect(
      needsIndividualPropertyRetrieval({
        id: "rich_text",
        type: "rich_text",
        rich_text: Array.from({ length: 25 }, () => ({ type: "mention" })),
      }),
    ).toBe(true);
    expect(
      needsIndividualPropertyRetrieval({
        id: "rollup",
        type: "rollup",
        rollup: { type: "number", number: 1 },
      }),
    ).toBe(true);
  });

  it("uses the dedicated endpoint for malformed and future property types", () => {
    expect(needsIndividualPropertyRetrieval({ id: "missing-type" })).toBe(true);
    expect(
      needsIndividualPropertyRetrieval({
        id: "future",
        type: "future_property",
      }),
    ).toBe(true);
  });
});
