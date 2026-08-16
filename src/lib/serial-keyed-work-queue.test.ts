import { describe, expect, it, vi } from 'vitest';
import { SerialKeyedWorkQueue } from './serial-keyed-work-queue';

describe('SerialKeyedWorkQueue', () => {
  it('serializes writers and coalesces repeated work for a pending pair', async () => {
    const queue = new SerialKeyedWorkQueue();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const first = vi.fn(async () => { order.push('first:start'); await gate; order.push('first:end'); });
    const second = vi.fn(async () => { order.push('second'); });

    expect(queue.enqueue('pair-a', first)).toBe(true);
    expect(queue.enqueue('pair-a', first)).toBe(false);
    expect(queue.enqueue('pair-b', second)).toBe(true);
    await vi.waitFor(() => expect(order).toEqual(['first:start']));
    release();
    await vi.waitFor(() => expect(order).toEqual(['first:start', 'first:end', 'second']));
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
  });
});