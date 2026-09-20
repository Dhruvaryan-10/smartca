// The provider-neutral model interface for the future assistant. It is a SHAPE and a set of guards, nothing more:
//
//   a conversation goes in  ->  final text, or tool calls (a name + JSON arguments), comes out
//
// What this file is not, on purpose, and what a test pins by checking that it has no imports at all:
//   - It knows no provider, no SDK, no endpoint and no credential. Which provider or router sits behind it is
//     UNDECIDED: the project has named OmniRoute but not specified what it is (see SECURITY.md, "Open decisions"), so nothing
//     is invented here. A future provider is one small `ModelAdapter` implementation.
//   - It knows none of SmartCA's tools. A tool is only a name, a description and a JSON schema the caller supplies; the
//     definitions of SmartCA's own tools live elsewhere, and this file never runs one.
//   - It has no database, no tax calculation and no authorization. A request has no user field, and the guards below are strict
//     allow-lists of field NAMES: a `userId` field on a request, a message or a tool declaration is refused by name (in an error
//     that clips the name). What they do NOT do is read text: a user id typed into a message's content, or written into a
//     tool's JSON schema, is not detected here. Keeping it out of the conversation is the orchestrator's job (it never sends
//     one) and the caller's.
//
// Tool arguments arrive from a model as text and can be broken. They are therefore carried as a two-way union: parsed
// (`json`, always an object) or `malformed` (a bounded excerpt and a reason). There is deliberately no way to hold
// unparsed text as if it were parsed; whoever consumes a call must handle `malformed`, and every tool validates its
// own arguments regardless.

// ---------------------------------------------------------------------
// The interface
// ---------------------------------------------------------------------

export type JsonObject = Record<string, unknown>;

export type ToolArguments =
  | { kind: "json"; value: JsonObject }
  /** `raw` is only a short excerpt, never the whole text; do not log it: it can echo whatever the model was given. */
  | { kind: "malformed"; raw: string; error: string };

export type ModelToolCall = { id: string; name: string; arguments: ToolArguments };

/** A tool as the model sees it: a name, what it is for, and a JSON schema for its arguments. Supplied by the caller. */
export type ModelToolDeclaration = { name: string; description: string; parameters: JsonObject };

export type ModelMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ModelToolCall[] }
  /** The result of a tool call, as text, answering the call with this id. */
  | { role: "tool"; toolCallId: string; name: string; content: string };

export type ModelRequest = { messages: ModelMessage[]; tools?: ModelToolDeclaration[] };

export type ModelResponse = { kind: "text"; text: string } | { kind: "tool_calls"; calls: ModelToolCall[] };

export interface ModelAdapter {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

// ---------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------

export const MAX_MESSAGES = 100;
export const MAX_MESSAGE_CHARS = 50_000;
export const MAX_TOOLS = 20;
export const MAX_TOOL_CALLS_PER_RESPONSE = 8;
export const MAX_TOOL_ARGUMENT_CHARS = 20_000;
const MAX_RAW_EXCERPT_CHARS = 500;
const MAX_ERROR_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 1_000;
const MAX_ID_CHARS = 128;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

// ---------------------------------------------------------------------
// Tool arguments from a model's text
// ---------------------------------------------------------------------

const malformed = (raw: string, error: string): ToolArguments => ({ kind: "malformed", raw: raw.slice(0, MAX_RAW_EXCERPT_CHARS), error });

/**
 * A model's argument text -> `json` (a parsed OBJECT) or `malformed`. Anything that is not a JSON object is malformed:
 * empty text, broken JSON, an array, a number, null, and text too large to be arguments (not parsed at all). This is what
 * a provider implementation should call on whatever text its provider returns for a tool call.
 */
export function parseToolArguments(raw: string): ToolArguments {
  if (typeof raw !== "string") return malformed("", "The arguments are not text.");
  if (raw.length > MAX_TOOL_ARGUMENT_CHARS) return malformed(raw, "The arguments are too large to accept.");
  if (raw.trim() === "") return malformed(raw, "The arguments are empty.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return malformed(raw, "The arguments are not valid JSON.");
  }
  if (!isPlainObject(parsed)) return malformed(raw, "The arguments must be a JSON object.");
  return { kind: "json", value: parsed };
}

// ---------------------------------------------------------------------
// Guards: strict allow-lists for what goes in and what comes out
// ---------------------------------------------------------------------

export class ModelRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelRequestError";
  }
}

export class ModelResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelResponseError";
  }
}

type Fail = (message: string) => never;
const failRequest: Fail = (message) => {
  throw new ModelRequestError(message);
};
const failResponse: Fail = (message) => {
  throw new ModelResponseError(message);
};

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A name a model or provider chose, made safe to put in an error message: printable ASCII only (a newline cannot forge a log
 * line) and at most 40 characters (a field name can be as long as the whole argument text). The full name is never echoed.
 */
function shown(name: string): string {
  const printable = name.replace(/[^\x20-\x7e]/g, "?");
  return printable.length > 40 ? `${printable.slice(0, 40)}…` : printable;
}

function object(value: unknown, where: string, allowed: readonly string[], fail: Fail): JsonObject {
  if (!isPlainObject(value)) return fail(`${where} must be an object.`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return fail(`${where}: the field "${shown(key)}" is not accepted.`);
  }
  return value;
}

function text(value: unknown, where: string, max: number, fail: Fail, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && value.trim() === "")) {
    return fail(`${where} must be text of ${allowEmpty ? 0 : 1} to ${max} characters.`);
  }
  return value;
}

function toolName(value: unknown, where: string, fail: Fail): string {
  if (typeof value !== "string" || !TOOL_NAME.test(value)) return fail(`${where} must be a lower-case tool name such as "search_thing".`);
  return value;
}

function toolArguments(value: unknown, where: string, fail: Fail): ToolArguments {
  const args = object(value, where, ["kind", "value", "raw", "error"], fail);
  if (args.kind === "json") {
    object(args, where, ["kind", "value"], fail);
    if (!isPlainObject(args.value)) return fail(`${where}.value must be a JSON object.`);
    let size: number;
    try {
      size = JSON.stringify(args.value).length;
    } catch {
      return fail(`${where}.value is not JSON.`);
    }
    if (size > MAX_TOOL_ARGUMENT_CHARS) return fail(`${where}.value is too large.`);
    return { kind: "json", value: args.value };
  }
  if (args.kind === "malformed") {
    object(args, where, ["kind", "raw", "error"], fail);
    return {
      kind: "malformed",
      raw: text(args.raw, `${where}.raw`, MAX_RAW_EXCERPT_CHARS, fail, true),
      error: text(args.error, `${where}.error`, MAX_ERROR_CHARS, fail),
    };
  }
  return fail(`${where}.kind must be "json" or "malformed": raw argument text is not accepted.`);
}

function toolCalls(value: unknown, where: string, max: number, fail: Fail): ModelToolCall[] {
  if (!Array.isArray(value) || value.length > max) return fail(`${where} must be a list of at most ${max} tool calls.`);
  const seen = new Set<string>();
  return value.map((entry, i) => {
    const at = `${where}[${i}]`;
    const call = object(entry, at, ["id", "name", "arguments"], fail);
    const id = text(call.id, `${at}.id`, MAX_ID_CHARS, fail);
    if (seen.has(id)) return fail(`${where}: the tool call id "${shown(id)}" is used twice.`);
    seen.add(id);
    return { id, name: toolName(call.name, `${at}.name`, fail), arguments: toolArguments(call.arguments, `${at}.arguments`, fail) };
  });
}

function message(value: unknown, i: number): ModelMessage {
  const where = `messages[${i}]`;
  const role = isPlainObject(value) ? value.role : undefined;
  if (role === "system" || role === "user") {
    const m = object(value, where, ["role", "content"], failRequest);
    return { role, content: text(m.content, `${where}.content`, MAX_MESSAGE_CHARS, failRequest) };
  }
  if (role === "assistant") {
    const m = object(value, where, ["role", "content", "toolCalls"], failRequest);
    const content = text(m.content, `${where}.content`, MAX_MESSAGE_CHARS, failRequest, true);
    return m.toolCalls === undefined
      ? { role, content }
      : { role, content, toolCalls: toolCalls(m.toolCalls, `${where}.toolCalls`, MAX_TOOL_CALLS_PER_RESPONSE, failRequest) };
  }
  if (role === "tool") {
    const m = object(value, where, ["role", "toolCallId", "name", "content"], failRequest);
    return {
      role,
      toolCallId: text(m.toolCallId, `${where}.toolCallId`, MAX_ID_CHARS, failRequest),
      name: toolName(m.name, `${where}.name`, failRequest),
      content: text(m.content, `${where}.content`, MAX_MESSAGE_CHARS, failRequest, true),
    };
  }
  return failRequest(`${where}.role must be "system", "user", "assistant" or "tool".`);
}

/** Strictly checks a request: only `messages` and `tools`, well-formed and bounded. Anything else, a user id included, is refused by name. */
export function assertModelRequest(value: unknown): ModelRequest {
  const request = object(value, "request", ["messages", "tools"], failRequest);
  if (!Array.isArray(request.messages) || request.messages.length < 1 || request.messages.length > MAX_MESSAGES) {
    return failRequest(`messages must be a list of 1 to ${MAX_MESSAGES} messages.`);
  }
  const messages = request.messages.map(message);

  if (request.tools === undefined) return { messages };
  if (!Array.isArray(request.tools) || request.tools.length > MAX_TOOLS) return failRequest(`tools must be a list of at most ${MAX_TOOLS} tools.`);
  const names = new Set<string>();
  const tools = request.tools.map((entry, i): ModelToolDeclaration => {
    const where = `tools[${i}]`;
    const tool = object(entry, where, ["name", "description", "parameters"], failRequest);
    const name = toolName(tool.name, `${where}.name`, failRequest);
    if (names.has(name)) return failRequest(`tools: "${name}" is declared twice.`);
    names.add(name);
    if (!isPlainObject(tool.parameters)) return failRequest(`${where}.parameters must be a JSON schema object.`);
    return { name, description: text(tool.description, `${where}.description`, MAX_DESCRIPTION_CHARS, failRequest), parameters: tool.parameters };
  });
  return { messages, tools };
}

/** Strictly checks what a provider returned: final text, or 1 to 8 tool calls whose arguments are in the safe two-way form. */
export function assertModelResponse(value: unknown): ModelResponse {
  const kind = isPlainObject(value) ? value.kind : undefined;
  if (kind === "text") {
    const response = object(value, "response", ["kind", "text"], failResponse);
    return { kind, text: text(response.text, "response.text", MAX_MESSAGE_CHARS, failResponse) };
  }
  if (kind === "tool_calls") {
    const response = object(value, "response", ["kind", "calls"], failResponse);
    const calls = toolCalls(response.calls, "response.calls", MAX_TOOL_CALLS_PER_RESPONSE, failResponse);
    if (calls.length === 0) return failResponse("response.calls must contain at least one tool call.");
    return { kind, calls };
  }
  return failResponse('response.kind must be "text" or "tool_calls".');
}

/**
 * Wraps any adapter so that an invalid request never reaches it and an invalid answer never leaves it. A provider's own
 * failure is not caught: it propagates to whoever is orchestrating.
 */
export function withModelGuard(inner: ModelAdapter): ModelAdapter {
  return { complete: async (request) => assertModelResponse(await inner.complete(assertModelRequest(request))) };
}
