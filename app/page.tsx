"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  dominantExpression,
  expressionsToMap,
  faceTensionFromExpressions,
  verdictFromSignals,
  hearingLevelFromRms,
  voiceStressFromRmsSeries,
} from "@/lib/lieScore";
import { pickQuestion } from "@/lib/questions";
import { useLiveTranscript } from "@/lib/useLiveTranscript";
import { useSpeechSynthesis } from "@/lib/useSpeechSynthesis";

type Verdict = "truth" | "lie" | null;

const MODEL_BASE =
  "https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model";
const SAMPLE_MS = 120;
const MAX_SAMPLES = 35;
const MIN_SAMPLES_ANALYZE = 8;

type FaceApiModule = typeof import("@vladmandic/face-api");

function pushRing<T>(arr: T[], value: T, max: number) {
  arr.push(value);
  if (arr.length > max) arr.shift();
}

function average(nums: number[]) {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const floatBufRef = useRef<Float32Array | null>(null);
  const faceBusyRef = useRef(false);
  const faceTensionSamplesRef = useRef<number[]>([]);
  const rmsSamplesRef = useRef<number[]>([]);
  /** Rolling RMS for voice meter before “Answer now” (not used for scoring). */
  const previewRmsRef = useRef<number[]>([]);
  const capturingAnswerRef = useRef(false);
  const faceapiRef = useRef<FaceApiModule | null>(null);

  const [mediaError, setMediaError] = useState<string | null>(null);
  const [modelsStatus, setModelsStatus] = useState<
    "idle" | "loading" | "ready" | "error"
  >("idle");
  const [modelError, setModelError] = useState<string | null>(null);

  const [liveFace, setLiveFace] = useState(0);
  /** Mic input loudness (0–1) for the volume-style meter. */
  const [liveHearing, setLiveHearing] = useState(0);
  const [dominantEmotion, setDominantEmotion] = useState<string>("—");
  const [faceSeenRecently, setFaceSeenRecently] = useState(false);
  const [rmsReady, setRmsReady] = useState(false);

  const [analyzing, setAnalyzing] = useState(false);
  const [verdict, setVerdict] = useState<Verdict>(null);
  const [explain, setExplain] = useState<string | null>(null);
  /** Snapshot when “Check my answer” runs (transcript clears when capture stops). */
  const [lastAnswerText, setLastAnswerText] = useState<string | null>(null);

  /** Set only after mount so SSR + first client paint match (no Math.random during render). */
  const [question, setQuestion] = useState<string | null>(null);
  const [capturingAnswer, setCapturingAnswer] = useState(false);
  useEffect(() => {
    setQuestion(pickQuestion());
  }, []);

  const { speak: speakQuestion, cancel: cancelTts, speaking: ttsSpeaking, supported: ttsSupported } =
    useSpeechSynthesis();

  const {
    beginListening,
    endListening,
    display: liveTranscript,
    error: speechError,
    supported: speechSupported,
    listening: sttListening,
    lastEvent: sttLastEvent,
  } = useLiveTranscript();

  const liveTranscriptRef = useRef(liveTranscript);
  liveTranscriptRef.current = liveTranscript;

  useEffect(() => {
    capturingAnswerRef.current = capturingAnswer;
  }, [capturingAnswer]);

  const resetRound = useCallback(
    (nextQuestion: string) => {
      cancelTts();
      endListening();
      setQuestion(nextQuestion);
      setVerdict(null);
      setExplain(null);
      setLastAnswerText(null);
      setCapturingAnswer(false);
      capturingAnswerRef.current = false;
      faceTensionSamplesRef.current = [];
      rmsSamplesRef.current = [];
      previewRmsRef.current = [];
      setRmsReady(false);
    },
    [cancelTts, endListening],
  );

  const newQuestion = () => {
    resetRound(pickQuestion(question ?? undefined));
  };

  const startAnswering = () => {
    if (mediaError) return;
    cancelTts();
    setVerdict(null);
    setExplain(null);
    setLastAnswerText(null);
    faceTensionSamplesRef.current = [];
    rmsSamplesRef.current = [];
    setRmsReady(false);
    setCapturingAnswer(true);
    capturingAnswerRef.current = true;
    beginListening();
  };

  const tryAnotherAnswer = () => {
    cancelTts();
    endListening();
    setVerdict(null);
    setExplain(null);
    setLastAnswerText(null);
    faceTensionSamplesRef.current = [];
    rmsSamplesRef.current = [];
    setRmsReady(false);
    setCapturingAnswer(false);
    capturingAnswerRef.current = false;
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "user",
            width: { ideal: 640 },
            height: { ideal: 480 },
          },
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play();
        }

        const ctx = new AudioContext();
        audioCtxRef.current = ctx;
        if (ctx.state === "suspended") await ctx.resume();
        const source = ctx.createMediaStreamSource(stream);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.65;
        source.connect(analyser);
        analyserRef.current = analyser;
        floatBufRef.current = new Float32Array(analyser.fftSize);
      } catch {
        if (!cancelled) {
          setMediaError(
            "Camera and microphone access are required. Allow both in your browser settings.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
      void audioCtxRef.current?.close();
      audioCtxRef.current = null;
      analyserRef.current = null;
      floatBufRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setModelsStatus("loading");
      setModelError(null);
      try {
        const faceapi = await import("@vladmandic/face-api");
        if (cancelled) return;
        await faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_BASE);
        await faceapi.nets.faceLandmark68TinyNet.loadFromUri(MODEL_BASE);
        await faceapi.nets.faceExpressionNet.loadFromUri(MODEL_BASE);
        if (cancelled) return;
        faceapiRef.current = faceapi;
        setModelsStatus("ready");
      } catch (e) {
        if (!cancelled) {
          setModelsStatus("error");
          setModelError(
            e instanceof Error ? e.message : "Could not load face models.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (modelsStatus !== "ready" || mediaError) return;
    const faceapi = faceapiRef.current;
    if (!faceapi) return;

    const tick = window.setInterval(() => {
      const capturing = capturingAnswerRef.current;
      const analyser = analyserRef.current;
      const buf = floatBufRef.current;
      if (analyser && buf) {
        analyser.getFloatTimeDomainData(
          buf as Float32Array<ArrayBuffer>,
        );
        let sum = 0;
        for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
        const rms = Math.sqrt(sum / buf.length);
        setLiveHearing(hearingLevelFromRms(rms));
        if (capturing) {
          pushRing(rmsSamplesRef.current, rms, MAX_SAMPLES);
          if (rmsSamplesRef.current.length >= MIN_SAMPLES_ANALYZE) {
            setRmsReady(true);
          }
        } else {
          pushRing(previewRmsRef.current, rms, 24);
          setRmsReady(false);
        }
      }

      const video = videoRef.current;
      if (!video || video.readyState < 2 || faceBusyRef.current) return;

      faceBusyRef.current = true;
      void (async () => {
        try {
          const result = await faceapi
            .detectSingleFace(
              video,
              new faceapi.TinyFaceDetectorOptions({
                inputSize: 320,
                scoreThreshold: 0.45,
              }),
            )
            .withFaceLandmarks(true)
            .withFaceExpressions();

          if (result) {
            const map = expressionsToMap(result.expressions);
            const tension = faceTensionFromExpressions(map);
            setLiveFace(tension);
            setDominantEmotion(dominantExpression(map));
            setFaceSeenRecently(true);
            if (capturingAnswerRef.current) {
              pushRing(faceTensionSamplesRef.current, tension, MAX_SAMPLES);
            }
          } else {
            setFaceSeenRecently(false);
          }
        } catch {
          setFaceSeenRecently(false);
        } finally {
          faceBusyRef.current = false;
        }
      })();
    }, SAMPLE_MS);

    return () => clearInterval(tick);
  }, [modelsStatus, mediaError]);

  const canAnalyze =
    modelsStatus === "ready" &&
    !mediaError &&
    rmsReady &&
    capturingAnswer;

  const analyze = () => {
    if (!canAnalyze || analyzing) return;
    setAnalyzing(true);
    setVerdict(null);
    setExplain(null);

    window.requestAnimationFrame(() => {
      const heard = liveTranscriptRef.current.trim();
      setLastAnswerText(heard || null);
      endListening();

      const faceArr = [...faceTensionSamplesRef.current];
      const rmsArr = [...rmsSamplesRef.current];
      const voice = voiceStressFromRmsSeries(rmsArr);
      const faceAvg = average(faceArr);

      let v: "truth" | "lie";
      let line: string;

      if (faceArr.length < 3) {
        v = voice >= 0.42 ? "lie" : "truth";
        line = `Mostly from your voice (face wasn’t visible long enough). Voice stress ${(voice * 100).toFixed(0)}%.`;
        if (!heard) {
          line += " No speech detected — turn on mic for Chrome/Edge and speak after Answer now.";
        }
      } else {
        const { verdict: ver, combined } = verdictFromSignals(faceAvg, voice);
        v = ver;
        line = `Blend: face tension ${(faceAvg * 100).toFixed(0)}%, voice variability ${(voice * 100).toFixed(0)}%, combined ${(combined * 100).toFixed(0)}%.`;
        if (!heard) {
          line +=
            " (Speech-to-text didn’t pick up words — verdict uses face + voice tone only.)";
        }
      }

      setVerdict(v);
      setExplain(line);
      setCapturingAnswer(false);
      capturingAnswerRef.current = false;
      setAnalyzing(false);
    });
  };

  return (
    <div className="flex min-h-full flex-1 flex-col items-center justify-center px-4 py-10 sm:py-14">
      <main className="w-full max-w-md">
        <div className="rounded-[2rem] border border-white/70 bg-white/65 p-6 shadow-xl shadow-fuchsia-200/40 backdrop-blur-md sm:p-8">
          <div className="mb-6 text-center">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-violet-400">
              Lie detector
            </p>
            <h1 className="mt-1 text-2xl font-bold text-violet-950 sm:text-3xl">
              Truth Whisper
            </h1>
            <p className="mt-2 text-sm text-violet-800/80">
              Hear the question, tap <span className="font-semibold">Answer now</span>,
              then speak — we match speech-to-text with your face and voice.
            </p>
          </div>

          <p className="mb-4 rounded-xl border border-amber-100 bg-amber-50/80 px-3 py-2 text-xs text-amber-950/90">
            For fun only: expression + voice heuristics, not a scientific or legal
            test.
          </p>

          <div className="space-y-5">
            {modelsStatus === "loading" && (
              <p className="text-center text-sm text-violet-700">
                Loading face models… (one-time download)
              </p>
            )}
            {modelsStatus === "error" && (
              <p className="text-center text-sm text-rose-600">
                {modelError ?? "Model load failed."}
              </p>
            )}

            {mediaError ? (
              <p className="text-center text-sm text-rose-600">{mediaError}</p>
            ) : (
              <>
                <section className="rounded-2xl border border-violet-200/80 bg-gradient-to-br from-violet-50/95 to-pink-50/90 p-4 shadow-md shadow-violet-200/30">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-violet-500">
                      Your question
                    </p>
                    <button
                      type="button"
                      onClick={newQuestion}
                      disabled={analyzing}
                      className="shrink-0 rounded-full border border-violet-200 bg-white/90 px-2.5 py-1 text-[11px] font-semibold text-violet-800 shadow-sm transition hover:bg-violet-50 disabled:opacity-50"
                    >
                      New question
                    </button>
                  </div>
                  <p className="mt-2 text-base font-semibold leading-snug text-violet-950">
                    {question ?? (
                      <span className="font-normal text-violet-400">
                        Preparing your question…
                      </span>
                    )}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => question && speakQuestion(question)}
                      disabled={
                        !question ||
                        ttsSupported !== true ||
                        ttsSpeaking ||
                        Boolean(analyzing)
                      }
                      className="rounded-xl border border-violet-200 bg-white/90 px-3 py-2 text-xs font-semibold text-violet-900 shadow-sm transition hover:bg-violet-50 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {ttsSpeaking ? "Reading…" : "Play question"}
                    </button>
                    <button
                      type="button"
                      onClick={startAnswering}
                      disabled={
                        !question ||
                        capturingAnswer ||
                        Boolean(analyzing)
                      }
                      className="rounded-xl bg-gradient-to-r from-emerald-200 to-teal-200 px-4 py-2 text-xs font-bold text-emerald-950 shadow-md shadow-emerald-200/50 transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      Answer now
                    </button>
                  </div>
                  <p className="mt-2 text-xs text-violet-700/90">
                    Optional: <span className="font-semibold">Play question</span> reads
                    it aloud. Tap <span className="font-semibold">Answer now</span> once
                    — that starts speech-to-text (works best in{" "}
                    <span className="font-semibold">Chrome or Edge</span> with internet).
                    Then speak clearly; tap <span className="font-semibold">Check my answer</span>{" "}
                    when done.
                  </p>
                </section>

                <section
                  className="rounded-2xl border border-sky-200/80 bg-white/85 p-4 shadow-inner shadow-sky-100/50"
                  aria-live="polite"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-sky-600">
                      Your speech (live)
                    </p>
                    {speechSupported !== false &&
                      question &&
                      capturingAnswer && (
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                            sttListening
                              ? "bg-emerald-100 text-emerald-900"
                              : "bg-amber-100 text-amber-900"
                          }`}
                        >
                          {sttListening ? "Mic on (STT)" : "Starting…"}
                        </span>
                      )}
                  </div>
                  {capturingAnswer &&
                    speechSupported !== false &&
                    sttLastEvent && (
                      <p className="mt-1 text-[10px] text-sky-700/90">
                        Status: {sttLastEvent}
                      </p>
                    )}
                  {speechError ? (
                    <p className="mt-2 text-sm text-rose-600">{speechError}</p>
                  ) : speechSupported === false ? (
                    <p className="mt-2 text-sm text-violet-700">
                      Speech-to-text isn’t available here. You can still use face +
                      voice signals for the check after you tap Answer now.
                    </p>
                  ) : !question ? (
                    <p className="mt-2 text-sm text-violet-400">…</p>
                  ) : !capturingAnswer ? (
                    <p className="mt-2 min-h-[4.5rem] rounded-xl border border-dashed border-sky-200/80 bg-sky-50/50 px-3 py-2.5 text-sm leading-relaxed text-violet-500">
                      Tap <span className="font-semibold text-violet-700">Answer now</span>{" "}
                      — then your words will appear here while you speak.
                    </p>
                  ) : (
                    <p className="mt-2 min-h-[4.5rem] whitespace-pre-wrap rounded-xl border border-sky-100/80 bg-sky-50/80 px-3 py-2.5 text-sm leading-relaxed text-violet-950">
                      {liveTranscript || (
                        <span className="text-violet-400">
                          Speak your answer — text appears as you talk…
                        </span>
                      )}
                    </p>
                  )}
                </section>

                <section className="rounded-2xl border border-fuchsia-100 bg-white/80 p-4 shadow-inner shadow-fuchsia-100/50">
                  <label className="block text-sm font-semibold text-fuchsia-950">
                    Camera + mic{" "}
                    {capturingAnswer ? (
                      <span className="font-normal text-fuchsia-700">
                        (scoring your answer)
                      </span>
                    ) : (
                      <span className="font-normal text-fuchsia-600">
                        (preview — answer not recorded yet)
                      </span>
                    )}
                  </label>
                  <div className="mt-3 overflow-hidden rounded-xl border border-fuchsia-100 bg-black/5">
                    <video
                      ref={videoRef}
                      playsInline
                      muted
                      className="aspect-video w-full object-cover"
                    />
                  </div>
                  <div className="mt-3 grid gap-2 text-xs text-fuchsia-900/85">
                    <div className="flex justify-between gap-2">
                      <span>
                        Face tension
                        {!capturingAnswer && (
                          <span className="text-fuchsia-500"> (preview)</span>
                        )}
                      </span>
                      <span className="font-semibold tabular-nums">
                        {(liveFace * 100).toFixed(0)}%
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-fuchsia-100">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-fuchsia-300 to-rose-300 transition-[width] duration-150"
                        style={{ width: `${liveFace * 100}%` }}
                      />
                    </div>
                    <div className="flex justify-between gap-2 pt-1">
                      <span>
                        Hearing level
                        {!capturingAnswer && (
                          <span className="text-fuchsia-500"> (preview)</span>
                        )}
                      </span>
                      <span className="font-semibold tabular-nums">
                        {(liveHearing * 100).toFixed(0)}%
                      </span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-violet-100">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-violet-300 to-sky-300 transition-[width] duration-150"
                        style={{ width: `${liveHearing * 100}%` }}
                      />
                    </div>
                    <p className="pt-1">
                      Top expression:{" "}
                      <span className="font-semibold capitalize">
                        {dominantEmotion}
                      </span>
                      {!faceSeenRecently && (
                        <span className="text-rose-600">
                          {" "}
                          — center your face in frame
                        </span>
                      )}
                    </p>
                  </div>
                </section>

                <button
                  type="button"
                  onClick={analyze}
                  disabled={
                    modelsStatus !== "ready" ||
                    Boolean(mediaError) ||
                    analyzing ||
                    !rmsReady ||
                    !capturingAnswer
                  }
                  className="w-full rounded-2xl bg-gradient-to-r from-violet-300 via-purple-200 to-sky-200 py-3.5 text-lg font-bold text-violet-950 shadow-lg shadow-violet-300/50 transition hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-45"
                >
                  {analyzing
                    ? "Checking…"
                    : modelsStatus !== "ready"
                      ? "Loading models…"
                      : !capturingAnswer
                        ? "Tap Answer now first"
                        : !rmsReady
                          ? "Gathering answer…"
                          : "Check my answer"}
                </button>
              </>
            )}

            {verdict && (
              <div
                className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-emerald-100 bg-gradient-to-br from-emerald-50/90 to-teal-50/90 px-4 py-6 text-center shadow-inner shadow-emerald-100/80"
                role="status"
              >
                <p className="max-w-full text-[11px] font-medium uppercase tracking-wide text-emerald-800/80">
                  For your answer to
                </p>
                <p className="max-w-full text-sm font-semibold italic leading-snug text-emerald-950">
                  “{question ?? ""}”
                </p>
                {lastAnswerText ? (
                  <p className="max-w-full text-xs leading-relaxed text-emerald-900/90">
                    You said: “{lastAnswerText}”
                  </p>
                ) : null}
                <span className="text-5xl" aria-hidden>
                  {verdict === "truth" ? "😊" : "😶‍🌫️"}
                </span>
                <p className="text-xl font-bold text-emerald-900">
                  {verdict === "truth" ? "Truth" : "Lie"}
                </p>
                {explain && (
                  <p className="max-w-xs text-xs leading-relaxed text-emerald-800/85">
                    {explain}
                  </p>
                )}
                <button
                  type="button"
                  onClick={tryAnotherAnswer}
                  className="mt-2 rounded-full border border-emerald-200 bg-white/80 px-4 py-2 text-xs font-semibold text-emerald-900 shadow-sm transition hover:bg-emerald-50"
                >
                  Try again
                </button>
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
