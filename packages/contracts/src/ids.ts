export type ProviderKind = "github" | "gitlab" | "bitbucket";
export type WorkspaceId = string;
export type ProviderConnectionId = string;
export type RepositoryId = string;
export type ChangeRequestId = string;
export type ExternalActorId = string;

export interface RepositoryRef {
  provider: ProviderKind;
  externalId: RepositoryId;
  owner: string;
  name: string;
}

export interface ChangeRequestRef {
  repository: RepositoryRef;
  externalId: ChangeRequestId;
  number: number;
  baseRevision: string;
  headRevision: string;
}
