const EMBEDDED_COMPLETE_TYPES = new Set([
  "button",
  "checkbox",
  "created_by",
  "created_time",
  "date",
  "email",
  "files",
  "formula",
  "last_edited_by",
  "last_edited_time",
  "multi_select",
  "number",
  "phone_number",
  "place",
  "select",
  "status",
  "unique_id",
  "url",
  "verification",
]);

export function needsIndividualPropertyRetrieval(
  property: Record<string, unknown>,
): boolean {
  const type = property.type;
  if (typeof type !== "string") return true;

  if (type === "rollup") return true;
  if (type === "relation") {
    return property.has_more !== false || !Array.isArray(property.relation);
  }
  if (type === "people") {
    return !Array.isArray(property.people) || property.people.length >= 25;
  }
  if (type === "title" || type === "rich_text") {
    const fragments = property[type];
    if (!Array.isArray(fragments)) return true;
    return fragments.filter(isMention).length >= 25;
  }

  // Unknown future property types use the dedicated endpoint until their
  // completeness guarantees are understood.
  return !EMBEDDED_COMPLETE_TYPES.has(type);
}

function isMention(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "mention"
  );
}
