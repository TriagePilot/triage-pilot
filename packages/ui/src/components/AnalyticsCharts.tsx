import type { AnalyticsReport } from "@triagepilot/contracts";

/** Pure presentation: the table provides the same daily values as the stacked bars. */
export function AnalyticsCharts({ report }: { report: AnalyticsReport }) {
  const days = new Map<string, Map<string, number>>();
  // Include all UTC buckets in the exact half-open report interval, including zero days.
  for (let day = Date.parse(`${report.start.slice(0, 10)}T00:00:00Z`); day < Date.parse(report.end); day += 86_400_000) {
    days.set(new Date(day).toISOString().slice(0, 10), new Map());
  }
  for (const assignment of report.assignments) {
    for (const bucket of assignment.days) {
      const actors = days.get(bucket.day) ?? new Map<string, number>();
      actors.set(assignment.actor, (actors.get(assignment.actor) ?? 0) + bucket.count);
      days.set(bucket.day, actors);
    }
  }
  const buckets = [...days].sort(([a], [b]) => a.localeCompare(b));
  const maximum = Math.max(1, ...buckets.map(([, actors]) => [...actors.values()].reduce((sum, count) => sum + count, 0)));
  return <>
    <section className="data-section analytics-panel" aria-label="Daily assignments">
      <h3>{report.mode === "shadow" ? "Proposed assignments" : "Reviewer assignments over time"}</h3>
      <p>UTC daily assignments</p>
      <svg className="analytics-bars" viewBox={`0 0 ${Math.max(1, buckets.length) * 12} 100`} role="img" aria-label="Daily stacked assignment counts; exact values are in the following table">
        {buckets.map(([day, actors], index) => {
          let offset = 0;
          return <g key={day}>{report.assignments.map((assignment, actorIndex) => {
            const count = actors.get(assignment.actor) ?? 0;
            const height = count / maximum * 95;
            const y = 100 - offset - height;
            offset += height;
            return <rect key={assignment.actor} x={index * 12 + 1} y={y} width={10} height={height} className={`analytics-bar analytics-bar--${actorIndex % 4}`}><title>{day}: {assignment.actor}, {count}</title></rect>;
          })}</g>;
        })}
      </svg>
      <ul className="analytics-legend" aria-label="Assignment chart legend">{report.assignments.map((row, index) => <li key={row.actor}><svg width="12" height="12" aria-hidden="true"><rect width="12" height="12" className={`analytics-bar analytics-bar--${index % 4}`} /></svg> {row.actor}</li>)}</ul>
      <div className="table-scroll" role="region" tabIndex={0} aria-label="UTC daily assignment counts">
        <table><caption>UTC daily assignment counts by developer</caption><thead><tr><th scope="col">UTC day</th>{report.assignments.map((row) => <th scope="col" key={row.actor}>{row.actor}</th>)}<th scope="col">Total</th></tr></thead>
          <tbody>{buckets.map(([day, actors]) => <tr key={day}><th scope="row">{day}</th>{report.assignments.map((row) => <td key={row.actor}>{actors.get(row.actor) ?? 0}</td>)}<td>{[...actors.values()].reduce((sum, count) => sum + count, 0)}</td></tr>)}</tbody></table>
      </div>
    </section>
  </>;
}

export function AnalyticsRisk({ report }: { report: AnalyticsReport }) {
  const counts = report.counts;
  const risks = [["Low", counts.riskLow], ["Medium", counts.riskMedium], ["High", counts.riskHigh], ["Unknown", counts.riskUnknown]] as const;
  return <section className="data-section analytics-panel" aria-label="Risk distribution"><h3>Risk distribution</h3><div className="analytics-risk-bar" aria-hidden="true">{risks.map(([label, count]) => <span key={label} className={`analytics-risk-bar--${label.toLowerCase()}`} style={{ flex: count }} />)}</div><ul className="analytics-risk">{risks.map(([label, count]) => <li key={label}>{label}: {count} ({counts.assessed === 0 ? "Unavailable" : `${(count / counts.assessed * 100).toFixed(1)}%`})</li>)}</ul><p className="cell-detail">{counts.assessed} assessed PRs · {counts.riskUnknown} unknown risk. Unidentified decisions: {report.coverage.unidentifiedDecisions}. Unknown original assignments: {report.coverage.unknownOriginalAssignments}.</p></section>;
}
