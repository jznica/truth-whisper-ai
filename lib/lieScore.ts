/** Playful heuristics from expression probs + voice variability — not scientific lie detection. */

export type ExpressionMap = Record<string, number>;

/** Maps FaceAPI `FaceExpressions` fields into a plain record. */
export function expressionsToMap(e: {
  neutral: number;
  happy: number;
  sad: number;
  angry: number;
  fearful: number;
  disgusted: number;
  surprised: number;
}): ExpressionMap {
  return {
    neutral: e.neutral,
    happy: e.happy,
    sad: e.sad,
    angry: e.angry,
    fearful: e.fearful,
    disgusted: e.disgusted,
    surprised: e.surprised,
  };
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Higher = more "tense" / incongruent-looking face for the demo. */
export function faceTensionFromExpressions(expr: ExpressionMap): number {
  const g = (k: string) => expr[k] ?? 0;
  const neutral = g("neutral");
  const happy = g("happy");
  const fear = g("fearful");
  const surprise = g("surprised");
  const angry = g("angry");
  const disgusted = g("disgusted");
  const sad = g("sad");

  const negative =
    0.34 * (fear + surprise) +
    0.22 * (angry + disgusted) +
    0.14 * sad +
    0.12 * (1 - neutral);
  const calm = 0.28 * happy + 0.12 * neutral;
  return clamp01(negative - calm + 0.35);
}

/**
 * Instantaneous mic loudness for display (0–1).
 * Float32 PCM RMS is typically ~0.01–0.25 for normal speech.
 */
export function hearingLevelFromRms(rms: number): number {
  if (rms < 1e-9) return 0;
  return clamp01(rms / 0.2);
}

/** Voice "jitter": variability of loudness (RMS), normalized 0–1. */
export function voiceStressFromRmsSeries(rms: number[]): number {
  if (rms.length < 4) return 0;
  const mean = rms.reduce((a, b) => a + b, 0) / rms.length;
  if (mean < 1e-6) return 0;
  const variance =
    rms.reduce((acc, x) => acc + (x - mean) ** 2, 0) / rms.length;
  const cv = Math.sqrt(variance) / mean;
  /* Slightly more sensitive so normal speech isn’t always “flat truth”. */
  return clamp01(cv / 0.92);
}

export function dominantExpression(expr: ExpressionMap): string {
  let best = "neutral";
  let max = -1;
  for (const [k, v] of Object.entries(expr)) {
    if (v > max) {
      max = v;
      best = k;
    }
  }
  return best;
}

export function verdictFromSignals(faceTension: number, voiceStress: number): {
  verdict: "truth" | "lie";
  combined: number;
} {
  const combined = clamp01(0.5 * faceTension + 0.5 * voiceStress);
  return {
    combined,
    /* Slightly below 0.5 so “medium” stress can read as lie more often. */
    verdict: combined >= 0.46 ? "lie" : "truth",
  };
}
