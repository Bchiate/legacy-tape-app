import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { BookOpen, Eye, ArrowLeft, ArrowRight, ChevronLeft, Loader2 } from "lucide-react";
import SkyBackground from "@/components/SkyBackground";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { getFamilyStory, type StoryChapter } from "@/lib/database";

interface LocationState {
  familyCode?: string;
  name?: string;
}

const Dashboard = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const state = (location.state as LocationState) || {};
  const familyCode = state.familyCode;
  const name = state.name || "Storyteller";

  const { data: story, isLoading } = useQuery({
    queryKey: ["family-story", familyCode],
    queryFn: () => getFamilyStory(familyCode!),
    enabled: !!familyCode,
  });
  const books = story?.books ?? [];

  const allChapters: (StoryChapter & { bookTitle: string })[] = books.flatMap((b) =>
    b.chapters.map((ch) => ({ ...ch, bookTitle: b.title }))
  );
  allChapters.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  const [bookViewOpen, setBookViewOpen] = useState(false);
  const [currentChapterIdx, setCurrentChapterIdx] = useState(0);
  const [currentPage, setCurrentPage] = useState(0);
  const [touchStart, setTouchStart] = useState<number | null>(null);

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

  const currentChapter = allChapters[currentChapterIdx];
  const pages = currentChapter ? splitIntoParagraphs(currentChapter.transcript) : [""];
  const totalPages = pages.length;

  const openBookView = (chapterIndex = 0) => {
    setCurrentChapterIdx(chapterIndex);
    setCurrentPage(0);
    setBookViewOpen(true);
  };

  const goNext = () => {
    if (currentPage < totalPages - 1) setCurrentPage((p) => p + 1);
    else if (currentChapterIdx < allChapters.length - 1) {
      setCurrentChapterIdx((c) => c + 1);
      setCurrentPage(0);
    }
  };

  const goPrev = () => {
    if (currentPage > 0) setCurrentPage((p) => p - 1);
    else if (currentChapterIdx > 0) {
      const prevIdx = currentChapterIdx - 1;
      const prevPages = splitIntoParagraphs(allChapters[prevIdx].transcript);
      setCurrentChapterIdx(prevIdx);
      setCurrentPage(prevPages.length - 1);
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => setTouchStart(e.touches[0].clientX);
  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStart === null) return;
    const diff = touchStart - e.changedTouches[0].clientX;
    if (Math.abs(diff) > 50) { diff > 0 ? goNext() : goPrev(); }
    setTouchStart(null);
  };

  if (!familyCode) {
    return (
      <div className="min-h-[100dvh] relative flex items-center justify-center">
        <SkyBackground />
        <div className="text-center text-muted-foreground px-6">
          <p className="font-medium">No story selected</p>
          <p className="text-sm mt-1">Go back and enter a family code to follow a story.</p>
          <Button className="mt-4 rounded-xl" onClick={() => navigate("/follow")}>
            Find a Story
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100dvh] relative pb-20">
      <SkyBackground />

      <header className="sticky top-0 z-10 border-b bg-card/80 backdrop-blur-md px-4 pt-[env(safe-area-inset-top)] safe-top">
        <div className="flex items-center justify-between max-w-lg mx-auto py-3.5">
          <div className="flex items-center gap-3">
            <button onClick={() => navigate("/home")} className="text-muted-foreground active:opacity-60 transition-opacity p-1 -ml-1">
              <ChevronLeft className="size-6" />
            </button>
            <div className="pt-0.5">
              <h1 className="text-lg font-bold text-foreground leading-tight">{name}</h1>
              <p className="text-xs text-muted-foreground">Their story, your treasure</p>
            </div>
          </div>
          {allChapters.length > 0 && (
            <Button variant="outline" size="sm" className="gap-1.5 rounded-xl text-[13px] h-9 self-center" onClick={() => openBookView(0)}>
              <BookOpen className="size-3.5" />
              Book View
            </Button>
          )}
        </div>
      </header>

      <div className="max-w-lg mx-auto px-5 py-6 space-y-6 safe-bottom">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : allChapters.length === 0 ? (
          <div className="text-center text-muted-foreground py-16">
            <BookOpen className="size-12 mx-auto mb-3 opacity-40" />
            <p className="font-medium">No chapters yet</p>
            <p className="text-sm mt-1">This storyteller hasn't recorded any chapters yet</p>
          </div>
        ) : (
          <>
            <div className="p-4 rounded-2xl bg-card/80 backdrop-blur-sm border border-border/50 space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground font-medium">Story Progress</span>
                <span className="font-bold text-primary">{allChapters.length} chapter{allChapters.length !== 1 ? "s" : ""}</span>
              </div>
              <Progress value={100} className="h-2.5 rounded-full" />
              <p className="text-xs text-muted-foreground">
                {books.length} book{books.length !== 1 ? "s" : ""} · {allChapters.length} chapter{allChapters.length !== 1 ? "s" : ""} recorded
              </p>
            </div>

            <div className="space-y-3">
              <h2 className="text-lg font-semibold text-foreground px-1">Chapters</h2>
              {allChapters.map((ch, i) => (
                <div key={ch.id} className="border border-border/50 rounded-2xl p-4 bg-card/80 backdrop-blur-sm space-y-2.5">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="font-semibold text-[15px] text-foreground leading-snug">{ch.title}</h3>
                      <p className="text-[11px] text-muted-foreground">{ch.bookTitle}</p>
                    </div>
                    <Button variant="ghost" size="sm" className="gap-1 text-primary text-[13px] shrink-0 h-8 rounded-lg" onClick={() => openBookView(i)}>
                      <Eye className="size-3.5" /> View
                    </Button>
                  </div>
                  <p className="text-[13px] text-muted-foreground leading-relaxed">
                    {ch.transcript.slice(0, 120)}{ch.transcript.length > 120 ? "..." : ""}
                  </p>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <Dialog open={bookViewOpen} onOpenChange={setBookViewOpen}>
        <DialogContent className="max-w-[calc(100%-2rem)] h-[85dvh] flex flex-col p-0 overflow-hidden rounded-2xl">
          <DialogHeader className="px-5 pt-5 pb-3 border-b shrink-0">
            <DialogTitle className="text-base">{currentChapter?.title}</DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto px-6 py-6" onTouchStart={handleTouchStart} onTouchEnd={handleTouchEnd}>
            <p className="text-foreground leading-[1.8] text-[16px] whitespace-pre-line">
              {pages[currentPage]}
            </p>
          </div>
          <div className="border-t px-5 py-3 flex items-center justify-between bg-card shrink-0 safe-bottom">
            <Button variant="ghost" size="sm" onClick={goPrev} disabled={currentChapterIdx === 0 && currentPage === 0} className="rounded-lg">
              <ArrowLeft className="size-4 mr-1" /> Prev
            </Button>
            <span className="text-xs text-muted-foreground font-medium">{currentPage + 1} / {totalPages}</span>
            <Button variant="ghost" size="sm" onClick={goNext} disabled={currentChapterIdx === allChapters.length - 1 && currentPage === totalPages - 1} className="rounded-lg">
              Next <ArrowRight className="size-4 ml-1" />
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default Dashboard;
