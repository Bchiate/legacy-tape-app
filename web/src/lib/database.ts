import { supabase } from "./supabase";

export interface Profile {
  id: string;
  display_name: string | null;
  family_code: string;
  created_at: string;
}

export interface Book {
  id: string;
  user_id: string;
  title: string;
  type: "book" | "journal";
  created_at: string;
  chapters?: Chapter[];
}

export interface Chapter {
  id: string;
  book_id: string;
  title: string;
  order_index: number;
  transcript: string;
  duration_seconds: number;
  created_at: string;
}

// --- Profiles ---

export async function getProfile(userId: string): Promise<Profile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", userId)
    .single();
  if (error) {
    // Profile may not exist yet for pre-existing users; create one
    if (error.code === "PGRST116") {
      return ensureProfile(userId);
    }
    console.error("getProfile error:", error);
    return null;
  }
  return data;
}

export async function ensureProfile(userId: string): Promise<Profile | null> {
  const { data: user } = await supabase.auth.getUser();
  const displayName =
    user?.user?.user_metadata?.full_name ||
    user?.user?.user_metadata?.name ||
    user?.user?.email?.split("@")[0] ||
    "Storyteller";

  const { data, error } = await supabase
    .from("profiles")
    .upsert({ id: userId, display_name: displayName }, { onConflict: "id" })
    .select()
    .single();

  if (error) {
    console.error("ensureProfile error:", error);
    return null;
  }
  return data;
}

export async function updateProfile(
  userId: string,
  updates: Partial<Pick<Profile, "display_name">>
) {
  const { error } = await supabase
    .from("profiles")
    .update(updates)
    .eq("id", userId);
  if (error) console.error("updateProfile error:", error);
}

// --- Books ---

export async function getBooks(userId: string): Promise<Book[]> {
  const { data, error } = await supabase
    .from("books")
    .select("*, chapters(id, title, order_index, duration_seconds, created_at)")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) {
    console.error("getBooks error:", error);
    return [];
  }
  return data ?? [];
}

export async function createBook(
  userId: string,
  title: string,
  type: "book" | "journal" = "book"
): Promise<Book | null> {
  const { data, error } = await supabase
    .from("books")
    .insert({ user_id: userId, title, type })
    .select()
    .single();
  if (error) {
    console.error("createBook error:", error);
    return null;
  }
  return data;
}

export async function deleteBook(bookId: string) {
  const { error } = await supabase.from("books").delete().eq("id", bookId);
  if (error) console.error("deleteBook error:", error);
}

// --- Chapters ---

export async function getChapters(bookId: string): Promise<Chapter[]> {
  const { data, error } = await supabase
    .from("chapters")
    .select("*")
    .eq("book_id", bookId)
    .order("order_index", { ascending: true });
  if (error) {
    console.error("getChapters error:", error);
    return [];
  }
  return data ?? [];
}

export async function createChapter(
  bookId: string,
  title: string,
  orderIndex: number,
  transcript: string,
  durationSeconds: number
): Promise<Chapter | null> {
  const { data, error } = await supabase
    .from("chapters")
    .insert({
      book_id: bookId,
      title,
      order_index: orderIndex,
      transcript,
      duration_seconds: durationSeconds,
    })
    .select()
    .single();
  if (error) {
    console.error("createChapter error:", error);
    return null;
  }
  return data;
}

export async function updateChapter(
  chapterId: string,
  updates: Partial<Pick<Chapter, "title" | "transcript">>
): Promise<Chapter | null> {
  const { data, error } = await supabase
    .from("chapters")
    .update(updates)
    .eq("id", chapterId)
    .select()
    .single();
  if (error) {
    console.error("updateChapter error:", error);
    return null;
  }
  return data;
}

export async function deleteChapter(chapterId: string): Promise<boolean> {
  const { error } = await supabase.from("chapters").delete().eq("id", chapterId);
  if (error) {
    console.error("deleteChapter error:", error);
    return false;
  }
  return true;
}

export async function reorderChapters(
  updates: { id: string; order_index: number }[]
): Promise<boolean> {
  const promises = updates.map(({ id, order_index }) =>
    supabase.from("chapters").update({ order_index }).eq("id", id)
  );
  const results = await Promise.all(promises);
  const failed = results.find((r) => r.error);
  if (failed?.error) {
    console.error("reorderChapters error:", failed.error);
    return false;
  }
  return true;
}

// --- Follow ---

export type StoryChapter = Omit<Chapter, "book_id">;

export interface FamilyStory {
  /** The storyteller's first name. */
  name: string;
  books: (Omit<Book, "user_id" | "chapters"> & { chapters: StoryChapter[] })[];
}

/**
 * A storyteller's books, found by the family code they shared, or null when
 * no one has that code. Followers can't read other accounts' tables directly;
 * the family_story RPC returns just this, and only for a matching code.
 */
export async function getFamilyStory(code: string): Promise<FamilyStory | null> {
  const { data, error } = await supabase.rpc("family_story", { code });
  if (error) {
    console.error("getFamilyStory error:", error);
    return null;
  }
  return (data as FamilyStory | null) ?? null;
}
