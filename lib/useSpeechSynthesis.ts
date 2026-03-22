"use client";

import { startTransition, useCallback, useEffect, useState } from "react";

export function useSpeechSynthesis() {
  const [speaking, setSpeaking] = useState(false);
  /** null until mounted — avoids SSR/client mismatch for speechSynthesis. */
  const [supported, setSupported] = useState<boolean | null>(null);

  useEffect(() => {
    startTransition(() => {
      setSupported(typeof window.speechSynthesis !== "undefined");
    });
    return () => {
      window.speechSynthesis?.cancel();
    };
  }, []);

  const speak = useCallback((text: string) => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = navigator.language || "en-US";
    u.rate = 0.92;
    u.pitch = 1;
    u.onstart = () => setSpeaking(true);
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    window.speechSynthesis.speak(u);
  }, []);

  const cancel = useCallback(() => {
    if (typeof window === "undefined") return;
    window.speechSynthesis?.cancel();
    setSpeaking(false);
  }, []);

  return { speak, cancel, speaking, supported };
}
