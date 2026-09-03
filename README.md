# Address Verify

A **bounded address-verification** app. Someone who needs to prove where they
live installs it, pins their home, and runs a fixed verification window
(default 14 days). The app records low-resolution location during that window;
a server job scores how many nights the device was actually at the claimed
address and issues a **certificate** — then the raw location data is deleted.

This is deliberately *not* a live-tracking / "admin watches a map" product:

- Tracking is **time-boxed** — it stops automatically when the window ends.
- Collection is **minimal** — periodic fixes, low accuracy, no movement trail.
- The output is a **conclusion** (verdict + night count), not a journey log.
- Raw location points are **purged** once the certificate is issued (or the
  user cancels).
- The normal two OS location prompts are shown with a plain-language reason —
  nothing is hidden or auto-accepted.

```
app/       Expo / React Native app (iOS + Android)
backend/   PocketBase — auth, database, scoring + purge jobs. Self-hosted.
```

## How a verification works

1. **Sign up** with your full legal name (it goes on the certificate).
2. **Claim address** — search for it or use your current location, adjust the
   pin, confirm. This creates a verification with a 14-day window and starts
   low-resolution background tracking.
3. **Verification window** — keep the app installed and sleep at home normally.
   The app checks device presence at the address between 01:00–05:00 local.
   The progress screen shows nights confirmed so far.
4. **Window ends** — tracking stops. An hourly server job (`certify.pb.js`)
   scores the nights and issues a certificate.
5. **Certificate** — verdict (`verified` / `inconclusive` / `not verified`),
   nights present vs. total, confidence, a reference code. Shareable.
6. **Purge** — ~48 h later `purge.pb.js` deletes the raw samples; the
   certificate remains.

## Backend

PocketBase. Collections: `users`, `verifications`, `location_samples`,
`certificates`. See [backend/README.md](backend/README.md).

```bash
cd backend && docker compose up -d
# admin UI: http://localhost:8090/_/
```

Scoring/purge run on cron. To force them (superuser auth):
`POST /api/kyc/run-certify`, `POST /api/kyc/run-purge`.

## App

Expo SDK 57 / RN 0.86. Needs a dev client (native modules) — not Expo Go.

```bash
cd app
npm install
cp .env.example .env          # POCKETBASE_URL + optional GOOGLE_API_KEY
./run-android.sh              # local build (sets JDK 21 + SDK paths)
```

Env overrides for testing: `EXPO_PUBLIC_WINDOW_DAYS`,
`EXPO_PUBLIC_NIGHTS_REQUIRED`, `EXPO_PUBLIC_MATCH_RADIUS_M`.

### Honest limitations

- **Background location is a two-step OS grant.** Android 11+ / iOS require
  foreground permission first, then a separate "Allow all the time". This
  cannot be combined or bypassed by a normal app — by design.
- **iOS after force-quit** degrades to movement-triggered relaunch (Apple's
  limit). Android OEM battery killers can pause the service; it restarts on
  reboot or the next significant movement.
- Reverse-geocoding quality depends on map data coverage. Where there are no
  street addresses, the certificate still carries exact coordinates + a Plus
  Code.
