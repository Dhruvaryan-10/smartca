// STRUCTURED OBSERVABILITY for assistant requests: the events the application service (service.ts) emits to whatever sink the server
// wires in (none by default: this code logs nothing itself). METADATA ONLY: ids, codes, counts, durations, names of tools and classes.
// Never a message, an answer, a tool argument or result, a key, an endpoint, a header, an error's text, or the person's user id (a
// request id and a run id identify the event; the audit row links the run to its user).

export type AssistantEvent =
  | { type: "assistant_request"; requestId: string; at: number }
  | { type: "authorization_failure"; requestId: string; code: string } // not signed in, or consent missing, expired, revoked or not fitting
  | { type: "request_rejected"; requestId: string; code: string } // an unacceptable request, or a disabled or misconfigured assistant
  | { type: "rate_limit_rejection"; requestId: string; code: string }
  | { type: "run_started"; requestId: string; runId: string; profileId: string; recipient: string; modelId: string; allowedTools: readonly string[]; visibleClasses: readonly string[] }
  | { type: "model_call"; requestId: string; runId: string; outcome: string; durationMs: number; inputTokens: number | null; outputTokens: number | null }
  | { type: "tool_call"; requestId: string; runId: string; tool: string; outcome: "ok" | "refused"; reason: string | null }
  | { type: "tool_denial"; requestId: string; runId: string; code: string } // the model asked for a tool it may not use, or with bad arguments
  | { type: "provider_failure"; requestId: string; runId: string; code: string }
  | { type: "timeout"; requestId: string; runId: string; code: string }
  | { type: "audit_failure"; requestId: string; runId: string | null; stage: "begin" | "plan" | "finish" | "reject" }
  | { type: "run_completed"; requestId: string; runId: string; status: "succeeded" | "failed"; code: string | null; answerState: string | null; durationMs: number };

export type AssistantEventSink = (event: AssistantEvent) => void;
