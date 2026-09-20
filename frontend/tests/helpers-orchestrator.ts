// Fixtures shared by the orchestrator tests: the scripted fake model, stub tools that record every call, and small builders.
// PURE: it imports no database client and loads no environment, so a test built only on it needs no DATABASE_URL (a test pins
// that). Tests that run the REAL tool wrappers live in *.db.test.ts files and add their own imports.
import assert from "node:assert/strict";
import { OrchestratorError } from "../services/assistant/orchestrator";
import type { OrchestratorErrorCode } from "../services/assistant/orchestrator";
import { parseToolArguments } from "../services/assistant/model";
import type { ModelAdapter, ModelRequest, ModelResponse } from "../services/assistant/model";
import { ASSISTANT_TOOL_NAMES } from "../lib/assistant/tool-contract";
import type { ToolName } from "../lib/assistant/tool-contract";
import type { createAssistantTools, ToolResult } from "../services/assistant/tools";
import type { TaxEvidence } from "../services/tax-retrieval";

export const USER = "8f3a1c0e-5b7d-4c1a-9e2f-0a1b2c3d4e5f";
export type AssistantTools = ReturnType<typeof createAssistantTools>;

/** The Phase 6C style fake: scripted responses in order, and a record of every request (cloned, so later changes cannot rewrite it). */
export function scriptedModel(...responses: unknown[]): ModelAdapter & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    complete: async (request) => {
      requests.push(structuredClone(request));
      if (responses.length === 0) throw new Error("the script ran out");
      return responses.shift() as ModelResponse;
    },
  };
}
/** A model that never stops asking for tools. */
export function insistentModel(makeCalls: (round: number) => unknown): ModelAdapter & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    complete: async (request) => {
      requests.push(structuredClone(request));
      return { kind: "tool_calls", calls: makeCalls(requests.length) } as ModelResponse;
    },
  };
}

export const call = (id: string, name: string, args: unknown) => ({ id, name, arguments: parseToolArguments(JSON.stringify(args)) });
export const toolCalls = (...calls: unknown[]) => ({ kind: "tool_calls", calls });
export const text = (t: string) => ({ kind: "text", text: t });
export const ask = (content = "Help me.") => [{ role: "user" as const, content }];

export type Recorded = { tool: ToolName; userId: unknown; args: unknown };
/** Stub tools that record every invocation and return a canned envelope. Nothing here can touch a database. */
export function stubTools(results: Partial<Record<ToolName, ToolResult<unknown>>> = {}): { tools: AssistantTools; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const tools = Object.fromEntries(
    ASSISTANT_TOOL_NAMES.map((name) => [
      name,
      async (userId: unknown, args: unknown) => {
        calls.push({ tool: name, userId, args });
        return results[name] ?? { status: "ok", tool: name, result: { stub: name } };
      },
    ]),
  ) as unknown as AssistantTools;
  return { tools, calls };
}

export const errorCode = async (work: () => Promise<unknown>): Promise<OrchestratorError> => {
  try {
    await work();
  } catch (error) {
    assert.ok(error instanceof OrchestratorError, `expected an OrchestratorError, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: "expected the orchestrator to reject" });
};
export const rejectsWith = async (code: OrchestratorErrorCode, work: () => Promise<unknown>) => {
  const error = await errorCode(work);
  assert.equal(error.code, code, error.message);
  return error;
};

export const taxBody = { assessmentYear: "2026-27", ageCategory: "below60", income: { salaryPaise: 150_000_000 }, deductions: { section80CPaise: 15_000_000 } };

export const evidence = (n: number): TaxEvidence => ({
  evidenceId: `ev_${String(n).padStart(16, "0")}`, chunkId: `chunk-${n}`, sourceKey: "s", title: "t", publisher: "p", url: "https://x.gov.in/", authorityTier: "official_guidance",
  sectionRef: "87A", quote: `quote ${n}`, assessmentYear: "2026-27", effectiveFrom: null, retrievedAt: "2026-09-19T00:00:00.000Z", corpusVersion: "v1", verificationStatus: "primary_verified", score: 1,
});
