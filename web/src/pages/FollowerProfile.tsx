import { useNavigate } from "react-router-dom";
import { User, ArrowLeft } from "lucide-react";
import SkyBackground from "@/components/SkyBackground";

const FollowerProfile = () => {
  const navigate = useNavigate();

  return (
    <div className="min-h-[100dvh] relative flex flex-col">
      <SkyBackground />
      <header className="border-b bg-card/80 backdrop-blur-md safe-top">
        <div className="px-6 py-6 text-center">
          <h1 className="text-2xl font-bold text-foreground">Profile</h1>
          <p className="text-sm text-muted-foreground mt-1">Follower settings</p>
        </div>
      </header>
      <div className="flex-1 flex items-center justify-center pb-24">
        <div className="text-center text-muted-foreground">
          <User className="size-12 mx-auto mb-3 opacity-40" />
          <p className="font-medium">Follower profile</p>
          <p className="text-sm mt-1">Coming soon</p>
        </div>
      </div>
    </div>
  );
};

export default FollowerProfile;
