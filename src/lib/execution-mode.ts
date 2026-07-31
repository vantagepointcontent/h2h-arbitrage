export const EXECUTION_MODES = ['paper', 'live-gated', 'live'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export function isExecutionMode(value: unknown): value is ExecutionMode {
  return typeof value === 'string' && EXECUTION_MODES.includes(value as ExecutionMode);
}

/** Preserve the behavior of the legacy dry-run + kill-switch pair. */
export function migrateLegacyExecutionMode(dryRun: boolean, killSwitch: boolean): ExecutionMode {
  if (dryRun) return 'paper';
  return killSwitch ? 'live-gated' : 'live';
}

/** Victor's approved Option A: emergency stop blocks live orders without simulating them. */
export function applyEmergencyStop(mode: ExecutionMode): ExecutionMode {
  return mode === 'live' ? 'live-gated' : mode;
}

export function executionModeToDryRun(mode: ExecutionMode): boolean {
  return mode === 'paper';
}

export function validateLiveConfirmation(confirmation: unknown): boolean {
  return confirmation === 'LIVE';
}
