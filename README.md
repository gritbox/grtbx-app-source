# grtbx-app-source

The grtbx surface: a mobile-first chat interface that serves — and edits — itself
from inside a running Sprite.

## This is not run standalone

A Sprite clones this repo to `/data/surface`, where a Vite dev server owned by the
agent serves it behind the grtbx bridge's reverse proxy at `/surface/`. Editing a
file in that clone reaches the phone over HMR within seconds, which is the point:
the interface is progressively built by the agent using it, from a phone.

That is why `vite.config.ts` declares `base: "/surface/"` rather than the usual
`"./"` — the app only ever exists behind that proxy path.

## Why a clone rather than a copy

Because the clone shares this repo's history, an upstream change arrives by
`git fetch && git merge`: a real three-way merge, with the user's own commits
preserved and genuine conflicts surfaced as conflicts. A copy has no merge base,
so an update can only overwrite or be refused. That distinction is the whole
reason this repo exists separately from the grtbx monorepo.

## Local development

```sh
npm ci
npm test
npm run dev
```

The chat WebSocket expects a grtbx bridge at `127.0.0.1:8080`; without one the UI
renders but cannot hold a conversation.

## Proven live (gritbox/grtbx#56)

The `grtbx-gritbox` Sprite was re-seeded onto a real clone of this repo, then this
line was added here and pulled into `/data/surface` with `git fetch && git merge`
— confirming an upstream change reaches a live Sprite without a hand-copy.
