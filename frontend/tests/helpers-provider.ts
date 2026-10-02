// A deterministic, RECORDING test provider: a ProviderDriver (services/assistant/provider.ts) whose wire format is plain JSON and whose
// transport is an in-memory script. TEST-ONLY: it keeps what it records in memory for the test that created it, writes nothing and
// contacts nothing. PURE: no database, no network (the hermetic test lists it as a pure helper).
//
// It records exactly what crossed the provider boundary: the URL, the headers, the raw body, and the parsed body (the model id, the
// messages, including every tool result as the model was sent it, the tool definitions offered, and the output-token cap the adapter
// handed the driver).
import { parseToolArguments } from "../services/assistant/model";
import type { ModelMessage, ModelRequest, ModelToolDeclaration } from "../services/assistant/model";
import type { ProviderDriver, ProviderWireRequest } from "../services/assistant/provider";

export type ScriptedReply =
  | { kind: "text"; text: string }
  | { kind: "tool_calls"; calls: Array<{ id: string; name: string; args: unknown }> };

/** One scripted answer from the provider, in the order calls arrive. */
export type WireStep =
  | { reply: ScriptedReply | Record<string, unknown>; model?: string; inputTokens?: number; outputTokens?: number; status?: number }
  | { status: number; body: string }
  | { throws: string }
  | { hang: true };

export type RecordedWireCall = {
  url: string;
  headers: Record<string, string>;
  body: string;
  sent: { model: string; maxOutputTokens: number; maxOutputChars?: number; messages: ModelMessage[]; tools: ModelToolDeclaration[] };
  timeoutMs?: number;
  hadSignal: boolean;
};

export const DEFAULT_REPLY: ScriptedReply = { kind: "text", text: "Here is what I can help with." };

export function testProvider(...steps: WireStep[]): { driver: ProviderDriver; calls: RecordedWireCall[] } {
  const calls: RecordedWireCall[] = [];
  const driver: ProviderDriver = {
    encode: (request: ModelRequest, target) =>
      JSON.stringify({ model: target.modelId, maxOutputTokens: target.maxOutputTokens, ...(target.maxOutputChars === undefined ? {} : { maxOutputChars: target.maxOutputChars }), messages: request.messages, tools: request.tools ?? [] }),
    decode: (body: string) => {
      const parsed = JSON.parse(body) as { reply: Record<string, unknown>; model?: string; inputTokens?: number; outputTokens?: number };
      const reply = parsed.reply;
      const response =
        reply.kind === "tool_calls" && Array.isArray(reply.calls)
          ? { kind: "tool_calls", calls: (reply.calls as Array<{ id: string; name: string; args: unknown }>).map((c) => ({ id: c.id, name: c.name, arguments: parseToolArguments(JSON.stringify(c.args)) })) }
          : reply;
      return {
        response,
        ...(parsed.model === undefined ? {} : { model: parsed.model }),
        ...(parsed.inputTokens === undefined ? {} : { inputTokens: parsed.inputTokens }),
        ...(parsed.outputTokens === undefined ? {} : { outputTokens: parsed.outputTokens }),
      };
    },
    // Like the real driver: the model and counts the body states, judging nothing; a body naming no model states no usage.
    readUsage: (body: string) => {
      try {
        const parsed = JSON.parse(body) as { model?: unknown; inputTokens?: unknown; outputTokens?: unknown };
        if (typeof parsed?.model !== "string") return undefined;
        const whole = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
        const [inputTokens, outputTokens] = [whole(parsed.inputTokens), whole(parsed.outputTokens)];
        if (inputTokens === undefined && outputTokens === undefined) return undefined;
        return { model: parsed.model, ...(inputTokens === undefined ? {} : { inputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) };
      } catch {
        return undefined;
      }
    },
    authHeaders: (apiKey) => ({ authorization: `Bearer ${apiKey.reveal()}` }),
    transport: async (request: ProviderWireRequest) => {
      calls.push({
        url: request.url,
        headers: { ...request.headers },
        body: request.body,
        sent: JSON.parse(request.body),
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
        hadSignal: request.signal !== undefined,
      });
      const step = steps.shift() ?? { reply: DEFAULT_REPLY };
      if ("throws" in step) throw new Error(`${step.throws} (sent with ${request.headers.authorization ?? "no header"})`);
      if ("hang" in step) return new Promise(() => undefined);
      if ("body" in step) return { status: step.status, body: step.body };
      const { reply, status, ...meta } = step;
      return { status: status ?? 200, body: JSON.stringify({ reply, ...meta }) };
    },
  };
  return { driver, calls };
}

/** Every tool message the provider was sent, across all calls, in order. */
export const toolMessagesSent = (calls: RecordedWireCall[]) =>
  calls.flatMap((c) => c.sent.messages.filter((m): m is Extract<ModelMessage, { role: "tool" }> => m.role === "tool"));
