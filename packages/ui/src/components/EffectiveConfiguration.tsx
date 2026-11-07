import { useEffect, useRef, useState } from "react";

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
  onUnauthorized?(message: string): void;
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; configuration: EffectiveConfigurationOverview }
  | { status: "failed"; message: string };

export function EffectiveConfiguration(props: EffectiveConfigurationProps) {
  return (
    <ConfigurationWorkspace
      key={`${props.workspace.id}:${props.repository.id}`}
      {...props}
    />
  );
}

function ConfigurationWorkspace({
  api,
  workspace,
  repository,
  authorization,
  navigation,
  initialConfiguration,
  onUnauthorized,
}: EffectiveConfigurationProps) {
  const [state, setState] = useState<LoadState>(
    initialConfiguration
      ? { status: "ready", configuration: initialConfiguration }
      : { status: "loading" },
  );

  const [tab, setTab] = useState("All settings");
  const requestVersion = useRef(0);

  async function loadConfiguration() {
    const version = ++requestVersion.current;
    if (!authorization.canViewOperations) {
      setState({
        status: "failed",
        message: "Configuration is not available for this workspace.",
      });
      return;
    }
    setState({ status: "loading" });
    try {
      const configuration = await api.readEffectiveConfiguration(
        workspace,
        repository,
      );
      if (version === requestVersion.current)
        setState({ status: "ready", configuration });
    } catch (caught) {
      if (version !== requestVersion.current) return;
      if (
        typeof caught === "object" &&
        caught !== null &&
        "status" in caught &&
        caught.status === 401
      )
        onUnauthorized?.(messageFrom(caught, "Session expired."));
      setState({
        status: "failed",
        message: messageFrom(
          caught,
          "Could not load the effective configuration.",
        ),
      });
    }
  }

  useEffect(() => {
    if (initialConfiguration && authorization.canViewOperations) {
      setState({ status: "ready", configuration: initialConfiguration });
      return;
    }
    void loadConfiguration();
    return () => {
      requestVersion.current += 1;
    };
  }, [
    api,
    workspace.id,
    repository.id,
    authorization.canViewOperations,
    initialConfiguration,
  ]);

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
      <section
        className="data-section data-section--danger"
        aria-labelledby="configuration-error-title"
      >
        <div className="section-heading">
          <h2 id="configuration-error-title">Effective configuration</h2>
        </div>
        <p role="alert" className="notice notice--danger">
          {state.message}
        </p>
        <button type="button" onClick={() => void loadConfiguration()}>
          Retry configuration
        </button>
      </section>
    );
  }

  if (!authorization.canViewOperations)
    return <p>Configuration is not available for this workspace.</p>;
  const configuration = state.configuration;
  const values = configuration.values.filter(
    (entry) =>
      tab === "All settings" ||
      (tab === "Risk scoring"
        ? /(?:^|\.)risk(?:\.|$)/i.test(entry.path)
        : tab === "Ownership"
          ? /(?:^|\.)ownership(?:\.|$)/i.test(entry.path)
          : /(?:^|\.)routing(?:\.|$)/i.test(entry.path)),
  );
  return (
    <section
      className="effective-configuration data-section"
      id="effective-configuration"
      aria-labelledby="effective-configuration-heading"
    >
      <div className="section-heading">
        <h2 id="effective-configuration-heading">Effective configuration</h2>
        {authorization.canManageConfiguration ? (
          <a
            className="button-link button-link--quiet"
            href={navigation.hrefFor("configuration")}
          >
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
          <dd>
            <ProviderLinkValue link={configuration.repository} />
          </dd>
        </div>
        <div>
          <dt>Trusted path</dt>
          <dd>{configuration.trustedPath ?? "No repository configuration"}</dd>
        </div>
        <div>
          <dt>Trusted revision</dt>
          <dd>
            {configuration.trustedRevision}
          </dd>
        </div>
        <div>
          <dt>Repository revision</dt>
          <dd>{configuration.repositoryRevision ?? "No repository revision"}</dd>
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
      <div
        className="page-tabs"
        role="group"
        aria-label="Configuration categories"
      >
        {["All settings", "Risk scoring", "Ownership", "Routing"].map(
          (name) => (
            <button
              key={name}
              type="button"
              aria-pressed={tab === name}
              onClick={() => setTab(name)}
            >
              {name}
            </button>
          ),
        )}
      </div>
      <p className="configuration-readonly">
        Read-only. Update the trusted source file to change these settings.
      </p>
      <div
        className="table-scroll"
        role="region"
        tabIndex={0}
        aria-labelledby="effective-configuration-heading"
      >
        <table>
          <caption className="sr-only">Effective configuration values</caption>
          <thead>
            <tr>
              <th scope="col">Setting</th>
              <th scope="col">Value</th>
              <th scope="col">Source</th>
            </tr>
          </thead>
          <tbody>
            {values.length === 0 ? (
              <tr>
                <td className="empty-cell" colSpan={3}>
                  {configuration.values.length === 0
                    ? "No effective configuration values are available."
                    : "No settings in this category."}
                </td>
              </tr>
            ) : (
              values.map((entry) => (
                <tr key={entry.path}>
                  <th scope="row">
                    <span className="data-text">{entry.label}</span>
                    <details className="setting-details">
                      <summary>Setting details</summary>
                      <p>{entry.path}</p>
                      <p>Value from {entry.source} source.</p>
                      <pre>{JSON.stringify(entry.value, null, 2)}</pre>
                    </details>
                  </th>
                  <td className="data-text">{formatValue(entry.value)}</td>
                  <td>
                    <span className={`chip chip--${entry.source}`}>
                      {entry.source} source
                    </span>
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

function ProviderLinkValue({
  link,
}: {
  link: EffectiveConfigurationOverview["repository"];
}) {
  return link.href === null ? (
    link.label
  ) : (
    <a href={link.href} target="_blank" rel="noreferrer">
      {link.label}
    </a>
  );
}

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value === null) return "null";
  return JSON.stringify(value);
}

function messageFrom(caught: unknown, fallback: string): string {
  return caught instanceof Error ? caught.message : fallback;
}
