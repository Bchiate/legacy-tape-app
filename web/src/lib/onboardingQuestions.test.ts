import { describe, expect, it } from "vitest";
import { getQuestions, OTHER_QUESTIONS, QUESTION_IDS, SELF_QUESTIONS } from "./onboardingQuestions";

describe("onboarding survey", () => {
  it("asks the same ten questions on both paths, keyed by stable ids", () => {
    expect(QUESTION_IDS).toHaveLength(10);
    expect(OTHER_QUESTIONS.map((q) => q.id)).toEqual(SELF_QUESTIONS.map((q) => q.id));
    expect(new Set(QUESTION_IDS).size).toBe(10);
  });

  it("uses the person's name when setting up for someone else", () => {
    const questions = getQuestions("other", " Rosa ");
    expect(questions[0]).toBe("Where did Rosa grow up, and what was that place like?");
    expect(questions.some((q) => q.includes("{name}"))).toBe(false);
  });

  it("falls back to 'them' without a name", () => {
    expect(getQuestions("other", "")[3]).toBe("Who are the people closest to them?");
  });
});
