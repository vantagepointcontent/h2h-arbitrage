// Tests for src/lib/rate-limiter.ts
// Run with: npx ts-node --esm src/lib/rate-limiter.test.ts
// or: node --import tsx src/lib/rate-limiter.test.ts

import { RateLimiter, RateLimiterConfig, rateLimiters } from './rate-limiter';

/* ──────────────────────────── Helpers ──────────────────────────── */

let pass = 0;
let fail = 0;

function assert(cond: boolean, label: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.error(`  ✗ ${label}`);
  }
}

function assertApprox(actual: number, expected: number, delta: number, label: string) {
  assert(Math.abs(actual - expected) <= delta, `${label} (got ${actual}, expected ~${expected})`);
}

/* ──────────────────────────── Test: Basic token consumption ────── */

async function testBasicConsumption() {
  console.log('\n[Test] Basic token consumption');
  const cfg: RateLimiterConfig = {
    maxTokens: 5,
    refillIntervalMs: 100,
    initialTokens: 5,
    maxQueueSize: -1,
    maxRetries: 0,
    retryBaseDelayMs: 100,
  };
  const rl = new RateLimiter('test-basic', cfg);

  // Should consume all 5 tokens immediately
  const promises = [];
  for (let i = 0; i < 5; i++) {
    promises.push(rl.execute(() => Promise.resolve(i)));
  }
  const results = await Promise.all(promises);
  assert(results.length === 5, '5 requests completed');
  assert(results[0] === 0 && results[4] === 4, 'correct return values');

  rl.dispose();
}

/* ──────────────────────────── Test: Token refill over time ─────── */

async function testTokenRefill() {
  console.log('\n[Test] Token refill over time');
  const cfg: RateLimiterConfig = {
    maxTokens: 3,
    refillIntervalMs: 50, // 20 tokens/sec
    initialTokens: 3,
    maxQueueSize: -1,
    maxRetries: 0,
    retryBaseDelayMs: 100,
  };
  const rl = new RateLimiter('test-refill', cfg);

  // Drain all tokens
  await Promise.all([
    rl.execute(() => Promise.resolve(1)),
    rl.execute(() => Promise.resolve(2)),
    rl.execute(() => Promise.resolve(3)),
  ]);

  // Wait for refill (~150ms = 3 tokens at 50ms each)
  await new Promise(r => setTimeout(r, 150));

  // Should have tokens again
  const snap = rl.getThrottleSnapshot();
  assert(snap.tokens >= 2, `refilled tokens: ${snap.tokens} (expected >= 2)`);
  assert(snap.effectiveRate === 20, `effective rate: ${snap.effectiveRate} (expected 20)`);

  rl.dispose();
}

/* ──────────────────────────── Test: FIFO queue ordering ────────── */

async function testFifoOrdering() {
  console.log('\n[Test] FIFO queue ordering');
  const cfg: RateLimiterConfig = {
    maxTokens: 1,
    refillIntervalMs: 50,
    initialTokens: 1,
    maxQueueSize: 10,
    maxRetries: 0,
    retryBaseDelayMs: 100,
  };
  const rl = new RateLimiter('test-fifo', cfg);

  // Consume the one token
  await rl.execute(() => Promise.resolve('first'));

  // Submit 3 requests — they'll queue since bucket is empty
  const order: number[] = [];
  const start = Date.now();
  const promises = [0, 1, 2].map(async (i) => {
    await rl.execute(() => {
      order.push(i);
      return i;
    });
  });
  await Promise.all(promises);

  // Requests should complete in submission order (FIFO)
  assert(order[0] === 0, `first queued request is #0 (got ${order[0]})`);
  assert(order[1] === 1, `second queued request is #1 (got ${order[1]})`);
  assert(order[2] === 2, `third queued request is #2 (got ${order[2]})`);

  const elapsed = Date.now() - start;
  // 3 requests, 1 token at 50ms each → need to wait for 3 refills ≈ 150ms minimum
  assert(elapsed >= 100, `queue wait took ${elapsed}ms (expected >= 100ms)`);

  rl.dispose();
}

/* ──────────────────────────── Test: Queue overflow rejection ──── */

async function testQueueOverflow() {
  console.log('\n[Test] Queue overflow rejection');
  const cfg: RateLimiterConfig = {
    maxTokens: 1,
    refillIntervalMs: 1000, // slow refill so tokens don't come back
    initialTokens: 1,
    maxQueueSize: 2,
    maxRetries: 0,
    retryBaseDelayMs: 100,
  };
  const rl = new RateLimiter('test-overflow', cfg);

  // Consume the token
  await rl.execute(() => Promise.resolve('drain'));

  // Fill the queue (2 slots)
  const p1 = rl.execute(() => Promise.resolve(1));
  const p2 = rl.execute(() => Promise.resolve(2));

  // Third should be rejected
  let rejected = false;
  try {
    await rl.execute(() => Promise.resolve(3));
  } catch (err: any) {
    rejected = true;
    assert(err.message.includes('Queue full'), `reject message mentions queue: "${err.message}"`);
  }
  assert(rejected, 'third request was rejected');

  await p1;
  await p2;

  rl.dispose();
}

/* ──────────────────────────── Test: 429 retry with backoff ────── */

async function test429Retry() {
  console.log('\n[Test] 429 retry with backoff');
  const cfg: RateLimiterConfig = {
    maxTokens: 10,
    refillIntervalMs: 10,
    initialTokens: 10,
    maxQueueSize: -1,
    maxRetries: 3,
    retryBaseDelayMs: 50,
  };
  const rl = new RateLimiter('test-429', cfg);

  // Simulate a function that returns a Response-like object with status 429 twice, then succeeds
  let callCount = 0;
  const mockFn = (): Promise<object> => {
    callCount++;
    if (callCount < 3) {
      return Promise.resolve({ status: 429 } as any);
    }
    return Promise.resolve({ status: 200, ok: true } as any);
  };

  const start = Date.now();
  const result = await rl.execute(mockFn);
  const elapsed = Date.now() - start;

  assert(callCount === 3, `called 3 times (got ${callCount})`);
  assert((result as any).status === 200, `final result is 200`);
  // Two retries with base 50ms: 50*(0.75..1.25) + 50*2*(0.75..1.25) ≈ 75..150 + 150..300 = 225..450ms
  assert(elapsed >= 100, `retry took ${elapsed}ms (expected >= 100ms total backoff)`);

  const metrics = rl.getMetrics();
  assert(metrics.retry429Count === 2, `429 retries: ${metrics.retry429Count} (expected 2)`);

  rl.dispose();
}

/* ──────────────────────────── Test: Metrics tracking ──────────── */

async function testMetricsTracking() {
  console.log('\n[Test] Metrics tracking');
  const cfg: RateLimiterConfig = {
    maxTokens: 2,
    refillIntervalMs: 50,
    initialTokens: 2,
    maxQueueSize: 5,
    maxRetries: 0,
    retryBaseDelayMs: 100,
  };
  const rl = new RateLimiter('test-metrics', cfg);

  // Make 4 requests (2 immediate + 2 queued)
  await Promise.all([
    rl.execute(() => Promise.resolve(1)),
    rl.execute(() => Promise.resolve(2)),
    rl.execute(() => Promise.resolve(3)),
    rl.execute(() => Promise.resolve(4)),
  ]);

  const metrics = rl.getMetrics();
  assert(metrics.totalRequests === 4, `total: ${metrics.totalRequests} (expected 4)`);
  assert(metrics.queuedRequests >= 2, `queued: ${metrics.queuedRequests} (expected >= 2)`);
  assert(metrics.rejectedRequests === 0, `rejected: ${metrics.rejectedRequests} (expected 0)`);
  assert(metrics.avgQueueWaitMs > 0, `avg wait: ${metrics.avgQueueWaitMs}ms (expected > 0)`);

  // Reset and verify
  rl.resetMetrics();
  const afterReset = rl.getMetrics();
  assert(afterReset.totalRequests === 0, 'reset cleared totalRequests');

  rl.dispose();
}

/* ──────────────────────────── Test: Throttle snapshot ─────────── */

async function testThrottleSnapshot() {
  console.log('\n[Test] Throttle snapshot');
  const cfg: RateLimiterConfig = {
    maxTokens: 10,
    refillIntervalMs: 100,
    initialTokens: 10,
    maxQueueSize: 50,
    maxRetries: 0,
    retryBaseDelayMs: 100,
  };
  const rl = new RateLimiter('test-throttle', cfg);

  const snap = rl.getThrottleSnapshot();
  assert(snap.tokens === 10, `initial tokens: ${snap.tokens}`);
  assert(snap.isThrottled === false, 'not throttled initially');
  assert(snap.queueLength === 0, 'empty queue initially');
  assert(snap.effectiveRate === 10, `effective rate: ${snap.effectiveRate}`);

  // Exhaust tokens
  await Promise.all(Array.from({ length: 10 }, (_, i) =>
    rl.execute(() => Promise.resolve(i)),
  ));

  const snap2 = rl.getThrottleSnapshot();
  assert(snap2.tokens <= 0 || snap2.isThrottled, 'throttled after exhaustion');

  rl.dispose();
}

/* ──────────────────────────── Test: Pre-built instances ───────── */

function testPreBuiltInstances() {
  console.log('\n[Test] Pre-built instances');
  assert(!!rateLimiters.gamma, 'gamma limiter exists');
  assert(!!rateLimiters.clobMarkets, 'clobMarkets limiter exists');
  assert(!!rateLimiters.clobBook, 'clobBook limiter exists');
  assert(!!rateLimiters.kalshi, 'kalshi limiter exists');
  assert(!!rateLimiters.predictionhunt, 'predictionhunt limiter exists');

  // Verify gamma defaults
  const gammaSnap = rateLimiters.gamma.getThrottleSnapshot();
  assert(gammaSnap.effectiveRate === 30, `gamma rate: ${gammaSnap.effectiveRate} (expected 30)`);
}

/* ──────────────────────────── Test: Burst then sustain ────────── */

async function testBurstThenSustain() {
  console.log('\n[Test] Burst then sustain');
  // 5 tokens, refill 1 per 20ms (= 50 tokens/sec)
  const cfg: RateLimiterConfig = {
    maxTokens: 5,
    refillIntervalMs: 20,
    initialTokens: 5,
    maxQueueSize: -1,
    maxRetries: 0,
    retryBaseDelayMs: 100,
  };
  const rl = new RateLimiter('test-burst', cfg);

  // Burst: consume all 5 instantly
  const burstStart = Date.now();
  await Promise.all(Array.from({ length: 5 }, (_, i) =>
    rl.execute(() => Promise.resolve(i)),
  ));
  const burstElapsed = Date.now() - burstStart;
  assert(burstElapsed < 50, `burst was instant (${burstElapsed}ms)`);

  // Now submit 5 more — they'll queue and get served at ~50/sec
  const sustainStart = Date.now();
  await Promise.all(Array.from({ length: 5 }, (_, i) =>
    rl.execute(() => Promise.resolve(i + 100)),
  ));
  const sustainElapsed = Date.now() - sustainStart;
  // Need 5 tokens at 20ms each = ~100ms minimum
  assert(sustainElapsed >= 60, `sustain took ${sustainElapsed}ms (expected >= 60ms)`);

  rl.dispose();
}

/* ──────────────────────────── Runner ──────────────────────────── */

async function runTests() {
  console.log('═══════════════════════════════════════');
  console.log('  Rate Limiter Tests');
  console.log('═══════════════════════════════════════');

  await testBasicConsumption();
  await testTokenRefill();
  await testFifoOrdering();
  await testQueueOverflow();
  await test429Retry();
  await testMetricsTracking();
  await testThrottleSnapshot();
  testPreBuiltInstances();
  await testBurstThenSustain();

  console.log('\n═══════════════════════════════════════');
  console.log(`  Results: ${pass} passed, ${fail} failed`);
  console.log('═══════════════════════════════════════');

  if (fail > 0) {
    console.error('\nSome tests FAILED.');
    process.exit(1);
  } else {
    console.log('\nAll tests PASSED.');
  }
}

runTests().catch(err => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
