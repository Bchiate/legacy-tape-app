import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, ChevronRight, Loader2, ArrowLeft, ArrowRight, HardDrive, Play, Pause } from "lucide-react";
import { Button } from "@/components/ui/button";
import SkyBackground from "@/components/SkyBackground";
import AppTabBar from "@/components/AppTabBar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuth } from "@/lib/AuthProvider";
import { supabase } from "@/lib/supabase";
import { getBooks, getChapters, type Book, type Chapter } from "@/lib/database";
import {
  type ChapterGroup,
  type DeviceBook,
  fetchRecordings,
  groupByBook,
  chapterTranscript,
  formatDuration,
} from "@/lib/deviceRecordings";
import { useTakesPlayback } from "@/lib/useTakesPlayback";

// The Library is a VIEW over both places a story can come from:
//   • phone recordings  → books / chapters tables (transcript only, no audio)
//   • device recordings → recordings table, grouped by book_name + chapter_idx
//     (audio + transcript; a chapter's takes play back-to-back as one timeline)
// Device books are synthesized on read — nothing is copied into `books`, so
// there's no second copy to keep in sync and everything already recorded
// appears immediately.

type ReaderTarget =
  | { kind: "phone"; chapter: Chapter }
  | { kind: "device"; group: ChapterGroup; bookTitle: string };

// One list entry, either source, so they can be sorted together by recency.
type LibraryEntry =
  | { kind: "phone"; id: string; book: Book; latestAt: string }
  | { kind: "device"; id: string; book: DeviceBook; latestAt: string };

const CreatorLibrary = () => {
  const { user } = useAuth();
  const qc = useQueryClient();

  const { data: books = [], isLoading: booksLoading } = useQuery({
    queryKey: ["books", user?.id],
    queryFn: () => getBooks(user!.id),
    enabled: !!user?.id,
  });

  const { data: recordings = [], isLoading: recsLoading } = useQuery({
    queryKey: ["recordings", user?.id],
    queryFn: () => fetchRecordings(user!.id),
    enabled: !!user?.id,
  });

  // A new take finalizing on the device, or a transcript landing, should show
  // up here without leaving the tab.
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`library-recordings:${user.id}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "recordings", filter: `account_id=eq.${user.id}` },
        () => qc.invalidateQueries({ queryKey: ["recordings", user.id] }))
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [user, qc]);

  const deviceBooks = groupByBook(recordings);

  const entries: LibraryEntry[] = [
    ...deviceBooks.map((b) => ({ kind: "device" as const, id: `device:${b.key}`, book: b, latestAt: b.latestAt })),
    ...books.map((b) => ({ kind: "phone" as const, id: b.id, book: b, latestAt: b.created_at })),
  ].sort((a, b) => b.latestAt.localeCompare(a.latestAt));

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [reader, setReader] = useState<ReaderTarget | null>(null);
  const [currentPage, setCurrentPage] = useState(0);
  const playback = useTakesPlayback();

  // Phone chapters are lazy-loaded per book (unchanged behavior).
  const expandedPhoneBookId = expandedId && !expandedId.startsWith("device:") ? expandedId : null;
  const { data: phoneChapters = [] } = useQuery({
    queryKey: ["chapters", expandedPhoneBookId],
    queryFn: () => getChapters(expandedPhoneBookId!),
    enabled: !!expandedPhoneBookId,
  });

  const splitIntoParagraphs = (text: string) => {
    const paragraphs = text.split(/\n\n+/).filter(Boolean);
    if (paragraphs.length <= 1) {
      const words = text.split(" ");
      const pages: string[] = [];
      for (let i = 0; i < words.length; i += 150) {
        pages.push(words.slice(i, i + 150).join(" "));
      }
      return pages.length > 0 ? pages : [text];
    }
    return paragraphs;
  };

  const readerText =
    reader?.kind === "phone" ? reader.chapter.transcript
    : reader?.kind === "device" ? chapterTranscript(reader.group)
    : "";
  const pages = reader ? splitIntoParagraphs(readerText) : [];
  const readerTitle =
    reader?.kind === "phone" ? reader.chapter.title
    : reader?.kind === "device" ? reader.group.title
    : "";

  const openReader = (t: ReaderTarget) => {
    setReader(t);
    setCurrentPage(0);
  };
  const closeReader = () => {
    playback.stop();
    setReader(null);
  };

  const isLoading = booksLoading || recsLoading;

  return (
    <div className="min-h-[100dvh] relative flex flex-col">
      <SkyBackground />
      <header className="border-b bg-card/80 backdrop-blur-md safe-top">
        <div className="px-6 py-6 text-center">
          <h1 className="text-2xl font-bold text-foreground">Your Library</h1>
          <p className="text-sm text-muted-foreground mt-1">All your recorded books</p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto pb-24">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : entries.length === 0 ? (
          <div className="flex-1 flex items-center justify-center py-16">
            <div className="text-center text-muted-foreground">
              <BookOpen className="size-12 mx-auto mb-3 opacity-40" />
              <p className="font-medium">No books yet</p>
              <p className="text-sm mt-1">Start recording to see your books here</p>
            </div>
          </div>
        ) : (
          <div className="max-w-lg mx-auto w-full px-5 py-5 space-y-3">
            {entries.map((entry) => {
              const isExpanded = expandedId === entry.id;
              const isDevice = entry.kind === "device";
              const chapterCount = isDevice ? entry.book.chapters.length : (entry.book.chapters?.length ?? 0);
              const meta = isDevice
                ? [`${chapterCount} chapter${chapterCount !== 1 ? "s" : ""}`, formatDuration(entry.book.totalDuration), "device"].filter(Boolean).join(" · ")
                : `${chapterCount} chapter${chapterCount !== 1 ? "s" : ""} · ${entry.book.type}`;

              return (
                <div key={entry.id} className="rounded-2xl bg-card/80 backdrop-blur-sm border border-border/50 overflow-hidden shadow-sm">
                  <button
                    className="w-full p-4 flex items-center gap-3 text-left active:opacity-80 transition-opacity"
                    onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                  >
                    <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                      {isDevice
                        ? <HardDrive className="size-5 text-primary" />
                        : <BookOpen className="size-5 text-primary" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-[15px] text-foreground truncate">{entry.book.title}</p>
                      <p className="text-[13px] text-muted-foreground">{meta}</p>
                    </div>
                    <ChevronRight className={`size-4 text-muted-foreground transition-transform ${isExpanded ? "rotate-90" : ""}`} />
                  </button>

                  {isExpanded && (
                    <div className="border-t border-border/30 px-4 pb-3">
                      {isDevice ? (
                        entry.book.chapters.map((g) => {
                          const transcribed = g.takes.filter((r) => r.transcription).length;
                          const preview = g.takes.find((r) => r.transcription)?.transcription ?? "";
                          const isPlaying = playback.playingKey === g.key;
                          const isBuffering = playback.loadingKey === g.key;
                          return (
                            <div
                              key={g.key}
                              className="w-full flex items-center gap-3 py-3 border-b border-border/20 last:border-0"
                            >
                              <button
                                onClick={() => playback.toggle(g.key, g.takes)}
                                aria-label={isPlaying ? `Pause ${g.title}` : `Play ${g.title}`}
                                className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                                  isPlaying || isBuffering ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary active:bg-primary/20"
                                }`}
                              >
                                {isBuffering ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
                                  : isPlaying ? <Pause className="size-3.5" aria-hidden="true" />
                                  : <Play className="size-3.5 ml-0.5" aria-hidden="true" />}
                              </button>
                              <button
                                className="flex-1 min-w-0 text-left active:opacity-80 transition-opacity"
                                onClick={() => openReader({ kind: "device", group: g, bookTitle: entry.book.title })}
                              >
                                <p className="text-sm font-medium text-foreground">
                                  {g.title}
                                  {isPlaying && g.takes.length > 1 && (
                                    <span className="text-xs text-muted-foreground font-normal"> · take {playback.playingTake + 1} of {g.takes.length}</span>
                                  )}
                                </p>
                                <p className="text-xs text-muted-foreground truncate">
                                  {preview
                                    ? `${preview.slice(0, 80)}${preview.length > 80 ? "..." : ""}`
                                    : transcribed === 0 ? "Transcribing…" : ""}
                                </p>
                              </button>
                              <span className="text-xs text-muted-foreground shrink-0">
                                {formatDuration(g.totalDuration) || "0:00"}
                              </span>
                            </div>
                          );
                        })
                      ) : phoneChapters.length === 0 ? (
                        <p className="text-sm text-muted-foreground py-3 text-center">No chapters recorded yet</p>
                      ) : (
                        phoneChapters.map((ch) => (
                          <button
                            key={ch.id}
                            className="w-full flex items-center gap-3 py-3 border-b border-border/20 last:border-0 text-left active:opacity-80 transition-opacity"
                            onClick={() => openReader({ kind: "phone", chapter: ch })}
                          >
                            <div className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium text-foreground">{ch.title}</p>
                              <p className="text-xs text-muted-foreground truncate">
                                {ch.transcript.slice(0, 80)}{ch.transcript.length > 80 ? "..." : ""}
                              </p>
                            </div>
                            <span className="text-xs text-muted-foreground shrink-0">
                              {Math.floor(ch.duration_seconds / 60)}m {ch.duration_seconds % 60}s
                            </span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Chapter reader — transcript pages; device chapters also play their audio */}
      <Dialog open={!!reader} onOpenChange={(open) => !open && closeReader()}>
        <DialogContent className="max-w-[calc(100%-2rem)] h-[85dvh] flex flex-col p-0 overflow-hidden rounded-2xl">
          <DialogHeader className="px-5 pt-5 pb-3 border-b shrink-0">
            <div className="flex items-center gap-3 pr-6">
              {reader?.kind === "device" && (
                <button
                  onClick={() => playback.toggle(reader.group.key, reader.group.takes)}
                  aria-label={playback.playingKey === reader.group.key ? "Pause" : "Play chapter"}
                  className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                    playback.playingKey === reader.group.key || playback.loadingKey === reader.group.key
                      ? "bg-primary text-primary-foreground"
                      : "bg-primary/10 text-primary active:bg-primary/20"
                  }`}
                >
                  {playback.loadingKey === reader.group.key ? <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                    : playback.playingKey === reader.group.key ? <Pause className="size-4" aria-hidden="true" />
                    : <Play className="size-4 ml-0.5" aria-hidden="true" />}
                </button>
              )}
              <div className="min-w-0">
                <DialogTitle className="text-base truncate">{readerTitle}</DialogTitle>
                {reader?.kind === "device" && (
                  <p className="text-xs text-muted-foreground truncate">
                    {reader.bookTitle} · {formatDuration(reader.group.totalDuration) || "0:00"}
                    {reader.group.takes.length > 1 ? ` · ${reader.group.takes.length} takes` : ""}
                    {playback.playingKey === reader.group.key && reader.group.takes.length > 1
                      ? ` · playing ${playback.playingTake + 1}/${reader.group.takes.length}` : ""}
                  </p>
                )}
              </div>
            </div>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto px-6 py-6">
            <p className="text-foreground leading-[1.8] text-[16px] whitespace-pre-line">
              {pages[currentPage]}
            </p>
          </div>
          {pages.length > 1 && (
            <div className="border-t px-5 py-3 flex items-center justify-between bg-card shrink-0 safe-bottom">
              <Button variant="ghost" size="sm" onClick={() => setCurrentPage((p) => p - 1)} disabled={currentPage === 0} className="rounded-lg">
                <ArrowLeft className="size-4 mr-1" /> Prev
              </Button>
              <span className="text-xs text-muted-foreground font-medium">{currentPage + 1} / {pages.length}</span>
              <Button variant="ghost" size="sm" onClick={() => setCurrentPage((p) => p + 1)} disabled={currentPage === pages.length - 1} className="rounded-lg">
                Next <ArrowRight className="size-4 ml-1" />
              </Button>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <AppTabBar />
    </div>
  );
};

export default CreatorLibrary;
