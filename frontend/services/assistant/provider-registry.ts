// THE DRIVER REGISTRY: which ProviderDriver serves an external configuration, chosen by the configuration's MODEL_WIRE_FORMAT and nothing
// else (docs/decisions/0004). It is the one place that turns a format NAME into wire details, so the generic configuration
// (config.ts), the provider boundary (provider.ts) and the service never name a wire field.
//
//   "openai-chat-completions"            -> Chat Completions driver, cap sent as max_completion_tokens (OpenAI's current field)
//   "openai-chat-completions-max-tokens" -> Chat Completions driver, cap sent as max_tokens (compatible servers that need the older field)
//
// A driver never decides the endpoint, model, key, recipient or limits (provider.ts takes those from the configuration). A format that is
// not listed fails closed, naming the variable and never its value. Only the application service calls this (a layering test pins it).
import { AssistantConfigError, isModelWireFormat } from "./config";
import type { ExternalAssistantConfig, ModelWireFormat } from "./config";
import type { ProviderDriver } from "./provider";
import { chatCompletionsDriver } from "./provider-chat-completions";
import type { ChatCompletionsTokenField, FetchLike } from "./provider-chat-completions";

const CHAT_COMPLETIONS_FIELD: Readonly<Record<ModelWireFormat, ChatCompletionsTokenField>> = Object.freeze({
  "openai-chat-completions": "max_completion_tokens",
  "openai-chat-completions-max-tokens": "max_tokens",
});

/** The driver for an external configuration's wire format. `fetch` is for tests only; production uses the platform's. */
export function providerDriverFor(config: Pick<ExternalAssistantConfig, "wireFormat">, options: { fetch?: FetchLike } = {}): ProviderDriver {
  const format: unknown = config.wireFormat;
  if (!isModelWireFormat(format)) throw new AssistantConfigError("invalid_configuration", ["MODEL_WIRE_FORMAT"]);
  return chatCompletionsDriver({ tokenField: CHAT_COMPLETIONS_FIELD[format], ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
}
