// finalize_recording: see handler.ts. Deployed with JWT verification off: the
// device authenticates with its hardware id and pairing token instead.
import { withErrorHandling } from "../_shared/http.ts";
import { runAfterResponse } from "../_shared/runtime.ts";
import { storeFromEnv } from "../_shared/supabase_store.ts";
import { createFinalizeHandler } from "./handler.ts";

Deno.serve(withErrorHandling(createFinalizeHandler({
  store: storeFromEnv(),
  background: runAfterResponse,
})));
