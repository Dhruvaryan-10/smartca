// THE EGRESS DISCLOSURE: what an external run would send, and withhold, for a given set of tools and visible data classes, derived from
// ASSISTANT_EGRESS_INVENTORY and nothing else. PURE: it imports only the tool contract and the egress filter's class reader, and reaches
// no database, session, provider or network (a test pins that).
//
// It is the contract a consent screen, an API response and an audit log can all depend on:
//   - `tools[].sent` and `tools[].withheld` list every inventory field of every tool, by path and class; together they are the whole
//     inventory for that tool, so nothing is left unmentioned. The egress filter enforces exactly this split (a test pins that they agree).
//   - `conversation` states what is always sent in an external run whatever the classes: the person's own messages, the assistant's earlier
//     answers and the model's own tool arguments. The egress filter does not touch them.
//   - `inventoryVersion` is a fingerprint of the whole inventory. It changes whenever any field or class does, so a consent or an audit
//     record that carries it says which field list it was given against.
// It describes; it decides nothing about what may leave SmartCA.
import { ASSISTANT_EGRESS_INVENTORY, ASSISTANT_TOOL_NAMES } from "./tool-contract";
import type { EgressFieldClass, ToolName } from "./tool-contract";
import { readEgressClasses } from "./egress-filter";
import type { EgressClasses } from "./egress-filter";

export const DISCLOSURE_FORMAT_VERSION = 1;

export type DisclosedField = Readonly<{ path: string; class: EgressFieldClass }>;

export type EgressDisclosure = Readonly<{
  format: typeof DISCLOSURE_FORMAT_VERSION;
  /** A fingerprint of ASSISTANT_EGRESS_INVENTORY: the field list this disclosure was derived from. */
  inventoryVersion: string;
  visibleClasses: readonly EgressFieldClass[];
  /** Always sent in an external run, whatever the classes. */
  conversation: Readonly<{ userMessages: "sent"; assistantAnswers: "sent"; modelToolArguments: "sent"; class: "user_free_text" }>;
  tools: ReadonlyArray<Readonly<{ tool: ToolName; sent: readonly DisclosedField[]; withheld: readonly DisclosedField[] }>>;
}>;

const CLASS_ORDER: readonly EgressFieldClass[] = ["user_free_text", "user_financial_data", "tax_corpus_text", "system_value"];

/** FNV-1a (32-bit) of the inventory in a canonical order: a stable fingerprint, not a security hash. */
export function fingerprintInventory(inventory: Readonly<Record<string, Readonly<Record<string, string>>>> = ASSISTANT_EGRESS_INVENTORY): string {
  const canonical = Object.keys(inventory)
    .sort()
    .map((tool) => `${tool}{${Object.keys(inventory[tool]).sort().map((path) => `${path}=${inventory[tool][path]}`).join(";")}}`)
    .join("|");
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `inv1-${hash.toString(16).padStart(8, "0")}`;
}

/** What an external run with these tools and visible classes sends and withholds. Unknown or repeated tools are a RangeError. */
export function describeEgress(tools: readonly ToolName[], classes: EgressClasses): EgressDisclosure {
  const visible = readEgressClasses(classes);
  if (!Array.isArray(tools) || tools.length === 0) throw new RangeError("describeEgress needs at least one tool.");
  const known: ReadonlySet<string> = new Set(ASSISTANT_TOOL_NAMES);
  const seen = new Set<string>();
  for (const tool of tools) {
    if (typeof tool !== "string" || !known.has(tool) || seen.has(tool)) throw new RangeError(`describeEgress: an unknown or repeated tool: "${String(tool)}".`);
    seen.add(tool);
  }
  const byPath = (a: DisclosedField, b: DisclosedField) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const described = ASSISTANT_TOOL_NAMES.filter((tool) => seen.has(tool)).map((tool) => {
    const fields = Object.entries(ASSISTANT_EGRESS_INVENTORY[tool]).map(([path, c]) => Object.freeze({ path, class: c }));
    return Object.freeze({
      tool,
      sent: Object.freeze(fields.filter((f) => visible[f.class]).sort(byPath)),
      withheld: Object.freeze(fields.filter((f) => !visible[f.class]).sort(byPath)),
    });
  });
  return Object.freeze({
    format: DISCLOSURE_FORMAT_VERSION,
    inventoryVersion: fingerprintInventory(),
    visibleClasses: Object.freeze(CLASS_ORDER.filter((c) => visible[c])),
    conversation: Object.freeze({ userMessages: "sent", assistantAnswers: "sent", modelToolArguments: "sent", class: "user_free_text" }),
    tools: Object.freeze(described),
  });
}
