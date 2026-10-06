import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { User, LogOut, Bell, Shield, HelpCircle, ChevronRight, Wrench, Copy, Check, BookOpen, FileText, Radio, HardDrive, Trash2, Loader2, AlertTriangle } from "lucide-react";
import { toast } from "sonner";
import SkyBackground from "@/components/SkyBackground";
import AppTabBar from "@/components/AppTabBar";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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
import { useAuth } from "@/lib/AuthProvider";
import { supabase } from "@/lib/supabase";
import { getProfile, getBooks } from "@/lib/database";

const CreatorProfile = () => {
  const navigate = useNavigate();
  const { user, signOut } = useAuth();
  const [adminMode, setAdminMode] = useState(
    () => localStorage.getItem("adminMode") === "true"
  );
  const [copied, setCopied] = useState(false);

  const { data: profile } = useQuery({
    queryKey: ["profile", user?.id],
    queryFn: () => getProfile(user!.id),
    enabled: !!user?.id,
  });

  const { data: books = [] } = useQuery({
    queryKey: ["books", user?.id],
    queryFn: () => getBooks(user!.id),
    enabled: !!user?.id,
  });

  const totalChapters = books.reduce(
    (sum, b) => sum + (b.chapters?.length ?? 0),
    0
  );

  const handleAdminToggle = (checked: boolean) => {
    setAdminMode(checked);
    localStorage.setItem("adminMode", String(checked));
    if (checked) {
      localStorage.removeItem("dismissedPrompts");
    }
  };

  const copyFamilyCode = async () => {
    if (!profile?.family_code) return;
    try {
      await navigator.clipboard.writeText(profile.family_code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const settingsItems = [
    { icon: Bell, label: "Notifications", type: "toggle" as const, key: "notifications" },
    { icon: Shield, label: "Privacy", type: "link" as const, key: "privacy" },
    { icon: HelpCircle, label: "Help & Support", type: "link" as const, key: "help" },
  ];

  return (
    <div className="min-h-[100dvh] relative flex flex-col">
      <SkyBackground />
      <header className="border-b bg-card/80 backdrop-blur-md safe-top">
        <div className="px-6 py-6 text-center">
          <h1 className="text-2xl font-bold text-foreground">Profile</h1>
          <p className="text-sm text-muted-foreground mt-1">Manage your account</p>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto pb-24">
        <div className="max-w-lg mx-auto w-full px-6 py-6 space-y-5">
          {/* Avatar & Name */}
          <div className="flex flex-col items-center gap-3">
            <div className="w-20 h-20 rounded-full bg-primary/10 border border-border/50 flex items-center justify-center">
              <User className="size-9 text-primary" />
            </div>
            <div className="text-center">
              <p className="text-lg font-semibold text-foreground">{user?.user_metadata?.full_name || "Storyteller"}</p>
              <p className="text-sm text-muted-foreground">{user?.email || "No email"}</p>
            </div>
          </div>

          {/* Family Code */}
          {profile?.family_code && (
            <div className="rounded-2xl bg-primary/5 border border-primary/20 p-4 space-y-2">
              <p className="text-xs font-semibold text-primary uppercase tracking-wide">Your Family Code</p>
              <div className="flex items-center justify-between">
                <p className="text-2xl font-mono font-bold tracking-[0.2em] text-foreground">{profile.family_code}</p>
                <Button variant="ghost" size="sm" className="rounded-lg gap-1.5" onClick={copyFamilyCode}>
                  {copied ? <Check className="size-4 text-green-500" /> : <Copy className="size-4" />}
                  {copied ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">Share this code with family so they can follow your story</p>
            </div>
          )}

          {/* Stats */}
          <div className="grid grid-cols-2 gap-3">
            <div className="rounded-2xl bg-card/80 backdrop-blur-sm border border-border/50 p-4 text-center shadow-sm">
              <BookOpen className="size-5 text-primary mx-auto mb-1" />
              <p className="text-2xl font-bold text-foreground">{books.length}</p>
              <p className="text-xs text-muted-foreground">Book{books.length !== 1 ? "s" : ""}</p>
            </div>
            <div className="rounded-2xl bg-card/80 backdrop-blur-sm border border-border/50 p-4 text-center shadow-sm">
              <FileText className="size-5 text-primary mx-auto mb-1" />
              <p className="text-2xl font-bold text-foreground">{totalChapters}</p>
              <p className="text-xs text-muted-foreground">Chapter{totalChapters !== 1 ? "s" : ""}</p>
            </div>
          </div>

          {/* Settings */}
          <div className="rounded-2xl bg-card/80 backdrop-blur-sm border border-border/50 overflow-hidden shadow-sm">
            {settingsItems.map((item) => (
              <div
                key={item.key}
                className="flex items-center justify-between px-5 py-4 border-b border-border/30"
              >
                <div className="flex items-center gap-3">
                  <item.icon className="size-5 text-muted-foreground" />
                  <span className="text-[15px] text-foreground">{item.label}</span>
                </div>
                {item.type === "toggle" ? (
                  <Switch />
                ) : (
                  <ChevronRight className="size-4 text-muted-foreground" />
                )}
              </div>
            ))}
            {/* Testing Mode */}
            <div className="flex items-center justify-between px-5 py-4">
              <div className="flex items-center gap-3">
                <Wrench className="size-5 text-muted-foreground" />
                <div>
                  <span className="text-[15px] text-foreground">Testing Mode</span>
                  <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">Device test tools, skip-survey, BLE diagnostics</p>
                </div>
              </div>
              <Switch checked={adminMode} onCheckedChange={handleAdminToggle} />
            </div>
          </div>

          {adminMode && <TestingPanel />}

          <Button
            variant="outline"
            className="w-full rounded-xl"
            onClick={() => window.open("https://mylegacytape.com", "_blank", "noopener,noreferrer")}
          >
            <Radio className="size-4 mr-2" />
            Buy a Device
          </Button>

          <Button
            variant="outline"
            className="w-full rounded-xl"
            onClick={async () => { await signOut(); navigate("/"); }}
          >
            <LogOut className="size-4 mr-2" />
            Sign Out
          </Button>
        </div>
      </div>

      <AppTabBar />
    </div>
  );
};

// ── Testing Mode panel ────────────────────────────────────────────────────────
// The device test loop is: reflash device → pair → onboard → record → verify →
// repeat. Every cycle needs the APP side wiped so pairing starts from zero;
// this panel is the one place to do that, and to see at a glance which account
// owns what. (The DEVICE side — its stored token + paired flag in NVS — is the
// firmware's to reset; the note at the bottom says so.)
const TestingPanel = () => {
  const { user } = useAuth();
  const qc = useQueryClient();
  const [busy, setBusy] = useState<"reset" | "clear" | null>(null);
  // Which destructive action is awaiting confirmation. NOT window.confirm():
  // WKWebView returns false from confirm() unless the native side implements a
  // UI delegate, and this app doesn't — so the old code silently did nothing.
  const [confirming, setConfirming] = useState<"reset" | "clear" | null>(null);

  const { data: device } = useQuery({
    queryKey: ["test-device", user?.id],
    queryFn: async () => {
      const { data } = await supabase
        .from("devices")
        .select("id, hardware_id, pairing_token, paired_at, onboarding_complete, chapter_mode, last_seen_at")
        .eq("user_id", user!.id)
        .order("paired_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return data;
    },
    enabled: !!user?.id,
    refetchInterval: 15_000, // keeps the "device active" warning honest
  });

  const { data: recCount = 0 } = useQuery({
    queryKey: ["test-rec-count", user?.id],
    queryFn: async () => {
      const { count } = await supabase
        .from("recordings")
        .select("id", { count: "exact", head: true })
        .eq("account_id", user!.id);
      return count ?? 0;
    },
    enabled: !!user?.id,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["test-device", user?.id] });
    qc.invalidateQueries({ queryKey: ["test-rec-count", user?.id] });
  };

  // Full teardown: WAVs, orphan chunks, recordings rows, devices row — the same
  // delete_device path "Remove this device" uses, so behavior can't drift.
  const resetDevice = async () => {
    if (!device) return;
    setConfirming(null);
    setBusy("reset");
    const { data, error } = await supabase.functions.invoke("delete_device", {
      body: { deviceId: device.id },
    });
    setBusy(null);
    if (error || !(data as { ok?: boolean })?.ok) {
      toast.error("Reset failed — check your connection and try again.");
      return;
    }
    toast.success(`${device.hardware_id} wiped. Reset the device, then scan its QR.`);
    refresh();
  };

  // Recordings only — keeps the pairing so record→verify→clear→record loops
  // don't need a device reset in between.
  const clearRecordings = async () => {
    if (!user) return;
    setConfirming(null);
    setBusy("clear");
    const { data: rows } = await supabase
      .from("recordings")
      .select("id, storage_path")
      .eq("account_id", user.id);
    const paths = (rows ?? []).map((r) => r.storage_path);
    if (paths.length) await supabase.storage.from("recordings").remove(paths);
    const { error } = await supabase.from("recordings").delete().eq("account_id", user.id);
    setBusy(null);
    if (error) { toast.error("Couldn't delete recordings."); return; }
    toast.success(`Deleted ${paths.length} recording${paths.length === 1 ? "" : "s"}.`);
    refresh();
  };

  const isAnon = !!user?.is_anonymous;
  // Resetting while the device is mid-take makes its upload/finalize calls 401
  // and loses the recording. last_seen_at is stamped by the device's config poll
  // (null until that lands on both sides), so this is a warning, not a lock.
  const activeRecently =
    !!device?.last_seen_at && Date.now() - new Date(device.last_seen_at).getTime() < 60_000;

  return (
    <div className="rounded-2xl bg-card/80 backdrop-blur-sm border border-primary/30 overflow-hidden shadow-sm">
      <div className="px-5 py-3 border-b border-border/30 bg-primary/5">
        <p className="text-[11px] font-semibold text-primary uppercase tracking-wide">Testing Mode</p>
      </div>

      {/* Who we are — the #1 cause of "paired to another account" */}
      <div className="px-5 py-3 border-b border-border/30 space-y-1">
        <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Signed in as</p>
        <p className="text-[14px] text-foreground font-medium">
          {user?.email ?? (isAnon ? "Anonymous session" : user?.id.slice(0, 8) + "…")}
        </p>
        {isAnon && (
          <p className="text-[12px] text-amber-700 flex items-start gap-1.5 leading-snug">
            <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
            Anonymous sessions can't keep a device across reinstalls. Sign out and sign in with a real test account.
          </p>
        )}
      </div>

      {/* What this account owns */}
      <div className="px-5 py-3 border-b border-border/30 space-y-1">
        <p className="text-[11px] text-muted-foreground uppercase tracking-wide">Device on this account</p>
        {device ? (
          <>
            <p className="text-[14px] text-foreground font-mono font-medium flex items-center gap-2">
              <HardDrive className="size-4 text-primary" /> {device.hardware_id}
            </p>
            <p className="text-[12px] text-muted-foreground">
              {device.onboarding_complete ? "Onboarded" : "Onboarding incomplete"} · {device.chapter_mode} · token {device.pairing_token.slice(0, 6)}… · {recCount} recording{recCount === 1 ? "" : "s"}
            </p>
          </>
        ) : (
          <p className="text-[14px] text-muted-foreground">None — scan a QR to pair.</p>
        )}
      </div>

      {/* Actions */}
      <div className="px-5 py-3 space-y-2">
        {activeRecently && (
          <p className="text-[12px] text-amber-700 flex items-start gap-1.5 leading-snug pb-1">
            <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
            Device was active in the last minute. Resetting mid-recording loses that take.
          </p>
        )}
        <Button
          variant="outline"
          className="w-full rounded-xl justify-start text-destructive border-destructive/30"
          disabled={!device || busy !== null}
          onClick={() => setConfirming("reset")}
        >
          {busy === "reset" ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Trash2 className="size-4 mr-2" />}
          Reset device for re-pair (wipe everything)
        </Button>
        <Button
          variant="outline"
          className="w-full rounded-xl justify-start"
          disabled={recCount === 0 || busy !== null}
          onClick={() => setConfirming("clear")}
        >
          {busy === "clear" ? <Loader2 className="size-4 mr-2 animate-spin" /> : <Trash2 className="size-4 mr-2" />}
          Clear recordings only (keep pairing)
        </Button>
        <p className="text-[11px] text-muted-foreground/80 leading-relaxed pt-1">
          Resets the app side only. The device must also drop its pairing — today that's an
          NVS wipe by the device dev (~2s); soon the device notices the removal and resets
          itself. Pairing in this mode skips the survey and offers a wipe if this account
          already paired the device; failed scans show a BLE trail.
        </p>
      </div>

      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming === "reset" ? `Wipe ${device?.hardware_id}?` : "Delete all recordings?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirming === "reset"
                ? `All recordings, transcripts and the pairing for ${device?.hardware_id} will be deleted. The device itself still needs its own reset before it can pair again.`
                : `All ${recCount} recording${recCount === 1 ? "" : "s"} on this account will be deleted. The device stays paired.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => { e.preventDefault(); confirming === "reset" ? resetDevice() : clearRecordings(); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {confirming === "reset" ? "Wipe device" : "Delete recordings"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default CreatorProfile;
