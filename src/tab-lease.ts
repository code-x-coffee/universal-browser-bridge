// Serializes daemon-side operations per tab (a chained-promise mutex) and
// tracks a per-tab generation counter used to reject stale snapshot refs.
// Because the chain always advances once the running job settles, a client
// disconnecting mid-operation cannot leave the next queued job stuck.
export class TabLeaseManager {
  private chains = new Map<number, Promise<unknown>>();
  private generations = new Map<number, number>();

  getGeneration(tabId: number): number {
    return this.generations.get(tabId) ?? 0;
  }

  bumpGeneration(tabId: number): number {
    const next = this.getGeneration(tabId) + 1;
    this.generations.set(tabId, next);
    return next;
  }

  forgetTab(tabId: number): void {
    this.generations.delete(tabId);
    this.chains.delete(tabId);
  }

  async runExclusive<T>(tabId: number, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(tabId) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    // Swallow the result/rejection here so the chain always advances; callers
    // still observe the real outcome through the returned promise.
    this.chains.set(
      tabId,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  }
}
