export type StartupRestoreStatus =
  | "skipped"
  | "already-active"
  | "activated"
  | "cancelled"
  | "failed";

export interface StartupOptimizationResult {
  success: boolean;
  skipped?: boolean;
  error?: string;
}

export interface StartupRestoreOptions {
  enabled: boolean;
  signal?: AbortSignal;
  isActive: () => Promise<boolean> | boolean;
  optimize: (signal?: AbortSignal) => Promise<StartupOptimizationResult>;
  activate: () => Promise<void>;
  onOptimizationFailure?: (error?: string) => void;
}

export interface StartupRestoreResult {
  status: StartupRestoreStatus;
  optimized: boolean;
  usedFallback: boolean;
  error?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Coordinates the hidden-login path without depending on Electron or the UI.
 * A failed optimization deliberately falls through to activation: the caller's
 * activation path owns the saved-profile/quick-selection fallback.
 */
export async function restoreBypassOnStartup(
  options: StartupRestoreOptions,
): Promise<StartupRestoreResult> {
  if (!options.enabled) {
    return { status: "skipped", optimized: false, usedFallback: false };
  }
  if (options.signal?.aborted) {
    return { status: "cancelled", optimized: false, usedFallback: false };
  }

  try {
    if (await options.isActive()) {
      return { status: "already-active", optimized: false, usedFallback: false };
    }
  } catch (error) {
    return { status: "failed", optimized: false, usedFallback: true, error: errorMessage(error) };
  }

  if (options.signal?.aborted) {
    return { status: "cancelled", optimized: false, usedFallback: false };
  }

  let optimized = false;
  let optimizationSkipped = false;
  let optimizationError: string | undefined;
  try {
    const result = await options.optimize(options.signal);
    optimizationSkipped = result.skipped === true;
    optimized = result.success === true && !optimizationSkipped;
    optimizationError = result.error;
  } catch (error) {
    optimizationError = errorMessage(error);
  }

  if (options.signal?.aborted) {
    return {
      status: "cancelled",
      optimized,
      usedFallback: !optimized && !optimizationSkipped,
      error: optimizationError,
    };
  }

  if (!optimized && !optimizationSkipped) options.onOptimizationFailure?.(optimizationError);

  try {
    await options.activate();
    return {
      status: "activated",
      optimized,
      usedFallback: !optimized && !optimizationSkipped,
      error: optimizationError,
    };
  } catch (error) {
    return {
      status: options.signal?.aborted ? "cancelled" : "failed",
      optimized,
      usedFallback: !optimized && !optimizationSkipped,
      error: errorMessage(error),
    };
  }
}
