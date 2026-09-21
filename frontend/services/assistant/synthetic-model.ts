// The SYNTHETIC model transport: a ModelAdapter that answers from deterministic fixtures and does nothing else. It has no network
// call, no endpoint, no environment read, no file, no database and no provider. It is a pure function of the request it is given,
// so the same request always gets the same response (a test pins that).
//
// It exists to validate the provider boundary (timeout, size limit, recipient allow-list, typed errors, metadata, the tool round
// trip, the answer layer) before any real provider is connected. It never sees real data: it is only ever run with the synthetic
// tool set and synthetic messages (services/assistant/synthetic.ts).
//
// A scenario is chosen when the transport is built; it does not read the person's words to choose one:
//   honest       plain, calc, law, compare, simulate, summary, disabled-tool
//   misbehaving  wrong-figure, invented-citation, recommend-regime     (texts the answer layer must withhold)
//   transport    hang, oversized, foreign-recipient, no-metadata, rate-limited, leaky-error     (faults the guard must contain)
// "leaky-error" throws an error that CONTAINS the configured key on purpose, so the boundary can be shown to keep it out of every
// error, log and result. The key is otherwise never used: this transport authenticates to nothing.
import { ModelProviderError, parseToolArguments } from "./model";
import type { ModelAdapter, ModelCallOptions, ModelMessage, ModelRequest, ModelResponse, ModelToolCall } from "./model";
import type { Secret } from "./config";
import { SYNTHETIC_CALC_ARGS, SYNTHETIC_SEARCH_ARGS, SYNTHETIC_SIMULATE_ARGS, SYNTHETIC_TAX_BODY } from "./synthetic-tools";

/** The recipient id the synthetic transport reports. It must be on MODEL_APPROVED_RECIPIENTS, like any other recipient. */
export const SYNTHETIC_RECIPIENT = "synthetic-local";
export const SYNTHETIC_MODEL_ID = "synthetic-fixture-v1";

export const SYNTHETIC_SCENARIOS = [
  "plain", "calc", "law", "compare", "simulate", "summary", "disabled-tool",
  "wrong-figure", "invented-citation", "recommend-regime",
  "hang", "oversized", "foreign-recipient", "no-metadata", "rate-limited", "leaky-error",
] as const;
export type SyntheticScenario = (typeof SYNTHETIC_SCENARIOS)[number];

export type SyntheticModelOptions = {
  scenario: SyntheticScenario;
  /** The model id to report (MODEL_ID). */
  modelId?: string;
  /** Held only so the "leaky-error" fixture can put it in an error on purpose. Never used to authenticate: nothing is contacted. */
  secret?: Secret;
};

type Plan = { call?: { name: string; args: unknown }; final: (toolText: string | null) => string };

const PLANS: Record<string, Plan> = {
  plain: { final: () => "This is a synthetic answer produced from a fixture. No tool was used." },
  calc: {
    call: { name: "calculate_tax", args: SYNTHETIC_CALC_ARGS },
    final: () => "Under the old regime, the tool computed the figures for the synthetic input. I have not added, changed or rounded any number.",
  },
  law: {
    call: { name: "search_tax_law", args: SYNTHETIC_SEARCH_ARGS },
    final: (toolText) => {
      const id = /ev_[0-9a-f]{16}/.exec(toolText ?? "")?.[0];
      return id === undefined ? "I could not find any evidence for that in the synthetic fixtures." : `The synthetic fixture passage states that it is test data [${id}].`;
    },
  },
  compare: {
    call: { name: "compare_tax_regimes", args: SYNTHETIC_TAX_BODY },
    final: () => "The comparison was computed for both regimes on the same synthetic income. It is not a recommendation.",
  },
  simulate: {
    call: { name: "simulate_tax", args: SYNTHETIC_SIMULATE_ARGS },
    final: () => "The tool computed the change between the base case and the scenario in the old regime. I did not calculate any figure myself.",
  },
  summary: {
    call: { name: "get_financial_summary", args: {} },
    final: () => "The synthetic totals above come from the summary tool. I did not calculate any figure myself.",
  },
  "disabled-tool": {
    call: { name: "query_transactions", args: {} },
    final: () => "That tool is not available in synthetic mode, so I cannot answer from it.",
  },
  "wrong-figure": {
    call: { name: "calculate_tax", args: SYNTHETIC_CALC_ARGS },
    final: () => "Under the old regime your total tax is ₹99,999.",
  },
  "invented-citation": { final: () => "The synthetic rebate rule applies [ev_ffffffffffffffff]." },
  "recommend-regime": { final: () => "You should choose the new regime." },
};

/** A rough, deterministic token estimate: four characters a token. It is a fixture, not a measurement. */
const tokens = (chars: number) => Math.ceil(chars / 4);
const charsIn = (messages: readonly ModelMessage[]) => messages.reduce((sum, m) => sum + m.content.length, 0);

export function createSyntheticModel(options: SyntheticModelOptions): ModelAdapter {
  const model = options.modelId ?? SYNTHETIC_MODEL_ID;
  return {
    async complete(request: ModelRequest, call?: ModelCallOptions): Promise<ModelResponse> {
      switch (options.scenario) {
        case "hang":
          return new Promise<never>((_resolve, reject) => {
            if (call?.signal?.aborted) reject(new ModelProviderError("aborted"));
            call?.signal?.addEventListener("abort", () => reject(new ModelProviderError("aborted")), { once: true });
          });
        case "rate-limited":
          throw new ModelProviderError("rate_limited");
        case "leaky-error":
          throw Object.assign(new Error(`401 Unauthorized: the key ${options.secret?.reveal() ?? "synthetic-placeholder-key"} was rejected`), { name: "SyntheticProviderError" });
        default:
          break;
      }

      const inputTokens = tokens(charsIn(request.messages));
      const reply = (response: { kind: "text"; text: string } | { kind: "tool_calls"; calls: ModelToolCall[] }, recipient: string | null): ModelResponse => {
        const outputChars = response.kind === "text" ? response.text.length : JSON.stringify(response.calls).length;
        return { ...response, ...(recipient === null ? {} : { meta: { recipient, model, inputTokens, outputTokens: tokens(outputChars) } }) } as ModelResponse;
      };

      if (options.scenario === "oversized") return reply({ kind: "text", text: "x".repeat((call?.maxOutputChars ?? 20_000) + 1) }, SYNTHETIC_RECIPIENT);

      const plan = PLANS[options.scenario] ?? PLANS.plain;
      const lastTool = [...request.messages].reverse().find((m): m is Extract<ModelMessage, { role: "tool" }> => m.role === "tool");
      const recipient = options.scenario === "foreign-recipient" ? "unlisted-recipient" : options.scenario === "no-metadata" ? null : SYNTHETIC_RECIPIENT;
      if (plan.call !== undefined && lastTool === undefined) {
        return reply({ kind: "tool_calls", calls: [{ id: "syn-call-1", name: plan.call.name, arguments: parseToolArguments(JSON.stringify(plan.call.args)) }] }, recipient);
      }
      return reply({ kind: "text", text: plan.final(lastTool?.content ?? null) }, recipient);
    },
  };
}
