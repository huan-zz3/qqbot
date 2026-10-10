import { TypeSafeClient, type EntryType, type Questions } from "@typesafe-ai/sdk";

import { config } from "../config.js";

// Answers are yes-probabilities keyed by question name.
export type Judge = (state: EntryType, questions: Questions) => Promise<Record<string, number>>;

export function createJevJudge(): Judge {
  const client = new TypeSafeClient({
    apiKey: config.jev.apiKey,
    defaultModel: config.jev.model,
    timeout: config.jev.timeoutMs,
    retry: { maxRetries: 1 },
  });
  return async (state, questions) => {
    const result = await client.systemOne({ state, questions });
    const probabilities: Record<string, number> = {};
    for (const [name, answer] of Object.entries(result.answers)) {
      if (answer.type === "noul") probabilities[name] = answer.noul;
    }
    return probabilities;
  };
}
