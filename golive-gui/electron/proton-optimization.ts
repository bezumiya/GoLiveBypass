/** One selection owns the profile until its subprocess and route cleanup finish. */
export interface ProtonOptimizationOperation {
  requestId: string;
  ownerId: number;
  controller: AbortController;
  cancellable: boolean;
}

export class ProtonOptimizationCoordinator {
  private current: ProtonOptimizationOperation | undefined;

  start(requestId: string, ownerId: number): ProtonOptimizationOperation | undefined {
    if (this.current) return undefined;
    this.current = { requestId, ownerId, controller: new AbortController(), cancellable: true };
    return this.current;
  }

  cancel(requestId: string, ownerId: number): boolean {
    const operation = this.current;
    if (!operation || operation.requestId !== requestId || operation.ownerId !== ownerId || !operation.cancellable) return false;
    operation.controller.abort();
    return true;
  }

  invalidate(): void {
    if (this.current?.cancellable) this.current.controller.abort();
  }

  isCurrent(operation: ProtonOptimizationOperation): boolean {
    return this.current === operation && !operation.controller.signal.aborted;
  }

  finish(operation: ProtonOptimizationOperation): void {
    if (this.current === operation) this.current = undefined;
  }
}
