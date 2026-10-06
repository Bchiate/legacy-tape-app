import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  HardDrive,
  Wifi,
  ChevronDown,
  ChevronRight,
  Pencil,
  Check,
  Plus,
  Loader2,
  AlertCircle,
  Clock,
  BookOpen,
  Mic,
  Play,
  Pause,
  Trash2,
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import SkyBackground from "@/components/SkyBackground";
import AppTabBar from "@/components/AppTabBar";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/AuthProvider";
import {
  type Recording,
  type ChapterGroup,
  groupByChapter,
  formatDuration,
} from "@/lib/deviceRecordings";
import { useTakesPlayback } from "@/lib/useTakesPlayback";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Chapter {
  id: string;
  title: string;
  order_index: number;
  duration_seconds: number;
  transcript: string;
  created_at: string;
}

interface Book {
  id: string;
  title: string;
  type: string;
  device_id: string | null;
  created_at: string;
  chapters: Chapter[];
}

interface Device {
  id: string;
  hardware_id: string;
  pairing_token: string;
  wifi_ssid: string | null;
  subject_name: string | null;
  subject_dob: string | null;
  setup_for: "self" | "other" | null;
  paired_at: string;
  last_seen_at: string | null;
  onboarding_complete: boolean;
  sync_requested: boolean;
  chapter_mode: "manual" | "auto";
  chapter_auto_minutes: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Transcription pipeline events, for Safari's Web Inspector on a debug build.
function logDiag(tag: string, data: Record<string, unknown>) {
  console.debug(`[${tag}]`, data);
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

// ── Inline editable title ─────────────────────────────────────────────────────

const EditableTitle = ({
  value,
  onSave,
  className = "",
}: {
  value: string;
  onSave: (v: string) => Promise<void>;
  className?: string;
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = async () => {
    if (draft.trim() === value) { setEditing(false); return; }
    setSaving(true);
    await onSave(draft.trim() || value);
    setSaving(false);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") setEditing(false); }}
          onBlur={commit}
          className="h-7 text-[14px] px-2 rounded-lg flex-1 min-w-0"
          autoFocus
        />
        {saving && <Loader2 className="size-3.5 animate-spin text-muted-foreground shrink-0" aria-hidden="true" />}
        {!saving && (
          <button onClick={commit} className="shrink-0 text-primary" aria-label="Save title">
            <Check className="size-3.5" aria-hidden="true" />
          </button>
        )}
      </div>
    );
  }

  return (
    <button
      className={`flex items-center gap-1.5 text-left flex-1 min-w-0 group ${className}`}
      onClick={() => { setDraft(value); setEditing(true); setTimeout(() => inputRef.current?.focus(), 0); }}
      aria-label={`Rename ${value}`}
    >
      <span className="truncate">{value}</span>
      <Pencil className="size-3 text-muted-foreground opacity-0 group-hover:opacity-100 group-active:opacity-100 shrink-0 transition-opacity" aria-hidden="true" />
    </button>
  );
};

// ── Main page ─────────────────────────────────────────────────────────────────

const ManageDevice = () => {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [device, setDevice] = useState<Device | null>(null);
  const [books, setBooks] = useState<Book[]>([]);
  const [recordings, setRecordings] = useState<Recording[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedBooks, setExpandedBooks] = useState<Set<string>>(new Set());
  // Chapter playback: takes play back-to-back (shared with Library).
  const { loadingKey, playingKey, playingTake, toggle: playChapterTakes, stop: stopPlayback } = useTakesPlayback();
  const [deleteCandidate, setDeleteCandidate] = useState<
    { kind: "chapter"; group: ChapterGroup } | { kind: "take"; rec: Recording } | null
  >(null);
  const [confirmRemoveDevice, setConfirmRemoveDevice] = useState(false);
  const processingRef = useRef<string | null>(null);
  const [failedTranscriptions, setFailedTranscriptions] = useState<Map<string, string>>(new Map());
  const recordingsRef = useRef<Recording[]>([]);
  const failedRef = useRef<Map<string, string>>(new Map());
  const hasNativeBridge =
    typeof window !== "undefined" &&
    (window as unknown as { __nativeSpeechBridge?: boolean }).__nativeSpeechBridge === true;

  // ── Data loading ────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!user) return;
    load();

    // Live updates when the device finalizes a recording or Whisper completes.
    const channel = supabase
      .channel(`recordings:${user.id}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "recordings",
          filter: `account_id=eq.${user.id}`,
        },
        (payload) => {
          const row = payload.new as Recording;
          setRecordings((prev) =>
            prev.some((r) => r.id === row.id) ? prev : [row, ...prev]
          );
        }
      )
      .on(
        "postgres_changes",
        {
          event: "UPDATE",
          schema: "public",
          table: "recordings",
          filter: `account_id=eq.${user.id}`,
        },
        (payload) => {
          const row = payload.new as Recording;
          setRecordings((prev) =>
            prev.map((r) => (r.id === row.id ? row : r))
          );
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [user]);

  // Native iOS transcription: when a recording row lacks a transcript and we're
  // running inside the iOS WebView, download the WAV and run Apple STT on it.
  // Processes one recording at a time to avoid hammering SFSpeech with parallel
  // tasks (10 stories recorded offline shouldn't fire 10 simultaneous requests).
  useEffect(() => {
    recordingsRef.current = recordings;
  }, [recordings]);

  useEffect(() => {
    failedRef.current = failedTranscriptions;
  }, [failedTranscriptions]);

  // If the native side never calls back (recognizer cancelled, app backgrounded
  // mid-recognition — SpeechBridge returns early when a result is neither final
  // nor an error), the queue would otherwise stay "busy" forever. Give each
  // attempt a hard ceiling, generous enough for a long chapter.
  const TRANSCRIBE_TIMEOUT_MS = 5 * 60_000;
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearTranscribeTimeout = () => {
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
  };

  const processNext = async () => {
    if (processingRef.current) return;
    const w = window as unknown as {
      __speechBridge?: { transcribeFile?: (url: string, recordingId: string) => void };
    };
    if (!w.__speechBridge?.transcribeFile) return;

    const next = recordingsRef.current.find(
      (r) => !r.transcription && !failedRef.current.has(r.id)
    );
    if (!next) return;

    processingRef.current = next.id;
    const { data, error: signErr } = await supabase.storage
      .from("recordings")
      .createSignedUrl(next.storage_path, 3600);
    if (!data?.signedUrl) {
      processingRef.current = null;
      logDiag("transcribe", { step: "sign_failed", id: next.id, path: next.storage_path, err: signErr?.message });
      markFailed(next.id, "Could not sign storage URL");
      return;
    }
    logDiag("transcribe", { step: "start", id: next.id, urlLen: data.signedUrl.length });
    clearTranscribeTimeout();
    timeoutRef.current = setTimeout(() => {
      if (processingRef.current !== next.id) return;
      processingRef.current = null;
      logDiag("transcribe", { step: "timeout", id: next.id });
      markFailed(next.id, "Transcription timed out");
      processNext();
    }, TRANSCRIBE_TIMEOUT_MS);
    w.__speechBridge.transcribeFile!(data.signedUrl, next.id);
  };

  // The refs are what processNext reads, and React only syncs them in an effect
  // AFTER the next render. Calling processNext synchronously right after a
  // setState therefore saw the OLD list — the just-finished recording still
  // looked untranscribed and was started a second time (every recording in the
  // logs showed start→success→start→error). Update the refs in the same tick.
  const markTranscribed = (recordingId: string, text: string, transcribedAt: string) => {
    recordingsRef.current = recordingsRef.current.map((r) =>
      r.id === recordingId ? { ...r, transcription: text, transcribed_at: transcribedAt } : r
    );
    setRecordings(recordingsRef.current);
  };
  const markFailed = (recordingId: string, message: string) => {
    failedRef.current = new Map(failedRef.current).set(recordingId, message);
    setFailedTranscriptions(failedRef.current);
  };

  useEffect(() => {
    if (!hasNativeBridge) return;
    const w = window as unknown as {
      __onFileTranscribed?: (recordingId: string, text: string) => void;
      __onFileTranscribeError?: (recordingId: string, message: string) => void;
    };

    w.__onFileTranscribed = async (recordingId, text) => {
      // Ignore a late callback for something we already gave up on / moved past.
      if (processingRef.current !== recordingId) return;
      clearTranscribeTimeout();
      logDiag("transcribe", { step: "success", id: recordingId, textLen: text.length });
      const transcribedAt = new Date().toISOString();
      markTranscribed(recordingId, text, transcribedAt);   // before clearing busy → no re-pick
      processingRef.current = null;
      await supabase
        .from("recordings")
        .update({ transcription: text, transcribed_at: transcribedAt })
        .eq("id", recordingId);
      processNext();
    };

    w.__onFileTranscribeError = (recordingId, message) => {
      if (processingRef.current !== recordingId) return;
      clearTranscribeTimeout();
      console.warn(`[transcribe] ${recordingId}: ${message}`);
      logDiag("transcribe", { step: "error", id: recordingId, message });
      markFailed(recordingId, message);                     // before clearing busy → no re-pick
      processingRef.current = null;
      processNext();
    };

    return () => {
      delete w.__onFileTranscribed;
      delete w.__onFileTranscribeError;
      clearTranscribeTimeout();
    };
  }, [hasNativeBridge]);

  // Kick the queue whenever the recordings list changes (new INSERT from Realtime,
  // or initial load). The worker is a no-op if something is already in flight.
  useEffect(() => {
    if (!hasNativeBridge) return;
    processNext();
  }, [recordings, hasNativeBridge]);

  const retryTranscription = (recordingId: string) => {
    const next = new Map(failedRef.current);
    next.delete(recordingId);
    failedRef.current = next;
    setFailedTranscriptions(next);
    processNext();
  };

  const load = async () => {
    setLoading(true);
    const [{ data: devData }, { data: bookData }, { data: recData }] = await Promise.all([
      supabase
        .from("devices")
        .select("*")
        .eq("user_id", user!.id)
        .order("paired_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from("books")
        .select("*, chapters(*)")
        .eq("user_id", user!.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("recordings")
        .select("*")
        .eq("account_id", user!.id)
        .order("created_at", { ascending: false }),
    ]);

    setDevice(devData ?? null);
    if (bookData) {
      const sorted = bookData.map((b: Book) => ({
        ...b,
        chapters: [...(b.chapters ?? [])].sort(
          (a, b) => a.order_index - b.order_index
        ),
      }));
      setBooks(sorted);
    }
    setRecordings((recData ?? []) as Recording[]);
    setLoading(false);
  };

  // ── Rename handlers ─────────────────────────────────────────────────────────

  const renameBook = async (bookId: string, title: string) => {
    await supabase.from("books").update({ title }).eq("id", bookId);
    setBooks((prev) =>
      prev.map((b) => (b.id === bookId ? { ...b, title } : b))
    );
  };

  const renameChapter = async (chapterId: string, bookId: string, title: string) => {
    await supabase.from("chapters").update({ title }).eq("id", chapterId);
    setBooks((prev) =>
      prev.map((b) =>
        b.id === bookId
          ? {
              ...b,
              chapters: b.chapters.map((c) =>
                c.id === chapterId ? { ...c, title } : c
              ),
            }
          : b
      )
    );
  };

  const playChapter = (g: ChapterGroup) => playChapterTakes(g.key, g.takes);

  const [removing, setRemoving] = useState(false);

  const removeDevice = async () => {
    if (!device) return;
    setRemoving(true);
    // Stop any playback before tearing down.
    stopPlayback();

    // Full teardown via the delete_device edge function, which checks that the
    // signed-in user owns the device and then deletes everything: WAVs,
    // leftover audio chunks, recording rows and the device row.
    const { data, error } = await supabase.functions.invoke("delete_device", {
      body: { deviceId: device.id },
    });

    if (error || !(data as { ok?: boolean })?.ok) {
      console.error("delete_device failed:", error, data);
      toast.error("Couldn't remove the device. Check your connection and try again.");
      setRemoving(false);
      return; // keep UI intact so the user can retry
    }

    toast.success("Device removed.");
    setDevice(null);
    setRecordings([]);
    setRemoving(false);
  };

  const updateChapterSettings = async (
    patch: Partial<Pick<Device, "chapter_mode" | "chapter_auto_minutes">>
  ) => {
    if (!device) return;
    const next = { ...device, ...patch };
    setDevice(next); // optimistic
    await supabase
      .from("devices")
      .update(patch)
      .eq("id", device.id);
  };

  // Renaming a chapter renames every take in it — chapter_name lives per row.
  const renameChapterGroup = async (g: ChapterGroup, name: string) => {
    const ids = g.takes.map((r) => r.id);
    await supabase.from("recordings").update({ chapter_name: name }).in("id", ids);
    setRecordings((prev) =>
      prev.map((r) => (ids.includes(r.id) ? { ...r, chapter_name: name } : r))
    );
  };

  // Best-effort storage cleanup before the DB rows; if storage fails the rows
  // stay so the user can retry — better than orphaning WAVs silently.
  const deleteTakes = async (takes: Recording[]) => {
    stopPlayback();
    await supabase.storage.from("recordings").remove(takes.map((r) => r.storage_path));
    const ids = takes.map((r) => r.id);
    await supabase.from("recordings").delete().in("id", ids);
    setRecordings((prev) => prev.filter((r) => !ids.includes(r.id)));
  };

  const toggleBook = (id: string) => {
    setExpandedBooks((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  // ── Render helpers ──────────────────────────────────────────────────────────

  const deviceBooks = device
    ? books.filter((b) => b.device_id === device.id)
    : [];
  const otherBooks = books.filter(
    (b) => !device || b.device_id !== device.id
  );

  // ── Loading ─────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="relative flex min-h-[100dvh] flex-col safe-top safe-bottom">
        <SkyBackground />
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="size-8 text-primary animate-spin" />
        </div>
        <AppTabBar />
      </div>
    );
  }

  // ── No device ───────────────────────────────────────────────────────────────

  if (!device) {
    return (
      <div className="relative flex min-h-[100dvh] flex-col safe-top safe-bottom">
        <SkyBackground />
        <div className="flex-1 flex flex-col items-center justify-center text-center px-6 pb-20">
          <div className="w-20 h-20 rounded-full bg-muted/50 flex items-center justify-center mb-5">
            <HardDrive className="size-9 text-muted-foreground" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">No Device Paired</h1>
          <p className="text-muted-foreground text-[14px] mt-2 max-w-[260px] leading-relaxed">
            Pair your LegacyTape recorder to start capturing stories.
          </p>
          <Button
            className="mt-8 h-12 px-8 rounded-xl font-semibold"
            onClick={() => navigate("/device-setup")}
          >
            <Plus className="size-4 mr-2" />
            Pair a Device
          </Button>
        </div>
        <AppTabBar />
      </div>
    );
  }

  // ── Main ────────────────────────────────────────────────────────────────────

  return (
    <div className="relative flex min-h-[100dvh] flex-col safe-top safe-bottom">
      <SkyBackground />

      {/* Page header */}
      <div className="px-6 pt-14 pb-3">
        <h1 className="text-2xl font-bold text-foreground">My Device</h1>
        <p className="text-muted-foreground text-[13px] mt-0.5">
          Manage your LegacyTape recorder
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-24 space-y-5">

        {/* Device card */}
        <div className="bg-card/80 backdrop-blur-sm border border-border/60 rounded-2xl p-4 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                <HardDrive className="size-5 text-primary" />
              </div>
              <div>
                <p className="font-semibold text-foreground text-[15px]">
                  {device.hardware_id}
                </p>
                <p className="text-muted-foreground text-[12px]">
                  Paired {timeAgo(device.paired_at)}
                </p>
              </div>
            </div>
            <span
              className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${
                device.onboarding_complete
                  ? "bg-green-500/15 text-green-600"
                  : "bg-amber-500/15 text-amber-600"
              }`}
            >
              {device.onboarding_complete ? "Ready" : "Setup pending"}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2 text-[13px]">
            {device.wifi_ssid && (
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Wifi className="size-3.5 shrink-0" />
                <span className="truncate">{device.wifi_ssid}</span>
              </div>
            )}
            {device.last_seen_at && (
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Clock className="size-3.5 shrink-0" />
                <span>Last seen {timeAgo(device.last_seen_at)}</span>
              </div>
            )}
            {device.subject_name && (
              <div className="col-span-2 flex items-center gap-1.5 text-muted-foreground">
                <AlertCircle className="size-3.5 shrink-0" />
                <span>
                  Set up for{" "}
                  <span className="text-foreground font-medium">
                    {device.subject_name}
                  </span>
                  {device.setup_for === "other" && " (gift)"}
                </span>
              </div>
            )}
          </div>

          {/* Chapter mode setting */}
          <div className="border-t border-border/40 pt-3 space-y-2.5">
            <p className="text-[12px] font-semibold text-muted-foreground uppercase tracking-wide">
              Chapters
            </p>
            <div className="flex gap-2">
              <button
                onClick={() => updateChapterSettings({ chapter_mode: "manual" })}
                aria-pressed={device.chapter_mode === "manual"}
                className={`flex-1 px-3 py-2 rounded-xl text-[13px] font-medium transition-all ${
                  device.chapter_mode === "manual"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted/60 text-muted-foreground"
                }`}
              >
                Manual
              </button>
              <button
                onClick={() => updateChapterSettings({ chapter_mode: "auto" })}
                aria-pressed={device.chapter_mode === "auto"}
                className={`flex-1 px-3 py-2 rounded-xl text-[13px] font-medium transition-all ${
                  device.chapter_mode === "auto"
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted/60 text-muted-foreground"
                }`}
              >
                Auto
              </button>
            </div>
            {device.chapter_mode === "auto" && (
              <div className="flex flex-wrap gap-1.5">
                {[5, 10, 15, 30, 60].map((m) => (
                  <button
                    key={m}
                    onClick={() => updateChapterSettings({ chapter_auto_minutes: m })}
                    className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-all ${
                      device.chapter_auto_minutes === m
                        ? "bg-primary/15 text-primary border border-primary/30"
                        : "bg-muted/50 text-muted-foreground border border-transparent"
                    }`}
                  >
                    {m < 60 ? `${m} min` : "1 hr"}
                  </button>
                ))}
              </div>
            )}
            <p className="text-[11px] text-muted-foreground/70 leading-relaxed">
              {device.chapter_mode === "manual"
                ? "A new chapter starts only when you switch it on the device."
                : `A new chapter starts every ${device.chapter_auto_minutes} minutes.`}
            </p>
          </div>

          <div className="border-t border-border/40 pt-2 -mb-1 flex flex-col">
            <button
              className="w-full text-[13px] text-muted-foreground py-2 active:opacity-60 transition-opacity text-center"
              onClick={() => navigate("/device-setup")}
            >
              + Pair a different device
            </button>
            <button
              className="w-full text-[13px] text-destructive/80 py-2 active:opacity-60 transition-opacity text-center flex items-center justify-center gap-1.5"
              onClick={() => setConfirmRemoveDevice(true)}
              aria-label={`Remove ${device.hardware_id}`}
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
              Remove this device
            </button>
          </div>
        </div>

        {/* Books linked to this device */}
        {deviceBooks.length > 0 && (
          <section>
            <h2 className="text-[12px] font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">
              Synced to this device
            </h2>
            <div className="space-y-2">
              {deviceBooks.map((book) => (
                <BookRow
                  key={book.id}
                  book={book}
                  expanded={expandedBooks.has(book.id)}
                  onToggle={() => toggleBook(book.id)}
                  onRenameBook={(t) => renameBook(book.id, t)}
                  onRenameChapter={(cid, t) => renameChapter(cid, book.id, t)}
                />
              ))}
            </div>
          </section>
        )}

        {/* All other books */}
        {otherBooks.length > 0 && (
          <section>
            <h2 className="text-[12px] font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">
              {deviceBooks.length > 0 ? "Other books" : "Your books"}
            </h2>
            <div className="space-y-2">
              {otherBooks.map((book) => (
                <BookRow
                  key={book.id}
                  book={book}
                  expanded={expandedBooks.has(book.id)}
                  onToggle={() => toggleBook(book.id)}
                  onRenameBook={(t) => renameBook(book.id, t)}
                  onRenameChapter={(cid, t) => renameChapter(cid, book.id, t)}
                />
              ))}
            </div>
          </section>
        )}

        {/* Recordings from device */}
        {recordings.length > 0 && (
          <section>
            <h2 className="text-[12px] font-semibold text-muted-foreground uppercase tracking-wide mb-2 px-1">
              Recordings
            </h2>
            {!hasNativeBridge && recordings.some((r) => !r.transcription) && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 mb-2 flex items-start gap-2">
                <AlertCircle className="size-4 text-amber-600 shrink-0 mt-0.5" />
                <p className="text-[12px] text-amber-700 leading-relaxed">
                  Open the Legacy Tape app on iPhone to enable automatic transcription.
                  Recordings play here, but transcripts are generated on-device.
                </p>
              </div>
            )}
            <div className="space-y-2">
              {groupByChapter(recordings).map((g) => (
                <ChapterCard
                  key={g.key}
                  group={g}
                  playing={playingKey === g.key}
                  loading={loadingKey === g.key}
                  playingTake={playingKey === g.key ? playingTake : -1}
                  onPlay={() => playChapter(g)}
                  onRename={(t) => renameChapterGroup(g, t)}
                  onDeleteChapter={() => setDeleteCandidate({ kind: "chapter", group: g })}
                  onDeleteTake={(rec) => setDeleteCandidate({ kind: "take", rec })}
                  failed={failedTranscriptions}
                  onRetry={hasNativeBridge ? retryTranscription : undefined}
                  showTranscribingIndicator={hasNativeBridge}
                />
              ))}
            </div>
          </section>
        )}

        {books.length === 0 && recordings.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-center">
            <Mic className="size-10 text-muted-foreground/40 mb-3" />
            <p className="text-muted-foreground text-[14px]">No recordings yet.</p>
            <p className="text-muted-foreground/60 text-[13px] mt-1">
              Stories recorded on the device will appear here.
            </p>
          </div>
        )}

      </div>

      <AlertDialog open={confirmRemoveDevice} onOpenChange={setConfirmRemoveDevice}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this device?</AlertDialogTitle>
            <AlertDialogDescription>
              {device?.hardware_id} will be unpaired and all {recordings.length} recording{recordings.length === 1 ? "" : "s"} will be permanently deleted, including audio files and transcripts. This can't be undone — you'll need to scan the QR code again to re-pair.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={removing}
              onClick={(e) => { e.preventDefault(); removeDevice().then(() => setConfirmRemoveDevice(false)); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {removing ? "Removing…" : "Remove Device"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!deleteCandidate} onOpenChange={(open) => !open && setDeleteCandidate(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {deleteCandidate?.kind === "chapter" ? "Delete this chapter?" : "Delete this take?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {deleteCandidate?.kind === "chapter"
                ? `"${deleteCandidate.group.title}" and all ${deleteCandidate.group.takes.length} take${deleteCandidate.group.takes.length === 1 ? "" : "s"} in it will be permanently removed, including audio and transcripts.`
                : `This ${formatDuration(deleteCandidate?.kind === "take" ? deleteCandidate.rec.duration_seconds : 0) || "short"} take will be permanently removed from the chapter, including its audio and transcript.`}
              {" "}This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteCandidate?.kind === "chapter") deleteTakes(deleteCandidate.group.takes);
                else if (deleteCandidate?.kind === "take") deleteTakes([deleteCandidate.rec]);
                setDeleteCandidate(null);
              }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AppTabBar />
    </div>
  );
};

// ── BookRow component ─────────────────────────────────────────────────────────

const BookRow = ({
  book,
  expanded,
  onToggle,
  onRenameBook,
  onRenameChapter,
}: {
  book: Book;
  expanded: boolean;
  onToggle: () => void;
  onRenameBook: (t: string) => Promise<void>;
  onRenameChapter: (chapterId: string, t: string) => Promise<void>;
}) => {
  const totalDuration = book.chapters.reduce(
    (acc, c) => acc + (c.duration_seconds ?? 0),
    0
  );

  return (
    <div className="bg-card/80 backdrop-blur-sm border border-border/60 rounded-2xl overflow-hidden">
      {/* Book header row */}
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
          <BookOpen className="size-4 text-primary" />
        </div>
        <EditableTitle
          value={book.title}
          onSave={onRenameBook}
          className="font-semibold text-[15px] text-foreground"
        />
        <div className="flex items-center gap-2 shrink-0 ml-auto">
          {totalDuration > 0 && (
            <span className="text-[11px] text-muted-foreground">
              {formatDuration(totalDuration)}
            </span>
          )}
          <span className="text-[11px] text-muted-foreground">
            {book.chapters.length} ch
          </span>
          <button
            onClick={onToggle}
            aria-label={expanded ? `Collapse ${book.title}` : `Expand ${book.title}`}
            aria-expanded={expanded}
            className="text-muted-foreground active:opacity-60 transition-opacity p-1"
          >
            {expanded ? (
              <ChevronDown className="size-4" aria-hidden="true" />
            ) : (
              <ChevronRight className="size-4" aria-hidden="true" />
            )}
          </button>
        </div>
      </div>

      {/* Chapters */}
      {expanded && (
        <div className="border-t border-border/40">
          {book.chapters.length === 0 ? (
            <p className="text-muted-foreground text-[13px] px-4 py-3">
              No chapters yet.
            </p>
          ) : (
            book.chapters.map((chapter, i) => (
              <div
                key={chapter.id}
                className={`flex items-center gap-3 px-4 py-2.5 ${
                  i < book.chapters.length - 1
                    ? "border-b border-border/30"
                    : ""
                }`}
              >
                <div className="w-6 h-6 rounded-md bg-muted/50 flex items-center justify-center shrink-0">
                  <Mic className="size-3 text-muted-foreground" />
                </div>
                <EditableTitle
                  value={chapter.title}
                  onSave={(t) => onRenameChapter(chapter.id, t)}
                  className="text-[14px] text-foreground"
                />
                {chapter.duration_seconds > 0 && (
                  <span className="text-[11px] text-muted-foreground shrink-0 ml-auto">
                    {formatDuration(chapter.duration_seconds)}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};

// ── ChapterCard component ─────────────────────────────────────────────────────
// One card per chapter. Play runs the takes back-to-back; the transcript is the
// takes in order (Q above A for AI-interview takes). Takes are listed under a
// disclosure so a bad one can be deleted without losing the chapter.

const ChapterCard = ({
  group: g,
  playing,
  loading,
  playingTake,
  onPlay,
  onRename,
  onDeleteChapter,
  onDeleteTake,
  failed,
  onRetry,
  showTranscribingIndicator,
}: {
  group: ChapterGroup;
  playing: boolean;
  loading: boolean;
  playingTake: number;
  onPlay: () => void;
  onRename: (title: string) => Promise<void>;
  onDeleteChapter: () => void;
  onDeleteTake: (rec: Recording) => void;
  failed: Map<string, string>;
  onRetry?: (recordingId: string) => void;
  showTranscribingIndicator: boolean;
}) => {
  const [expanded, setExpanded] = useState(false);
  const [showTakes, setShowTakes] = useState(false);

  const transcribed = g.takes.filter((r) => r.transcription).length;
  const failedCount = g.takes.filter((r) => !r.transcription && failed.has(r.id)).length;
  const pending = g.takes.length - transcribed - failedCount;
  const hasAnyText = transcribed > 0;

  const subtitleParts: string[] = [];
  if (g.bookName?.trim()) subtitleParts.push(g.bookName.trim());
  if (g.totalDuration > 0) subtitleParts.push(formatDuration(g.totalDuration));
  if (g.takes.length > 1) subtitleParts.push(`${g.takes.length} takes`);
  subtitleParts.push(timeAgo(g.latestAt));
  const subtitle = subtitleParts.join(" · ");

  const playLabel = loading ? "Loading chapter" : playing ? "Pause chapter" : `Play ${g.title}`;

  return (
    <div className="bg-card/80 backdrop-blur-sm border border-border/60 rounded-2xl overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <button
          onClick={onPlay}
          aria-label={playLabel}
          className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-colors ${
            playing || loading
              ? "bg-primary text-primary-foreground"
              : "bg-primary/10 text-primary active:bg-primary/20"
          }`}
        >
          {loading ? (
            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
          ) : playing ? (
            <Pause className="size-4" aria-hidden="true" />
          ) : (
            <Play className="size-4 ml-0.5" aria-hidden="true" />
          )}
        </button>

        <div className="flex-1 min-w-0">
          <EditableTitle value={g.title} onSave={onRename} className="font-semibold text-[14px] text-foreground" />
          <p className="text-muted-foreground text-[12px] truncate">
            {playing && g.takes.length > 1 ? `Playing take ${playingTake + 1} of ${g.takes.length} · ` : ""}
            {subtitle}
          </p>
        </div>

        <button
          onClick={onDeleteChapter}
          aria-label={`Delete ${g.title}`}
          className="shrink-0 text-muted-foreground/60 active:text-destructive transition-colors p-1 -mr-1"
        >
          <Trash2 className="size-4" aria-hidden="true" />
        </button>

        <button
          onClick={() => setExpanded((v) => !v)}
          aria-label={hasAnyText ? (expanded ? "Hide transcript" : "Show transcript") : "Transcript pending"}
          className="shrink-0 text-muted-foreground active:opacity-60 transition-opacity p-1"
        >
          {hasAnyText ? (
            expanded
              ? <ChevronDown className="size-4" aria-hidden="true" />
              : <FileText className="size-4" aria-hidden="true" />
          ) : (
            <span className="text-[10px] text-muted-foreground/60 font-medium">{pending > 0 ? "…" : ""}</span>
          )}
        </button>
      </div>

      {/* Transcript — every take in order, as one reading. ai_question_text is
          snapshotted per take by the device, so a later toggle never rewrites
          past chapters. */}
      {expanded && hasAnyText && (
        <div className="border-t border-border/40 px-4 py-3 space-y-3">
          {g.takes.map((rec, i) => (
            <div key={rec.id} className="space-y-1">
              {rec.ai_question_text && (
                <p className="text-[13px] text-foreground/90 leading-relaxed">
                  <span className="font-semibold text-primary">Q:</span> {rec.ai_question_text}
                </p>
              )}
              {rec.transcription ? (
                <p className="text-[13px] text-muted-foreground leading-relaxed">
                  {rec.ai_question_text && <span className="font-semibold text-foreground/70">A: </span>}
                  {rec.transcription}
                </p>
              ) : failed.has(rec.id) ? (
                <p className="text-[12px] text-destructive/80 italic">
                  [take {i + 1}: transcription failed]
                  {onRetry && (
                    <button onClick={() => onRetry(rec.id)} className="ml-2 not-italic text-primary font-medium active:opacity-60">
                      Retry
                    </button>
                  )}
                </p>
              ) : (
                <p className="text-[12px] text-muted-foreground/60 italic flex items-center gap-1.5">
                  <Loader2 className="size-3 animate-spin" aria-hidden="true" /> take {i + 1} transcribing…
                </p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Status line: transcribing / failed (only when something is off) */}
      {pending > 0 && showTranscribingIndicator && !expanded && (
        <div className="border-t border-border/40 px-4 py-2 flex items-center gap-1.5">
          <Loader2 className="size-3 animate-spin text-muted-foreground/50" aria-hidden="true" />
          <span className="text-[11px] text-muted-foreground/60">
            Transcribing{g.takes.length > 1 ? ` ${transcribed + failedCount + 1} of ${g.takes.length}` : ""}…
          </span>
        </div>
      )}
      {failedCount > 0 && !expanded && (
        <div className="border-t border-border/40 px-4 py-2 flex items-center gap-1.5">
          <AlertCircle className="size-3 text-destructive/70 shrink-0" aria-hidden="true" />
          <span className="text-[11px] text-destructive/80 flex-1">
            {failedCount === g.takes.length ? "Transcription failed" : `${failedCount} of ${g.takes.length} takes failed to transcribe`}
          </span>
          {onRetry && (
            <button
              onClick={() => g.takes.filter((r) => !r.transcription && failed.has(r.id)).forEach((r) => onRetry(r.id))}
              className="text-[11px] text-primary font-medium active:opacity-60"
            >
              Retry
            </button>
          )}
        </div>
      )}

      {/* Takes — collapsed by default; for deleting a bad one */}
      {g.takes.length > 1 && (
        <div className="border-t border-border/40">
          <button
            onClick={() => setShowTakes((v) => !v)}
            className="w-full px-4 py-2 flex items-center justify-between text-[11px] text-muted-foreground active:opacity-60"
            aria-expanded={showTakes}
          >
            <span>{g.takes.length} takes</span>
            {showTakes ? <ChevronDown className="size-3.5" aria-hidden="true" /> : <ChevronRight className="size-3.5" aria-hidden="true" />}
          </button>
          {showTakes && g.takes.map((rec, i) => (
            <div key={rec.id} className="px-4 py-1.5 flex items-center gap-2 text-[12px] border-t border-border/20">
              <span className="text-muted-foreground w-12 shrink-0">Take {i + 1}</span>
              <span className="text-muted-foreground/70 flex-1 truncate">
                {formatDuration(rec.duration_seconds) || "0:00"} · {timeAgo(rec.created_at)}
                {!rec.transcription && (failed.has(rec.id) ? " · failed" : " · transcribing")}
              </span>
              <button
                onClick={() => onDeleteTake(rec)}
                aria-label={`Delete take ${i + 1}`}
                className="text-muted-foreground/50 active:text-destructive p-1"
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ManageDevice;
