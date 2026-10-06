import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { ArrowLeft, Mic, Pause, Square, Play, Loader2, ChevronRight, Check, Volume2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import SkyBackground from "@/components/SkyBackground";
import { createChapter } from "@/lib/database";
import { getQuestionAudio, type Voice } from "@/lib/questionAudio";

declare global {
  interface Window {
    __nativeSpeechBridge?: boolean;
    __speechBridge?: {
      start: () => void;
      pause: () => void;
      resume: () => void;
      stop: () => void;
      speak: (text: string) => void;
    };
    __onTranscript?: (text: string) => void;
    __onVolumeLevel?: (level: number) => void;
    __onRecordingStarted?: () => void;
    __onRecordingStopped?: () => void;
    __onSpeechError?: (msg: string) => void;
    __onSpeakFinished?: () => void;
  }
}

interface LocationState {
  bookId?: string;
  bookTitle?: string;
  chapterIndex?: number;
  questions?: string[];
  voicePreference?: Voice;
  topic?: string;
}

const RecordingSession = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state as LocationState) || {};
  const bookId = state.bookId;
  const chapterIndex = state.chapterIndex ?? 0;
  const bookTitle = state.bookTitle ?? "Untitled";
  const questions = state.questions;
  const voicePreference: Voice = state.voicePreference ?? "female";
  const topic = state.topic ?? "";

  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [volumeLevel, setVolumeLevel] = useState(0);
  const [transcript, setTranscript] = useState("");
  const [sttSupported, setSttSupported] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  const [currentQuestionIdx, setCurrentQuestionIdx] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const isGuided = !!questions && questions.length > 0;
  const totalQuestions = questions?.length ?? 0;
  const isLastQuestion = isGuided && currentQuestionIdx >= totalQuestions - 1;

  const useNative = !!window.__nativeSpeechBridge;

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number>(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recognitionRef = useRef<any>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef("");
  const savedTranscriptRef = useRef("");
  const audioElRef = useRef<HTMLAudioElement | null>(null);

  const speakQuestion = useCallback((text: string, questionIndex: number) => {
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current = null;
    }

    const clipPath = getQuestionAudio(topic, questionIndex, voicePreference);

    if (clipPath) {
      setIsSpeaking(true);
      if (useNative) window.__speechBridge?.pause();

      const audio = new Audio(clipPath);
      audioElRef.current = audio;
      audio.onended = () => {
        audioElRef.current = null;
        setIsSpeaking(false);
        if (useNative) window.__speechBridge?.resume();
      };
      audio.onerror = () => {
        audioElRef.current = null;
        fallbackTTS(text);
      };
      audio.play().catch(() => fallbackTTS(text));
      return;
    }

    fallbackTTS(text);
  }, [useNative, topic, voicePreference]);

  const fallbackTTS = useCallback((text: string) => {
    setIsSpeaking(true);
    if (useNative && window.__speechBridge?.speak) {
      window.__onSpeakFinished = () => setIsSpeaking(false);
      window.__speechBridge.speak(text);
    } else if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = "en-US";
      utterance.rate = 0.9;
      utterance.onend = () => setIsSpeaking(false);
      utterance.onerror = () => setIsSpeaking(false);
      window.speechSynthesis.speak(utterance);
    } else {
      setIsSpeaking(false);
    }
  }, [useNative]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  };

  const updateVolume = useCallback(() => {
    if (!analyserRef.current) return;
    const data = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    setVolumeLevel(Math.min(avg / 128, 1));
    animFrameRef.current = requestAnimationFrame(updateVolume);
  }, []);

  const startTimer = useCallback(() => {
    timerRef.current = setInterval(() => {
      setElapsedSeconds((p) => p + 1);
    }, 1000);
  }, []);

  const startNativeRecording = useCallback(() => {
    window.__onTranscript = (text: string) => {
      const full = savedTranscriptRef.current + text;
      setTranscript(full);
      transcriptRef.current = full;
    };
    window.__onVolumeLevel = (level: number) => setVolumeLevel(level);
    window.__onRecordingStarted = () => {
      setIsRecording(true);
      setIsPaused(false);
      startTimer();
      if (isGuided && questions) {
        speakQuestion(questions[0], 0);
      }
    };
    window.__onRecordingStopped = () => {
      setIsRecording(false);
      if (timerRef.current) clearInterval(timerRef.current);
    };
    window.__onSpeechError = (msg: string) => {
      console.warn("Speech error:", msg);
      setSttSupported(false);
    };

    window.__speechBridge?.start();
  }, [startTimer, isGuided, questions, speakQuestion]);

  const startBrowserRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      recorder.start();

      const ctx = new AudioContext();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      analyserRef.current = analyser;
      updateVolume();

      startTimer();

      const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = "en-US";
        recognition.onresult = (e: any) => {
          let finalText = "";
          for (let i = 0; i < e.results.length; i++) {
            finalText += e.results[i][0].transcript + " ";
          }
          const trimmed = finalText.trim();
          const full = savedTranscriptRef.current + trimmed;
          setTranscript(full);
          transcriptRef.current = full;
        };
        recognition.onerror = () => {};
        recognition.start();
        recognitionRef.current = recognition;
      } else {
        setSttSupported(false);
      }

      setIsRecording(true);
      setIsPaused(false);
      if (isGuided && questions) {
        speakQuestion(questions[0], 0);
      }
    } catch {
      // mic permission denied
    }
  }, [updateVolume, startTimer, isGuided, questions, speakQuestion]);

  const togglePause = () => {
    if (useNative) {
      if (isPaused) {
        window.__speechBridge?.resume();
        startTimer();
        setIsPaused(false);
      } else {
        window.__speechBridge?.pause();
        if (timerRef.current) clearInterval(timerRef.current);
        setVolumeLevel(0);
        setIsPaused(true);
      }
      return;
    }

    if (!mediaRecorderRef.current) return;
    if (isPaused) {
      mediaRecorderRef.current.resume();
      recognitionRef.current?.start();
      startTimer();
      updateVolume();
      setIsPaused(false);
    } else {
      mediaRecorderRef.current.pause();
      recognitionRef.current?.stop();
      if (timerRef.current) clearInterval(timerRef.current);
      cancelAnimationFrame(animFrameRef.current);
      setVolumeLevel(0);
      setIsPaused(true);
    }
  };

  const stopAndSave = async () => {
    if (audioElRef.current) { audioElRef.current.pause(); audioElRef.current = null; }
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    if (useNative) {
      window.__speechBridge?.stop();
    } else {
      mediaRecorderRef.current?.stop();
      recognitionRef.current?.stop();
      streamRef.current?.getTracks().forEach((t) => t.stop());
    }

    if (timerRef.current) clearInterval(timerRef.current);
    cancelAnimationFrame(animFrameRef.current);
    setIsRecording(false);

    const finalTranscript = transcriptRef.current;

    if (bookId && finalTranscript.trim()) {
      setIsSaving(true);
      const chapterTitle = `Chapter ${chapterIndex + 1}`;
      await createChapter(bookId, chapterTitle, chapterIndex, finalTranscript, elapsedSeconds);
      setIsSaving(false);
    }

    navigate(-1);
  };

  const handleNextQuestion = () => {
    if (!isGuided) return;

    // Snapshot current transcript as the saved portion with a separator
    const currentText = transcriptRef.current;
    const separator = currentText.trim() ? "\n\n" : "";
    savedTranscriptRef.current = currentText + separator;
    transcriptRef.current = savedTranscriptRef.current;
    setTranscript(savedTranscriptRef.current);

    if (isLastQuestion) {
      stopAndSave();
    } else {
      const nextIdx = currentQuestionIdx + 1;
      setCurrentQuestionIdx(nextIdx);
      if (questions) {
        speakQuestion(questions[nextIdx], nextIdx);
      }
    }
  };

  useEffect(() => {
    if (useNative) {
      startNativeRecording();
    } else {
      startBrowserRecording();
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      cancelAnimationFrame(animFrameRef.current);
      if (audioElRef.current) { audioElRef.current.pause(); audioElRef.current = null; }
      if ("speechSynthesis" in window) window.speechSynthesis.cancel();
      if (useNative) {
        window.__speechBridge?.stop();
        window.__onTranscript = undefined;
        window.__onVolumeLevel = undefined;
        window.__onRecordingStarted = undefined;
        window.__onRecordingStopped = undefined;
        window.__onSpeechError = undefined;
        window.__onSpeakFinished = undefined;
      } else {
        recognitionRef.current?.stop();
        streamRef.current?.getTracks().forEach((t) => t.stop());
      }
    };
  }, [useNative, startNativeRecording, startBrowserRecording]);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [transcript]);

  return (
    <div className="relative flex min-h-[100dvh] flex-col safe-top safe-bottom">
      <SkyBackground />

      <div className="pt-14 pb-4 px-6 flex items-center gap-3">
        <button
          onClick={() => navigate(-1)}
          className="flex items-center gap-1.5 text-muted-foreground active:opacity-60 transition-opacity"
        >
          <ArrowLeft className="size-5" />
        </button>
        <div>
          <h1 className="text-xl font-bold text-foreground">Recording</h1>
          {bookId && (
            <p className="text-xs text-muted-foreground">{bookTitle} — Chapter {chapterIndex + 1}</p>
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col items-center px-6 pb-8">
        {/* Guided Interview Question */}
        {isGuided && questions && (
          <div className="w-full mb-4 p-4 rounded-2xl border border-primary/30 bg-primary/5 backdrop-blur-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold text-primary uppercase tracking-wide flex items-center gap-1.5">
                Question {currentQuestionIdx + 1} of {totalQuestions}
                {isSpeaking && <Volume2 className="size-3 animate-pulse" />}
              </span>
              <div className="flex gap-1">
                {questions.map((_, i) => (
                  <div
                    key={i}
                    className={`w-1.5 h-1.5 rounded-full ${
                      i < currentQuestionIdx ? "bg-primary" : i === currentQuestionIdx ? "bg-primary animate-pulse" : "bg-muted-foreground/30"
                    }`}
                  />
                ))}
              </div>
            </div>
            <p className="text-[15px] font-medium text-foreground leading-relaxed">
              {questions[currentQuestionIdx]}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3 rounded-xl gap-1.5 w-full h-10 text-sm font-semibold"
              onClick={handleNextQuestion}
              disabled={!isRecording || isSaving}
            >
              {isLastQuestion ? (
                <>
                  <Check className="size-4" />
                  Finish Recording
                </>
              ) : (
                <>
                  Next Question
                  <ChevronRight className="size-4" />
                </>
              )}
            </Button>
          </div>
        )}

        {/* Mic + volume meter */}
        <div className="flex items-end gap-4 mt-2">
          <div className="w-3 h-24 rounded-full bg-muted/50 overflow-hidden flex flex-col justify-end">
            <div
              className="w-full rounded-full bg-primary transition-all duration-75"
              style={{ height: `${volumeLevel * 100}%` }}
            />
          </div>

          <div className="relative flex items-center justify-center">
            {isRecording && !isPaused && (
              <div className="absolute w-20 h-20 rounded-full bg-destructive/20 animate-ping" />
            )}
            <div className={`w-16 h-16 rounded-full flex items-center justify-center ${
              isRecording && !isPaused ? "bg-destructive" : "bg-muted"
            }`}>
              <Mic className="size-7 text-destructive-foreground" />
            </div>
          </div>

          <div className="w-3 h-24 rounded-full bg-muted/50 overflow-hidden flex flex-col justify-end">
            <div
              className="w-full rounded-full bg-primary transition-all duration-75"
              style={{ height: `${volumeLevel * 100}%` }}
            />
          </div>
        </div>

        {/* Timer */}
        <p className="text-3xl font-mono font-bold text-foreground mt-4">
          {formatTime(elapsedSeconds)}
        </p>
        <p className="text-sm text-muted-foreground mt-1">
          {isSaving ? "Saving..." : isPaused ? "Paused" : isRecording ? "Recording..." : "Starting..."}
        </p>

        {/* Transcript */}
        <div className="w-full mt-4 flex-1 max-h-[25vh] overflow-y-auto rounded-2xl border border-border/60 bg-card/80 backdrop-blur-sm p-4">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Live Transcript</p>
          {transcript ? (
            <p className="text-sm text-foreground leading-relaxed whitespace-pre-line">{transcript}</p>
          ) : (
            <p className="text-sm text-muted-foreground italic">
              {sttSupported ? "Start speaking to see your words appear here..." : "Speech-to-text not supported in this browser."}
            </p>
          )}
          <div ref={transcriptEndRef} />
        </div>

        {/* Controls */}
        <div className="flex items-center gap-6 mt-6">
          {isSaving ? (
            <div className="flex items-center gap-2 text-muted-foreground">
              <Loader2 className="size-6 animate-spin" />
              <span className="text-sm font-medium">Saving transcript...</span>
            </div>
          ) : (
            <>
              <Button
                variant="outline"
                size="lg"
                className="rounded-full w-14 h-14"
                onClick={togglePause}
                disabled={!isRecording}
              >
                {isPaused ? <Play className="size-6" /> : <Pause className="size-6" />}
              </Button>
              {!isGuided && (
                <Button
                  variant="destructive"
                  size="lg"
                  className="rounded-full w-14 h-14"
                  onClick={stopAndSave}
                  disabled={!isRecording}
                >
                  <Square className="size-6" />
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default RecordingSession;
