// delete_device: see handler.ts. The handler validates the caller's session
// with Supabase Auth itself, which works with both JWT and publishable API
// keys, so gateway JWT verification is off.
import { withErrorHandling } from "../_shared/http.ts";
import { storeFromEnv } from "../_shared/supabase_store.ts";
import { createDeleteDeviceHandler } from "./handler.ts";

Deno.serve(withErrorHandling(createDeleteDeviceHandler(storeFromEnv())));
