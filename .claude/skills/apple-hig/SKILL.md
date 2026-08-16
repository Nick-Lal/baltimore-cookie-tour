---
name: apple-hig
description: >
  Apply Apple's Human Interface Guidelines to a web UI: the clarity/deference/depth model,
  the iOS type scale and system font stack, 44pt touch targets, materials and vibrancy,
  bottom sheets with detents, large titles, segmented controls, spring motion, safe area
  insets, and the accessibility floor Apple treats as non-negotiable. Use when building or
  reviewing an interface that should feel native to iOS rather than like a generic web app.
---

# Apple Human Interface Guidelines for the web

The goal is an interface an iPhone user recognises as correct without being able to say why.
That comes from getting the measurements right, not from rounded corners and a blur filter.

## The three principles

**Clarity.** Text is legible at every size, icons are precise, and negative space is doing
work. If a screen has two equally weighted primary actions, one of them is not primary.

**Deference.** The content is the interface. Chrome recedes: translucent bars, minimal
borders, no decoration competing with what the user came for. On a map screen, the map wins.

**Depth.** Layers communicate hierarchy. A sheet sliding over content means "this is on top of
where you were and you can go back." Motion explains structure rather than adding delight.

## Type

Use the system stack so text renders in SF on Apple hardware and in the platform's own face
elsewhere. Never ship a webfont that mimics SF.

```css
--font-sans: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto,
             "Helvetica Neue", Arial, sans-serif;
--font-mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
--font-rounded: ui-rounded, "SF Pro Rounded", -apple-system, sans-serif;
```

The iOS text styles, which are the actual scale to build from:

| Style | Size | Line height | Weight | Tracking |
|---|---|---|---|---|
| Large title | 34px | 41px | 700 | +0.4 |
| Title 1 | 28px | 34px | 700 | +0.36 |
| Title 2 | 22px | 28px | 700 | +0.35 |
| Title 3 | 20px | 25px | 600 | +0.38 |
| Headline | 17px | 22px | 600 | -0.41 |
| Body | 17px | 22px | 400 | -0.41 |
| Callout | 16px | 21px | 400 | -0.32 |
| Subheadline | 15px | 20px | 400 | -0.24 |
| Footnote | 13px | 18px | 400 | -0.08 |
| Caption 1 | 12px | 16px | 400 | 0 |
| Caption 2 | 11px | 13px | 400 | +0.07 |

Body is 17px, not 16px. This is the single most common tell that a "native-feeling" web UI was
built to web defaults. Note that tracking goes *negative* at body sizes and *positive* at
display sizes; that crossover is real and worth reproducing.

Support Dynamic Type by driving sizes from a root scale variable rather than hardcoding px in
components, and never disable user zoom.

## Layout and touch

- Minimum touch target is 44 by 44 points. Not 40, not "it has padding around it." A 24px icon
  needs a 44px hit area, which may extend past the visible bounds.
- Standard screen margin is 16px on phones, 20px on larger phones and tablets.
- Vertical rhythm runs on an 8px grid, with 4px available for tight optical adjustments.
- Corner radii are nested, not uniform: an outer container at 20px holds cards at 12px which
  hold thumbnails at 8px. Concentric radii read as intentional; uniform radii read as a
  template.
- Respect safe areas. Anything fixed to the bottom needs
  `padding-bottom: max(16px, env(safe-area-inset-bottom))`, or it sits under the home
  indicator. Same for `env(safe-area-inset-top)` under the notch or Dynamic Island.

## Materials and vibrancy

Apple's translucent surfaces are a blur plus a saturation boost, not just opacity.

```css
.material-thick {
  background: color-mix(in srgb, var(--surface) 72%, transparent);
  backdrop-filter: saturate(180%) blur(20px);
  -webkit-backdrop-filter: saturate(180%) blur(20px);
}
@supports not (backdrop-filter: blur(1px)) {
  .material-thick { background: var(--surface); }
}
```

The saturation boost is what makes it look like iOS rather than like frosted glass. Always
provide the opaque fallback: without it, text over a failed blur is unreadable.

Use materials for chrome floating over content. Never use them for the content itself.

## Components that matter here

**Bottom sheet with detents.** On phones this replaces the desktop sidebar. Three heights:
peek (roughly 120px, enough for a handle and a summary line), medium (about half the viewport),
and full. It must be draggable by the handle, must snap to the nearest detent on release with
velocity taken into account, and must be dismissible by dragging down past a threshold. Never
resize a desktop sidebar and call it a sheet.

**Large title that collapses.** Starts at 34px inline with the content, shrinks to a 17px
centred headline in the nav bar as the user scrolls past it. The bar gains a hairline bottom
border only once content sits behind it.

**Segmented control.** A pill track with an indicator that slides between segments rather than
appearing instantly. Equal width segments, 
`transition: transform 0.3s cubic-bezier(0.32, 0.72, 0, 1)`.

**Lists.** Grouped inset style: rounded container, hairline separators inset to align with the
text and not the container edge, chevrons for navigation, and a pressed state that is a
background change rather than an opacity change.

## Motion

Apple's motion is spring based and fast. The workhorse curve, which approximates the standard
iOS spring, is `cubic-bezier(0.32, 0.72, 0, 1)`.

Durations: 200ms for a state change, 300ms for a sheet or a transition, 400ms at the very
outside for a full screen change. Anything slower feels broken on a phone.

Interruptibility matters. If a user grabs a sheet mid-animation it should follow their finger
from where it currently is, not finish its animation first.

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

Reduced motion means removing movement, not removing feedback. Keep opacity changes so the
interface still confirms it heard the tap.

## Colour

Semantic tokens, never raw hex at the point of use. The set that covers almost everything:

```
--label, --label-secondary, --label-tertiary, --label-quaternary
--fill, --fill-secondary, --fill-tertiary
--bg, --bg-elevated, --bg-grouped
--separator (non-opaque hairline), --separator-opaque
--tint (the single accent that marks interactive elements)
```

One tint colour per app. If everything is accented, nothing is.

Contrast floor is 4.5:1 for body text and 3:1 for large text and interactive boundaries.
Apple's own systemGray on white fails this at small sizes; use the darker greys and check
rather than copying values from a screenshot.

Never encode meaning in colour alone. A confidence badge needs a word or a shape, not just a
hue.

## Accessibility floor

These are not enhancements, they are the definition of done:

- Every interactive element is reachable by keyboard with a visible focus ring. Use
  `:focus-visible` so the ring does not appear on mouse clicks.
- Icon-only buttons carry `aria-label`.
- Sheets and modals trap focus, close on Escape, and return focus to whatever opened them.
- Live regions announce changes that happen without a page load.
- Form controls have real `<label>` elements, not placeholder text pretending to be labels.
- The page works at 200% zoom without horizontal scrolling.

## Checks before calling an interface done

1. Is body text 17px?
2. Is every tap target at least 44 by 44?
3. Do radii nest, or is everything the same number?
4. Does anything fixed to the bottom clear the home indicator?
5. Does every material have an opaque fallback?
6. Is there exactly one tint colour?
7. Does the sheet snap to detents with velocity, or just jump?
8. Does reduced motion actually remove movement?
9. Is there a visible focus ring on keyboard navigation only?
10. At 200% zoom, does the layout hold?
