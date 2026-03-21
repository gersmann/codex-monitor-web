export function trimString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

export function toNullableString(value: unknown) {
  const trimmed = trimString(value);
  return trimmed.length > 0 ? trimmed : null;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
