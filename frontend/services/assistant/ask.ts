// The safe, composed, SERVER-SIDE entry point to the assistant: the one function a future route should call.
//
//   trusted caller input -> runAssistant -> the FULL tool results (server-side) -> buildAnswer -> the validated Answer, and only that
//
// It is not a route, it is not exposed to the browser, and it has no provider: the model is whatever ModelAdapter the caller
// passes. What it guarantees, each pinned by tests/assistant-ask.test.ts:
//   - What comes back is an `Answer` (lib/assistant/answer.ts) and nothing else. The orchestrator's own result (the model's raw
//     text, the tool activity) is never returned, so raw model text cannot reach a caller without passing every answer rule.
//   - The person's own words are the only conversation input. There is no field for an assistant, tool or system message, so a
//     caller cannot smuggle one in to make a figure look trusted; a message that is not a plain string is refused before the
//     model is called. Every turn the model sees is a user turn, and only those turns are used to ground the answer.
//   - The userId is the caller's. It is never an argument the model or the person's words can change.
//   - An unexpected failure (a database error in a tool, a provider's own error) leaves as a sanitised AssistantFailure: a code,
//     a class name and a database code, never a message, a statement, a bound parameter or a raw tool result. Typed errors that
//     mean something (OrchestratorError, NotAuthenticatedError, an AssistantFailure from the tools, and a ModelProviderError, which
//     has only a code and a fixed message) pass through unchanged.
//   - The model calls run under `modelPolicy` when the caller supplies one: a per-call timeout, a total run budget, an output-size
//     limit and an approved-recipient allow-list. None is set by default; services/assistant/synthetic.ts sets all of them.
// It logs nothing.
import { OrchestratorError, runAssistant } from "./orchestrator";
import type { ModelRunPolicy, OrchestratorOptions } from "./orchestrator";
import { MAX_MESSAGE_CHARS, ModelProviderError } from "./model";
import type { ModelAdapter } from "./model";
import { AnswerInputError, buildAnswer } from "@/lib/assistant/answer";
import type { Answer, ToolRecord } from "@/lib/assistant/answer";
import { AssistantFailure } from "@/lib/assistant/failure";
import { NotAuthenticatedError } from "../errors";

/** The most turns of the person's own words one call accepts. */
export const MAX_USER_MESSAGES = 20;

export type AskInput = {
  /** The authenticated user's id, from the server's own session. Never from a request body and never from the model. */
  userId: string;
  /** What the person typed, oldest first, as plain text. There is no way to pass an assistant, tool or system message. */
  userMessages: readonly string[];
};

export type AskDeps = {
  model: ModelAdapter;
  /** The tool set. Defaults to the real one; tests inject stubs. Code's choice, never the model's. */
  tools?: OrchestratorOptions["tools"];
  /** Timeout, total run budget, output size and approved recipients for the model calls (see ModelRunPolicy). None is set by default. */
  modelPolicy?: ModelRunPolicy;
};

function readInput(input: unknown): { userId: string; userMessages: string[] } {
  const bad = (message: string) => new OrchestratorError("invalid_input", message);
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw bad("The input must be an object with a userId and the person's messages.");
  const keys = Object.keys(input);
  if (keys.length !== 2 || !keys.includes("userId") || !keys.includes("userMessages")) {
    throw bad("The input may only have a userId and userMessages: there is no way to send an assistant, tool or system message.");
  }
  const { userId, userMessages } = input as Record<string, unknown>;
  if (typeof userId !== "string" || userId.trim() === "") throw new NotAuthenticatedError();
  if (!Array.isArray(userMessages) || userMessages.length < 1 || userMessages.length > MAX_USER_MESSAGES) {
    throw bad(`userMessages must be a list of 1 to ${MAX_USER_MESSAGES} of the person's own messages.`);
  }
  userMessages.forEach((message, i) => {
    if (typeof message !== "string" || message.trim() === "" || message.length > MAX_MESSAGE_CHARS) {
      throw bad(`userMessages[${i}] must be the person's own words, as text of 1 to ${MAX_MESSAGE_CHARS} characters.`);
    }
  });
  return { userId, userMessages: [...(userMessages as string[])] };
}

/** Typed errors keep their meaning; anything else is reduced to a code and a class name. */
function boundary(error: unknown): Error {
  if (error instanceof OrchestratorError || error instanceof NotAuthenticatedError || error instanceof AssistantFailure || error instanceof AnswerInputError || error instanceof ModelProviderError) return error;
  return new AssistantFailure("unexpected_failure", error);
}

export async function askAssistant(input: AskInput, deps: AskDeps): Promise<Answer> {
  try {
    const { userId, userMessages } = readInput(input);
    const records: ToolRecord[] = [];
    const run = await runAssistant(
      { userId, messages: userMessages.map((content) => ({ role: "user" as const, content })) },
      {
        model: deps.model,
        ...(deps.tools === undefined ? {} : { tools: deps.tools }),
        ...(deps.modelPolicy === undefined ? {} : { modelPolicy: deps.modelPolicy }),
        // A deep copy of each full result, for buildAnswer alone: it is never logged, returned or put in an error.
        onToolResult: (record) => {
          records.push({ round: record.round, callId: record.callId, tool: record.tool, result: record.result });
        },
      },
    );
    return buildAnswer({ text: run.text, toolRecords: records, userMessages });
  } catch (error) {
    throw boundary(error);
  }
}
