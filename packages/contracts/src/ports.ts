import type {
  DecisionEventV1,
} from "./events";
import type {
  ProviderConnectionId,
  ProviderKind,
  RepositoryRef,
  WorkspaceId,
} from "./ids";

export interface ConfigurationDocument {
  content: string;
  revision: string;
  path: string;
}

export interface OrganizationConfigurationDocument extends ConfigurationDocument {
  version: string;
}

export interface ConfigurationSource {
  loadOrganization(workspaceId: WorkspaceId): Promise<OrganizationConfigurationDocument | null>;
  loadRepository(input: { workspaceId: WorkspaceId; repository: RepositoryRef; trustedRevision: string }): Promise<ConfigurationDocument | null>;
}

export interface CredentialProvider<TCredential> {
  getCredential(input: { workspaceId: WorkspaceId; providerConnectionId: ProviderConnectionId }): Promise<TCredential>;
}

export interface ProviderConnectionLookup {
  findWorkspace(input: { provider: ProviderKind; externalConnectionId: string }): Promise<{ workspaceId: WorkspaceId; providerConnectionId: ProviderConnectionId; active: boolean } | null>;
}

export interface DecisionEventSink {
  emit(event: DecisionEventV1): Promise<void>;
}

export interface Clock { now(): Date; }
export interface IdempotencyService { reserve(key: string): Promise<boolean>; }
