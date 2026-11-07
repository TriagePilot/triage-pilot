import type { ReactNode } from "react";

export function PageHeading({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <header className="operations-heading">
      <div>
        <h1>{title}</h1>
        <p className="lede">{description}</p>
      </div>
      {children ? <div className="operations-actions">{children}</div> : null}
    </header>
  );
}
export function Panel({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="data-section">
      <div className="section-heading">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
export function TableRegion({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="table-scroll" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}
export function Chip({ value }: { value: string }) {
  return (
    <span className={`chip chip--${value.replaceAll("_", "-")}`}>
      {value.replaceAll("_", " ")}
    </span>
  );
}
export function ProviderLink({
  link,
}: {
  link: { label: string; href: string | null };
}) {
  return link.href ? (
    <a href={link.href} target="_blank" rel="noreferrer">
      {link.label}
    </a>
  ) : (
    <>{link.label}</>
  );
}
export function Pagination({
  page,
  total,
  size,
  onChange,
}: {
  page: number;
  total: number;
  size: number;
  onChange(page: number): void;
}) {
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(page, pages);
  return (
    <div className="pagination">
      <span>
        {total === 0
          ? "0 records"
          : `Showing ${(current - 1) * size + 1}–${Math.min(current * size, total)} of ${total} records`}
      </span>
      <div>
        <button
          className="button--quiet button--compact"
          disabled={current === 1}
          onClick={() => onChange(current - 1)}
        >
          Previous
        </button>
        <span aria-live="polite">
          Page {current} of {pages}
        </span>
        <button
          className="button--quiet button--compact"
          disabled={current === pages}
          onClick={() => onChange(current + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}
export function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
export function messageFrom(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
export function isUnauthorized(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 401
  );
}
