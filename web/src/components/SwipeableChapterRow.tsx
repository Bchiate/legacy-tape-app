import { useRef, useState, type TouchEvent as ReactTouchEvent } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical, Trash2 } from "lucide-react";
import type { Chapter } from "@/lib/database";

interface Props {
  chapter: Chapter;
  displayIndex: number;
  onEdit: (ch: Chapter, idx: number) => void;
  onDelete: (ch: Chapter) => void;
}

const DELETE_THRESHOLD = 80;

export default function SwipeableChapterRow({ chapter, displayIndex, onEdit, onDelete }: Props) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: chapter.id });

  const [offsetX, setOffsetX] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const startX = useRef(0);
  const startY = useRef(0);
  const locked = useRef<"x" | "y" | null>(null);

  const dndStyle = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 50 : "auto" as const,
  };

  const onTouchStart = (e: ReactTouchEvent) => {
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
    locked.current = null;
    setIsSwiping(false);
  };

  const onTouchMove = (e: ReactTouchEvent) => {
    const dx = e.touches[0].clientX - startX.current;
    const dy = e.touches[0].clientY - startY.current;

    if (!locked.current) {
      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        locked.current = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      }
      return;
    }

    if (locked.current === "y") return;

    setIsSwiping(true);
    const clamped = Math.min(0, Math.max(-DELETE_THRESHOLD - 20, dx));
    setOffsetX(clamped);
  };

  const onTouchEnd = () => {
    if (locked.current === "x") {
      if (offsetX < -DELETE_THRESHOLD) {
        setOffsetX(-DELETE_THRESHOLD);
      } else {
        setOffsetX(0);
      }
    }
    setIsSwiping(false);
    locked.current = null;
  };

  const handleRowTap = () => {
    if (offsetX < -10) {
      setOffsetX(0);
      return;
    }
    onEdit(chapter, displayIndex);
  };

  return (
    <div ref={setNodeRef} style={dndStyle} className="relative overflow-hidden rounded-xl mb-2">
      {/* Delete backdrop */}
      <div className="absolute inset-y-0 right-0 flex items-center pr-4 bg-destructive rounded-xl">
        <button
          onClick={() => onDelete(chapter)}
          className="flex items-center gap-1.5 text-destructive-foreground px-2"
        >
          <Trash2 className="size-4" />
          <span className="text-xs font-semibold">Delete</span>
        </button>
      </div>

      {/* Foreground row */}
      <div
        className="relative flex items-start gap-2 p-3 border border-border/60 bg-card/80 backdrop-blur-sm text-left rounded-xl"
        style={{
          transform: `translateX(${offsetX}px)`,
          transition: isSwiping ? "none" : "transform 0.25s ease-out",
        }}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        {/* Drag handle */}
        <button
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          className="mt-1 p-0.5 -ml-0.5 touch-none text-muted-foreground/50 active:text-muted-foreground"
        >
          <GripVertical className="size-4" />
        </button>

        {/* Content (tappable for edit) */}
        <button className="flex-1 flex items-start gap-3 min-w-0 text-left" onClick={handleRowTap}>
          <div className="w-6 h-6 rounded-full bg-primary/10 flex items-center justify-center mt-0.5 shrink-0">
            <span className="text-[11px] font-bold text-primary">{displayIndex + 1}</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-foreground">Chapter {displayIndex + 1}</p>
            <p className="text-xs text-muted-foreground truncate mt-0.5">
              {chapter.transcript.slice(0, 80)}
              {chapter.transcript.length > 80 ? "..." : ""}
            </p>
          </div>
          <span className="text-[11px] text-muted-foreground shrink-0 mt-0.5">
            {Math.floor(chapter.duration_seconds / 60)}m {chapter.duration_seconds % 60}s
          </span>
        </button>
      </div>
    </div>
  );
}
