/** Lighthearted prompts — answer out loud for the demo. */

export const QUESTIONS: string[] = [
  "Have you ever said “I’m on my way” when you hadn’t left yet?",
  "Do you actually enjoy pineapple on pizza?",
  "Have you ever laughed at a joke you didn’t get?",
  "Would you let your pet pick your outfit for a day?",
  "Have you ever pretended you were busy to avoid a call?",
  "Do you still think about that one embarrassing moment from years ago?",
  "Would you share your last snack with a stranger?",
  "Have you ever complimented food you didn’t really like?",
  "Do you talk to yourself when nobody’s around?",
  "Would you go back in time to fix one tiny mistake?",
  "Have you ever stayed up “five more minutes” for three hours?",
  "Do you re-read messages before sending them more than once?",
];

export function pickQuestion(exclude?: string): string {
  if (QUESTIONS.length <= 1) return QUESTIONS[0] ?? "";
  let q = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)] ?? "";
  let guard = 0;
  while (q === exclude && guard++ < 20) {
    q = QUESTIONS[Math.floor(Math.random() * QUESTIONS.length)] ?? "";
  }
  return q;
}
