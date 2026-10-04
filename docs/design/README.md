# SmartCA design system

The visual and interaction system every SmartCA screen is built from.

- **Status:** Step 1, foundation. Tokens are implemented and tested; primitives and screens are not yet migrated to them.
- **Date / base:** 2026-10-02, branch `feat/smartca-ui`, base commit `c38ebc0`.
- **Values live in code:** `frontend/app/globals.css`. These documents explain the values; if they disagree with the CSS, the CSS wins and the document is corrected.
- **Guarded by:** `frontend/tests/design-tokens.test.ts`. It checks WCAG contrast for every text/surface pair in both themes, keeps the two dark-theme blocks identical, checks that every Tailwind colour utility resolves to a real token, and checks that reduced motion collapses every duration.

## Documents

| Document | Covers |
|---|---|
| [brand.md](brand.md) | Identity, principles, emotional tone, visual metaphor, voice, anti-patterns |
| [tokens.md](tokens.md) | Colour, spacing, radius, elevation, borders, layers: every token and its use |
| [typography.md](typography.md) | Families, scale, financial numerals, currency, decimal alignment |
| [components.md](components.md) | Iconography, component principles, component architecture |
| [finance-data.md](finance-data.md) | Tables, transactions, balances, summaries, filters, dates, negatives, percentages, comparisons, charts |
| [motion.md](motion.md) | Motion tokens and patterns, scroll choreography, reduced motion |
| [responsive.md](responsive.md) | Breakpoints and how each element adapts |
| [accessibility.md](accessibility.md) | Contrast, keyboard, focus, semantics, screen readers, touch, errors |

Earlier documents in this folder:

- `SMARTCA-UI-ROADMAP.md`: still the step-by-step sequencing plan.
- `SMARTCA-FRONTEND-DESIGN-SYSTEM.md`: the first proposal. Where it differs from these documents, these win. The differences are listed in [brand.md › History](brand.md#history).

## The system in one page

**Thesis: the computation sheet.** An Indian CA's *Computation of Total Income* has descriptions on the left, figures in one right-aligned column, a single rule above sub-totals, and a double rule under the final figure. SmartCA's identity is that document, rebuilt as calm, modern software.

**Signature element: the settled figure.** At most one per view: the number the view exists to answer, in display type with an accounting double rule (`rule-settled`). Everything else stays quiet.

**SmartCA-specific addition: provenance marks.** A small mark that says where a figure came from: the tax engine, the ledger, a confirmed Form 16, an unconfirmed extraction, a model explanation or official guidance. It makes the product's trust model visible.

**Palette: ink on ledger paper.** Cool, faintly green-grey paper surfaces, near-black green ink, and one deep ledger-ink teal accent (`#0B5D68`, or `#6CC2BA` in dark mode). Large surfaces stay neutral. A restrained **financial colour language** marks figures and small elements: income green, expense coral, tax gold, and the teal accent for Ask SmartCA. See [tokens.md › Financial colour language](tokens.md#financial-colour-language).

**Apple HIG as the quality bar, not the look.** We use the HIG copy in the `apple-design` skill for hierarchy, restraint, feedback, motion and accessibility. SmartCA does not use Apple's typefaces, materials, layouts or branding, and must never read as macOS or iOS.

## Using the tokens

```tsx
// Surfaces, text, lines
<section className="bg-surface text-foreground border border-border rounded-panel">
<p className="text-foreground-muted text-label">
// Type scale and figures
<h1 className="text-title font-display">Tax</h1>
<p className="text-display font-numeric rule-settled">₹4,12,300</p>
// Rhythm and layout
<main className="px-gutter max-w-data mx-auto space-y-section">
// Motion
<div className="transition-colors duration-(--duration-fast) ease-standard">
// Focus for new primitives
<button className="focus-visible:focus-ring">
```

Rules for new code:

- No raw hex, `rgb()` or named colours.
- No arbitrary `text-[13px]` or `p-[7px]`.
- No literal durations.
- Chart colours come from `var(--chart-*)`.

Existing screens still contain such values (for example `text-[13px]` in about 60 places, and the hard-coded pie colours in `reports/page.tsx`). They are migrated when each screen is rebuilt, not before.

## Implementation order

1. Foundation, including tokens (this step)
2. Primitives
3. Design Lab, a dev-only route behind auth
4. Application shell
5. Core screens
6. Assistant experience
7. Motion pass
8. Responsive and accessibility pass
9. Visual QA
10. Documentation
11. Deployment

## Open decisions

1. **Palette shift approval.** Surfaces moved from warm cream to cool ledger paper and the accent from `#0B6470` to `#0B5D68`. This shows on every existing screen. It is reversible in one file.
2. **Display face.** Keep Geist, or run a type spike for a display face (₹, tabular figures, U+2212, licence, weight). `--font-display` is ready for either.
3. **Theme control.** The HIG advises against an in-app appearance setting (`dark-mode.md › Best practices`). Options: keep the toggle and add a "System" choice, or follow the OS only.
4. **Icons.** In-house set (recommended) or `lucide-react`.
5. **The first proposal.** Mark `SMARTCA-FRONTEND-DESIGN-SYSTEM.md` as superseded, or delete it.
6. **Before Steps 4–6:** a shared app layout (route group), Ask replacing `/insights`, and the scope of the landing page.
