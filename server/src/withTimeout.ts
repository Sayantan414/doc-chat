// Rejects if `promise` has not settled after `ms`. Used wherever a hung call
// (e.g. a half-open Redis connection) must not hang a request with it.
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
