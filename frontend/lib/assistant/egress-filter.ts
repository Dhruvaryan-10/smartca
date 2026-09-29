// FIELD-LEVEL EGRESS FILTERING: what a model may see of a tool result, given which classes of data (EgressFieldClass) it may be shown.
// PURE and deterministic: it imports only the tool contract, never mutates the raw result, and reaches no database, session, provider
// or network (a test pins that). The classification it applies is ASSISTANT_EGRESS_INVENTORY; nothing here restates it.
//
// Semantics, for every value in the result (paths as in the inventory: dotted keys, `[]` for any array index):
//   - A node is decided by the inventory entry that covers it: the entry for its own path, or its nearest listed ancestor. Its class
//     is either shown (a deep copy) or removed.
//   - A node with a MORE SPECIFIC entry anywhere below it is never copied whole: it is walked, so a field classed on its own (for
//     example free text inside a structure classed as financial data) is decided by its own class, not its parent's.
//   - A value no entry covers, and with no entry below it, is UNCLASSIFIED: filtering refuses it (EgressFilterError), never passes it
//     through and never drops it silently. The egress inventory test keeps the real tools fully classified.
//   - A container that filtering empties is removed, so a list of emptied rows cannot reveal how many rows there were. A container
//     that was already empty in the raw result is kept only when at least one class it could hold is shown (so showing every class
//     reproduces it, and showing none reveals nothing). The envelope itself is always an object.
//   - All four classes shown reproduces the raw result exactly; none shown leaves an empty envelope.
//
// It filters TOOL RESULTS only. The conversation (the person's words, the model's own arguments) is not a tool result and is not
// touched here.
import { ASSISTANT_EGRESS_INVENTORY } from "./tool-contract";
import type { EgressFieldClass, ToolName } from "./tool-contract";

export type EgressClasses = Readonly<Record<EgressFieldClass, boolean>>;
export type EgressInventory = Readonly<Record<string, EgressFieldClass>>;

const CLASSES: readonly EgressFieldClass[] = ["user_free_text", "user_financial_data", "tax_corpus_text", "system_value"];

/** A tool result carried a field the egress inventory does not classify. Nothing of the result may be shown. */
export class EgressFilterError extends Error {
  readonly code = "unclassified_field";
  constructor(readonly path: string) {
    super(`The tool result has a field the egress inventory does not classify: "${path}".`);
    this.name = "EgressFilterError";
  }
}

/** The classes a caller states, checked: exactly the four, each true or false. Anything else is a mistake in code (a RangeError). */
export function readEgressClasses(value: unknown): EgressClasses {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new RangeError("The visible classes must be an object.");
  const keys = Object.keys(value);
  const record = value as Record<string, unknown>;
  if (keys.length !== CLASSES.length || !CLASSES.every((c) => typeof record[c] === "boolean")) {
    throw new RangeError(`The visible classes must state exactly ${CLASSES.join(", ")}, each true or false.`);
  }
  return Object.freeze(Object.fromEntries(CLASSES.map((c) => [c, record[c] as boolean])) as Record<EgressFieldClass, boolean>);
}

const isAtOrUnder = (path: string, entry: string) => path === entry || path.startsWith(`${entry}.`) || path.startsWith(`${entry}[]`);
const isStrictlyUnder = (entry: string, path: string) => (path === "" ? entry !== "" : entry.startsWith(`${path}.`) || entry.startsWith(`${path}[]`));
const childPath = (path: string, key: string) => (path === "" ? key : `${path}.${key}`);

type Kept = { keep: true; value: unknown } | { keep: false };

function filterNode(value: unknown, path: string, inventory: EgressInventory, entries: readonly string[], classes: EgressClasses): Kept {
  const hasEntryBelow = entries.some((entry) => isStrictlyUnder(entry, path));
  const isContainer = typeof value === "object" && value !== null;

  if (hasEntryBelow && isContainer) {
    const couldHoldShown = () => entries.some((entry) => isStrictlyUnder(entry, path) && classes[inventory[entry]]);
    if (Array.isArray(value)) {
      if (value.length === 0) return couldHoldShown() ? { keep: true, value: [] } : { keep: false };
      const kept = value.map((item) => filterNode(item, `${path}[]`, inventory, entries, classes)).filter((k): k is { keep: true; value: unknown } => k.keep);
      return kept.length === 0 ? { keep: false } : { keep: true, value: kept.map((k) => k.value) };
    }
    const fields = Object.entries(value).filter(([, v]) => v !== undefined);
    if (fields.length === 0) return path === "" || couldHoldShown() ? { keep: true, value: {} } : { keep: false };
    const out: Record<string, unknown> = {};
    for (const [key, item] of fields) {
      const kept = filterNode(item, childPath(path, key), inventory, entries, classes);
      if (kept.keep) out[key] = kept.value;
    }
    return Object.keys(out).length === 0 && path !== "" ? { keep: false } : { keep: true, value: out };
  }

  let covering: string | null = null;
  for (const entry of entries) if (isAtOrUnder(path, entry) && (covering === null || entry.length > covering.length)) covering = entry;
  if (covering === null) throw new EgressFilterError(path === "" ? "(the result itself)" : path);
  return classes[inventory[covering]] ? { keep: true, value: structuredClone(value) } : { keep: false };
}

/** The model-visible form of `result` under an explicit inventory. Exposed for the mechanism's own tests; use filterToolResult. */
export function filterByInventory(result: unknown, inventory: EgressInventory, classes: EgressClasses): Record<string, unknown> {
  if (typeof result !== "object" || result === null || Array.isArray(result)) throw new EgressFilterError("(the result itself)");
  const checked = readEgressClasses(classes);
  const kept = filterNode(result, "", inventory, Object.keys(inventory), checked);
  return (kept.keep ? kept.value : {}) as Record<string, unknown>;
}

/** What the model may see of one real tool's result: its fields whose ASSISTANT_EGRESS_INVENTORY class is shown. The raw result is untouched. */
export function filterToolResult(tool: ToolName, result: unknown, classes: EgressClasses): Record<string, unknown> {
  const inventory = ASSISTANT_EGRESS_INVENTORY[tool];
  if (inventory === undefined) throw new EgressFilterError(`(unknown tool ${String(tool)})`);
  return filterByInventory(result, inventory, classes);
}
