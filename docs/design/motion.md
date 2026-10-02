# Motion

SmartCA should feel alive but never gimmicky. **Motion communicates structure and change. It never decorates.**

## Principles

| Principle | Meaning in SmartCA | HIG basis |
|---|---|---|
| **Purpose** | Every animation answers an action or shows a change of state. If nothing changed, nothing moves | `motion.md › Best practices`: "Add motion purposefully, supporting the experience without overshadowing it" |
| **Continuity** | Elements arrive from where they live and leave the way they came: a menu from its trigger, a sheet from the bottom edge, the drawer from the left, a new row in place | `design-principles.md › Flexibility`: "use natural animations to ease transitions" |
| **Hierarchy** | Bigger surfaces move slower and with more emphasis; small controls respond almost instantly | Judgment |
| **Feedback** | Every press, save and failure gets an immediate, brief, local response | `motion.md › Providing feedback`: "Aim for brevity and precision in feedback animations" |
| **Spatial relationships** | Motion reveals relationships (this figure changed because you edited that input) instead of adding spectacle | Judgment |
| **Productivity** | Frequent interactions get almost no motion; nothing blocks input; everything can be interrupted | `motion.md › Providing feedback`: "In apps, generally avoid adding motion to UI interactions that occur frequently", "Let people cancel motion" |
| **Optional** | Every meaning survives with motion turned off | `motion.md › Best practices`: "Make motion optional" |

Not allowed: floating or ambient animation, springy overshoot, bouncing, staggered cascades, count-up numbers, parallax in the app, shimmering "AI" text, and any animation longer than 500ms apart from the fading recompute wash.

## Tokens

These are implemented in `globals.css`.

### Durations

| Token | Value | For |
|---|---|---|
| `--duration-instant` | 80ms | Press feedback |
| `--duration-fast` | 140ms | Hover, focus and selection colour changes |
| `--duration-normal` | 200ms | Menus, popovers, page settle, drawer, tab indicators |
| `--duration-slow` | 320ms | Dialogs, sheets, the settled-figure rule |
| `--duration-reveal` | 480ms | One-time chart and proportion-bar entrances |
| `--duration-wash` | 900ms | The recalculated-figure highlight fading out (it does not block anything) |

### Easing

| Token | Curve | For |
|---|---|---|
| `--ease-standard` / `ease-standard` | cubic-bezier(0.2, 0, 0, 1) | State changes in place: colours, indicators, expansion |
| `--ease-entrance` / `ease-entrance` | cubic-bezier(0.05, 0.7, 0.1, 1) | Arriving: decelerates into place |
| `--ease-exit` / `ease-exit` | cubic-bezier(0.3, 0, 0.8, 0.15) | Leaving: accelerates away. Exits run at about 75% of the entrance duration |
| `--ease-emphasized` / `ease-emphasized` | cubic-bezier(0.32, 0.72, 0, 1) | Large surfaces (sheets, dialogs): a long, smooth settle without overshoot |

There is no spring library. The emphasized curve gives physical plausibility (mass that settles) without bounce. framer-motion stays out of the application routes; it is used only on the landing page. three and react-three-fiber never enter the app shell.

Usage: `transition-colors duration-(--duration-fast) ease-standard`, or `animation: x var(--duration-normal) var(--ease-entrance)` in CSS.

## Patterns

These are for future implementation, unless they are marked as existing.

| Pattern | Behaviour |
|---|---|
| **Hover** | Colour or surface step, `fast`, `standard`. No scale, lift or glow |
| **Focus** | The ring appears instantly; the ring itself never animates. Focus must never wait for motion |
| **Press** | A darker step within `instant`. Primary buttons may also move 0.5px |
| **Page transition** | Content fades and rises 4px, `normal`, on route change only (existing `.page-enter`). Once the shell is a shared layout, the shell never re-animates. The View Transitions API, behind feature detection, may later cross-fade the content region only |
| **Modal entrance** | The scrim fades over `normal`. The dialog fades and scales from 0.98 to 1 over `slow`, `emphasized`. Exit is a fade over about 240ms, `exit` |
| **Drawer entrance** | Slides in from the left edge over `normal`, `entrance` (existing `.shell-drawer-enter`). The scrim fades |
| **Sheet entrance** | Rises from the bottom edge over `slow`, `emphasized`, and follows the finger when dragged |
| **Dropdown / popover** | Fades and moves 4px from the trigger over `normal`, `entrance`. Exits over about 150ms |
| **List appearance** | No entrance on initial load: content is simply there. A newly added or edited row gets the recompute wash once. A removed row collapses its height over `normal`. No staggered cascades |
| **Number updates** | A figure changes instantly, never counting up. Changed figures get the **recompute wash** (existing `.recompute-wash`): a 14% accent background fading over `wash`. Sub-total rules redraw. This is SmartCA's signature motion |
| **Settled figure** | On first load of a view, its double rule may draw left to right once, over `slow`. Never on updates |
| **Chart transitions** | Lines draw or bars grow once on first render, over `reveal` (existing `.bar-grow`, Recharts on Summary). No animation on data refresh, filter change or resize; the chart redraws instantly and the takeaway text updates |
| **Tab / nav indicator** | Slides between items over `normal`, `standard` |
| **Expansion** | Disclosure rows expand over `normal`, `standard`, only when the content is short. Long content appears instantly |
| **Success** | The busy label becomes a completed label ("Saved") in place, or a toast appears when the result is off screen. No checkmark flourishes or confetti |
| **Error** | The message appears and the field edge turns `danger`, both instantly. No shaking |
| **Loading** | A skeleton with a slow 1.6s pulse (existing `.skeleton`), delayed 150ms and shown for at least 400ms. Small regions get a spinner. During recalculation the old result stays at 60% opacity |
| **Ask SmartCA button** (existing) | Settles in once, 240ms after load: fades and rises 8px from 92% scale over `slow`, `emphasized`. Hover and focus widen its halo over `normal`; press scales to 96% within `instant`. The tooltip appears after 300ms on hover, at once on focus. No pulse or loop |
| **Assistant panel** (existing) | Native modal sheet. Slides 24px in from the right (or 32px up from the bottom on phones) and fades over `slow`, `emphasized`, while the backdrop fades over `normal` |
| **Assistant waiting** | Static text ("Working on your question…") with Cancel. No typing simulation. The answer appears as one settled block, with focus moving to its heading |

## Scroll choreography

> Not implemented. These principles govern any future work.

**The rule: scroll motion must communicate structure (what belongs together, what comes next, where you are), never decorate.**

### In the application

Scrolling is reading. Content does not move unless the person moves it.

| Technique | Use | Rule |
|---|---|---|
| **Sticky structure** | Top bar, table headers, the Tax result column beside the form, the assistant composer | `position: sticky`; never hides focused content (`scroll-margin-top: var(--header-height)`) |
| **Contextual header** | The page title condenses into the top bar when the `h1` leaves the viewport, with `shadow-raised` appearing | `IntersectionObserver`; no scroll listeners |
| **Progressive disclosure** | Collapsed derivation rows, "Show more", assumptions behind a disclosure | Driven by the person, never by scroll position |
| **Section reveals** | Data sections below the fold (on Summary, Reports, Tax and Vault) settle in as they scroll into view: they rise 12px and go from 40% to full opacity. They are softened, never hidden. The animation is linked to scroll position and is complete once a section's top is 120px into view, whatever its height. Content already in view is unaffected | `.reveal`: CSS `animation-timeline: view()` inside `@supports`, so browsers without view timelines show the section in place; off under reduced motion |
| **Chart reveals** | A chart's bars grow once on first render (Recharts, `reveal` duration). The money-flow and spending bars and the settled figure's double rule draw left to right once (`.wipe-in`, `.wipe-in-slow`) | Static under reduced motion |
| **Parallax, pinned content, scrollytelling** | **None in the application** | — |
| **Smooth scrolling** | Only for explicit "Jump to result" actions | Never global (it fights the skip link and anchors), never under reduced motion |

### On marketing and onboarding pages (landing, Phase 8)

These pages can tell a story, so they get a little more freedom, with strict limits:

- **Sticky storytelling sections.** One pinned narrative at most, for example the computation sheet building itself line by line as the reader scrolls. Each step's content must also exist as plain readable text.
- **Viewport transitions.** Elements fade or rise 8–16px as they enter. They must finish by the time the element is 25% into the viewport, and must never wait for scroll to reveal essential information.
- **Parallax, where appropriate.** Only at depth differences of 10% or less, on decorative layers, never on text. Turned off under reduced motion and on low-power devices.
- **Implementation.** CSS scroll-driven animations (`animation-timeline: view()`) behind `@supports`, with the static layout as the default. No scroll-jacking. Scroll speed and direction stay the person's.
- **Performance.** Animate only transform and opacity, and hold 60fps on a mid-range Android phone, or the effect is removed.

## Reduced motion

Implemented in `globals.css`. Under `prefers-reduced-motion: reduce`:

- Every `--duration-*` token collapses to 0.01ms, so `transitionend` handlers still fire.
- Keyframe entrances (`.page-enter`, `.skeleton`, `.bar-grow`, the drawer and scrim) are removed.
- `.recompute-wash` becomes a static 2px primary edge, so the change is still marked, without movement.
- Recharts animations are disabled through `usePrefersReducedMotion()` (existing).
- Scroll-driven effects are off, and smooth scrolling is off.

`accessibility.md › Cognitive`: "Be cautious with fast-moving and blinking animations." Nothing in SmartCA blinks or flashes.

## Performance

- Animate `opacity` and `transform` only.
- Use `will-change` only while an animation runs.
- No scroll listeners; use `IntersectionObserver` and `position: sticky`.
- Any animation that cannot hold 60fps on a mid-range phone is removed, not tuned.
