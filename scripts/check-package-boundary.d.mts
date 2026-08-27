export interface PackageBoundaryViolation {
  path: string;
  rule: string;
}

export function formatViolation(violation: PackageBoundaryViolation): string;
export function scanPackageBoundary(options?: { cwd?: string }): Promise<PackageBoundaryViolation[]>;
