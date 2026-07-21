export type LifecycleRequest =
  | { action: 'sweep' }
  | { action: 'archive' | 'unarchive'; id: string };

export function parseLifecycleRequest(body: Record<string, unknown>): LifecycleRequest | { error: string } {
  const action = body.action;

  if (action === 'sweep') return { action };

  if (action === 'archive' || action === 'unarchive') {
    const id = body.id;
    if (typeof id !== 'string' || id.trim().length === 0) {
      return { error: 'Missing or invalid id' };
    }
    return { action, id };
  }

  return { error: 'Invalid action. Use "sweep", "archive", or "unarchive".' };
}
