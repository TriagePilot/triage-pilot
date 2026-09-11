import { createHash } from "node:crypto";

import type {
  ConfigurationSource,
  RepositoryRef,
  WorkspaceId,
} from "@triagepilot/contracts";
import {
  mergeConfigurationWithSources,
  sourceTreeFor,
  type ConfigurationSourceTree,
  type ConfigurationValueSource,
} from "./inheritance.js";
import {
  parseConfigurationDocument,
  validateFinalConfiguration,
  type ConfigDiagnostic,
  type ConfigurationDocumentValue,
  type TriagePilotConfig,
} from "./schema.js";

export interface EffectiveConfigurationProvenance {
  organizationVersion: string | null;
  repositoryPath: string | null;
  repositoryRevision: string | null;
  inheritanceMode: "defaults" | "organization" | "replace" | "inherit";
  effectiveHash: string | null;
  sources: Record<string, "default" | "organization" | "repository">;
}

export type EffectiveConfigurationResult =
  | { ok: true; config: TriagePilotConfig; diagnostics: []; provenance: EffectiveConfigurationProvenance }
  | { ok: false; diagnostics: ConfigDiagnostic[]; provenance: EffectiveConfigurationProvenance };

export interface ResolveConfigurationInput {
  workspaceId: WorkspaceId;
  repository: RepositoryRef;
  trustedRevision: string;
  source: ConfigurationSource;
  allowOrganizationEnforce: boolean;
}

export async function resolveConfiguration(
  input: ResolveConfigurationInput,
): Promise<EffectiveConfigurationResult> {
  const repositorySource = await input.source.loadRepository({
    workspaceId: input.workspaceId,
    repository: input.repository,
    trustedRevision: input.trustedRevision,
  });
  let organizationSource = null as Awaited<ReturnType<ConfigurationSource["loadOrganization"]>>;

  let inheritanceMode: EffectiveConfigurationProvenance["inheritanceMode"] = repositorySource === null
    ? "defaults"
    : "replace";
  const baseProvenance = (): EffectiveConfigurationProvenance => ({
    organizationVersion: organizationSource?.version ?? null,
    repositoryPath: repositorySource?.path ?? null,
    repositoryRevision: repositorySource?.revision ?? null,
    inheritanceMode,
    effectiveHash: null,
    sources: {},
  });

  const repositoryResult = repositorySource === null
    ? null
    : parseConfigurationDocument(repositorySource.content, { partial: true });
  if (repositoryResult !== null && !repositoryResult.ok) {
    return { ok: false, diagnostics: repositoryResult.diagnostics, provenance: baseProvenance() };
  }

  const repositoryDocument = repositoryResult?.document ?? null;
  inheritanceMode = repositoryDocument === null
    ? "defaults"
    : repositoryDocument.inheritance === true ? "inherit" : "replace";

  if (repositorySource !== null && inheritanceMode === "replace") {
    const fullRepositoryResult = parseConfigurationDocument(repositorySource.content, { partial: false });
    if (!fullRepositoryResult.ok) {
      return { ok: false, diagnostics: fullRepositoryResult.diagnostics, provenance: baseProvenance() };
    }
  }

  if (inheritanceMode !== "replace") {
    organizationSource = await input.source.loadOrganization(input.workspaceId);
    inheritanceMode = repositoryDocument === null
      ? organizationSource === null ? "defaults" : "organization"
      : "inherit";
  }

  let organizationDocument: ConfigurationDocumentValue | null = null;
  if (organizationSource !== null && inheritanceMode !== "replace") {
    const organizationResult = parseConfigurationDocument(organizationSource.content, { partial: true });
    if (!organizationResult.ok) {
      return { ok: false, diagnostics: organizationResult.diagnostics, provenance: baseProvenance() };
    }
    if (organizationResult.document.inheritance !== undefined) {
      return {
        ok: false,
        diagnostics: [{ path: "$.inheritance", message: "inheritance is only valid in repository configuration" }],
        provenance: baseProvenance(),
      };
    }
    organizationDocument = organizationResult.document;
  }

  const repositoryExecutionDocument = withoutInheritance(repositoryDocument);
  const merged = mergeDocuments(organizationDocument, repositoryExecutionDocument, inheritanceMode);
  if (
    repositorySource === null
    && !input.allowOrganizationEnforce
    && isObject(merged.value)
    && merged.value.mode === "enforce"
  ) {
    merged.value.mode = "shadow";
    if (isSourceObject(merged.sources)) merged.sources.mode = "default";
  }

  const finalResult = validateFinalConfiguration(merged.value);
  if (!finalResult.ok) {
    return { ok: false, diagnostics: finalResult.diagnostics, provenance: baseProvenance() };
  }

  return {
    ok: true,
    config: finalResult.config,
    diagnostics: [],
    provenance: {
      ...baseProvenance(),
      effectiveHash: createHash("sha256").update(stableStringify(finalResult.config)).digest("hex"),
      sources: collectLeafSources(finalResult.config, merged.sources),
    },
  };
}

function mergeDocuments(
  organizationDocument: ConfigurationDocumentValue | null,
  repositoryDocument: ConfigurationDocumentValue | null,
  mode: EffectiveConfigurationProvenance["inheritanceMode"],
): { value: unknown; sources: ConfigurationSourceTree } {
  if (repositoryDocument === null) {
    const value = organizationDocument ?? {};
    return { value: clone(value), sources: sourceTreeFor(value, organizationDocument === null ? "default" : "organization") };
  }
  if (mode === "inherit") {
    return mergeConfigurationWithSources(
      organizationDocument ?? {},
      repositoryDocument,
      "organization",
      "repository",
    );
  }
  return { value: clone(repositoryDocument), sources: sourceTreeFor(repositoryDocument, "repository") };
}

function withoutInheritance(document: ConfigurationDocumentValue | null): ConfigurationDocumentValue | null {
  if (document === null) return null;
  const { inheritance: _inheritance, ...executionDocument } = document;
  return executionDocument;
}

const inputKeyByOutputKey: Record<string, string> = {
  highRiskReviewers: "high_risk_reviewers",
  excludeTargetBranches: "exclude_target_branches",
  excludeSourceBranchPatterns: "exclude_source_branch_patterns",
  includeDraftPullRequests: "include_draft_pull_requests",
  highChangedFiles: "high_changed_files",
  highChangedLines: "high_changed_lines",
  ifAllMatch: "if_all_match",
  aiAuthorship: "ai_authorship",
  fallbackReviewers: "fallback_reviewers",
};

function collectLeafSources(
  value: unknown,
  sourceTree: ConfigurationSourceTree | undefined,
  path = "$",
  sources: Record<string, ConfigurationValueSource> = {},
): Record<string, ConfigurationValueSource> {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      const childTree = Array.isArray(sourceTree) ? sourceTree[index] : sourceTree;
      collectLeafSources(entry, childTree, `${path}.${index}`, sources);
    });
    return sources;
  }
  if (isObject(value)) {
    for (const [key, entry] of Object.entries(value)) {
      const inputKey = inputKeyByOutputKey[key] ?? key;
      const childTree = isSourceObject(sourceTree) ? sourceTree[inputKey] : sourceTree;
      collectLeafSources(entry, childTree, `${path}.${key}`, sources);
    }
    return sources;
  }
  sources[path] = typeof sourceTree === "string" ? sourceTree : "default";
  return sources;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isObject(value)) {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`);
    return `{${entries.join(",")}}`;
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

function isSourceObject(value: ConfigurationSourceTree | undefined): value is Record<string, ConfigurationSourceTree> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
