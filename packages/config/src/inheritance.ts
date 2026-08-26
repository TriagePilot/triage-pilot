export type ConfigurationValueSource = "default" | "organization" | "repository";

export type ConfigurationSourceTree =
  | ConfigurationValueSource
  | { [key: string]: ConfigurationSourceTree }
  | ConfigurationSourceTree[];

export interface ConfigurationMergeResult {
  value: unknown;
  sources: ConfigurationSourceTree;
}

export function mergeConfiguration(parent: unknown, child: unknown): unknown {
  return mergeConfigurationWithSources(parent, child, "organization", "repository").value;
}

export function mergeConfigurationWithSources(
  parent: unknown,
  child: unknown,
  parentSource: ConfigurationValueSource,
  childSource: ConfigurationValueSource,
): ConfigurationMergeResult {
  return mergeAtPath(parent, child, parentSource, childSource, []);
}

export function sourceTreeFor(value: unknown, source: ConfigurationValueSource): ConfigurationSourceTree {
  if (Array.isArray(value)) return value.map((entry) => sourceTreeFor(entry, source));
  if (isObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sourceTreeFor(entry, source)]),
    );
  }
  return source;
}

function mergeAtPath(
  parent: unknown,
  child: unknown,
  parentSource: ConfigurationValueSource,
  childSource: ConfigurationValueSource,
  path: string[],
): ConfigurationMergeResult {
  if (isObject(parent) && isObject(child)) {
    const value: Record<string, unknown> = {};
    const sources: Record<string, ConfigurationSourceTree> = {};
    const keys = new Set([...Object.keys(parent), ...Object.keys(child)]);

    for (const key of keys) {
      if (!(key in child)) {
        value[key] = clone(parent[key]);
        sources[key] = sourceTreeFor(parent[key], parentSource);
      } else if (!(key in parent)) {
        value[key] = clone(child[key]);
        sources[key] = sourceTreeFor(child[key], childSource);
      } else {
        const merged = mergeAtPath(parent[key], child[key], parentSource, childSource, [...path, key]);
        value[key] = merged.value;
        sources[key] = merged.sources;
      }
    }
    return { value, sources };
  }

  if (Array.isArray(parent) && Array.isArray(child)) {
    const parentKeys = parent.map((entry) => arrayEntryKey(path, entry));
    const childKeys = new Set(child.map((entry) => arrayEntryKey(path, entry)));
    const retainedParentEntries = parent.filter((_entry, index) => !childKeys.has(parentKeys[index]!));
    return {
      value: [
        ...child.map(clone),
        ...retainedParentEntries.map(clone),
      ],
      sources: [
        ...child.map((entry) => sourceTreeFor(entry, childSource)),
        ...retainedParentEntries.map((entry) => sourceTreeFor(entry, parentSource)),
      ],
    };
  }

  return { value: clone(child), sources: sourceTreeFor(child, childSource) };
}

function arrayEntryKey(path: string[], entry: unknown): string {
  const pathKey = path.join(".");
  if (pathKey === "risk.paths" && isObject(entry) && typeof entry.pattern === "string") {
    return normalizeScalarKey(entry.pattern);
  }
  if (pathKey === "risk.suppressors" && isObject(entry) && Array.isArray(entry.if_all_match)) {
    return normalizeSetKey(entry.if_all_match);
  }
  if (pathKey === "ownership.rules" && isObject(entry) && Array.isArray(entry.paths)) {
    return normalizeSetKey(entry.paths);
  }
  if (typeof entry === "string") return normalizeScalarKey(entry);
  return stableKey(entry);
}

export function normalizeScalarKey(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : stableKey(value);
}

export function normalizeSetKey(values: unknown[]): string {
  return [...new Set(values.map(normalizeScalarKey))].sort().join("\u0000");
}

function stableKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableKey(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as T;
  if (isObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)])) as T;
  }
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
