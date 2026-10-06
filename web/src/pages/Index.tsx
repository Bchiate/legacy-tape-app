import { useNavigate } from "react-router-dom";
import { Mic, BookOpen, BookText, Plus } from "lucide-react";
import SkyBackground from "@/components/SkyBackground";
import AppTabBar from "@/components/AppTabBar";

const Index = () => {
  const navigate = useNavigate();

  const actions = [
    { label: "Follow a Loved One", icon: "BookOpen" as const, route: "/follow", desc: "Read their story" },
    { label: "Record a Book", icon: "Mic" as const, route: "/record?type=book", desc: "Voice to keepsake" },
    { label: "Record a Journal", icon: "BookText" as const, route: "/record?type=journal", desc: "Daily reflections" },
    { label: "Set Up a Device", icon: "Plus" as const, route: "/device-setup", desc: "Connect recorder" },
  ];

  const iconMap = {
    BookOpen: <BookOpen className="size-7 text-primary" />,
    Mic: <Mic className="size-7 text-primary" />,
    BookText: <BookText className="size-7 text-primary" />,
    Plus: <Plus className="size-7 text-primary" />,
  };

  return (
    <div className="relative min-h-[100dvh] flex flex-col px-6 safe-top">
      <SkyBackground />

      {/* Header - pinned to top */}
      <div className="text-center pt-16">
        <h1 className="text-4xl font-bold tracking-tight text-foreground">
          LegacyTape
        </h1>
        <p className="text-muted-foreground text-base leading-relaxed max-w-[260px] mx-auto mt-2">
          Turn spoken stories into books your family will treasure forever
        </p>
      </div>

      {/* Buttons - evenly spaced between header and tab bar */}
      <div className="flex-1 flex flex-col pb-[calc(4rem+env(safe-area-inset-bottom,20px))]">
        <div className="flex-1" />

        <div className="w-full max-w-sm mx-auto flex flex-col gap-3">
          {actions.map((action) => (
            <button
              key={action.label}
              className="w-full rounded-2xl bg-card/80 backdrop-blur-sm border border-border/60 flex items-center gap-4 px-5 py-4 text-left active:opacity-80 transition-opacity shadow-sm"
              onClick={() => navigate(action.route)}
            >
              {iconMap[action.icon]}
              <div>
                <p className="font-semibold text-[15px] text-foreground leading-tight">{action.label}</p>
                <p className="text-[12px] text-muted-foreground leading-tight mt-0.5">{action.desc}</p>
              </div>
            </button>
          ))}
        </div>

        <div className="flex-1" />
      </div>

      <AppTabBar />
    </div>
  );
};

export default Index;
