# Brand identity

## What SmartCA is

SmartCA is a personal finance and tax workspace for Indian taxpayers. It computes deterministically, shows its working, and never claims more than it knows.

Its value is **trustworthy figures with visible provenance**:

- The ledger is the person's own record.
- The tax engine is the only thing that computes tax.
- Form 16 values are suggestions until the person confirms them.
- The assistant explains what the tools produced. It never invents figures.

## Visual metaphor: the computation sheet

A chartered accountant's *Computation of Total Income* is a document almost every Indian taxpayer has seen. It has descriptions on the left and figures in one right-aligned column, with a single rule above each sub-total and a double rule under the final figure. It is calm and exact, and it shows its working. SmartCA rebuilds that document as modern software, with four elements:

1. **The money column.** Figures are right-aligned, tabular and kept on one edge per view. Labels sit on the left.
2. **The settled figure.** At most one per view. It is the number the view exists to answer, such as savings this period or tax payable. It is set in display type and finished with an accounting double rule. This is SmartCA's signature, the one thing people remember it by. Everything around it stays quiet so it counts (`branding.md › Best practices`: "Ensure branding always defers to content").
3. **Ink on ledger paper.** Cool, faintly green-grey paper with near-black green ink and one deep ledger-ink teal. Neutrals do almost all the work.
4. **Provenance marks.** A small vocabulary that shows where a figure came from (see [components.md › Provenance marks](components.md#provenance-marks)). It turns the backend's guarantees into something you can see: figures come only from tools, nothing is used until confirmed, and guidance is never presented as more authoritative than it is.

None of these elements comes from another brand. All of them come from accounting practice.

## Personality

| SmartCA is | SmartCA is not |
|---|---|
| **Precise.** Figures are aligned, wording is exact, and nothing approximate is presented as exact | Rounded for effect ("about ₹1L" when the exact figure is known) |
| **Calm.** Neutral surfaces, one accent, and motion only when something changed | Busy: gradients, glows, pulsing badges, ambient animation |
| **Candid.** It says what is not supported and what was not computed | Persuasive: "AI-powered" claims, invented features, urgency |
| **Professional.** It uses the vocabulary of a CA's working papers | Playful: emoji, mascots, confetti, exclamation marks |
| **Assisted.** The assistant is a plainly named tool ("Ask") | An "AI startup": sparkles, purple gradients, avatars, simulated typing |

**Compared with typical accounting software**, SmartCA keeps the rigour of a ledger without the clutter. There are fewer, larger, better-ranked figures, with the detail one step away rather than all on screen at once.

## Emotional tone

The feeling to aim for is **settled confidence**: "my numbers are right and I can see why" (`design-principles.md › Delight`: "Identify the emotion you want to inspire"). Not excitement, and not reassurance theatre.

## Principles

1. **The figure is the interface.** Hierarchy starts from which number matters most. Type, space and alignment express it before colour, borders or containers do.
2. **Show the working.** Every computed figure can be traced through its derivation tree, section references, engine and rules versions, and provenance mark.
3. **Honest by construction.** SmartCA never shows a figure that the system did not compute or the person did not enter. It states what is unsupported. An empty state never pretends to be data.
4. **One accent, and one meaning per colour** (`color.md › Best practices`: "Avoid using the same color to mean different things").
5. **Quiet structure.** Rules and surfaces appear only where an accountant would draw them. No card inside a card, and no decorative dividers.
6. **Motion answers an action.** If nothing changed, nothing moves.
7. **Excellent without animation, colour or a mouse.** Every state must read correctly with reduced motion, in greyscale, by keyboard and with a screen reader.
8. **People stay in control.** Nothing that is extracted or suggested takes effect without an explicit action. Destructive actions ask for confirmation. Everything else is reversible where the API allows (`design-principles.md › Agency`: "Help people recover from mistakes").

## Voice

- Write in sentence case.
- Use specific verbs ("Save run", "Confirm values", "Delete document") and plain words.
- Avoid filler, exclamation marks and emoji.
- Errors say what happened and what to do next, without apologising.
- Never use the words "AI-powered", "smart", "magic" or "effortless" in the interface.
- Name things after what people recognise (Form 16, AY 2026-27, Section 80C), not after how the system is built.

## Anti-patterns

SmartCA must not ship any of these. A review that finds one treats it as a defect.

**Layout and surfaces**
- A generic SaaS dashboard template: a 4-up row of tinted stat cards, a chart and a "recent activity" card.
- Too many cards: a card inside a card, a card per sentence, a card around every figure.
- Visual clutter: more than one primary action per view, or decorative dividers.
- Too much rounding: pill buttons, pill badges, or panels rounder than 12px.
- Too many shadows, or shadows on flat panels.
- Meaningless glassmorphism or blur in content.
- Gradients used as decoration, purple "AI" gradients, or glows.

**Colour and type**
- Arbitrary colours outside the tokens, or a rainbow chart palette.
- Financial colour used as a fill: green, coral or gold backgrounds on cards, rows or whole sections. The financial colours are for figures and small marks only.
- Colour used as the only signal.
- Contrast below the token guarantees.
- Tiny type (below 12px, or body text below 14px), light or thin weights, Title Case.

**Financial figures**
- Poor number formatting: `₹1234.5`, float artefacts, Western grouping, a hyphen instead of a minus sign, misaligned decimals in a column.
- Invented figures: projections presented as facts, or "monthly" values computed from all-time totals.

**Motion**
- Decorative motion: floating blobs, ambient loops, parallax in the app, count-up numbers, staggered list cascades.
- Arbitrary animation durations or springy overshoot.
- Animation that delays or blocks interaction.

**Interaction**
- Unnecessary modals, `alert()`, or confirmation dialogs for undoable actions.
- Inconsistent spacing or one-off values instead of the scale.
- Hover-only affordances, or icon-only controls without labels.
- An AI presented as a person (avatar, typing simulation), or model text rendered as HTML or markdown.

## History

These documents supersede `SMARTCA-FRONTEND-DESIGN-SYSTEM.md` where they differ:

| Topic | Earlier proposal | Now | Why |
|---|---|---|---|
| Token names | paper / sheet / ink / pencil | background / surface / foreground / foreground-muted | Role names read better in code. The metaphor survives in comments |
| Radius | 4 / 6 / 10 / 14 | 4 / 6 / 8 / 12 / 16, plus pill | Matches how existing components consume the tokens, so migration changes fewer corners |
| Display face | Anek Latin, gated by a spike | Geist until approved | No dependency before the spike |
| Motion | 80/140/200/280/320/900 | instant 80, fast 140, normal 200, slow 320, reveal 480, wash 900; four easings | Named scale; 480 matches the existing chart entrances |
| Assistant colour | not specified | First "none", then (2026-10-02, owner decision) the SmartCA accent | Gives Ask SmartCA a recognisable, restrained identity without a new hue |
| Income/expense colour | "money is ink" | Income green, expense coral, tax gold, as accents only | Owner decision 2026-10-02: the interface was too monochrome. Signs and labels remain mandatory |
| Provenance marks | not present | Added | Makes the trust model visible |
