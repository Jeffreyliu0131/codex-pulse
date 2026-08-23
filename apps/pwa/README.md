# CodexPulse PWA

Vanilla TypeScript + Vite 的移动优先 Home Screen PWA。

Implemented:

- access-token login exchanged for Secure、HttpOnly、SameSite=Strict cookie;
- Activity summary, status filters, task detail, safe alias, watch/mute rules and unread badge;
- two-host health, phone-confirmed pairing and host revocation;
- explicit Push permission, subscription health, test Push and device unsubscribe;
- iPhone “Safari → 分享 → 添加到主屏幕” guidance;
- Service Worker shell cache that explicitly excludes `/api/*`;
- declarative-compatible Web Push fallback and same-origin notification click routing;
- safe last-dashboard cache for read-only offline display.

Local development:

```sh
npm run dev:pwa
npm run build
npm run preview:ui
```

`preview:ui` serves production assets with synthetic MacBook/Mac mini data at `127.0.0.1:4173`. The UI has been inspected at 390×844 and 320×568 with no horizontal page overflow or console warnings.

On iPhone, Push requires HTTPS and a Home Screen installation. Permission is requested only after the user taps the enable button. Focus mode, lock-screen settings and OS notification settings remain outside the PWA's control.
