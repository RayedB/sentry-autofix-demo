export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

export function readNumber(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function tagValue(record: Record<string, unknown>, key: string): string | null {
  const tags = record.tags;
  if (Array.isArray(tags)) {
    for (const tag of tags) {
      if (Array.isArray(tag) && tag[0] === key && typeof tag[1] === "string") {
        return tag[1];
      }
      if (isRecord(tag) && (tag.key === key || tag.name === key) && typeof tag.value === "string") {
        return tag.value;
      }
    }
    return null;
  }
  if (isRecord(tags) && typeof tags[key] === "string") {
    return tags[key];
  }
  return null;
}
