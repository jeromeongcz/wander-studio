# Wander AI Director: design system (source of truth for the web UI)

Generated with the UI UX Pro Max skill's `--design-system` search (query: SaaS project-management dashboard, step-by-step workflow, clean, light), then adjusted by hand. The skill's first suggestion for "video studio" (a black, scroll-animated storytelling page) was rejected as unsuitable for a task tool.

## Direction
Flat design, light by default (dark is a user toggle). Calm teal for structure and actions; orange only as a small "next step" highlight. No gradients on controls, soft shadows only on raised cards.

## Tokens (light)
| Token | Value | Use |
|---|---|---|
| background | `#F0FDFA` | page |
| card | `#FFFFFF` | panels |
| muted | `#E8F1F4` | wells, table heads |
| border | `#D3E7E4` | hairlines |
| foreground | `#134E4A` | text (contrast ≥ 9:1) |
| muted-foreground | `#475569` | secondary text (≥ 7:1) |
| primary | `#0F766E` | buttons, current step (white text = 5.5:1; the skill's `#0D9488` with black text was swapped for AA white text) |
| primary-tint | `#CCFBF1` | selected/current backgrounds |
| accent | `#EA580C` | "next up" marker only, with dark text |
| destructive | `#DC2626` | delete, errors |
| ring | `#0F766E` | focus outline, 2px + offset |
Status pairs (text on tint, all ≥ 4.5:1): good `#166534/#DCFCE7`, warn `#92400E/#FEF3C7`, bad `#B91C1C/#FEE2E2`, info `#1D4ED8/#DBEAFE`.

## Type
Plus Jakarta Sans if installed, otherwise the system UI font (nothing is fetched from the internet: the app is local-first). Scale 12 / 13 / 14 / 16 / 20 / 28; weights 500 / 600 / 700; headings tight (-0.01em).

## Rules applied from the skill's checklist
- Icons are inline SVG, never emoji or text glyphs.
- Every clickable element has `cursor: pointer`; disabled ones are dimmed, change the cursor, and say why (locked steps name what unlocks them).
- Visible keyboard focus on everything; `prefers-reduced-motion` removes transitions and spinners' easing.
- Actions stay enabled and explain what is missing when pressed (no mystery-disabled "Approve").
- Touch targets ≥ 40px on phone width; layouts checked at 375, 768, 1024, 1440.
- Sticky header height is reserved so it never covers content.

## Process UI
A six-step stepper is the primary navigation: Topic → Script → Storyboard & visuals → Voice & captions → Compose & render → Publish. Steps unlock in order once the previous step's approvals are done (the Topic approval is the first gate). Earlier steps are always reachable.
