// The composed EXTERNAL entry point: askAssistant for a real, external model, under the person's explicit authorization. It is not a
// route, it is not exposed to the browser, and it chooses no provider: the provider-specific wire parts are a ProviderDriver the server
// passes, and WHERE a request goes (endpoint, model id, key, the one approved recipient) comes only from the configuration
// (provider.ts). Nothing can reach it today, because readAssistantConfig refuses every ASSISTANT_ENV but "synthetic", so no
// configuration it produces has env "external".
//
//   server: config (env "external", exactly one approved recipient) + session userId + stored authorization + ProviderDriver
//     -> planModelAccess(EXTERNAL_PROFILE, authorization, { userId, recipient: the configured one, now }, config.approvedRecipients)
//     -> createProviderAdapter(config, driver)    (only after the plan: an unauthorized request never builds or calls a provider)
//     -> askAssistant(input, { model, allowedTools, visibleClasses, modelPolicy: limits + approvedRecipients = [the authorized one] })
//     -> runAssistant -> withModelGuard -> checkCall -> the real read-only tools -> egress filter -> model -> buildAnswer -> Answer
//
// What it guarantees, each pinned by tests/assistant-external.test.ts and tests/assistant-external.db.test.ts:
//   - The profile is chosen HERE, by code: EXTERNAL_PROFILE. There is no profile parameter, and the input contract is askAssistant's
//     own (a userId and the person's messages, nothing else), so neither a request nor the model can choose or widen it. An
//     authorization given for another profile is refused (profile_mismatch).
//   - Nothing is sent without the person's explicit authorization: consent, the data classes, the recipient and the validity window
//     are all checked (lib/assistant/authorization.ts) BEFORE the model is called or any tool runs.
//   - The recipient, endpoint and model are the configuration's: a caller cannot name, add or replace them (there is no parameter for
//     any of them). The recipient must also be the one the person authorized, and the model guard checks every response against it,
//     with the configuration's timeout, run budget and output limit.
//   - The model is told about, and may call, only the plan's tools, and it is shown only the plan's classes of each tool result.
//   - The real tool set is used: there is no tools parameter, so this entry point cannot be pointed at other tools.
// It logs nothing and persists nothing; the plan's audit record is available to a future audit log through `onAccessPlanned`.
import { askAssistant } from "./ask";
import type { AskInput } from "./ask";
import { policyFromConfig } from "./config";
import type { AssistantConfig } from "./config";
import type { ModelCallInfo } from "./model";
import type { ToolActivity } from "./orchestrator";
import { createProviderAdapter, readProviderTarget } from "./provider";
import type { ProviderDriver } from "./provider";
import { planModelAccess } from "@/lib/assistant/access-plan";
import type { AccessAuditRecord } from "@/lib/assistant/access-plan";
import { FULL_PROFILE } from "@/lib/assistant/profiles";
import type { AssistantProfile } from "@/lib/assistant/profiles";
import type { Answer } from "@/lib/assistant/answer";
import { NotAuthenticatedError } from "../errors";

/** The one profile an external run uses: the capability-first mode of ADR 0002. Chosen by code, never by a request or the model. */
export const EXTERNAL_PROFILE: AssistantProfile = FULL_PROFILE;

export type ExternalRunOptions = {
  /** The provider's wire parts, chosen by server code (tests pass a recording fake). It never chooses the endpoint, model or recipient. */
  driver: ProviderDriver;
  /** The person's authorization, as the server holds it (lib/assistant/authorization.ts). Absent means no consent. */
  authorization: unknown;
  /** Milliseconds since the epoch; defaults to the server's clock. */
  now?: number;
  /** Metadata about each model call (recipient, model, tokens, duration, outcome), never content. */
  onModelCall?: (info: ModelCallInfo) => void;
  /** Metadata about each tool call that ran (tool, call id, round, outcome, reason), never a result or argument. For audit. */
  onToolActivity?: (activity: ToolActivity) => void;
  /** The plan's audit record, once the run is authorized and before the model is called. Metadata only. */
  onAccessPlanned?: (audit: AccessAuditRecord) => void;
};

export async function askExternal(config: AssistantConfig, input: AskInput, options: ExternalRunOptions): Promise<Answer> {
  // Enabled, external, and exactly one approved recipient: the one every call goes to.
  const { config: target, recipient } = readProviderTarget(config);

  // The user comes from the server's session; without one there is nobody whose authorization could apply.
  const userId = typeof input === "object" && input !== null ? (input as { userId?: unknown }).userId : undefined;
  if (typeof userId !== "string" || userId.trim() === "") throw new NotAuthenticatedError();

  // Consent, validity, binding, profile, classes and recipient, all before anything runs. Throws, typed, on any failure.
  const plan = planModelAccess(
    EXTERNAL_PROFILE,
    options.authorization,
    { userId, recipient, now: options.now ?? Date.now() },
    target.approvedRecipients,
  );
  options.onAccessPlanned?.(plan.audit);

  return askAssistant(input, {
    model: createProviderAdapter(config, options.driver),
    allowedTools: plan.allowedTools,
    visibleClasses: plan.visibleClasses,
    ...(options.onToolActivity === undefined ? {} : { onToolActivity: options.onToolActivity }),
    modelPolicy: {
      ...policyFromConfig(target),
      approvedRecipients: [...plan.approvedRecipients],
      ...(options.onModelCall === undefined ? {} : { onCall: options.onModelCall }),
    },
  });
}
