import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { BookOpen, Radio, Loader2 } from "lucide-react";
import SkyBackground from "@/components/SkyBackground";
import AppTabBar from "@/components/AppTabBar";
import { Progress } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/AuthProvider";
import { getBooks } from "@/lib/database";

const CreatorHome = () => {
  const navigate = useNavigate();
  const { user } = useAuth();

  const { data: books = [], isLoading } = useQuery({
    queryKey: ["books", user?.id],
    queryFn: () => getBooks(user!.id),
    enabled: !!user?.id,
  });

  const totalChapters = books.reduce(
    (sum, b) => sum + (b.chapters?.length ?? 0),
    0
  );

  const latestBook = books[0];
  const latestChapterCount = latestBook?.chapters?.length ?? 0;

  const displayName = user?.user_metadata?.full_name || user?.email?.split("@")[0] || "Storyteller";

  return (
    <div className="min-h-[100dvh] relative flex flex-col">
      <SkyBackground />

      <header className="border-b bg-card/80 backdrop-blur-md safe-top">
        <div className="px-6 py-5 flex flex-col items-center gap-3">
          <div className="text-center">
            <h1 className="text-2xl font-bold text-foreground">Welcome, {displayName}</h1>
            <p className="text-sm text-muted-foreground mt-1">Your creator dashboard</p>
          </div>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto pb-24">
        <div className="max-w-lg mx-auto w-full px-6 py-6 space-y-5">
          {isLoading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <>
              {/* Stats */}
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-2xl bg-card/80 backdrop-blur-sm border border-border/50 p-4 text-center shadow-sm">
                  <p className="text-3xl font-bold text-foreground">{books.length}</p>
                  <p className="text-sm text-muted-foreground mt-0.5">Book{books.length !== 1 ? "s" : ""}</p>
                </div>
                <div className="rounded-2xl bg-card/80 backdrop-blur-sm border border-border/50 p-4 text-center shadow-sm">
                  <p className="text-3xl font-bold text-foreground">{totalChapters}</p>
                  <p className="text-sm text-muted-foreground mt-0.5">Chapter{totalChapters !== 1 ? "s" : ""}</p>
                </div>
              </div>

              {/* Current Book or empty state */}
              {latestBook ? (
                <div className="rounded-2xl bg-card/80 backdrop-blur-sm border border-border/50 p-5 shadow-sm space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                      <BookOpen className="size-5 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-[15px] text-foreground">Current Book</p>
                      <p className="text-[13px] text-muted-foreground">{latestBook.title}</p>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>Progress</span>
                      <span>{latestChapterCount} chapter{latestChapterCount !== 1 ? "s" : ""} recorded</span>
                    </div>
                    <Progress value={latestChapterCount > 0 ? 100 : 0} className="h-2" />
                  </div>
                  <Button className="w-full rounded-xl" onClick={() => navigate("/record")}>
                    Continue Recording
                  </Button>
                </div>
              ) : (
                <div className="rounded-2xl bg-card/80 backdrop-blur-sm border border-border/50 p-5 shadow-sm space-y-4">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                      <BookOpen className="size-5 text-primary" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-semibold text-[15px] text-foreground">No Books Yet</p>
                      <p className="text-[13px] text-muted-foreground">Create your first book to get started</p>
                    </div>
                  </div>
                  <Button className="w-full rounded-xl" onClick={() => navigate("/record")}>
                    Start Recording
                  </Button>
                </div>
              )}
            </>
          )}

          <button
            onClick={() => navigate("/device-setup")}
            className="w-full flex items-center gap-4 p-4 rounded-2xl bg-card/80 backdrop-blur-sm border border-border/50 text-left active:opacity-80 transition-opacity shadow-sm"
          >
            <div className="w-11 h-11 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
              <Radio className="size-5 text-primary" />
            </div>
            <div className="min-w-0">
              <p className="font-semibold text-[15px] text-foreground">Set Up Device</p>
              <p className="text-[13px] text-muted-foreground leading-tight mt-0.5">Connect your LegacyTape recorder</p>
            </div>
          </button>
        </div>
      </div>

      <AppTabBar />
    </div>
  );
};

export default CreatorHome;
