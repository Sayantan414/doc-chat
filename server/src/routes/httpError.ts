// An Error with an HTTP status; the JSON error handler in index.ts uses err.status.
export function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}
