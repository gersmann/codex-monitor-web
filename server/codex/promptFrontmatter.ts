function parseFrontmatterLine(line: string) {
  const [rawKey, ...rest] = line.split(":");
  if (!rawKey || rest.length === 0) {
    return null;
  }
  return {
    key: rawKey.trim().toLowerCase(),
    value: rest.join(":").trim().replace(/^['"]|['"]$/g, ""),
  };
}

export function parseFrontmatter(content: string) {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return {
      description: null,
      argumentHint: null,
      body: content,
    };
  }
  let index = 1;
  let description: string | null = null;
  let argumentHint: string | null = null;
  for (; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line === "---") {
      index += 1;
      break;
    }
    const parsed = parseFrontmatterLine(line);
    if (!parsed) {
      continue;
    }
    if (parsed.key === "description") {
      description = parsed.value || null;
      continue;
    }
    if (parsed.key === "argument-hint" || parsed.key === "argument_hint") {
      argumentHint = parsed.value || null;
    }
  }
  return {
    description,
    argumentHint,
    body: lines.slice(index).join("\n"),
  };
}
