// The composed SYNTHETIC entry point: askAssistant with the synthetic model and the synthetic tools, under the configuration's limits,
// and nothing else. It is not a route and is not exposed to the browser.
//
//   configuration (ASSISTANT_ENV must be "synthetic") -> synthetic user + synthetic messages only -> synthetic model + synthetic tools -> Answer
//
// Synthetic mode never touches real user data, and that is enforced here, not promised:
//   - it passes its own tool set EXPLICITLY. The orchestrator would otherwise load the real, database-backed tools for a caller that
//     gives none; this file cannot fall back to them (a test scans for it, and an import-graph test pins that nothing here can load
//     the database client);
//   - it refuses any user id other than SYNTHETIC_USER_ID, before the model or any tool runs, so a real account's id cannot be used;
//   - it refuses any message that does not begin with SYNTHETIC_MESSAGE_PREFIX, so real chat text cannot be sent by accident. (A
//     person can still type the prefix in front of real text: this stops accidents, not deliberate misuse.)
//   - a configuration whose mode is anything but "synthetic" fails closed here too, even if it was built by hand.
import { askAssistant } from "./ask";
import type { AskInput } from "./ask";
import { AssistantConfigError, policyFromConfig } from "./config";
import type { AssistantConfig } from "./config";
import type { ModelCallInfo } from "./model";
import { createSyntheticModel } from "./synthetic-model";
import type { SyntheticScenario } from "./synthetic-model";
import { SYNTHETIC_USER_ID, createSyntheticTools } from "./synthetic-tools";
import type { Answer } from "@/lib/assistant/answer";

/** Every message in synthetic mode must begin with this. */
export const SYNTHETIC_MESSAGE_PREFIX = "[synthetic]";

export const SYNTHETIC_MODE_ERROR_CODES = ["real_user_not_permitted", "message_not_synthetic"] as const;
export type SyntheticModeErrorCode = (typeof SYNTHETIC_MODE_ERROR_CODES)[number];

/** Something that is not synthetic was offered to synthetic mode. It carries a code and a fixed message, never the offending value. */
export class SyntheticModeError extends Error {
  readonly code: SyntheticModeErrorCode;
  constructor(code: SyntheticModeErrorCode) {
    super(code === "real_user_not_permitted" ? "Synthetic mode accepts only the synthetic user." : `Synthetic mode accepts only messages that begin with ${SYNTHETIC_MESSAGE_PREFIX}.`);
    this.name = "SyntheticModeError";
    this.code = code;
  }
}

export type SyntheticRunOptions = {
  scenario: SyntheticScenario;
  /** Called once per model call with metadata only (recipient, model, tokens, duration, outcome). */
  onModelCall?: (info: ModelCallInfo) => void;
};

export async function askSynthetic(config: AssistantConfig, input: AskInput, options: SyntheticRunOptions): Promise<Answer> {
  if (!config.enabled) throw new AssistantConfigError("assistant_disabled");
  if ((config as { env: string }).env !== "synthetic") throw new AssistantConfigError("real_data_mode_not_permitted", ["ASSISTANT_ENV"]);

  // Before anything runs: the user and the words must be synthetic. Any other shape is left for askAssistant to refuse, typed.
  if (typeof input === "object" && input !== null) {
    if (input.userId !== SYNTHETIC_USER_ID) throw new SyntheticModeError("real_user_not_permitted");
    if (Array.isArray(input.userMessages) && !input.userMessages.every((m) => typeof m === "string" && m.startsWith(SYNTHETIC_MESSAGE_PREFIX))) {
      throw new SyntheticModeError("message_not_synthetic");
    }
  }

  return askAssistant(input, {
    model: createSyntheticModel({ scenario: options.scenario, modelId: config.modelId, secret: config.apiKey }),
    tools: createSyntheticTools(),
    modelPolicy: { ...policyFromConfig(config), ...(options.onModelCall === undefined ? {} : { onCall: options.onModelCall }) },
  });
}
