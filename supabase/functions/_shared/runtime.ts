/** Work that may finish after the response has been sent. */

declare const EdgeRuntime: { waitUntil(task: Promise<unknown>): void } | undefined;

/**
 * Supabase's Edge Runtime keeps the worker alive until `task` settles;
 * elsewhere the task simply runs. Failures are logged, never thrown.
 */
export function runAfterResponse(task: Promise<unknown>): void {
  const logged = task.catch((error) => console.error("background task failed:", error));
  if (typeof EdgeRuntime !== "undefined") EdgeRuntime.waitUntil(logged);
}
