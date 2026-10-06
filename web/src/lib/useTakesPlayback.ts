import { useEffect, useRef, useState } from "react";
import { supabase } from "./supabase";
import type { Recording } from "./deviceRecordings";

// ── Sequential playback of a chapter's takes ─────────────────────────────────
// One hook, used by My Device and Library, so a chapter sounds the same
// everywhere: the takes play back-to-back as one timeline (matching the
// device's own get_recording playback). Each take gets a fresh signed URL
// just-in-time — a 1h URL minted for take 1 could expire before a long
// chapter reaches take 6.
//
//   loadingKey  → first take's URL is being fetched / buffering
//   playingKey  → audio is coming out; playingTake = which take (0-based)
//   neither     → idle

export function useTakesPlayback() {
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [playingTake, setPlayingTake] = useState(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Bumped on every start/stop so a take that finishes after the user moved on
  // can't chain into the next take of a chapter that's no longer playing.
  const seqRef = useRef(0);

  const releaseAudio = () => {
    const a = audioRef.current;
    if (!a) return;
    a.pause();
    a.removeAttribute("src");
    a.load(); // releases the underlying media resource
    audioRef.current = null;
  };

  const stop = () => {
    seqRef.current++;
    releaseAudio();
    setPlayingKey(null);
    setLoadingKey(null);
    setPlayingTake(0);
  };

  const playTake = async (key: string, takes: Recording[], i: number, seq: number) => {
    if (seq !== seqRef.current) return;
    if (i >= takes.length) { stop(); return; }
    setPlayingTake(i);

    const { data } = await supabase.storage
      .from("recordings")
      .createSignedUrl(takes[i].storage_path, 3600);
    if (seq !== seqRef.current) return;
    if (!data?.signedUrl) { stop(); return; }

    releaseAudio();
    const audio = new Audio(data.signedUrl);
    audioRef.current = audio;
    audio.onplay = () => {
      if (seq !== seqRef.current) return;
      setLoadingKey(null);
      setPlayingKey(key);
    };
    audio.onended = () => {
      if (seq !== seqRef.current) return;
      playTake(key, takes, i + 1, seq);
    };
    audio.onerror = () => { if (seq === seqRef.current) stop(); };
    audio.play().catch(() => { if (seq === seqRef.current) stop(); });
  };

  /** Toggle: tapping the chapter that's playing/loading stops it. */
  const toggle = (key: string, takes: Recording[]) => {
    if (playingKey === key || loadingKey === key) { stop(); return; }
    stop();
    const seq = ++seqRef.current;
    setLoadingKey(key);
    playTake(key, takes, 0, seq);
  };

  // Release any in-flight audio on unmount so we don't leak Media objects.
  useEffect(() => () => { seqRef.current++; releaseAudio(); }, []);

  return { loadingKey, playingKey, playingTake, toggle, stop };
}
