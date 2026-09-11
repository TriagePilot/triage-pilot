import { useEffect, useState } from "react";

import type {
  AuthorizationCapabilities,
  EffectiveConfigurationOverview,
  NavigationHost,
  OperationsApiClient,
  RepositoryContext,
  WorkspaceContext,
} from "../api.js";

export interface EffectiveConfigurationProps {
  api: OperationsApiClient;
  workspace: WorkspaceContext;
  repository: RepositoryContext;
  authorization: AuthorizationCapabilities;
  navigation: NavigationHost;
  initialConfiguration?: EffectiveConfigurationOverview;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; configuration: EffectiveConfigurationOverview }
  | { status: "failed"; message: string };

export function EffectiveConfiguration({
  api,
  workspace,
  repository,
  authorization,
  navigation,
  initialConfiguration,
}: EffectiveConfigurationProps) {
  const [state, setState] = useState<LoadState>(
    initialConfiguration ? { status: "ready", configuration: initialConfiguration } : { status: "loading" },
  );

  async function loadConfiguration() {
    if (!authorization.canViewOperations) {
      setState({ status: "failed", message: "Configuration is not available for this workspace." });
      return;
    }
    setState({ status: "loading" });
    try {
      setState({ status: "ready", configuration: await api.readEffectiveConfiguration(workspace, repository) });
    } catch (caught) {
      setState({ status: "failed", message: messageFrom(caught, "Could not load the effective configuration.") });
    }
  }

  useEffect(() => {
    if (initialConfiguration) {
      setState({ status: "ready", configuration: initialConfiguration });
      return;
    }
    void loadConfiguration();
  }, [api, workspace.id, repository.id, authorization.canViewOperations, initialConfiguration]);

  if (state.status === "loading") {
    return (
      <section className="data-section" role="status" aria-live="polite">
        <div className="section-heading">
          <h2>Effective configuration</h2>
        </div>
        <p className="empty-cell">Reading configuration provenance.</p>
      </section>
    );
  }

  if (state.status === "failed") {
    return (
      <section className="data-section data-section--danger" aria-labelledby="configuration-error-title">
        <div className="section-heading">
          <h2 id="configuration-error-title">Effective configuration</h2>
        </div>
        <p role="alert" className="notice notice--danger">
          {state.message}
        </p>
      </section>
    );
  }

  const configuration = state.configuration;
  return (
    <section className="effective-configuration data-section" aria-labelledby="effective-configuration-heading">
      <div className="section-heading">
        <h2 id="effective-configuration-heading">Effective configuration</h2>
        {authorization.canManageConfiguration ? (
          <a className="button-link button-link--quiet" href={navigation.hrefFor("configuration")}>
            Edit configuration
          </a>
        ) : null}
      </div>
      <dl className="configuration-provenance">
        <div>
          <dt>Workspace</dt>
          <dd>{workspace.displayName}</dd>
        </div>
        <div>
          <dt>Repository</dt>
          <dd><ProviderLinkValue link={configuration.repository} /></dd>
        </div>
        <div>
          <dt>Trusted path</dt>
          <dd>{configuration.trustedPath ?? "No repository configuration"}</dd>
        </div>
        <div>
          <dt>Trusted revision</dt>
          <dd>{configuration.repositoryRevision ?? configuration.trustedRevision}</dd>
        </div>
        <div>
          <dt>Inheritance</dt>
          <dd>{configuration.inheritanceMode}</dd>
        </div>
        <div>
          <dt>Effective hash</dt>
          <dd>{configuration.effectiveHash ?? "invalid"}</dd>
        </div>
      </dl>
      <div className="table-scroll" role="region" tabIndex={0} aria-labelledby="effective-configuration-heading">
        <table>
          <caption className="sr-only">Effective configuration values</caption>
          <thead>
            <tr>
              <th scope="col">Value</th>
              <th scope="col">Setting</th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {configuration.values.length === 0 ? (
              <tr>
                <td className="empty-cell" colSpan={3}>No effective configuration values are available.</td>
              </tr>
            ) : (
              configuration.values.map((entry) => (
                <tr key={entry.path}>
                  <td className="data-text">{formatValue(entry.value)}</td>
                  <th scope="row">
                    <span className="data-text">{entry.label}</span>
                    <span className="cell-detail">{entry.path}</span>
                  </th>
                  <td>
                    <span className={`chip chip--${entry.source}`}>{entry.source} source</span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ProviderLinkValue({ link }: { link: EffectiveConfigurationOverview["repository"] }) {
  return link.href === null ? link.label : (
    <a href={link.href} target="_blank" rel="noreferrer">{link.label}</a>
  );
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  return JSON.stringify(value);
}

function messageFrom(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}
