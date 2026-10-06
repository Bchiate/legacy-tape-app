import { createClient } from "@supabase/supabase-js";

// Set these in web/.env.local (see .env.example). The publishable key is meant
// to ship in the client: row-level security and the edge functions decide what
// each caller may read or write.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error(
    "Missing VITE_SUPABASE_URL or VITE_SUPABASE_PUBLISHABLE_KEY. Copy web/.env.example to web/.env.local and fill them in."
  );
}

export const supabase = createClient(supabaseUrl, supabaseKey);
