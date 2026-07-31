import { describe, expect, it } from 'vitest';
import {
  applyEmergencyStop,
  executionModeToDryRun,
  migrateLegacyExecutionMode,
  validateLiveConfirmation,
} from './execution-mode';

describe('execution mode safety state machine', () => {
  it('migrates legacy dry-run and kill-switch values without changing behavior', () => {
    expect(migrateLegacyExecutionMode(true, true)).toBe('paper');
    expect(migrateLegacyExecutionMode(true, false)).toBe('paper');
    expect(migrateLegacyExecutionMode(false, true)).toBe('live-gated');
    expect(migrateLegacyExecutionMode(false, false)).toBe('live');
  });

  it('moves live execution to live-gated when the emergency stop is activated', () => {
    expect(applyEmergencyStop('live')).toBe('live-gated');
    expect(applyEmergencyStop('live-gated')).toBe('live-gated');
    expect(applyEmergencyStop('paper')).toBe('paper');
  });

  it('only paper mode executes as a simulation', () => {
    expect(executionModeToDryRun('paper')).toBe(true);
    expect(executionModeToDryRun('live-gated')).toBe(false);
    expect(executionModeToDryRun('live')).toBe(false);
  });

  it('requires the exact typed LIVE confirmation before entering live mode', () => {
    expect(validateLiveConfirmation('LIVE')).toBe(true);
    expect(validateLiveConfirmation('live')).toBe(false);
    expect(validateLiveConfirmation(' LIVE ')).toBe(false);
    expect(validateLiveConfirmation(undefined)).toBe(false);
  });
});
