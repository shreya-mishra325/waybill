# Waybill public website

Phases 1-3: design foundation, animated hero, and Product section. Architecture, features, public docs, authentication, and the private dashboard are not implemented in this package.

## Local development

From the repository root:

```bash
bun install
bun run dev:web
```

Open `http://127.0.0.1:3001`. Express retains its separate API process and port. This package has no route handlers, database clients, AWS clients, or copied backend logic.

```bash
bun run check:web
bun run build:web
bun run --cwd packages/web start
```

Add `?motion=off` for a deterministic static animation frame. The operating system's reduced-motion setting also disables motion. No database, Redis, or AWS configuration is needed to render the hero.

## Structure

- `src/app/tokens.css`: centralized palette, heading size, line height, and tracking, exposed to Tailwind v4.
- `src/app/layout.tsx`: Next App Router shell and self-hosted Google Fonts via `next/font`.
- `src/components/site-header.tsx`: supplied logo, responsive navigation, and honest notices for future pages.
- `src/components/hero.tsx`: heading, copy, actions, and four highlights.
- `src/components/product.tsx`, `product-preview.tsx`, `src/app/product.css`: Product layout, background continuation, and labelled example delivery viewer with working local filters.
- `src/components/hero-network.tsx`: SVG paths, nodes, packets, airplane, and one animation scheduler.
- `src/lib/network.ts`: path definitions, motion timing, and interpolation.

Motion for React provides restrained scroll parallax for the decorative layer. The SVG animation uses cached path samples and direct transform/opacity updates, without React renders on every frame. It stops when the document is hidden, outside the viewport, reduced motion is enabled, or motion is explicitly off. Cleanup cancels the frame and removes observers/listeners. Small screens simplify the network and reposition the flight zone below the actions.

## Typography

The screenshot does not identify an exact font. The selected approximation is **Libre Caslon Display**, regular 400, from [Google Fonts](https://fonts.google.com/specimen/Libre+Caslon+Display), with Georgia and Times New Roman fallbacks. UI text uses **DM Sans**, from [Google Fonts](https://fonts.google.com/specimen/DM+Sans), with Arial fallback. `next/font` self-hosts these in generated build output; no third-party font binaries are committed.

Desktop heading: `clamp(76px, 7.4vw, 114px)`, line height `0.95`, tracking `-0.042em`. Tablet: 86 px. Mobile: `clamp(45px, 8.6vw, 65px)`, line height `1.05`, tracking `-0.04em`. Compare rendered glyphs, not font names. Review future family changes against the approved serif reference.

## Scope of links

Get started opens the repository's actual local setup. View on GitHub opens the actual repository. Product scrolls to `/#product`. Explore product opens the repository architecture document until the on-page How It Works section is implemented. Features, Docs, and Sign in currently open labelled preview notices with a real repository link. The Product viewer is illustrative, uses supported delivery fields and states, and does not load private records or simulate authentication. Future sections are not rendered. `/docs` is not implemented yet.

Visual evidence and remaining differences are recorded in `docs/PUBLIC_HERO_REVIEW.md`.
