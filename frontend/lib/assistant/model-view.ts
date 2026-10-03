// How a tool result is WRITTEN for the model, after the egress filter has decided what it may see. PURE: no database, session,
// provider or network.
//
// Money in tool results is integer paise (fields named "...Paise"). Asked to state it in rupees, a real 7B model divided by 100
// wrongly or not at all (₹1,50,00,000 for ₹1,50,000), and the answer layer rightly withheld every such answer. So the model is shown
// each amount already written in rupees, exactly as SmartCA's own pages write it (lib/format formatRupees), under the field name
// without its unit suffix: { incomePaise: 15000000 } is shown as { income: "₹1,50,000" }. The model then copies figures instead of
// computing them.
//
// This changes the WRITING, never the data: it runs on the already-filtered result, adds no field the filter removed, and re-renders
// only values the filter let through, so the egress inventory, the disclosure and every consent stand. The raw result (in paise) is
// still what the answer layer grounds figures against.
import { formatRupees } from "../format";

const PAISE_KEY = /^(.+)Paise$/;

export function presentForModel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(presentForModel);
  if (typeof value !== "object" || value === null) return value;
  const source = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    const money = PAISE_KEY.exec(key);
    if (money && typeof item === "number" && Number.isSafeInteger(item)) {
      const name = money[1];
      // Never overwrite a field the result already has under the shorter name: keep the original key then.
      out[Object.hasOwn(source, name) ? key : name] = formatRupees(item);
    } else {
      out[key] = presentForModel(item);
    }
  }
  return out;
}
