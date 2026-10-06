import { useLocation, useNavigate } from "react-router-dom";
import { Home, Mic, HardDrive, BookOpen, User } from "lucide-react";

// The single app-wide bottom bar. Same five destinations on every main screen —
// only the active highlight moves. Focused "drill-in" flows (the story reader,
// pairing, an active recording) render no bar and use a back button instead.
const tabs = [
  { label: "Home", icon: Home, route: "/home" },
  { label: "Record", icon: Mic, route: "/record" },
  { label: "My Device", icon: HardDrive, route: "/manage-device" },
  { label: "Library", icon: BookOpen, route: "/creator-library" },
  { label: "Profile", icon: User, route: "/creator-profile" },
];

const AppTabBar = () => {
  const location = useLocation();
  const navigate = useNavigate();

  return (
    <nav className="fixed bottom-0 left-0 right-0 border-t border-border/50 bg-card/80 backdrop-blur-md safe-bottom z-50">
      <div className="flex items-center justify-around h-16">
        {tabs.map((tab) => {
          const active = location.pathname === tab.route;
          return (
            <button
              key={tab.label}
              onClick={() => navigate(tab.route)}
              aria-label={tab.label}
              aria-current={active ? "page" : undefined}
              className="flex flex-col items-center gap-1 flex-1 pt-2 pb-1"
            >
              <tab.icon className={`size-5 ${active ? "text-primary" : "text-muted-foreground"}`} />
              <span
                className={`text-[10px] font-medium ${
                  active ? "text-primary" : "text-muted-foreground"
                }`}
              >
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
};

export default AppTabBar;
