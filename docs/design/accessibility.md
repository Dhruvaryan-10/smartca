# Accessibility

The target is WCAG 2.2 AA. Accessibility is part of every token and component definition, not a final pass.

| Area | Requirement | Status |
|---|---|---|
| **Contrast** | Text at least 4.5:1, large text and UI components at least 3:1, and focus indicators at least 3:1, in light, dark and increased contrast | Text tokens are enforced by `tests/design-tokens.test.ts` |
| **Increased contrast** | Under `prefers-contrast: more`, hairlines take the field-border colour and muted text moves 80% toward ink | Implemented |
| **Colour independence** | No meaning carried by colour alone. Negatives have a minus sign, statuses have words, chart series have patterns (`color.md › Inclusive color`) | Rule |
| **Keyboard** | Every action reachable in a logical order. A skip link to the main content. Arrow keys in menus, tablists and segmented controls. Escape closes the topmost layer and returns focus to its trigger. No traps outside modal layers (`accessibility.md › Speech`: "Let people use the keyboard alone to navigate and interact with your app") | The skip link exists; the menu and drawer gaps are fixed in Steps 2 and 4 |
| **Visible focus** | A 2px `--border-focus` outline with a 2px offset (primary is at least 6.2:1 on every surface). A base-layer `:focus-visible` rule covers any element without its own style. Focus never animates and is never hidden behind sticky headers (`scroll-margin-top`) | Implemented (base rule and `focus-ring` utility) |
| **Semantic HTML** | `header`, `nav` and `main` landmarks. One `h1` per page with headings in order. Real `<table>`, `<dl>` for figure rows, `<button>` for actions and `<a>` for navigation. `fieldset`/`legend` for groups. `lang="en-IN"` | `lang` implemented; the rest is per component |
| **Labels** | Every control has a visible label, and icon-only buttons have an `aria-label`. Placeholders never replace labels | Rule |
| **Error communication** | Errors appear inline, next to the field, in words with an icon, linked through `aria-describedby`, with `aria-invalid` set. On submit, focus moves to the first invalid field. Input is preserved. Blocking errors use `role="alert"`; everything else is polite. Errors never auto-dismiss | Rule (existing `TextField` is the model) |
| **Screen readers** | Live regions announce calculation results, assistant answers and toasts. Charts carry data tables. Negative figures announce "minus". Provenance marks are read with their figure. The busy state uses `aria-busy` | Rule |
| **Reduced motion** | Every duration collapses and entrances are removed; meaning is preserved (see [motion.md › Reduced motion](motion.md#reduced-motion)) | Implemented |
| **Reduced transparency** | No translucency is used. Any future blur needs an opaque fallback | Rule |
| **Touch targets** | At least 44×44px on touch layouts, with 12px between targets (`accessibility.md › Mobility`: "Offer sufficiently sized controls") | Rule |
| **Text size** | Layouts survive 200% zoom and a 20px default font size without clipping or overlap (`accessibility.md › Vision`: "give people the option to enlarge text by at least 200 percent") | Rule |
| **Time** | No time-boxed interface. Session-expiry warnings give time to act (`accessibility.md › Cognitive`: "Minimize use of time-boxed interface elements") | Rule |

## Verification at each step

- A keyboard-only walkthrough of every changed flow.
- axe on every route, in both themes.
- NVDA on the key flows: sign in, add an entry, calculate tax, confirm a Form 16, ask a question.
- Reduced motion on; increased contrast on.
- 320px wide and 200% zoom.
