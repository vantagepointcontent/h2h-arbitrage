import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPlatformLinkId } from './platform-link-id';

describe('createPlatformLinkId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('uses crypto.randomUUID when the secure-context API is available', () => {
    const randomUUID = vi.fn(() => 'secure-uuid');
    vi.stubGlobal('crypto', { randomUUID });

    expect(createPlatformLinkId()).toBe('secure-uuid');
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it('creates a usable local ID when randomUUID is unavailable over HTTP', () => {
    vi.stubGlobal('crypto', undefined);
    vi.spyOn(Date, 'now').mockReturnValue(123456789);
    vi.spyOn(Math, 'random').mockReturnValue(0.5);

    expect(createPlatformLinkId()).toBe('platform-21i3v9-i');
  });
});
