const ACTIONS = ['run', 'pause', 'resume', 'start_scheduler', 'stop_scheduler'] as const;
type Action = typeof ACTIONS[number];

export function parseAutoDiscoveryAction(body: Record<string, unknown>): { action: Action } | { error: string } {
  if (typeof body.action !== 'string' || !ACTIONS.includes(body.action as Action)) {
    return { error: 'Invalid action. Use "run", "pause", "resume", "start_scheduler", or "stop_scheduler".' };
  }
  return { action: body.action as Action };
}

export function parseAutoDiscoveryStatePatch(body: Record<string, unknown>): { paused: boolean } | { error: string } {
  if (Object.keys(body).length !== 1 || typeof body.paused !== 'boolean') {
    return { error: 'Expected exactly { paused: boolean }.' };
  }
  return { paused: body.paused };
}
