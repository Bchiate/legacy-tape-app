export type Voice = "male" | "female";

const audioMap: Record<string, Partial<Record<Voice, string[]>>> = {
  childhood: {
    female: [
      "audio/childhood/female-q1.mp3",
      "audio/childhood/female-q2.mp3",
      "audio/childhood/female-q3.mp3",
      "audio/childhood/female-q4.mp3",
      "audio/childhood/female-q5.mp3",
    ],
    male: [
      "audio/childhood/male-q1.mp3",
      "audio/childhood/male-q2.mp3",
      "audio/childhood/male-q3.mp3",
      "audio/childhood/male-q4.mp3",
      "audio/childhood/male-q5.mp3",
    ],
  },
};

export function getQuestionAudio(
  topic: string,
  index: number,
  voice: Voice
): string | null {
  return audioMap[topic]?.[voice]?.[index] ?? null;
}
