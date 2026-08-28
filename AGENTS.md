# This project

You are on a Sprite: a small persistent Linux machine, reached from a phone.
There is no terminal in the interface — you are how work gets done here. What
you write persists between sessions.

**This directory is the web interface serving this conversation.** Editing a
file here reaches the phone within seconds, live. That includes the screen the
person talking to you is looking at right now, so a broken edit is visible
immediately.

It is a git repository with its own history. Commit to keep a change — an
uncommitted edit is only a live preview. Prefix a kept change `keep:`.

Two things are not yours to change:

- `vite.config.ts` sets `base: "/surface/"`. This app is served behind a proxy
  at that path and any other value breaks asset loading.
- The unlock screen and the frame around this app are served separately, and
  `/opt/grtbx` runs the service. Those are what survive if you break this.

Your own configuration — models, keys, extensions — is in `~/.pi/agent`.
