import { useState, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import {
  ArrowLeft,
  Camera,
  CheckCircle2,
  Loader2,
  Wifi,
  WifiOff,
  AlertCircle,
  ChevronRight,
  User,
  Users,
  Copy,
  Check,
  Heart,
  RefreshCw,
  Wrench,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import SkyBackground from "@/components/SkyBackground";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/lib/AuthProvider";
import { getQuestions, QUESTION_IDS } from "@/lib/onboardingQuestions";
import { getProfile } from "@/lib/database";

// Status bytes from the device's BLE status characteristic.
const STATUS_LABEL: Record<number, string> = {
  0x01: "Validating token…",
  0x02: "Joining WiFi…",
};

const ERROR_MESSAGE: Record<number, string> = {
  0xe1: "Token mismatch — please re-scan the QR code.",
  0xe2: "Device couldn't read the payload — please try again.",
  0xe3: "Wrong WiFi password or network unreachable.",
  0xe4: "Device error — please try again.",
};

// State machine (WiFi is scan-and-pick only — no manual SSID entry):
// setupFor → bleConnecting ─┬─ wifiList (pick / rescan) → passwordEntry ─┐
//                           └─ bleFailed (scan again) ───────────────────┤
//                                                          ↓ (other: secondaryWifi →)
//                                       saving → pairing → wifiConnecting
//                                            → personInfo → chapterMode → survey
//                                            → completing → done
// Re-pair (already onboarded) routes 0x03 → welcomeBack instead.
type Step =
  | "idle"
  | "testWipe"
  | "setupFor"
  | "bleConnecting"
  | "bleFailed"
  | "wifiList"
  | "passwordEntry"
  | "secondaryWifi"
  | "saving"
  | "pairing"
  | "wifiConnecting"
  | "welcomeBack"
  | "personInfo"
  | "chapterMode"
  | "survey"
  | "completing"
  | "done"
  | "error";

interface QRData {
  hardwareId: string;
  token: string;
}

interface WifiNetwork {
  ssid: string;
  rssi: number;
}

declare global {
  interface Window {
    __nativePairingBridge?: boolean;
    __pairingBridge?: {
      startQRScan: () => void;
      connectBLE: (opts: { hardwareId: string }) => void;
      pair: (opts: {
        hardwareId: string;
        token: string;
        ssid: string;
        pw: string;
        ssid2?: string;
        pw2?: string;
        acct: string;
      }) => void;
      cancel: () => void;
    };
    __onQRResult?: (data: QRData) => void;
    __onQRError?: (msg: string) => void;
    __onPairingStatus?: (byte: number) => void;
    __onWifiListRaw?: (raw: string, bytes: number) => void;
    /** BLE handshake progress from PairingBridge.swift (Testing Mode diagnostics). */
    __onBleStage?: (stage: string, detail: string) => void;
    __pendingPairingQR?: QRData;
  }
}

/** One BLE handshake step, kept for the on-screen trail in Testing Mode. */
interface BleStage {
  t: number;      // ms since the scan began
  stage: string;
  detail: string;
}

// ── WiFi signal-strength indicator ─────────────────────────────────────────────
const WifiSignal = ({ rssi }: { rssi: number }) => {
  const bars = rssi > -50 ? 4 : rssi > -60 ? 3 : rssi > -70 ? 2 : 1;
  return (
    <div className="flex items-end gap-[2px] h-[16px] shrink-0">
      {[1, 2, 3, 4].map((b) => (
        <div
          key={b}
          className={`w-1 rounded-sm ${b <= bars ? "bg-primary" : "bg-muted-foreground/25"}`}
          style={{ height: `${b * 22 + 12}%` }}
        />
      ))}
    </div>
  );
};

// ── Shared layout shell ────────────────────────────────────────────────────────

const Shell = ({
  children,
  showBack,
  onBack,
}: {
  children: React.ReactNode;
  showBack?: boolean;
  onBack?: () => void;
}) => (
  <div className="relative flex min-h-[100dvh] flex-col px-6 safe-top safe-bottom">
    <SkyBackground />
    {showBack && (
      <div className="pt-14 pb-2">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-muted-foreground active:opacity-60 transition-opacity -ml-1"
          aria-label="Go back"
        >
          <ArrowLeft className="size-5" aria-hidden="true" />
          <span className="text-[15px]">Back</span>
        </button>
      </div>
    )}
    <div className={`flex-1 flex flex-col ${showBack ? "pt-2" : "pt-14"} pb-6`}>
      {children}
    </div>
  </div>
);

// ── Main component ─────────────────────────────────────────────────────────────

const DeviceSetup = () => {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [step, setStep] = useState<Step>("idle");
  const [qrData, setQrData] = useState<QRData | null>(null);

  // Who is this for?
  const [setupForValue, setSetupForValue] = useState<"self" | "other" | null>(null);

  // WiFi network list (from device BLE scan) and the user's selection
  const [wifiNetworks, setWifiNetworks] = useState<WifiNetwork[]>([]);
  // Admin-only diagnostic on the last WiFi-list payload received over BLE.
  const [wifiDebug, setWifiDebug] = useState<
    { bytes: number; count: number; parsed: boolean; sample: string } | null
  >(null);
  const [selectedSsid, setSelectedSsid] = useState("");

  // Primary WiFi
  const [ssid, setSsid] = useState("");
  const [pw, setPw] = useState("");

  // Optional secondary WiFi (other path)
  const [ssid2, setSsid2] = useState("");
  const [pw2, setPw2] = useState("");

  // BLE status feedback
  const [statusLabel, setStatusLabel] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  // Inline error shown above the password field when device rejects WiFi creds.
  const [wifiError, setWifiError] = useState("");

  // True if the QR-scanned device is already onboarded for this user, in which
  // case 0x03 skips the survey/personInfo screens and jumps to `done`.
  const [isRePair, setIsRePair] = useState(false);
  const isRePairRef = useRef(false);

  // Post-pairing onboarding state
  const [subjectName, setSubjectName] = useState("");
  const [subjectDob, setSubjectDob] = useState("");
  // Chapter advance mode: 'manual' (user switches) or 'auto' (every N minutes).
  // The device polls device_config to learn this; also changeable later in
  // Manage Device settings.
  const [chapterMode, setChapterMode] = useState<"manual" | "auto">("manual");
  // Pronouns for the AI interviewer's brain (avoids awkward "their" for one person).
  const [pronouns, setPronouns] = useState<"he" | "she" | "they" | null>(null);
  // Gift path: does the subject answer themselves, or does the helper relay?
  // Drives 2nd- vs 3rd-person framing in the brain. Always true on the self path.
  const [subjectSpeaks, setSubjectSpeaks] = useState(true);
  const [chapterAutoMinutes, setChapterAutoMinutes] = useState(10);
  const [surveyAnswers, setSurveyAnswers] = useState<string[]>(Array(10).fill(""));
  const [surveyIndex, setSurveyIndex] = useState(0);

  // Family code shown on the done screen for the "other" path so the setter
  // can share it with relatives who want to follow the loved one's stories.
  const [familyCode, setFamilyCode] = useState<string>("");
  const [copiedCode, setCopiedCode] = useState(false);

  // Keep a ref to setupForValue so the BLE callback closure can read it.
  const setupForRef = useRef<"self" | "other" | null>(null);
  // Refs read inside the (mount-once) BLE status callback so the latest values
  // are visible without stale closures.
  const wifiNetworksRef = useRef<WifiNetwork[]>([]);
  // The diagnostics inserts read the hardware id from here, not from `qrData`
  // state — the callbacks are defined in a mount-once effect and would
  // otherwise close over the pre-scan null forever (every May row had
  // hardware_id: null for exactly this reason).
  const qrDataRef = useRef<QRData | null>(null);

  // Testing Mode: BLE handshake trail for the current scan attempt.
  const [bleStages, setBleStages] = useState<BleStage[]>([]);
  const scanStartRef = useRef<number>(0);
  // Testing Mode: a devices row this account already owns for the scanned
  // hardware id (offered for a wipe before re-pairing).
  const [existingTestDevice, setExistingTestDevice] = useState<
    { id: string; token: string; onboarded: boolean } | null
  >(null);
  const [wiping, setWiping] = useState(false);

  const hasNative = !!window.__nativePairingBridge;
  // Admin mode is toggled from CreatorProfile and persisted in localStorage.
  // When on, exposes a "Skip" button on the post-pair survey screens so we
  // don't have to slog through 10 questions on every test reflash.
  const isAdmin =
    typeof window !== "undefined" &&
    window.localStorage.getItem("adminMode") === "true";

  const handleSkipOnboarding = async () => {
    if (!qrData) return;
    setStep("completing");
    await supabase
      .from("devices")
      .update({
        setup_for: setupForValue ?? "self",
        subject_name: subjectName.trim() || "Test User",
        subject_dob: subjectDob || null,
        survey_answers: {},
        pronouns: pronouns,
        subject_speaks: setupForValue === "other" ? subjectSpeaks : true,
        chapter_mode: chapterMode,
        chapter_auto_minutes: chapterAutoMinutes,
        onboarding_complete: true,
      })
      .eq("hardware_id", qrData.hardwareId);
    setStep("done");
  };

  // ── Native → JS callbacks ─────────────────────────────────────────────────

  // Detect re-pair: if this hardware_id already has a completed onboarding for
  // this user, mark the flow so we skip the survey/personInfo screens and avoid
  // overwriting their existing answers. Bypassed in admin mode so every test
  // cycle runs the full flow without having to clear the devices row first.
  const checkExistingDevice = async (hardwareId: string) => {
    if (!user) return;
    if (isAdmin) {
      // Testing Mode never takes the "Welcome back" shortcut — every cycle runs
      // the full flow. But if this account already owns the row, offer to wipe
      // it (recordings + storage + row) first so the cycle starts from zero.
      setIsRePair(false);
      const { data } = await supabase
        .from("devices")
        .select("id, pairing_token, onboarding_complete")
        .eq("hardware_id", hardwareId)
        .eq("user_id", user.id)
        .maybeSingle();
      if (data) {
        setExistingTestDevice({ id: data.id, token: data.pairing_token, onboarded: data.onboarding_complete });
        // Only redirect if the user hasn't already moved past the first screen.
        setStep((cur) => (cur === "setupFor" ? "testWipe" : cur));
      }
      return;
    }
    const { data } = await supabase
      .from("devices")
      .select("onboarding_complete, setup_for, subject_name, subject_dob")
      .eq("hardware_id", hardwareId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (data?.onboarding_complete) {
      setIsRePair(true);
      // Pre-populate so the done screen renders the right "X's stories" copy.
      if (data.setup_for) setSetupForValue(data.setup_for as "self" | "other");
      if (data.subject_name) setSubjectName(data.subject_name);
      if (data.subject_dob) setSubjectDob(data.subject_dob);
    } else {
      setIsRePair(false);
    }
  };

  useEffect(() => {
    window.__onQRResult = (data: QRData) => {
      qrDataRef.current = data;
      setQrData(data);
      setStep("setupFor");
      checkExistingDevice(data.hardwareId);
    };

    // BLE handshake trail, shown in Testing Mode so a failed pairing shows how
    // far it got without a serial cable on the device.
    window.__onBleStage = (stage: string, detail: string) => {
      if (stage === "scan_begin") scanStartRef.current = Date.now();
      const t = scanStartRef.current ? Date.now() - scanStartRef.current : 0;
      const entry: BleStage = { t, stage, detail };
      setBleStages((prev) => (stage === "scan_begin" ? [entry] : [...prev, entry]));
    };

    window.__onQRError = (msg: string) => {
      if (msg === "cancelled") return;
      setErrorMessage(msg);
      setStep("error");
    };

    window.__onPairingStatus = (byte: number) => {
      if (byte === 0x03) {
        // Re-pair: route through the "Welcome back" confirmation so the user
        // can choose to skip the survey or re-run it. Admin mode skips this
        // (checkExistingDevice already disables isRePair under admin), and
        // first pairs go straight to personInfo as before. The
        // onboarding_complete=true write for "pick up where we left off"
        // happens in the effect below when step flips to "done".
        setStep(isRePairRef.current ? "welcomeBack" : "personInfo");
        return;
      }
      // Wrong WiFi password — back to the password screen for the picked network.
      if (byte === 0xe3) {
        setWifiError(ERROR_MESSAGE[0xe3]);
        setPw("");
        setStep("passwordEntry");
        return;
      }
      if (byte >= 0xe0) {
        setErrorMessage(ERROR_MESSAGE[byte] ?? "Unknown device error.");
        setStep("error");
        return;
      }
      const label = STATUS_LABEL[byte];
      if (label) {
        setStatusLabel(label);
        setStep(byte === 0x01 ? "pairing" : "wifiConnecting");
      }
    };

    // WiFi list from the device — raw JSON string + byte count. We parse here
    // (in JS) so a truncated/invalid BLE payload is caught instead of silently
    // becoming an empty list. Always go to the picker; empty/parse-fail shows
    // the "no networks found / rescan" state. Debug info is surfaced in admin.
    window.__onWifiListRaw = (raw: string, bytes: number) => {
      let nets: WifiNetwork[] = [];
      let parsed = false;
      try {
        const p = JSON.parse(raw);
        if (Array.isArray(p)) { nets = p as WifiNetwork[]; parsed = true; }
      } catch { /* truncated / invalid */ }
      setWifiDebug({ bytes, count: nets.length, parsed, sample: raw.slice(0, 80) });
      setWifiNetworks(nets);
      // Only land on / stay on the picker while we're still choosing. A late
      // poll result must not yank the user back from passwordEntry etc.; it
      // just refreshes the cached list.
      setStep((cur) => (cur === "bleConnecting" || cur === "wifiList" ? "wifiList" : cur));
    };

    // Deep-link QR that arrived before this page mounted.
    if (window.__pendingPairingQR) {
      const pending = window.__pendingPairingQR;
      delete window.__pendingPairingQR;
      qrDataRef.current = pending;
      setQrData(pending);
      setStep("setupFor");
      checkExistingDevice(pending.hardwareId);
    }

    return () => {
      delete window.__onQRResult;
      delete window.__onQRError;
      delete window.__onPairingStatus;
      delete window.__onWifiListRaw;
      delete window.__onBleStage;
    };
  }, []);

  // Fallback: if bleConnecting doesn't get a WiFi list within 6s, surface a soft
  // failure screen with retry instead of silently dumping the user into manual
  // SSID entry — that jump used to feel like the app broke mid-flow.
  // 10s, comfortably past the device's WiFi scan (~3s) + its 5s scan-stall
  // self-timeout + BLE notify latency, so a slightly slow scan resolves to the
  // picker instead of briefly flashing "Scan Again".
  useEffect(() => {
    if (step !== "bleConnecting") return;
    const t = setTimeout(() => setStep("bleFailed"), 10000);
    return () => clearTimeout(t);
  }, [step]);

  // Keep refs in sync with state for stable callbacks.
  useEffect(() => { setupForRef.current = setupForValue; }, [setupForValue]);
  useEffect(() => { wifiNetworksRef.current = wifiNetworks; }, [wifiNetworks]);
  useEffect(() => { isRePairRef.current = isRePair; }, [isRePair]);

  // On re-pair, restore onboarding_complete=true once we reach the done screen.
  // handlePair's upsert always clears the flag so the firmware doesn't skip the
  // survey on a fresh pair; for re-pairs we have to put it back since
  // handleComplete (which normally sets it) is skipped.
  useEffect(() => {
    if (step === "done" && isRePair && qrData) {
      supabase
        .from("devices")
        .update({ onboarding_complete: true })
        .eq("hardware_id", qrData.hardwareId)
        .then(() => {});
    }
  }, [step, isRePair, qrData]);

  // ── Actions ───────────────────────────────────────────────────────────────

  // Testing Mode: tear down this account's previous pairing of the scanned
  // device — WAV files, orphan chunks, recordings rows, devices row — via the
  // same delete_device function "Remove this device" uses, then continue into a
  // clean first-time pairing. The device must be reset too, since it still
  // holds the old token.
  const wipeTestDevice = async () => {
    if (!existingTestDevice || !qrData) return;
    setWiping(true);
    const { data, error } = await supabase.functions.invoke("delete_device", {
      body: { deviceId: existingTestDevice.id },
    });
    setWiping(false);
    if (error || !(data as { ok?: boolean })?.ok) {
      setErrorMessage("Couldn't wipe the previous pairing. Check your connection and try again.");
      setStep("error");
      return;
    }
    setExistingTestDevice(null);
    setStep("setupFor");
  };

  const handleScan = () => {
    if (hasNative) {
      window.__pairingBridge!.startQRScan();
    } else {
      setTimeout(() => {
        setQrData({ hardwareId: "LT-A1B2C3", token: "8c4a7b9e6f1d2a3b5c4d6e7f8a9b0c1d" });
        setStep("setupFor");
      }, 600);
    }
  };

  const handleConnectBLE = (hwId: string) => {
    setStep("bleConnecting");
    if (hasNative) {
      window.__pairingBridge!.connectBLE({ hardwareId: hwId });
    } else {
      // Preview simulation — show a realistic network list after a short delay.
      setTimeout(() => {
        setWifiNetworks([
          { ssid: "MyHomeNetwork", rssi: -42 },
          { ssid: "iPhone Hotspot", rssi: -58 },
          { ssid: "Neighbors_5G", rssi: -71 },
          { ssid: "xfinitywifi", rssi: -78 },
        ]);
        setStep("wifiList");
      }, 1800);
    }
  };

  const handlePair = async () => {
    if (!qrData || !user) return;
    setStep("saving");

    // Reset onboarding_complete on every pair attempt — the firmware polls
    // device_status RPC and transitions Screen1→Screen2 the instant it sees
    // `true`. If a previous test left the flag set, the device would jump past
    // the survey before the user even sees it.
    //
    // Two writes, deliberately:
    //   1. An explicit UPDATE first — guaranteed to run even if some quirk of
    //      upsert's conflict resolution skips listed fields (RLS edge case,
    //      Postgrest version drift, etc.). Idempotent if the row doesn't exist.
    //   2. Then the upsert, which creates the row if missing and writes all
    //      the pair-time fields atomically.
    //
    // isRePair (read pre-upsert in checkExistingDevice) preserves the "skip
    // the survey" intent in component state — we write the flag back to true
    // after re-pair done, via the effect that watches step + isRePair.
    await supabase
      .from("devices")
      .update({ onboarding_complete: false })
      .eq("hardware_id", qrData.hardwareId);

    const { error: dbError } = await supabase.from("devices").upsert(
      {
        user_id: user.id,
        hardware_id: qrData.hardwareId,
        pairing_token: qrData.token,
        wifi_ssid: ssid,
        onboarding_complete: false,
      },
      { onConflict: "hardware_id" }
    );

    if (dbError) {
      // 42501 = the row for this hardware_id exists and RLS says we don't own it.
      // Only the owning account can release it (My Device → Remove this device).
      // In Testing Mode say WHO we are, so a wrong-account session is obvious
      // instead of looking like a device problem.
      const who = user.email ?? (user.is_anonymous ? "an anonymous session" : user.id.slice(0, 8) + "…");
      setErrorMessage(
        dbError.code === "42501"
          ? isAdmin
            ? `This device is paired to a different account. You're signed in as ${who}. ` +
              `Sign in as the account that paired it and use My Device → Remove this device, or ask the app dev to release it.`
            : "This device is already paired to another account."
          : "Could not save device — check your connection and try again."
      );
      setStep("error");
      return;
    }

    if (hasNative) {
      setStatusLabel("Connecting to device…");
      setStep("pairing");
      window.__pairingBridge!.pair({
        hardwareId: qrData.hardwareId,
        token: qrData.token,
        ssid,
        pw,
        ...(ssid2.trim() && pw2.trim() ? { ssid2: ssid2.trim(), pw2: pw2.trim() } : {}),
        acct: user.id,
      });
    } else {
      // Preview simulation.
      setStatusLabel("Validating token…");
      setStep("pairing");
      await new Promise((r) => setTimeout(r, 1000));
      setStatusLabel("Joining WiFi…");
      setStep("wifiConnecting");
      await new Promise((r) => setTimeout(r, 1500));
      setStep(isRePair ? "welcomeBack" : "personInfo");
    }
  };

  // "Welcome back" actions — only reachable when isRePair && !isAdmin.
  const handleRePairResume = () => {
    // Existing subject_name / survey_answers stay untouched on the row.
    // Effect on step="done" + isRePair=true re-sets onboarding_complete=true.
    setStep("done");
  };

  const handleRePairRestart = () => {
    // Treat this as a fresh setup: drop the re-pair flag so we no longer
    // short-circuit, clear cached subject data so personInfo starts blank,
    // and run the normal personInfo → survey → handleComplete path. The
    // upsert in handlePair already cleared onboarding_complete to false,
    // so the device firmware will keep waiting on the pairing screen until
    // handleComplete writes true after the new survey.
    setIsRePair(false);
    setSubjectName("");
    setSubjectDob("");
    setSurveyAnswers(Array(10).fill(""));
    setSurveyIndex(0);
    setStep("personInfo");
  };

  const handleComplete = async () => {
    if (!qrData || !user) return;
    setStep("completing");

    // Key survey_answers by stable semantic id (hometown, family, …) so the AI
    // interviewer prompts against named fields rather than positional q1..q10.
    const surveyMap: Record<string, string> = {};
    QUESTION_IDS.forEach((id, i) => {
      surveyMap[id] = surveyAnswers[i] ?? "";
    });

    await supabase
      .from("devices")
      .update({
        setup_for: setupForValue,
        subject_name: subjectName.trim() || null,
        subject_dob: subjectDob || null,
        survey_answers: surveyMap,
        pronouns: pronouns,
        subject_speaks: setupForValue === "other" ? subjectSpeaks : true,
        chapter_mode: chapterMode,
        chapter_auto_minutes: chapterAutoMinutes,
        onboarding_complete: true,
      })
      .eq("hardware_id", qrData.hardwareId);

    // Pull the user's family_code so the "for someone else" done screen can
    // surface it as the share/follow code. ensureProfile() inside getProfile()
    // creates one on the fly if this account doesn't have a profile row yet.
    if (setupForValue === "other") {
      const profile = await getProfile(user.id);
      if (profile?.family_code) setFamilyCode(profile.family_code);
    }

    setStep("done");
  };

  const copyFamilyCode = async () => {
    if (!familyCode) return;
    try {
      await navigator.clipboard.writeText(familyCode);
    } catch {
      // Native WKWebView may reject clipboard.writeText; the visual feedback
      // still fires so the user sees the action register.
    }
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleReset = () => {
    window.__pairingBridge?.cancel();
    setStep("idle");
    setQrData(null);
    setSetupForValue(null);
    setWifiNetworks([]);
    setSelectedSsid("");
    setSsid("");
    setPw("");
    setSsid2("");
    setPw2("");
    setErrorMessage("");
    setStatusLabel("");
    setWifiError("");
    setIsRePair(false);
    setSubjectName("");
    setSubjectDob("");
    setChapterMode("manual");
    setPronouns(null);
    setSubjectSpeaks(true);
    setChapterAutoMinutes(10);
    setSurveyAnswers(Array(10).fill(""));
    setSurveyIndex(0);
  };

  // ── Screens ───────────────────────────────────────────────────────────────

  // Done
  if (step === "done") {
    const isOther = setupForValue === "other";
    const subject = subjectName.trim() || (isOther ? "your loved one" : "you");

    return (
      <Shell>
        <div className="flex-1 flex flex-col items-center text-center pt-6">
          <div className="w-20 h-20 rounded-full bg-green-500/20 flex items-center justify-center mb-4">
            <CheckCircle2 className="size-10 text-green-500" aria-hidden="true" />
          </div>
          <h1 className="text-3xl font-bold text-foreground">
            {isRePair ? "Device Reconnected!" : "Device Ready!"}
          </h1>
          <p className="text-muted-foreground text-[15px] leading-relaxed max-w-[280px] mx-auto mt-2">
            {isRePair
              ? `${isOther ? subject + "'s" : "Your"} LegacyTape is back online and ready to record.`
              : isOther
              ? `${subject}'s LegacyTape is set up and ready to capture their story.`
              : "Your LegacyTape recorder is set up and ready to capture your story."}
          </p>

          {isOther && familyCode && !isRePair && (
            <div className="w-full max-w-sm mt-8 rounded-2xl bg-primary/5 border border-primary/20 p-4 space-y-2 text-left">
              <p className="text-[12px] font-semibold text-primary uppercase tracking-wide">
                Follow {subject}'s stories
              </p>
              <div className="flex items-center justify-between gap-3">
                <p className="text-2xl font-mono font-bold tracking-[0.2em] text-foreground">
                  {familyCode}
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="rounded-lg gap-1.5 shrink-0"
                  onClick={copyFamilyCode}
                  aria-label={copiedCode ? "Family code copied" : "Copy family code"}
                >
                  {copiedCode ? (
                    <Check className="size-4 text-green-500" aria-hidden="true" />
                  ) : (
                    <Copy className="size-4" aria-hidden="true" />
                  )}
                  {copiedCode ? "Copied" : "Copy"}
                </Button>
              </div>
              <p className="text-[12px] text-muted-foreground leading-relaxed">
                Share this code with family members so they can follow {subject}'s
                stories from their own phone.
              </p>
            </div>
          )}

          <div className="w-full max-w-sm mt-6 space-y-2">
            {isOther ? (
              <>
                <Button
                  className="w-full h-13 text-base rounded-xl font-semibold gap-2"
                  onClick={() =>
                    navigate("/dashboard", {
                      state: {
                        creatorUserId: user?.id,
                        name: subject,
                      },
                    })
                  }
                >
                  <Heart className="size-4" />
                  Follow {subject}'s Stories
                </Button>
                <button
                  className="w-full text-[14px] text-muted-foreground py-3 active:opacity-60 transition-opacity"
                  onClick={() => navigate("/manage-device")}
                >
                  Manage Device
                </button>
              </>
            ) : (
              <Button
                className="w-full h-13 text-base rounded-xl font-semibold"
                onClick={() => navigate("/manage-device")}
              >
                Manage My Device
              </Button>
            )}
          </div>
        </div>
      </Shell>
    );
  }

  // Error
  if (step === "error") {
    return (
      <Shell>
        <div className="flex-1 flex flex-col items-center justify-center text-center">
          <div className="w-20 h-20 rounded-full bg-red-500/20 flex items-center justify-center mb-5">
            <AlertCircle className="size-10 text-red-500" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">Something Went Wrong</h1>
          <p className="text-muted-foreground text-[15px] leading-relaxed max-w-[280px] mx-auto mt-2">
            {errorMessage}
          </p>
          <Button
            className="mt-8 h-13 px-8 text-base rounded-xl font-semibold"
            onClick={handleReset}
          >
            Try Again
          </Button>
        </div>
      </Shell>
    );
  }

  // bleConnecting spinner — waiting for WiFi list from the device
  if (step === "bleConnecting") {
    return (
      <Shell>
        <div className="flex-1 flex flex-col items-center justify-center text-center">
          <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mb-5">
            <Wifi className="size-10 text-primary animate-pulse" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">Connecting…</h1>
          <p className="text-muted-foreground text-[15px] mt-2">
            Scanning for nearby WiFi networks
          </p>
        </div>
      </Shell>
    );
  }

  // Spinner states (saving → pairing → wifiConnecting → completing)
  if (
    step === "saving" ||
    step === "pairing" ||
    step === "wifiConnecting" ||
    step === "completing"
  ) {
    const label =
      step === "saving"
        ? "Registering device…"
        : step === "completing"
        ? "Finishing setup…"
        : statusLabel;

    return (
      <Shell>
        <div className="flex-1 flex flex-col items-center justify-center text-center">
          <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mb-5">
            <Loader2 className="size-10 text-primary animate-spin" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">
            {step === "completing" ? "Setting Up…" : "Pairing…"}
          </h1>
          <p className="text-muted-foreground text-[15px] mt-2">{label}</p>
          {(step === "pairing" || step === "wifiConnecting") && (
            <div className="flex gap-2 mt-6">
              {(["pairing", "wifiConnecting"] as Step[]).map((s, i) => (
                <div
                  key={s}
                  className={`h-1.5 w-10 rounded-full transition-colors duration-300 ${
                    (step === "pairing" && i === 0) || step === "wifiConnecting"
                      ? "bg-primary"
                      : "bg-muted"
                  }`}
                />
              ))}
            </div>
          )}
        </div>
      </Shell>
    );
  }

  // Survey
  if (step === "survey") {
    const questions = getQuestions(setupForValue ?? "self", subjectName);
    const current = questions[surveyIndex];
    const isLast = surveyIndex === questions.length - 1;
    const currentAnswer = surveyAnswers[surveyIndex] ?? "";

    const handleSurveyBack = () => {
      if (surveyIndex > 0) {
        setSurveyIndex((i) => i - 1);
      } else {
        setStep("chapterMode");
      }
    };

    const handleSurveyNext = () => {
      if (isLast) {
        handleComplete();
      } else {
        setSurveyIndex((i) => i + 1);
      }
    };

    return (
      <Shell showBack onBack={handleSurveyBack}>
        <div className="flex flex-col flex-1">
          {/* Progress */}
          <div className="mb-6">
            <div className="flex justify-between text-[12px] text-muted-foreground mb-1.5">
              <span>Question {surveyIndex + 1} of {questions.length}</span>
              <span>{Math.round(((surveyIndex + 1) / questions.length) * 100)}%</span>
            </div>
            <div className="h-1 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300"
                style={{ width: `${((surveyIndex + 1) / questions.length) * 100}%` }}
              />
            </div>
          </div>

          <div className="flex-1">
            <p className="text-[13px] font-medium text-primary uppercase tracking-wide mb-3">
              {setupForValue === "other" ? `About ${subjectName || "them"}` : "About You"}
            </p>
            <h2 className="text-xl font-bold text-foreground leading-snug mb-8">{current}</h2>
            <Input
              placeholder="Your answer…"
              value={currentAnswer}
              onChange={(e) => {
                const updated = [...surveyAnswers];
                updated[surveyIndex] = e.target.value;
                setSurveyAnswers(updated);
              }}
              className="rounded-xl"
              autoFocus
            />
          </div>

          <Button
            className="w-full h-13 text-base rounded-xl font-semibold mt-6"
            onClick={handleSurveyNext}
            disabled={!currentAnswer.trim()}
          >
            {isLast ? "Finish" : "Next"}
            {!isLast && <ChevronRight className="size-4 ml-1" />}
          </Button>
          {isAdmin && (
            <button
              className="w-full text-[12px] text-muted-foreground/70 py-3 mt-1 active:opacity-60 transition-opacity"
              onClick={handleSkipOnboarding}
            >
              Skip onboarding (admin)
            </button>
          )}
        </div>
      </Shell>
    );
  }

  // Welcome back — shown when the device is already onboarded for this user.
  // Lets them pick up where they left off (default, muscle-memory case) or
  // start fresh (re-run personInfo + survey, overwrite existing answers).
  if (step === "welcomeBack") {
    const isOther = setupForValue === "other";
    const subject = subjectName.trim() || (isOther ? "your loved one" : "you");
    return (
      <Shell>
        <div className="flex-1 flex flex-col items-center text-center pt-6">
          <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mb-4">
            <Heart className="size-10 text-primary" aria-hidden="true" />
          </div>
          <h1 className="text-3xl font-bold text-foreground">Welcome back</h1>
          <p className="text-muted-foreground text-[15px] leading-relaxed max-w-[280px] mx-auto mt-2">
            {qrData?.hardwareId} is already set up
            {isOther ? ` for ${subject}` : ""}. What would you like to do?
          </p>

          <div className="w-full max-w-sm mt-8 space-y-3">
            <Button
              className="w-full h-13 text-base rounded-xl font-semibold"
              onClick={handleRePairResume}
              autoFocus
              aria-label="Pick up where we left off"
            >
              Pick up where we left off
            </Button>
            <button
              className="w-full bg-card/80 backdrop-blur-sm border border-border/60 rounded-2xl p-4 text-left active:opacity-70 transition-opacity"
              onClick={handleRePairRestart}
              aria-label="Start fresh with a new survey"
            >
              <p className="font-semibold text-foreground">Start fresh</p>
              <p className="text-muted-foreground text-[13px] mt-0.5">
                Re-do the questions and overwrite the existing answers.
              </p>
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  // Person info (name + DOB) — only path; sync option removed.
  if (step === "personInfo") {
    const isOther = setupForValue === "other";
    // For self, device is already paired by this point — back would force a
    // re-pair, so we hide it. Other path can step back to the secondary WiFi.
    return (
      <Shell showBack={isOther} onBack={isOther ? () => setStep("secondaryWifi") : undefined}>
        <div className="flex flex-col flex-1">
          <div className="mb-6">
            <p className="text-[13px] font-medium text-primary uppercase tracking-wide mb-1">
              {isOther ? "About the recipient" : "About you"}
            </p>
            <h1 className="text-2xl font-bold text-foreground leading-snug">
              {isOther
                ? "Tell us about them"
                : "A little about you"}
            </h1>
            <p className="text-muted-foreground text-[14px] mt-1">
              {isOther
                ? "This helps the AI interviewer ask the right questions."
                : "This personalizes your recording experience."}
            </p>
          </div>

          <div className="space-y-4 flex-1">
            <div>
              <label className="text-[13px] font-medium text-muted-foreground mb-1.5 block">
                {isOther ? "Their name" : "Your name"}
              </label>
              <Input
                placeholder={isOther ? "e.g. Margaret" : "e.g. John"}
                value={subjectName}
                onChange={(e) => setSubjectName(e.target.value)}
                className="rounded-xl"
                autoCorrect="off"
              />
            </div>
            <div>
              <label className="text-[13px] font-medium text-muted-foreground mb-1.5 block">
                {isOther ? "Their date of birth" : "Your date of birth"}
                <span className="text-muted-foreground/60 ml-1">(optional)</span>
              </label>
              <Input
                type="date"
                value={subjectDob}
                onChange={(e) => setSubjectDob(e.target.value)}
                className="rounded-xl"
                max={new Date().toISOString().split("T")[0]}
              />
            </div>
            <div>
              <label className="text-[13px] font-medium text-muted-foreground mb-1.5 block">
                {isOther ? "Their pronouns" : "Your pronouns"}
                <span className="text-muted-foreground/60 ml-1">(optional)</span>
              </label>
              <div className="flex gap-2">
                {([
                  { v: "he", label: "He/him" },
                  { v: "she", label: "She/her" },
                  { v: "they", label: "They/them" },
                ] as const).map((opt) => (
                  <button
                    key={opt.v}
                    type="button"
                    onClick={() => setPronouns(pronouns === opt.v ? null : opt.v)}
                    aria-pressed={pronouns === opt.v}
                    className={`flex-1 px-3 py-2.5 rounded-xl text-[14px] font-medium transition-all ${
                      pronouns === opt.v
                        ? "bg-primary/10 text-primary border border-primary"
                        : "bg-card/80 text-muted-foreground border border-border/60"
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
            {isOther && (
              <div>
                <label className="text-[13px] font-medium text-muted-foreground mb-1.5 block">
                  Who answers the questions?
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setSubjectSpeaks(true)}
                    aria-pressed={subjectSpeaks}
                    className={`flex-1 px-3 py-2.5 rounded-xl text-[13px] font-medium transition-all ${
                      subjectSpeaks
                        ? "bg-primary/10 text-primary border border-primary"
                        : "bg-card/80 text-muted-foreground border border-border/60"
                    }`}
                  >
                    {subjectName.trim() || "They"} answer{subjectName.trim() ? "s" : ""}
                  </button>
                  <button
                    type="button"
                    onClick={() => setSubjectSpeaks(false)}
                    aria-pressed={!subjectSpeaks}
                    className={`flex-1 px-3 py-2.5 rounded-xl text-[13px] font-medium transition-all ${
                      !subjectSpeaks
                        ? "bg-primary/10 text-primary border border-primary"
                        : "bg-card/80 text-muted-foreground border border-border/60"
                    }`}
                  >
                    I answer for them
                  </button>
                </div>
              </div>
            )}
          </div>

          <Button
            className="w-full h-13 text-base rounded-xl font-semibold mt-6"
            onClick={() => setStep("chapterMode")}
            disabled={!subjectName.trim()}
          >
            Continue
            <ChevronRight className="size-4 ml-1" />
          </Button>
          {isAdmin && (
            <button
              className="w-full text-[12px] text-muted-foreground/70 py-3 mt-1 active:opacity-60 transition-opacity"
              onClick={handleSkipOnboarding}
            >
              Skip onboarding (admin)
            </button>
          )}
        </div>
      </Shell>
    );
  }

  // Chapter mode — how recordings get grouped into chapters on the device.
  // All recordings flow into the current chapter until it advances; advance is
  // either manual (a control on the device) or automatic every N minutes.
  if (step === "chapterMode") {
    return (
      <Shell showBack onBack={() => setStep("personInfo")}>
        <div className="flex flex-col flex-1">
          <div className="mb-6">
            <p className="text-[13px] font-medium text-primary uppercase tracking-wide mb-1">
              Recording setup
            </p>
            <h1 className="text-2xl font-bold text-foreground leading-snug">
              How should chapters work?
            </h1>
            <p className="text-muted-foreground text-[14px] mt-1 leading-relaxed">
              Recordings group into one chapter until you move to the next. You can
              change this anytime in Manage Device.
            </p>
          </div>

          <div className="space-y-3 flex-1">
            <button
              className={`w-full rounded-2xl border p-4 text-left transition-all ${
                chapterMode === "manual"
                  ? "border-primary bg-primary/5"
                  : "border-border/60 bg-card/80"
              }`}
              onClick={() => setChapterMode("manual")}
              aria-pressed={chapterMode === "manual"}
            >
              <p className="font-semibold text-foreground">Switch chapters manually</p>
              <p className="text-muted-foreground text-[13px] mt-0.5">
                A new chapter starts only when you tell the device to.
              </p>
            </button>

            <button
              className={`w-full rounded-2xl border p-4 text-left transition-all ${
                chapterMode === "auto"
                  ? "border-primary bg-primary/5"
                  : "border-border/60 bg-card/80"
              }`}
              onClick={() => setChapterMode("auto")}
              aria-pressed={chapterMode === "auto"}
            >
              <p className="font-semibold text-foreground">Switch automatically</p>
              <p className="text-muted-foreground text-[13px] mt-0.5">
                Start a new chapter on a regular schedule.
              </p>
            </button>

            {chapterMode === "auto" && (
              <div className="rounded-2xl border border-border/60 bg-card/80 p-4">
                <label className="text-[13px] font-medium text-muted-foreground mb-2 block">
                  New chapter every
                </label>
                <div className="flex flex-wrap gap-2">
                  {[5, 10, 15, 30, 60].map((m) => (
                    <button
                      key={m}
                      onClick={() => setChapterAutoMinutes(m)}
                      className={`px-3.5 py-2 rounded-xl text-[14px] font-medium transition-all ${
                        chapterAutoMinutes === m
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted/60 text-muted-foreground"
                      }`}
                    >
                      {m < 60 ? `${m} min` : "1 hr"}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          <Button
            className="w-full h-13 text-base rounded-xl font-semibold mt-6"
            onClick={() => setStep("survey")}
          >
            Continue
            <ChevronRight className="size-4 ml-1" />
          </Button>
        </div>
      </Shell>
    );
  }

  // BLE-failed: the device didn't return a WiFi list within 6 s. Surface that
  // explicitly so the user can retry the scan or fall back to manual entry,
  // instead of being silently dropped into the SSID form.
  if (step === "bleFailed") {
    return (
      <Shell showBack onBack={() => { setQrData(null); setStep("idle"); }}>
        <div className="flex-1 flex flex-col items-center justify-center text-center">
          <div className="w-20 h-20 rounded-full bg-amber-500/15 flex items-center justify-center mb-5">
            <WifiOff className="size-9 text-amber-600" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">Couldn't Scan WiFi</h1>
          <p className="text-muted-foreground text-[15px] leading-relaxed max-w-[280px] mx-auto mt-2">
            We couldn't get the network list from your device. Make sure it's powered on and
            within a few feet of your phone.
          </p>
          <div className="w-full max-w-sm mt-8">
            <Button
              className="w-full h-13 text-base rounded-xl font-semibold"
              onClick={() => handleConnectBLE(qrData!.hardwareId)}
            >
              Scan Again
            </Button>
          </div>

          {/* Testing Mode: how far the BLE handshake got before giving up. The
              last line is the diagnosis — 'bt_pending' = permission prompt never
              answered; nothing after 'bt_powered_on' = device not advertising;
              'name_mismatch' = QR id ≠ advertised name; 'disconnected' = dropped. */}
          {isAdmin && bleStages.length > 0 && (
            <div className="w-full max-w-sm mt-5 rounded-lg bg-muted/40 border border-border/40 px-3 py-2 text-left">
              <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide mb-1">BLE trail</p>
              {bleStages.map((s, i) => (
                <p key={i} className="text-[10px] font-mono text-muted-foreground leading-relaxed">
                  {String((s.t / 1000).toFixed(1)).padStart(5)}s  {s.stage}{s.detail ? ` · ${s.detail}` : ""}
                </p>
              ))}
            </div>
          )}
        </div>
      </Shell>
    );
  }

  // Secondary WiFi (other path — collected before BLE pair so it goes in the payload)
  if (step === "secondaryWifi") {
    const hasS2 = !!ssid2.trim();
    const hasP2 = !!pw2.trim();
    const bothFilled = hasS2 && hasP2;
    return (
      <Shell showBack onBack={() => setStep("passwordEntry")}>
        <div className="flex flex-col flex-1">
          <div className="mb-5">
            <p className="text-[13px] font-medium text-primary uppercase tracking-wide mb-1">
              Optional
            </p>
            <h1 className="text-2xl font-bold text-foreground leading-snug">
              Add their home WiFi?
            </h1>
            <p className="text-muted-foreground text-[14px] mt-1 leading-relaxed">
              If you enter their home network now, the device will connect automatically
              when it arrives. You can skip this and add it later.
            </p>
          </div>

          <div className="space-y-3 flex-1">
            <div>
              <label className="text-[13px] font-medium text-muted-foreground mb-1.5 block">
                Their network name (SSID)
              </label>
              <Input
                placeholder="Their Home Network"
                value={ssid2}
                onChange={(e) => setSsid2(e.target.value)}
                className="rounded-xl"
                maxLength={32}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
              />
            </div>
            <div>
              <label className="text-[13px] font-medium text-muted-foreground mb-1.5 block">
                Password
              </label>
              <Input
                type="password"
                placeholder="Their WiFi password"
                value={pw2}
                onChange={(e) => setPw2(e.target.value)}
                className="rounded-xl"
                maxLength={63}
                autoComplete="off"
              />
            </div>
          </div>

          <div className="space-y-2 mt-5">
            <Button
              className="w-full h-13 text-base rounded-xl font-semibold"
              onClick={handlePair}
              disabled={hasS2 && !hasP2}
            >
              {bothFilled ? "Save & Pair Device" : "Continue"}
              <ChevronRight className="size-4 ml-1" />
            </Button>
            <button
              className="w-full text-[14px] text-primary font-medium py-3 active:opacity-60 transition-opacity"
              onClick={() => { setSsid2(""); setPw2(""); handlePair(); }}
            >
              Skip — pair without it
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  // Who is this for?
  // Testing Mode only: this account already paired this device. Offer a clean
  // slate before running the flow again.
  if (step === "testWipe") {
    return (
      <Shell showBack onBack={() => { setQrData(null); setExistingTestDevice(null); setStep("idle"); }}>
        <div className="flex-1 flex flex-col items-center justify-center text-center">
          <div className="w-20 h-20 rounded-full bg-primary/10 flex items-center justify-center mb-5">
            <Wrench className="size-9 text-primary" />
          </div>
          <p className="text-[12px] font-semibold text-primary uppercase tracking-wide mb-1">Testing Mode</p>
          <h1 className="text-2xl font-bold text-foreground">Already paired to this account</h1>
          <p className="text-muted-foreground text-[15px] leading-relaxed max-w-[300px] mx-auto mt-2">
            <span className="font-mono text-foreground">{qrData?.hardwareId}</span> was paired before
            {existingTestDevice?.onboarded ? " and finished onboarding" : ""}. Wipe its recordings and
            pairing so this run starts from zero, or keep them and pair on top.
          </p>
          <div className="w-full max-w-sm mt-8 space-y-2.5">
            <Button
              className="w-full h-13 text-base rounded-xl font-semibold"
              disabled={wiping}
              onClick={wipeTestDevice}
            >
              {wiping ? <Loader2 className="size-4 animate-spin mr-2" /> : <Trash2 className="size-4 mr-2" />}
              {wiping ? "Wiping…" : "Wipe & pair fresh"}
            </Button>
            <Button
              variant="outline"
              className="w-full h-13 text-base rounded-xl font-semibold"
              disabled={wiping}
              onClick={() => { setExistingTestDevice(null); setStep("setupFor"); }}
            >
              Keep data & pair
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground/70 mt-5 max-w-[300px] leading-relaxed">
            Wipes the app side only. The device still holds its old pairing until it's reset
            (NVS wipe by the device dev for now; self-reset on removal is coming).
          </p>
        </div>
      </Shell>
    );
  }

  if (step === "setupFor") {
    return (
      <Shell showBack onBack={() => { setQrData(null); setStep("idle"); }}>
        <div className="flex flex-col flex-1">
          <div className="mt-2 mb-0 text-center">
            <h1 className="text-2xl font-bold text-foreground">Who is this device for?</h1>
            <p className="text-muted-foreground text-[14px] mt-2 max-w-[260px] mx-auto">
              This helps us personalise the experience.
            </p>
          </div>
          <div className="flex-1 flex flex-col justify-center space-y-3">
            <button
              className="w-full bg-card/80 backdrop-blur-sm border border-border/60 rounded-2xl p-4 flex items-center gap-4 active:opacity-70 transition-opacity"
              onClick={() => {
                setSetupForValue("self");
                handleConnectBLE(qrData!.hardwareId);
              }}
            >
              <div className="w-11 h-11 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <User className="size-5 text-primary" />
              </div>
              <div className="text-left">
                <p className="font-semibold text-foreground">For me</p>
                <p className="text-muted-foreground text-[13px]">
                  I'll be recording my own stories.
                </p>
              </div>
            </button>
            <button
              className="w-full bg-card/80 backdrop-blur-sm border border-border/60 rounded-2xl p-4 flex items-center gap-4 active:opacity-70 transition-opacity"
              onClick={() => {
                setSetupForValue("other");
                handleConnectBLE(qrData!.hardwareId);
              }}
            >
              <div className="w-11 h-11 rounded-full bg-primary/10 flex items-center justify-center shrink-0">
                <Users className="size-5 text-primary" />
              </div>
              <div className="text-left">
                <p className="font-semibold text-foreground">For someone else</p>
                <p className="text-muted-foreground text-[13px]">
                  I'm gifting this to a family member.
                </p>
              </div>
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  // WiFi network list — user picks a network, then enters only the password
  if (step === "wifiList") {
    const isOther = setupForValue === "other";
    // Sort by signal strength (strongest first); de-dupe SSIDs from the scan.
    const seen = new Set<string>();
    const sorted = [...wifiNetworks]
      .sort((a, b) => b.rssi - a.rssi)
      .filter((n) => (seen.has(n.ssid) ? false : (seen.add(n.ssid), true)));
    return (
      <Shell showBack onBack={() => setStep("setupFor")}>
        <div className="flex flex-col flex-1">
          <div className="mb-4">
            <h1 className="text-2xl font-bold text-foreground">Choose a Network</h1>
            <p className="text-muted-foreground text-[14px] mt-1">
              Select the WiFi{isOther ? " at your location" : ""} for{" "}
              <span className="font-semibold text-foreground">{qrData?.hardwareId}</span>.
            </p>
          </div>

          {sorted.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center px-4">
              <div className="w-16 h-16 rounded-full bg-muted/50 flex items-center justify-center mb-4">
                <WifiOff className="size-8 text-muted-foreground" aria-hidden="true" />
              </div>
              <p className="font-semibold text-foreground">No networks found</p>
              <p className="text-muted-foreground text-[13px] mt-1 max-w-[260px]">
                Make sure you're near your router (the device only sees 2.4GHz networks),
                then scan again.
              </p>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto -mx-1 px-1 space-y-2">
              {sorted.map((net) => (
                <button
                  key={net.ssid}
                  className="w-full bg-card/80 backdrop-blur-sm border border-border/60 rounded-2xl px-4 py-3.5 flex items-center justify-between gap-3 active:opacity-70 transition-opacity"
                  onClick={() => {
                    setSelectedSsid(net.ssid);
                    setSsid(net.ssid);
                    setPw("");
                    setStep("passwordEntry");
                  }}
                  aria-label={`Select network ${net.ssid}`}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <Wifi className="size-4 text-muted-foreground shrink-0" aria-hidden="true" />
                    <span className="font-medium text-foreground truncate text-[15px]">
                      {net.ssid}
                    </span>
                  </div>
                  <WifiSignal rssi={net.rssi} />
                </button>
              ))}
            </div>
          )}

          <button
            className="w-full text-[14px] text-primary font-medium py-4 active:opacity-60 transition-opacity text-center flex items-center justify-center gap-1.5"
            onClick={() => handleConnectBLE(qrData!.hardwareId)}
            aria-label="Rescan for networks"
          >
            <RefreshCw className="size-4" aria-hidden="true" />
            Rescan
          </button>

          {isAdmin && wifiDebug && (
            <div className="mt-1 mb-2 rounded-lg bg-muted/40 border border-border/40 px-3 py-2">
              <p className="text-[10px] font-mono text-muted-foreground leading-relaxed">
                debug · {wifiDebug.bytes} bytes · parsed {wifiDebug.parsed ? "ok" : "FAIL"} · {wifiDebug.count} nets
                {wifiDebug.bytes > 0 && wifiDebug.count === 0 && (
                  <><br/>payload: {wifiDebug.sample || "(empty)"}</>
                )}
              </p>
            </div>
          )}
        </div>
      </Shell>
    );
  }

  // Password entry — shown after user picks a network from the list
  if (step === "passwordEntry") {
    const isOther = setupForValue === "other";
    return (
      <Shell showBack onBack={() => { setWifiError(""); setStep("wifiList"); }}>
        <div className="flex flex-col flex-1">
          <div className="mb-6">
            <div className="flex items-center gap-2 mb-1">
              <Wifi className="size-4 text-primary" />
              <span className="text-[13px] font-semibold text-primary">{selectedSsid}</span>
            </div>
            <h1 className="text-2xl font-bold text-foreground">Enter Password</h1>
            <p className="text-muted-foreground text-[14px] mt-1">
              Enter the password for this network.
            </p>
          </div>

          {wifiError && (
            <div className="mb-3 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3">
              <AlertCircle className="size-4 text-destructive shrink-0 mt-0.5" />
              <p className="text-[13px] text-destructive leading-relaxed">{wifiError}</p>
            </div>
          )}

          <div className="flex-1">
            <Input
              type="password"
              placeholder="WiFi password"
              value={pw}
              onChange={(e) => { setPw(e.target.value); if (wifiError) setWifiError(""); }}
              className="rounded-xl"
              maxLength={63}
              autoComplete="current-password"
              autoFocus
            />
          </div>

          <div className="space-y-2 mt-4">
            <Button
              className="w-full h-13 text-base rounded-xl font-semibold"
              onClick={() => {
                setWifiError("");
                if (isOther) {
                  setStep("secondaryWifi");
                } else {
                  handlePair();
                }
              }}
              disabled={!pw.trim()}
            >
              {isOther ? "Next" : "Set Up Device"}
              {isOther && <ChevronRight className="size-4 ml-1" />}
            </Button>
            <button
              className="w-full text-[13px] text-muted-foreground py-2 active:opacity-60 transition-opacity"
              onClick={() => { setWifiError(""); setStep("wifiList"); }}
            >
              Choose a different network
            </button>
          </div>
        </div>
      </Shell>
    );
  }

  // Idle — scan QR
  return (
    <Shell showBack onBack={() => navigate(-1)}>
      <div className="flex flex-col items-center text-center flex-1 justify-center">
        <div className="w-20 h-20 rounded-2xl bg-card/80 backdrop-blur-sm flex items-center justify-center border border-border/60 shadow-sm mb-5">
          <Camera className="size-9 text-primary" />
        </div>
        <h1 className="text-3xl font-bold text-foreground">Pair Your Device</h1>
        <p className="text-muted-foreground text-[15px] leading-relaxed max-w-[260px] mx-auto mt-2">
          Turn on your LegacyTape recorder and scan the QR code shown on its screen.
        </p>
        <Button
          className="w-full max-w-sm mt-8 h-13 text-base rounded-xl font-semibold gap-2"
          onClick={handleScan}
        >
          <Camera className="size-5" />
          Scan QR Code
        </Button>
      </div>
    </Shell>
  );
};

export default DeviceSetup;
