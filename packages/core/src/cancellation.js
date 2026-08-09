export function throwIfAborted(signal) {
  signal?.throwIfAborted();
}

export function rethrowIfAborted(error, signal) {
  if (signal?.aborted) signal.throwIfAborted();
  if (error?.name === "AbortError" || error?.code === "ABORT_ERR") throw error;
}
