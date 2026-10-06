import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, BookOpen, Plus, Mic, RotateCcw, Heart, Briefcase, Baby, Mail, Pen, BookHeart, Loader2, Eye, Save, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import SkyBackground from "@/components/SkyBackground";
import AppTabBar from "@/components/AppTabBar";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { useAuth } from "@/lib/AuthProvider";
import { getBooks, createBook, getChapters, updateChapter, deleteChapter, reorderChapters, type Book, type Chapter } from "@/lib/database";
import { interviewQuestions } from "@/lib/interviewQuestions";
import type { Voice } from "@/lib/questionAudio";
import {
  DndContext,
  closestCenter,
  TouchSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import SwipeableChapterRow from "@/components/SwipeableChapterRow";

const RecordFlow = () => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  const { data: books = [], isLoading } = useQuery({
    queryKey: ["books", user?.id],
    queryFn: () => getBooks(user!.id),
    enabled: !!user?.id,
  });

  const [selectedBook, setSelectedBook] = useState<Book | null>(null);
  const [showRerecord, setShowRerecord] = useState(false);
  const [guidedInterview, setGuidedInterview] = useState(false);
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null);
  const [voicePreference, setVoicePreference] = useState<Voice>(() => {
    return (localStorage.getItem("voicePreference") as Voice) || "female";
  });

  const handleVoiceChange = (v: Voice) => {
    setVoicePreference(v);
    localStorage.setItem("voicePreference", v);
  };
  const [customTopicName, setCustomTopicName] = useState("");
  const [customQuestions, setCustomQuestions] = useState("");

  const [showCreateBook, setShowCreateBook] = useState(false);
  const [newBookTitle, setNewBookTitle] = useState("");
  const [newBookType, setNewBookType] = useState<"book" | "journal">("book");

  // Chapter view/edit state
  const [editingChapter, setEditingChapter] = useState<Chapter | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editTranscript, setEditTranscript] = useState("");
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  const [showChapters, setShowChapters] = useState(false);

  const { data: fullChapters = [] } = useQuery({
    queryKey: ["chapters", selectedBook?.id],
    queryFn: () => getChapters(selectedBook!.id),
    enabled: !!selectedBook?.id && showChapters,
  });

  const createBookMutation = useMutation({
    mutationFn: () => createBook(user!.id, newBookTitle.trim(), newBookType),
    onSuccess: (book) => {
      queryClient.invalidateQueries({ queryKey: ["books", user?.id] });
      setShowCreateBook(false);
      setNewBookTitle("");
      if (book) setSelectedBook(book);
    },
  });

  const handleCloseCreateDialog = (open: boolean) => {
    setShowCreateBook(open);
    if (!open) {
      setNewBookTitle("");
      setNewBookType("book");
    }
  };

  const topics = [
    { id: "life", label: "Life Story", icon: BookHeart },
    { id: "childhood", label: "Childhood & Family", icon: Baby },
    { id: "love", label: "Love & Relationships", icon: Heart },
    { id: "career", label: "Career", icon: Briefcase },
    { id: "letters", label: "Letters to Family", icon: Mail },
    { id: "custom", label: "Custom", icon: Pen },
  ];

  const selectedChapters = selectedBook?.chapters ?? [];
  const chapterCount = selectedChapters.length;

  const getQuestionsForRecording = (): string[] | undefined => {
    if (!guidedInterview || !selectedTopic) return undefined;
    if (selectedTopic === "custom") {
      const lines = customQuestions.split("\n").map(l => l.trim()).filter(Boolean);
      return lines.length > 0 ? lines : undefined;
    }
    return interviewQuestions[selectedTopic] ?? undefined;
  };

  const handleRecordNewChapter = () => {
    if (!selectedBook) return;
    const questions = getQuestionsForRecording();
    navigate("/recording-session", {
      state: {
        bookId: selectedBook.id,
        bookTitle: selectedBook.title,
        chapterIndex: chapterCount,
        questions,
        voicePreference,
        topic: guidedInterview ? selectedTopic : undefined,
      },
    });
  };

  const handleRerecordChapter = (chapter: { id: string; title: string; order_index: number }) => {
    if (!selectedBook) return;
    const questions = getQuestionsForRecording();
    navigate("/recording-session", {
      state: {
        bookId: selectedBook.id,
        bookTitle: selectedBook.title,
        chapterIndex: chapter.order_index,
        questions,
        voicePreference,
        topic: guidedInterview ? selectedTopic : undefined,
      },
    });
  };

  const [editingChapterIndex, setEditingChapterIndex] = useState(0);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } })
  );

  const openEditChapter = useCallback((ch: Chapter, displayIndex: number) => {
    setEditingChapter(ch);
    setEditingChapterIndex(displayIndex);
    setEditTitle(`Chapter ${displayIndex + 1}`);
    setEditTranscript(ch.transcript);
  }, []);

  const handleDeleteChapter = useCallback(async (ch: Chapter) => {
    const ok = await deleteChapter(ch.id);
    if (ok) {
      queryClient.invalidateQueries({ queryKey: ["chapters", selectedBook?.id] });
      queryClient.invalidateQueries({ queryKey: ["books", user?.id] });
    }
  }, [queryClient, selectedBook?.id, user?.id]);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = fullChapters.findIndex((c) => c.id === active.id);
    const newIndex = fullChapters.findIndex((c) => c.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(fullChapters, oldIndex, newIndex);
    const updates = reordered.map((ch, idx) => ({ id: ch.id, order_index: idx }));

    queryClient.setQueryData(["chapters", selectedBook?.id], reordered.map((ch, idx) => ({ ...ch, order_index: idx })));

    await reorderChapters(updates);
    queryClient.invalidateQueries({ queryKey: ["chapters", selectedBook?.id] });
    queryClient.invalidateQueries({ queryKey: ["books", user?.id] });
  }, [fullChapters, queryClient, selectedBook?.id, user?.id]);

  const handleSaveEdit = async () => {
    if (!editingChapter) return;
    setIsSavingEdit(true);
    await updateChapter(editingChapter.id, {
      title: editTitle.trim() || editingChapter.title,
      transcript: editTranscript,
    });
    queryClient.invalidateQueries({ queryKey: ["chapters", selectedBook?.id] });
    queryClient.invalidateQueries({ queryKey: ["books", user?.id] });
    setIsSavingEdit(false);
    setEditingChapter(null);
  };

  // Keep selectedBook in sync with fetched data
  useEffect(() => {
    if (selectedBook && books.length > 0) {
      const updated = books.find(b => b.id === selectedBook.id);
      if (updated) setSelectedBook(updated);
    }
  }, [books]);

  return (
    <div className="relative flex min-h-[100dvh] flex-col safe-top safe-bottom">
      <SkyBackground />

      <div className="pt-14 pb-4 px-6 flex items-center gap-3">
        <button
          onClick={() => navigate("/home")}
          className="flex items-center gap-1.5 text-muted-foreground active:opacity-60 transition-opacity"
        >
          <ArrowLeft className="size-5" />
        </button>
        <h1 className="text-xl font-bold text-foreground">Record</h1>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-28 space-y-6">
        {/* Book Selection */}
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">Pick a Book</h2>

          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : books.length === 0 ? (
            <button
              onClick={() => setShowCreateBook(true)}
              className="w-full p-5 rounded-2xl border border-dashed border-border bg-card/60 backdrop-blur-sm flex flex-col items-center gap-2 active:opacity-80 transition-opacity"
            >
              <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center">
                <BookOpen className="size-6 text-primary" />
              </div>
              <p className="font-semibold text-foreground">Create Your First Book</p>
              <p className="text-xs text-muted-foreground">Start recording your story</p>
            </button>
          ) : (
            <>
              {books.map((book) => {
                const bookChapters = book.chapters ?? [];
                return (
                  <button
                    key={book.id}
                    onClick={() => {
                      setSelectedBook(book);
                      setShowRerecord(false);
                      setShowChapters(false);
                    }}
                    className={`w-full p-4 rounded-2xl border backdrop-blur-sm text-left active:opacity-80 transition-all ${
                      selectedBook?.id === book.id
                        ? "border-primary bg-primary/5"
                        : "border-border/60 bg-card/80"
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
                        <BookOpen className="size-5 text-primary" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-[15px] text-foreground">{book.title}</p>
                        <p className="text-[13px] text-muted-foreground">
                          {bookChapters.length} chapter{bookChapters.length !== 1 ? "s" : ""}
                        </p>
                      </div>
                      {bookChapters.length > 0 && (
                        <Progress value={100} className="w-16 h-1.5" />
                      )}
                    </div>
                  </button>
                );
              })}

              <button
                onClick={() => setShowCreateBook(true)}
                className="w-full p-3.5 rounded-2xl border border-dashed border-border/60 bg-card/40 backdrop-blur-sm flex items-center justify-center gap-2 active:opacity-80 transition-opacity"
              >
                <Plus className="size-4 text-primary" />
                <span className="text-sm font-medium text-primary">Create New Book</span>
              </button>
            </>
          )}
        </section>

        {/* Actions for selected book */}
        {selectedBook && (
          <section className="space-y-3">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
              {selectedBook.title}
            </h2>

            <Button
              className="w-full h-13 text-base rounded-xl font-semibold gap-2"
              onClick={handleRecordNewChapter}
            >
              <Mic className="size-5" />
              Record New Chapter
            </Button>

            {selectedChapters.length > 0 && (
              <>
                <Button
                  variant="outline"
                  className="w-full h-13 text-base rounded-xl font-semibold gap-2"
                  onClick={() => { setShowChapters(!showChapters); setShowRerecord(false); }}
                >
                  <Eye className="size-4" />
                  View Chapters
                  <ChevronDown className={`size-4 ml-auto transition-transform ${showChapters ? "rotate-180" : ""}`} />
                </Button>

                <Button
                  variant="outline"
                  className="w-full h-13 text-base rounded-xl font-semibold gap-2"
                  onClick={() => { setShowRerecord(!showRerecord); setShowChapters(false); }}
                >
                  <RotateCcw className="size-4" />
                  Re-record a Chapter
                </Button>
              </>
            )}

            {/* Chapter list for viewing/editing */}
            {showChapters && (
              <div className="space-y-2">
                {fullChapters.length === 0 ? (
                  <div className="flex items-center justify-center py-4">
                    <Loader2 className="size-5 animate-spin text-muted-foreground" />
                  </div>
                ) : (
                  <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
                    <SortableContext items={fullChapters.map((c) => c.id)} strategy={verticalListSortingStrategy}>
                      {fullChapters.map((ch, idx) => (
                        <SwipeableChapterRow
                          key={ch.id}
                          chapter={ch}
                          displayIndex={idx}
                          onEdit={openEditChapter}
                          onDelete={handleDeleteChapter}
                        />
                      ))}
                    </SortableContext>
                  </DndContext>
                )}
              </div>
            )}

            {/* Re-record chapter list */}
            {showRerecord && (
              <div className="space-y-2 pl-1">
                {selectedChapters.map((ch: any, idx: number) => (
                  <button
                    key={ch.id}
                    onClick={() => handleRerecordChapter(ch)}
                    className="w-full flex items-center gap-3 p-3 rounded-xl border border-border/60 bg-card/80 backdrop-blur-sm text-left active:opacity-80 transition-opacity"
                  >
                    <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                      <span className="text-[11px] font-bold text-primary">{idx + 1}</span>
                    </div>
                    <span className="text-sm text-foreground">Chapter {idx + 1}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        )}

        {/* Guided Interview */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Guided Interview</h2>
              <p className="text-xs text-muted-foreground">Choose a topic to guide your recording</p>
            </div>
            <Switch checked={guidedInterview} onCheckedChange={setGuidedInterview} />
          </div>

          {guidedInterview && (
            <>
              <div className="grid grid-cols-2 gap-2.5">
                {topics.map((topic) => (
                  <button
                    key={topic.id}
                    onClick={() => setSelectedTopic(selectedTopic === topic.id ? null : topic.id)}
                    className={`h-16 rounded-2xl border backdrop-blur-sm active:opacity-80 transition-all flex flex-col items-center justify-center text-center gap-1 ${
                      selectedTopic === topic.id
                        ? "border-primary bg-primary/10"
                        : "border-border/60 bg-card/80"
                    }`}
                  >
                    <topic.icon className={`size-4 ${selectedTopic === topic.id ? "text-primary" : "text-muted-foreground"}`} />
                    <span className={`text-[12px] font-medium ${selectedTopic === topic.id ? "text-primary" : "text-foreground"}`}>{topic.label}</span>
                  </button>
                ))}
              </div>

              {selectedTopic && selectedTopic !== "custom" && (
                <div className="flex gap-2">
                  <button
                    onClick={() => handleVoiceChange("female")}
                    className={`flex-1 p-2.5 rounded-xl border text-sm font-medium transition-all ${
                      voicePreference === "female" ? "border-primary bg-primary/10 text-primary" : "border-border/60 bg-card/80 text-muted-foreground"
                    }`}
                  >
                    Female Voice
                  </button>
                  <button
                    onClick={() => handleVoiceChange("male")}
                    className={`flex-1 p-2.5 rounded-xl border text-sm font-medium transition-all ${
                      voicePreference === "male" ? "border-primary bg-primary/10 text-primary" : "border-border/60 bg-card/80 text-muted-foreground"
                    }`}
                  >
                    Male Voice
                  </button>
                </div>
              )}

              {selectedTopic === "custom" && (
                <div className="p-4 rounded-2xl border border-border/60 bg-card/80 backdrop-blur-sm space-y-3">
                  <Input
                    placeholder="Topic name"
                    value={customTopicName}
                    onChange={(e) => setCustomTopicName(e.target.value)}
                    className="rounded-xl"
                  />
                  <Textarea
                    placeholder="Enter your own questions, one per line..."
                    value={customQuestions}
                    onChange={(e) => setCustomQuestions(e.target.value)}
                    className="rounded-xl min-h-[100px]"
                  />
                </div>
              )}

              {selectedTopic && selectedTopic !== "custom" && interviewQuestions[selectedTopic] && (
                <div className="p-4 rounded-2xl border border-primary/20 bg-primary/5 backdrop-blur-sm space-y-2">
                  <p className="text-xs font-semibold text-primary uppercase tracking-wide">
                    {interviewQuestions[selectedTopic].length} questions loaded
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Questions will be shown one at a time during recording.
                  </p>
                </div>
              )}
            </>
          )}
        </section>
      </div>

      {/* Create Book Dialog */}
      <Dialog open={showCreateBook} onOpenChange={handleCloseCreateDialog}>
        <DialogContent className="max-w-[calc(100%-3rem)] rounded-2xl top-[20%] translate-y-0">
          <DialogHeader>
            <DialogTitle className="text-xl">Create a New Book</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <Input
              placeholder="Book title"
              value={newBookTitle}
              onChange={(e) => setNewBookTitle(e.target.value)}
              className="h-12 rounded-xl text-base"
              autoFocus
            />
            <div className="flex gap-2">
              <button
                onClick={() => setNewBookType("book")}
                className={`flex-1 p-3 rounded-xl border text-sm font-medium transition-all ${
                  newBookType === "book" ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground"
                }`}
              >
                Book
              </button>
              <button
                onClick={() => setNewBookType("journal")}
                className={`flex-1 p-3 rounded-xl border text-sm font-medium transition-all ${
                  newBookType === "journal" ? "border-primary bg-primary/10 text-primary" : "border-border bg-card text-muted-foreground"
                }`}
              >
                Journal
              </button>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" className="rounded-xl flex-1" onClick={() => handleCloseCreateDialog(false)}>
              Cancel
            </Button>
            <Button
              className="rounded-xl flex-1"
              disabled={!newBookTitle.trim() || createBookMutation.isPending}
              onClick={() => createBookMutation.mutate()}
            >
              {createBookMutation.isPending ? <Loader2 className="size-4 animate-spin mr-2" /> : null}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Chapter Edit Dialog */}
      <Dialog open={!!editingChapter} onOpenChange={(open) => !open && setEditingChapter(null)}>
        <DialogContent className="max-w-[calc(100%-2rem)] max-h-[85dvh] p-0 !grid-rows-[auto_1fr_auto] overflow-hidden rounded-2xl">
          <div className="px-5 pt-5 pb-3 border-b">
            <input
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="text-base font-semibold bg-transparent border-none outline-none w-full text-foreground"
              spellCheck={true}
              autoCorrect="on"
            />
          </div>
          <div className="overflow-y-auto min-h-0 px-1">
            <textarea
              value={editTranscript}
              onChange={(e) => setEditTranscript(e.target.value)}
              className="w-full min-h-[50dvh] resize-none bg-transparent border-none outline-none text-foreground leading-[1.8] text-[15px] p-5"
              spellCheck={true}
              autoCorrect="on"
              autoCapitalize="sentences"
            />
          </div>
          <div className="border-t px-5 py-3 flex items-center justify-between bg-card safe-bottom">
            <Button variant="ghost" size="sm" className="rounded-lg" onClick={() => setEditingChapter(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="rounded-lg gap-1.5"
              onClick={handleSaveEdit}
              disabled={isSavingEdit}
            >
              {isSavingEdit ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              Save
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <AppTabBar />
    </div>
  );
};

export default RecordFlow;
