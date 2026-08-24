export interface PublicBoundaryViolation {
  path: string;
  rule: string;
}

export function findPathViolations(path: string): PublicBoundaryViolation[];
export function findContentViolations(path: string, content: string): PublicBoundaryViolation[];
export function formatViolation(violation: PublicBoundaryViolation): string;
export function scanPublicBoundary(options?: { cwd?: string }): Promise<PublicBoundaryViolation[]>;
