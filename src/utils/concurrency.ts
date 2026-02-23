/**
 * Bounded-concurrency async execution pool.
 *
 * Runs up to `concurrency` tasks in parallel with an optional stagger delay
 * between task starts. Results are returned in the same order as the input.
 */

export interface PoolOptions {
  /** Max concurrent tasks (default: 5) */
  concurrency: number;
  /** Delay in ms between task starts to avoid burst requests (default: 0) */
  delayMs?: number;
  /** Optional progress callback */
  onProgress?: (completed: number, total: number) => void;
}

/**
 * Map over items with bounded concurrency.
 *
 * Like `Promise.all(items.map(fn))` but limits how many run at once
 * and staggers starts by `delayMs` to spread load evenly.
 */
export async function pooledMap<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  options: PoolOptions
): Promise<R[]> {
  const { concurrency, delayMs = 0, onProgress } = options;
  if (items.length === 0) return [];

  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let completed = 0;

  async function worker(): Promise<void> {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) return;

      // Stagger task starts after the initial burst fills the pool
      if (delayMs > 0 && idx >= concurrency) {
        await new Promise((r) => setTimeout(r, delayMs));
      }

      results[idx] = await fn(items[idx], idx);
      completed++;
      onProgress?.(completed, items.length);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
