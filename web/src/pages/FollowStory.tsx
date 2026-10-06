import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Loader2 } from "lucide-react";
import SkyBackground from "@/components/SkyBackground";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { getFamilyStory } from "@/lib/database";

const FollowStory = () => {
  const navigate = useNavigate();
  const [familyCode, setFamilyCode] = useState("");
  const [lastName, setLastName] = useState("");
  const [showConfirm, setShowConfirm] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState("");
  const [foundName, setFoundName] = useState("");

  const handleContinue = async () => {
    if (!familyCode.trim()) return;
    setIsSearching(true);
    setError("");

    const result = await getFamilyStory(familyCode);

    setIsSearching(false);

    if (!result) {
      setError("No story found with that family code. Please check and try again.");
      return;
    }

    setFoundName(result.name || "this storyteller");
    setShowConfirm(true);
  };

  const canContinue = familyCode.trim().length > 0;

  return (
    <div className="relative min-h-[100dvh] flex flex-col px-6 safe-top safe-bottom pb-20">
      <SkyBackground />

      <div className="pt-14 pb-2">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 text-muted-foreground active:opacity-60 transition-opacity -ml-1 relative z-10"
        >
          <ArrowLeft className="size-5" /> <span className="text-[15px]">Back</span>
        </button>
      </div>

      <div className="pt-6 pb-2">
        <h1 className="text-3xl font-bold text-foreground">Follow a Story</h1>
        <p className="text-muted-foreground text-[15px] leading-relaxed mt-2">
          Enter a family code to find their story.
        </p>
      </div>

      <div className="space-y-3 mt-6 w-full max-w-sm mx-auto">
        <Input
          placeholder="Family Code (e.g. 7KQ4M2XD)"
          value={familyCode}
          onChange={(e) => {
            setFamilyCode(e.target.value.toUpperCase());
            setError("");
          }}
          className="h-13 text-[16px] rounded-xl bg-card/80 backdrop-blur-sm px-4 uppercase tracking-widest text-center font-mono"
          maxLength={9}
          onKeyDown={(e) => e.key === "Enter" && handleContinue()}
        />
        {error && (
          <p className="text-sm text-destructive text-center">{error}</p>
        )}
      </div>

      <div className="flex-1 min-h-8" />

      <div className="w-full max-w-sm mx-auto pb-10">
        <Button
          className="w-full h-13 text-base rounded-xl font-semibold"
          onClick={handleContinue}
          disabled={!canContinue || isSearching}
        >
          {isSearching ? (
            <>
              <Loader2 className="size-4 animate-spin mr-2" />
              Searching...
            </>
          ) : (
            "Continue"
          )}
        </Button>
      </div>

      <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
        <DialogContent className="max-w-[calc(100%-3rem)] rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-xl">Confirm</DialogTitle>
            <DialogDescription className="text-[15px] leading-relaxed pt-1">
              Would you like to follow <span className="font-semibold text-foreground">{foundName}</span>'s story?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 pt-2">
            <Button variant="outline" className="h-12 rounded-xl flex-1" onClick={() => setShowConfirm(false)}>
              Cancel
            </Button>
            <Button
              className="h-12 rounded-xl flex-1"
              onClick={() => navigate("/dashboard", { state: { familyCode, name: foundName } })}
            >
              Yes, Follow
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default FollowStory;
