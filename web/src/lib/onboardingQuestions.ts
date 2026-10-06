export interface SurveyQuestion {
  id: string;
  /** May contain `{name}` which is replaced with the subject's first name. */
  text: string;
}

// Onboarding survey — primes the AI interviewer with high-level context.
// All questions are age-neutral so the device works for a teenager, a parent,
// or an 80-year-old grandparent. Avoid presumptions about decades, marital
// status (e.g. "widowed"), career stage, or whether someone has kids.

export const SELF_QUESTIONS: SurveyQuestion[] = [
  { id: "hometown",     text: "Where did you grow up, and what was that place like?" },
  { id: "family",       text: "Tell us a little about the family you grew up with." },
  { id: "work",         text: "What kind of work, school, or projects fill your days right now?" },
  { id: "people",       text: "Who are the people closest to you in life?" },
  { id: "memory",       text: "What's an early memory of yours that still feels vivid?" },
  { id: "turning",      text: "What's a moment that changed how you see the world?" },
  { id: "passion",      text: "What do you love doing when you have free time?" },
  { id: "background",   text: "What cultural, religious, or family heritage shapes who you are?" },
  { id: "place",        text: "What place in the world holds the most meaning to you, and why?" },
  { id: "share",        text: "What's a story or lesson you most want preserved for the people you love?" },
];

export const OTHER_QUESTIONS: SurveyQuestion[] = [
  { id: "hometown",     text: "Where did {name} grow up, and what was that place like?" },
  { id: "family",       text: "Tell us a little about the family {name} grew up with." },
  { id: "work",         text: "What kind of work, school, or projects has {name} been part of?" },
  { id: "people",       text: "Who are the people closest to {name}?" },
  { id: "memory",       text: "What's a story from {name}'s life that gets told over and over?" },
  { id: "turning",      text: "What's a moment that changed how {name} sees the world?" },
  { id: "passion",      text: "What does {name} most love spending time on?" },
  { id: "background",   text: "What cultural, religious, or family heritage shapes who {name} is?" },
  { id: "place",        text: "What place in the world holds the most meaning to {name}, and why?" },
  { id: "share",        text: "What's a story or lesson {name} most wants preserved for the people they love?" },
];

// Stable semantic keys for survey_answers (same for self/other paths).
// devices.survey_answers is keyed by these, e.g. { hometown: "...", family: "..." },
// so consumers (the AI interviewer) prompt against named fields, not positions.
export const QUESTION_IDS = SELF_QUESTIONS.map((q) => q.id);

/**
 * Returns the 10 question strings for a given path, with `{name}` replaced.
 * Falls back to "them" if name is empty.
 */
export function getQuestions(setupFor: "self" | "other", name: string): string[] {
  const base = setupFor === "self" ? SELF_QUESTIONS : OTHER_QUESTIONS;
  const display = name.trim() || "them";
  return base.map((q) => q.text.replace(/\{name\}/g, display));
}
