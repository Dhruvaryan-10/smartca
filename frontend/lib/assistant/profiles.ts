// Named assistant ACCESS PROFILES: which tools the model may use in a mode, and which classes of data (ASSISTANT_EGRESS_INVENTORY's
// classes) it may be shown. PURE: it imports only the tool contract, which has no imports of its own, so it reaches no database,
// session, network, provider or service, and a test pins that.
//
// A profile is chosen by server code for a mode, never by the model or a request. It is not wired into anything yet: synthetic mode
// still passes its own tool list, and the orchestrator's `allowedTools` is still the one enforcement point for tools.
//
// A profile's classes are enforced by field-level egress filtering (lib/assistant/egress-filter.ts): an entry point that uses a profile
// passes its `allowedTools` AND its `classes` (as the orchestrator's `visibleClasses`), and the model is then shown only the fields of
// each tool result whose class the profile allows. A profile may therefore allow a tool while forbidding some of what it returns, for
// example financial figures without the person's free text.
import { ASSISTANT_EGRESS_INVENTORY, ASSISTANT_TOOL_EFFECTS, ASSISTANT_TOOL_NAMES } from "./tool-contract";
import type { EgressFieldClass, ToolName } from "./tool-contract";

export const EGRESS_FIELD_CLASSES: readonly EgressFieldClass[] = ["user_free_text", "user_financial_data", "tax_corpus_text", "system_value"];

export type AssistantProfile = {
  /** A name for the mode, for code and logs. */
  id: string;
  /** The tools the model may use. */
  tools: readonly ToolName[];
  /** Which classes of data the model may be shown. Every class must be stated. */
  classes: Readonly<Record<EgressFieldClass, boolean>>;
};

/**
 * A checked profile: its tools in the canonical order, ready to pass as `allowedTools`, and its classes, to pass as `visibleClasses`.
 * Both must be passed: passing only the tools would send every tool result whole.
 */
export type ResolvedProfile = { id: string; allowedTools: readonly ToolName[]; classes: Readonly<Record<EgressFieldClass, boolean>> };

const ALL_CLASSES: Readonly<Record<EgressFieldClass, boolean>> = Object.freeze({ user_free_text: true, user_financial_data: true, tax_corpus_text: true, system_value: true });

/** Synthetic mode's boundary: the five tools it serves (every tool but query_transactions), all classes (its data is fixtures). */
export const SYNTHETIC_PROFILE: AssistantProfile = Object.freeze({
  id: "synthetic",
  tools: Object.freeze(["search_tax_law", "get_financial_summary", "calculate_tax", "compare_tax_regimes", "simulate_tax"] as ToolName[]),
  classes: ALL_CLASSES,
});

/** The capability-first mode of ADR 0002: all six read-only tools, all four classes. */
export const FULL_PROFILE: AssistantProfile = Object.freeze({
  id: "full",
  tools: Object.freeze([...ASSISTANT_TOOL_NAMES] as ToolName[]),
  classes: ALL_CLASSES,
});

export type AssistantProfileErrorCode =
  | "invalid_profile"
  | "empty_tools"
  | "unknown_tool"
  | "duplicate_tool"
  | "write_tool_not_permitted"
  | "invalid_classes";

/** A profile that cannot be honoured. It is a mistake in code, never the model's, and nothing runs. */
export class AssistantProfileError extends Error {
  constructor(
    readonly code: AssistantProfileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AssistantProfileError";
  }
}

/** The classes of data a tool's result can carry today, read from the egress inventory. */
export function classesReturnedBy(tool: ToolName): EgressFieldClass[] {
  const found = new Set(Object.values(ASSISTANT_EGRESS_INVENTORY[tool]));
  return EGRESS_FIELD_CLASSES.filter((c) => found.has(c));
}

/** Check a profile, failing closed on anything it cannot honour. */
export function resolveProfile(profile: unknown): ResolvedProfile {
  const bad = (code: AssistantProfileErrorCode, message: string) => new AssistantProfileError(code, message);
  if (typeof profile !== "object" || profile === null || Array.isArray(profile)) throw bad("invalid_profile", "A profile must be an object.");
  const { id, tools, classes } = profile as Record<string, unknown>;
  if (typeof id !== "string" || id.trim() === "") throw bad("invalid_profile", "A profile needs an id.");

  if (!Array.isArray(tools) || tools.length === 0) throw bad("empty_tools", `Profile "${id}" must allow at least one tool.`);
  const known: ReadonlySet<string> = new Set(ASSISTANT_TOOL_NAMES);
  const seen = new Set<string>();
  for (const tool of tools) {
    if (typeof tool !== "string" || !known.has(tool)) throw bad("unknown_tool", `Profile "${id}" names a tool that does not exist: "${String(tool)}".`);
    if (seen.has(tool)) throw bad("duplicate_tool", `Profile "${id}" names "${tool}" twice.`);
    if (ASSISTANT_TOOL_EFFECTS[tool as keyof typeof ASSISTANT_TOOL_EFFECTS] === "write") {
      throw bad("write_tool_not_permitted", `Profile "${id}" names "${tool}", a write tool: that needs a server-side write authorization that does not exist.`);
    }
    seen.add(tool);
  }

  if (typeof classes !== "object" || classes === null || Array.isArray(classes)) throw bad("invalid_classes", `Profile "${id}" must state its classes.`);
  const stated = Object.keys(classes);
  const allowed = classes as Record<string, unknown>;
  if (stated.length !== EGRESS_FIELD_CLASSES.length || !EGRESS_FIELD_CLASSES.every((c) => typeof allowed[c] === "boolean")) {
    throw bad("invalid_classes", `Profile "${id}" must state exactly ${EGRESS_FIELD_CLASSES.join(", ")}, each true or false.`);
  }

  const allowedTools = ASSISTANT_TOOL_NAMES.filter((tool) => seen.has(tool));

  const resolvedClasses = Object.freeze(Object.fromEntries(EGRESS_FIELD_CLASSES.map((c) => [c, allowed[c] as boolean])) as Record<EgressFieldClass, boolean>);
  return Object.freeze({ id, allowedTools: Object.freeze(allowedTools), classes: resolvedClasses });
}
