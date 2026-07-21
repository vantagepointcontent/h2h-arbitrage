import { describe, expect, it } from 'vitest';
import { parseAutoDiscoveryAction, parseAutoDiscoveryStatePatch } from './auto-discovery-route-request';

describe('auto-discovery route requests', () => {
  it.each(['run', 'pause', 'resume', 'start_scheduler', 'stop_scheduler'])('accepts action %s', (action) => {
    expect(parseAutoDiscoveryAction({ action })).toEqual({ action });
  });
  it.each([{}, { action: 'delete' }, { action: 1 }])('rejects invalid actions', (body) => {
    expect(parseAutoDiscoveryAction(body)).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });
  it('accepts only a boolean paused patch', () => {
    expect(parseAutoDiscoveryStatePatch({ paused: true })).toEqual({ paused: true });
  });
  it.each([{}, { paused: 'true' }, { paused: false, extra: true }])('rejects invalid patches', (body) => {
    expect(parseAutoDiscoveryStatePatch(body)).toEqual(expect.objectContaining({ error: expect.any(String) }));
  });
});
