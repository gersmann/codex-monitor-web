import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_AGENT_MAX_THREADS = 6;
const DEFAULT_AGENT_MAX_DEPTH = 1;
const MIN_AGENT_MAX_THREADS = 1;
const MAX_AGENT_MAX_THREADS = 12;
const MIN_AGENT_MAX_DEPTH = 1;
const MAX_AGENT_MAX_DEPTH = 4;
const MANAGED_AGENTS_DIR = "agents";
const DEFAULT_AGENT_MODEL = "gpt-5-codex";
const DEFAULT_REASONING_EFFORT = "medium";

export type AgentSummary = {
  name: string;
  description: string | null;
  developerInstructions: string | null;
  configFile: string;
  resolvedPath: string;
  managedByApp: boolean;
  fileExists: boolean;
};

export type AgentsSettings = {
  configPath: string;
  multiAgentEnabled: boolean;
  maxThreads: number;
  maxDepth: number;
  agents: AgentSummary[];
};

export type SetAgentsCoreInput = {
  multiAgentEnabled: boolean;
  maxThreads: number;
  maxDepth?: number;
};

export type CreateAgentInput = {
  name: string;
  description?: string | null;
  developerInstructions?: string | null;
  template?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
};

export type UpdateAgentInput = {
  originalName: string;
  name: string;
  description?: string | null;
  developerInstructions?: string | null;
  renameManagedFile?: boolean;
};

export type DeleteAgentInput = {
  name: string;
  deleteManagedFile?: boolean;
};

type TomlSection = {
  name: string;
  lines: string[];
};

type TomlDocument = {
  preamble: string[];
  sections: TomlSection[];
};

function trimString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeOptionalString(raw: string | null | undefined) {
  const trimmed = trimString(raw);
  return trimmed ? trimmed : null;
}

function configPathForHome(codexHome: string) {
  return path.join(codexHome, "config.toml");
}

async function readConfigContents(codexHome: string) {
  return await fs.readFile(configPathForHome(codexHome), "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
}

async function writeConfigContents(codexHome: string, contents: string) {
  const configPath = configPathForHome(codexHome);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, contents.endsWith("\n") ? contents : `${contents}\n`, "utf8");
}

function parseDocument(contents: string): TomlDocument {
  const lines = contents.split(/\r?\n/);
  const preamble: string[] = [];
  const sections: TomlSection[] = [];
  let current: TomlSection | null = null;
  for (const line of lines) {
    const headerMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (headerMatch) {
      current = {
        name: headerMatch[1]!.trim(),
        lines: [],
      };
      sections.push(current);
      continue;
    }
    if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  return { preamble, sections };
}

function renderDocument(document: TomlDocument) {
  const chunks: string[] = [];
  const preamble = document.preamble.join("\n").replace(/\n+$/, "");
  if (preamble) {
    chunks.push(preamble);
  }
  for (const section of document.sections) {
    const body = section.lines.join("\n").replace(/\n+$/, "");
    chunks.push(`[${section.name}]${body ? `\n${body}` : ""}`);
  }
  return `${chunks.join("\n\n")}\n`;
}

function sectionIndex(document: TomlDocument, name: string) {
  return document.sections.findIndex((section) => section.name === name);
}

function ensureSection(document: TomlDocument, name: string) {
  const existingIndex = sectionIndex(document, name);
  if (existingIndex >= 0) {
    return document.sections[existingIndex]!;
  }
  const section: TomlSection = { name, lines: [] };
  document.sections.push(section);
  return section;
}

function findKeyLineIndex(section: TomlSection, key: string) {
  const matcher = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);
  return section.lines.findIndex((line) => matcher.test(line));
}

function setSectionValue(section: TomlSection, key: string, renderedValue: string | null) {
  const index = findKeyLineIndex(section, key);
  if (renderedValue === null) {
    if (index >= 0) {
      section.lines.splice(index, 1);
    }
    return;
  }
  const line = `${key} = ${renderedValue}`;
  if (index >= 0) {
    section.lines[index] = line;
  } else {
    section.lines.push(line);
  }
}

function readSectionRawValue(section: TomlSection | null, key: string) {
  if (!section) {
    return null;
  }
  const matcher = new RegExp(
    `^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=\\s*(.+?)\\s*(?:#.*)?$`,
  );
  for (const line of section.lines) {
    const match = line.match(matcher);
    if (match) {
      return match[1]!.trim();
    }
  }
  return null;
}

function parseTomlString(raw: string | null) {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readSectionString(section: TomlSection | null, key: string) {
  return normalizeOptionalString(parseTomlString(readSectionRawValue(section, key)));
}

function readSectionBoolean(section: TomlSection | null, key: string) {
  const raw = readSectionRawValue(section, key);
  if (!raw) {
    return null;
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  return null;
}

function readSectionInteger(section: TomlSection | null, key: string) {
  const raw = readSectionRawValue(section, key);
  if (!raw) {
    return null;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function validateMaxThreads(value: number) {
  if (Number.isInteger(value) && value >= MIN_AGENT_MAX_THREADS && value <= MAX_AGENT_MAX_THREADS) {
    return;
  }
  throw new Error(
    `agents.max_threads must be between ${MIN_AGENT_MAX_THREADS} and ${MAX_AGENT_MAX_THREADS}`,
  );
}

function validateMaxDepth(value: number) {
  if (Number.isInteger(value) && value >= MIN_AGENT_MAX_DEPTH && value <= MAX_AGENT_MAX_DEPTH) {
    return;
  }
  throw new Error(
    `agents.max_depth must be between ${MIN_AGENT_MAX_DEPTH} and ${MAX_AGENT_MAX_DEPTH}`,
  );
}

function isReservedAgentsKey(name: string) {
  return name === "max_threads" || name === "max_depth";
}

function normalizeAgentName(rawName: string) {
  let name = "";
  let previousWasSpace = false;
  for (const character of rawName.trim().toLowerCase()) {
    if (/\s/.test(character)) {
      if (name && !previousWasSpace) {
        name += "-";
      }
      previousWasSpace = true;
      continue;
    }
    name += character;
    previousWasSpace = false;
  }
  if (!name) {
    throw new Error("agent name is required");
  }
  if (name.length > 32) {
    throw new Error("agent name must be 32 characters or fewer");
  }
  const first = name[0]!;
  if (!/[a-z0-9]/.test(first)) {
    throw new Error("agent name must start with a lowercase letter or digit");
  }
  for (const character of name.slice(1)) {
    if (!/[a-z0-9_-]/.test(character)) {
      throw new Error("agent name must use only lowercase letters, digits, '_' or '-'");
    }
  }
  if (isReservedAgentsKey(name)) {
    throw new Error("agent name is reserved");
  }
  return name;
}

function normalizeAgentLookupName(rawName: string) {
  const trimmed = rawName.trim();
  if (!trimmed) {
    throw new Error("agent name is required");
  }
  return trimmed;
}

function managedRelativeConfigForName(name: string) {
  return path.posix.join(MANAGED_AGENTS_DIR, `${name}.toml`);
}

function normalizeRelativePath(rawPath: string) {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return null;
  }
  const parsed = path.posix.normalize(trimmed.replace(/\\/g, "/"));
  if (
    parsed === "." ||
    parsed.startsWith("../") ||
    parsed === ".." ||
    parsed.startsWith("/") ||
    /^[A-Za-z]:\//.test(parsed)
  ) {
    return null;
  }
  return parsed;
}

function managedRelativePathFromConfig(rawPath: string) {
  const normalized = normalizeRelativePath(rawPath);
  if (!normalized) {
    return null;
  }
  return normalized === MANAGED_AGENTS_DIR || normalized.startsWith(`${MANAGED_AGENTS_DIR}/`)
    ? normalized
    : null;
}

async function assertManagedPathWithoutSymlinks(
  codexHome: string,
  relativePath: string,
  includeLeaf: boolean,
) {
  const normalized = normalizeRelativePath(relativePath);
  if (!normalized) {
    throw new Error("invalid managed agent path");
  }
  let current = path.resolve(codexHome);
  const segments = normalized.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]!);
    const isLeaf = index === segments.length - 1;
    if (isLeaf && !includeLeaf) {
      break;
    }
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Managed agent config path may not contain symlinks: ${current}`);
      }
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String((error as NodeJS.ErrnoException).code ?? "")
          : "";
      if (code === "ENOENT") {
        break;
      }
      throw error;
    }
  }
}

async function resolveSafeManagedAbsPathForRead(codexHome: string, relativePath: string) {
  await assertManagedPathWithoutSymlinks(codexHome, relativePath, true);
  return path.join(codexHome, relativePath);
}

async function resolveSafeManagedAbsPathForWrite(codexHome: string, relativePath: string) {
  const target = path.join(codexHome, relativePath);
  await assertManagedPathWithoutSymlinks(codexHome, relativePath, true);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await assertManagedPathWithoutSymlinks(codexHome, relativePath, true);
  return target;
}

function buildTemplateContent(
  model: string | null,
  reasoningEffort: string | null,
  developerInstructions: string | null,
) {
  const lines = ["# Agent-specific overrides"];
  lines.push(`model = ${JSON.stringify(model ?? DEFAULT_AGENT_MODEL)}`);
  lines.push(
    `model_reasoning_effort = ${JSON.stringify(reasoningEffort ?? DEFAULT_REASONING_EFFORT)}`,
  );
  if (developerInstructions) {
    lines.push(`developer_instructions = ${JSON.stringify(developerInstructions)}`);
  }
  return `${lines.join("\n")}\n`;
}

async function readManagedDeveloperInstructions(codexHome: string, configFile: string) {
  const relativePath = managedRelativePathFromConfig(configFile);
  if (!relativePath) {
    return null;
  }
  const target = await resolveSafeManagedAbsPathForRead(codexHome, relativePath);
  const contents = await fs.readFile(target, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  });
  return readSectionString(parseDocument(contents).sections[0] ?? null, "developer_instructions") ??
    (() => {
      const match = contents.match(/^\s*developer_instructions\s*=\s*(.+?)\s*$/m);
      return normalizeOptionalString(parseTomlString(match?.[1] ?? null));
    })();
}

async function updateManagedDeveloperInstructions(
  targetPath: string,
  developerInstructions: string | null,
) {
  const previous = await fs.readFile(targetPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  const contents = previous?.toString("utf8") ?? "";
  const lines = contents.split(/\r?\n/).filter((line, index, all) => {
    return !(index === all.length - 1 && line === "");
  });
  const index = lines.findIndex((line) => /^\s*developer_instructions\s*=/.test(line));
  if (developerInstructions) {
    const replacement = `developer_instructions = ${JSON.stringify(developerInstructions)}`;
    if (index >= 0) {
      lines[index] = replacement;
    } else {
      lines.push(replacement);
    }
  } else if (index >= 0) {
    lines.splice(index, 1);
  }
  const rendered = `${lines.join("\n")}\n`;
  await fs.writeFile(targetPath, rendered, "utf8");
  return previous;
}

function resolvedConfigPathForDisplay(codexHome: string, configFile: string) {
  const trimmed = trimString(configFile);
  if (!trimmed) {
    return codexHome;
  }
  if (path.isAbsolute(trimmed)) {
    return trimmed;
  }
  const normalized = normalizeRelativePath(trimmed);
  return normalized ? path.join(codexHome, normalized) : codexHome;
}

function agentSectionName(name: string) {
  return `agents.${name}`;
}

function listAgentSections(document: TomlDocument) {
  return document.sections.filter((section) => {
    if (!section.name.startsWith("agents.")) {
      return false;
    }
    const name = section.name.slice("agents.".length);
    return Boolean(name) && !isReservedAgentsKey(name);
  });
}

function readMultiAgentEnabled(document: TomlDocument) {
  return readSectionBoolean(
    document.sections[sectionIndex(document, "features")] ?? null,
    "multi_agent",
  ) ?? false;
}

function readMaxThreads(document: TomlDocument) {
  const value = readSectionInteger(
    document.sections[sectionIndex(document, "agents")] ?? null,
    "max_threads",
  );
  if (value === null || value < MIN_AGENT_MAX_THREADS || value > MAX_AGENT_MAX_THREADS) {
    return DEFAULT_AGENT_MAX_THREADS;
  }
  return value;
}

function readMaxDepth(document: TomlDocument) {
  const value = readSectionInteger(
    document.sections[sectionIndex(document, "agents")] ?? null,
    "max_depth",
  );
  if (value === null || value < MIN_AGENT_MAX_DEPTH || value > MAX_AGENT_MAX_DEPTH) {
    return DEFAULT_AGENT_MAX_DEPTH;
  }
  return value;
}

async function collectAgents(codexHome: string, document: TomlDocument): Promise<AgentSummary[]> {
  const agents: AgentSummary[] = [];
  for (const section of listAgentSections(document)) {
    const name = section.name.slice("agents.".length);
    const description = readSectionString(section, "description");
    const configFile = readSectionString(section, "config_file") ?? "";
    const managedByApp = managedRelativePathFromConfig(configFile) !== null;
    const resolvedPath = resolvedConfigPathForDisplay(codexHome, configFile);
    const fileExists = await fs
      .stat(resolvedPath)
      .then((stat) => stat.isFile())
      .catch(() => false);
    agents.push({
      name,
      description,
      developerInstructions: await readManagedDeveloperInstructions(codexHome, configFile),
      configFile,
      resolvedPath,
      managedByApp,
      fileExists,
    });
  }
  return agents.sort((left, right) => left.name.localeCompare(right.name));
}

async function loadAgentsSettings(codexHome: string) {
  const contents = await readConfigContents(codexHome);
  const document = parseDocument(contents);
  return {
    document,
    settings: {
      configPath: configPathForHome(codexHome),
      multiAgentEnabled: readMultiAgentEnabled(document),
      maxThreads: readMaxThreads(document),
      maxDepth: readMaxDepth(document),
      agents: await collectAgents(codexHome, document),
    } satisfies AgentsSettings,
  };
}

function hasAgentNameConflict(document: TomlDocument, name: string, excluding?: string | null) {
  return listAgentSections(document).some((section) => {
    const sectionName = section.name.slice("agents.".length);
    if (excluding && sectionName === excluding) {
      return false;
    }
    return sectionName.toLowerCase() === name.toLowerCase();
  });
}

export async function getAgentsSettings(codexHome: string) {
  return (await loadAgentsSettings(codexHome)).settings;
}

export async function setAgentsCoreSettings(codexHome: string, input: SetAgentsCoreInput) {
  validateMaxThreads(input.maxThreads);
  const maxDepth = input.maxDepth ?? DEFAULT_AGENT_MAX_DEPTH;
  validateMaxDepth(maxDepth);
  const { document } = await loadAgentsSettings(codexHome);
  const featuresSection = ensureSection(document, "features");
  setSectionValue(featuresSection, "multi_agent", input.multiAgentEnabled ? "true" : "false");
  const agentsSection = ensureSection(document, "agents");
  setSectionValue(agentsSection, "max_threads", String(input.maxThreads));
  setSectionValue(agentsSection, "max_depth", String(maxDepth));
  await writeConfigContents(codexHome, renderDocument(document));
  return await getAgentsSettings(codexHome);
}

export async function createAgent(codexHome: string, input: CreateAgentInput) {
  const name = normalizeAgentName(input.name);
  const description = normalizeOptionalString(input.description);
  const developerInstructions = normalizeOptionalString(input.developerInstructions);
  const { document } = await loadAgentsSettings(codexHome);
  if (hasAgentNameConflict(document, name, null)) {
    throw new Error(`agent '${name}' already exists`);
  }
  const configFile = managedRelativeConfigForName(name);
  const targetPath = await resolveSafeManagedAbsPathForWrite(codexHome, configFile);
  const targetExists = await fs.stat(targetPath).then(() => true).catch(() => false);
  if (targetExists) {
    throw new Error(`target config file already exists: ${targetPath}`);
  }
  await fs.writeFile(
    targetPath,
    buildTemplateContent(
      normalizeOptionalString(input.model),
      normalizeOptionalString(input.reasoningEffort),
      developerInstructions,
    ),
    "utf8",
  );
  try {
    const section = ensureSection(document, agentSectionName(name));
    setSectionValue(section, "description", description ? JSON.stringify(description) : null);
    setSectionValue(section, "config_file", JSON.stringify(configFile));
    await writeConfigContents(codexHome, renderDocument(document));
  } catch (error) {
    await fs.rm(targetPath, { force: true });
    throw error;
  }
  return await getAgentsSettings(codexHome);
}

export async function updateAgent(codexHome: string, input: UpdateAgentInput) {
  const originalName = normalizeAgentLookupName(input.originalName);
  const nextName = normalizeAgentName(input.name);
  const description = normalizeOptionalString(input.description);
  const developerInstructionsInput = input.developerInstructions;
  const developerInstructions = normalizeOptionalString(input.developerInstructions);
  const renameManagedFile = input.renameManagedFile !== false;
  const { document } = await loadAgentsSettings(codexHome);
  const originalSectionIndex = sectionIndex(document, agentSectionName(originalName));
  if (originalSectionIndex < 0) {
    throw new Error(`agent '${originalName}' not found`);
  }
  if (nextName !== originalName && hasAgentNameConflict(document, nextName, originalName)) {
    throw new Error(`agent '${nextName}' already exists`);
  }

  const originalSection = document.sections[originalSectionIndex]!;
  const nextSection: TomlSection = {
    name: agentSectionName(nextName),
    lines: [...originalSection.lines],
  };

  let nextConfigFile = readSectionString(nextSection, "config_file");
  let renamedPaths: { oldPath: string; newPath: string } | null = null;
  let configBackup: { path: string; previous: Buffer | null } | null = null;
  try {
    if (renameManagedFile && nextName !== originalName && nextConfigFile) {
      const managedRelative = managedRelativePathFromConfig(nextConfigFile);
      if (managedRelative) {
        const newRelative = managedRelativeConfigForName(nextName);
        if (managedRelative !== newRelative) {
          const oldPath = await resolveSafeManagedAbsPathForRead(codexHome, managedRelative);
          const newPath = await resolveSafeManagedAbsPathForWrite(codexHome, newRelative);
          const newExists = await fs.stat(newPath).then(() => true).catch(() => false);
          if (newExists) {
            throw new Error(`target config file already exists: ${newPath}`);
          }
          const oldExists = await fs.stat(oldPath).then(() => true).catch(() => false);
          if (oldExists) {
            await fs.rename(oldPath, newPath);
            renamedPaths = { oldPath, newPath };
          }
          nextConfigFile = newRelative;
        }
      }
    }

    setSectionValue(nextSection, "description", description ? JSON.stringify(description) : null);
    if (nextConfigFile) {
      setSectionValue(nextSection, "config_file", JSON.stringify(nextConfigFile));
    } else {
      setSectionValue(nextSection, "config_file", null);
    }

    if (developerInstructionsInput !== undefined) {
      if (!nextConfigFile) {
        throw new Error(`agent '${nextName}' does not define config_file; cannot update developer_instructions`);
      }
      const managedRelative = managedRelativePathFromConfig(nextConfigFile);
      if (!managedRelative) {
        throw new Error(
          `agent '${nextName}' config_file is external; edit that file directly to change developer_instructions`,
        );
      }
      const targetPath = await resolveSafeManagedAbsPathForWrite(codexHome, managedRelative);
      configBackup = {
        path: targetPath,
        previous: await updateManagedDeveloperInstructions(targetPath, developerInstructions),
      };
    }

    document.sections.splice(originalSectionIndex, 1, nextSection);
    await writeConfigContents(codexHome, renderDocument(document));
  } catch (error) {
    if (configBackup) {
      if (configBackup.previous) {
        await fs.writeFile(configBackup.path, configBackup.previous);
      } else {
        await fs.rm(configBackup.path, { force: true });
      }
    }
    if (renamedPaths) {
      const newExists = await fs.stat(renamedPaths.newPath).then(() => true).catch(() => false);
      if (newExists) {
        await fs.rename(renamedPaths.newPath, renamedPaths.oldPath);
      }
    }
    throw error;
  }
  return await getAgentsSettings(codexHome);
}

export async function deleteAgent(codexHome: string, input: DeleteAgentInput) {
  const name = normalizeAgentLookupName(input.name);
  const deleteManagedFile = input.deleteManagedFile === true;
  const { document } = await loadAgentsSettings(codexHome);
  const index = sectionIndex(document, agentSectionName(name));
  if (index < 0) {
    throw new Error(`agent '${name}' not found`);
  }
  const section = document.sections[index]!;
  const configFile = readSectionString(section, "config_file");
  document.sections.splice(index, 1);

  let deletedConfigBackup: { path: string; bytes: Buffer } | null = null;
  try {
    if (deleteManagedFile && configFile) {
      const managedRelative = managedRelativePathFromConfig(configFile);
      if (managedRelative) {
        const targetPath = await resolveSafeManagedAbsPathForRead(codexHome, managedRelative);
        const exists = await fs.stat(targetPath).then(() => true).catch(() => false);
        if (exists) {
          const bytes = await fs.readFile(targetPath);
          await fs.rm(targetPath);
          deletedConfigBackup = { path: targetPath, bytes };
        }
      }
    }
    await writeConfigContents(codexHome, renderDocument(document));
  } catch (error) {
    if (deletedConfigBackup) {
      await fs.writeFile(deletedConfigBackup.path, deletedConfigBackup.bytes);
    }
    throw error;
  }
  return await getAgentsSettings(codexHome);
}

function resolveManagedAgentConfigRelativePath(document: TomlDocument, agentName: string) {
  const section = document.sections[sectionIndex(document, agentSectionName(agentName))] ?? null;
  if (!section) {
    throw new Error(`agent '${agentName}' not found`);
  }
  const configFile = readSectionString(section, "config_file");
  if (!configFile) {
    throw new Error(`agent '${agentName}' does not define config_file`);
  }
  const managedRelative = managedRelativePathFromConfig(configFile);
  if (!managedRelative) {
    throw new Error(`agent '${agentName}' config_file is not managed by CodexMonitor`);
  }
  return managedRelative;
}

export async function readAgentConfigToml(codexHome: string, agentName: string) {
  const { document } = await loadAgentsSettings(codexHome);
  const relativePath = resolveManagedAgentConfigRelativePath(document, normalizeAgentLookupName(agentName));
  const targetPath = await resolveSafeManagedAbsPathForRead(codexHome, relativePath);
  return await fs.readFile(targetPath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return "";
    }
    throw new Error(`Failed to read agent config file: ${error.message}`);
  });
}

export async function writeAgentConfigToml(codexHome: string, agentName: string, content: string) {
  const { document } = await loadAgentsSettings(codexHome);
  const relativePath = resolveManagedAgentConfigRelativePath(document, normalizeAgentLookupName(agentName));
  const targetPath = await resolveSafeManagedAbsPathForWrite(codexHome, relativePath);
  await fs.writeFile(targetPath, content, "utf8");
}
