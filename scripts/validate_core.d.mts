export interface RuleResult {
  id: string;
  title: string;
  status: 'PASS' | 'FAIL';
  failures: string[];
  notes: string[];
}

export interface ValidationReport {
  ok: boolean;
  results: RuleResult[];
}

export function timestampProblem(s: unknown): string | null;
export function parseUtcMs(s: unknown): number;
export function validateBundle(bundle: unknown): ValidationReport;
export function summarizeFailures(report: ValidationReport, maxDetails?: number): string[];
