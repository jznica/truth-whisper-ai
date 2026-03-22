"use client";

import { startTransition, useCallback, useEffect, useRef, useState } from "react";

function getSpeechRecognitionCtor(): typeof SpeechRecognition | null {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition ?? window.webkitSpeechRecognition ?? null;
}

function speechErrorMessage(code: string): string | null {
  switch (code) {
    case "not-allowed":
      return "Microphone blocked for speech recognition — allow mic in the address bar and tap Answer now again.";
    case "no-speech":
    case "aborted":
      return null;
    case "network":
      /* Shown only after repeated failures — see onerror handler. */
      return "Speech recognition can’t reach Google’s servers. Check Wi‑Fi/VPN/firewall or try again in a moment.";
    case "service-not-allowed":
      return "Speech service isn’t allowed here. Try Chrome or Edge.";
    case "audio-capture":
      return "No microphone found for speech-to-text.";
    default:
      return `Speech issue (${code}). Try Chrome/Edge and check mic permissions.`;
  }
}

function stopRecognitionInstance(r: SpeechRecognition | null) {
  if (!r) return;
  r.onend = null;
  try {
    r.stop();
  } catch {
    /* ignore */
  }
}

/**
 * Call `beginListening()` synchronously from the “Answer now” click handler.
 * Browsers require a user gesture to start the mic for speech recognition;
 * starting in useEffect does not count and often captures nothing.
 */
export function useLiveTranscript() {
  const [transcript, setTranscript] = useState("");
  const [interim, setInterim] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState<boolean | null>(null);
  const [listening, setListening] = useState(false);
  const [lastEvent, setLastEvent] = useState<string | null>(null);

  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const shouldRestartRef = useRef(false);
  const aliveRef = useRef(true);
  /** Chrome often fires `network` even when online; count before showing an error. */
  const networkFailCountRef = useRef(0);
  const hadSpeechResultRef = useRef(false);

  useEffect(() => {
    aliveRef.current = true;
    startTransition(() => {
      setSupported(getSpeechRecognitionCtor() !== null);
    });
    return () => {
      aliveRef.current = false;
      shouldRestartRef.current = false;
      stopRecognitionInstance(recognitionRef.current);
      recognitionRef.current = null;
    };
  }, []);

  const endListening = useCallback(() => {
    shouldRestartRef.current = false;
    stopRecognitionInstance(recognitionRef.current);
    recognitionRef.current = null;
    setListening(false);
    startTransition(() => {
      setTranscript("");
      setInterim("");
      setLastEvent(null);
    });
  }, []);

  const beginListening = useCallback(() => {
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setSupported(false);
      setError(
        "Speech-to-text isn’t supported in this browser. Use Chrome, Edge, or Safari.",
      );
      return;
    }

    shouldRestartRef.current = false;
    stopRecognitionInstance(recognitionRef.current);
    recognitionRef.current = null;

    setSupported(true);
    setError(null);
    setTranscript("");
    setInterim("");
    setLastEvent("starting…");
    networkFailCountRef.current = 0;
    hadSpeechResultRef.current = false;

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    recognition.lang = navigator.language || "en-US";

    shouldRestartRef.current = true;
    recognitionRef.current = recognition;

    recognition.onaudiostart = () => setLastEvent("hearing audio");
    recognition.onsoundstart = () => setLastEvent("sound detected");
    recognition.onspeechend = () => setLastEvent("processing…");

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      hadSpeechResultRef.current = true;
      networkFailCountRef.current = 0;
      setError(null);
      let chunkInterim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        const text = r[0]?.transcript ?? "";
        if (r.isFinal) {
          const t = text.trim();
          if (t) {
            setTranscript((prev) =>
              prev ? `${prev.trimEnd()} ${t}` : t,
            );
          }
        } else {
          chunkInterim += text;
        }
      }
      setInterim(chunkInterim.trim());
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (event.error === "no-speech" || event.error === "aborted") return;

      if (event.error === "network") {
        networkFailCountRef.current += 1;
        /* Don’t alarm the user on the first few — Chrome fires this spuriously while still working. */
        if (hadSpeechResultRef.current) {
          setError(null);
          setLastEvent("brief network hiccup — still listening");
          return;
        }
        if (networkFailCountRef.current < 5) {
          setError(null);
          setLastEvent(
            `cloud speech reconnecting (${networkFailCountRef.current}/5)…`,
          );
          return;
        }
        const msg = speechErrorMessage("network");
        if (msg) setError(msg);
        setLastEvent("error: network");
        return;
      }

      const msg = speechErrorMessage(event.error);
      if (msg) setError(msg);
      setLastEvent(`error: ${event.error}`);
    };

    recognition.onend = () => {
      if (
        !aliveRef.current ||
        !shouldRestartRef.current ||
        recognitionRef.current !== recognition
      ) {
        return;
      }
      window.setTimeout(() => {
        if (
          !shouldRestartRef.current ||
          recognitionRef.current !== recognition
        ) {
          return;
        }
        try {
          recognition.start();
        } catch {
          /* already running */
        }
      }, 150);
    };

    try {
      recognition.start();
      setListening(true);
      setLastEvent("listening");
    } catch {
      setError("Could not start speech recognition — tap Answer now again.");
      setListening(false);
      shouldRestartRef.current = false;
      recognitionRef.current = null;
    }
  }, []);

  const display = [transcript, interim]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return {
    beginListening,
    endListening,
    transcript,
    interim,
    display,
    error,
    supported,
    listening,
    lastEvent,
  };
}
