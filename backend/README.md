# Backend — PocketBase

Single Go binary: auth + database + realtime. No Firebase, no Supabase, you own the data.

## Run it

```bash
cd backend
docker compose up -d
# open http://localhost:8090/_/  and create the first admin account
```

The migration in `pb_migrations/` runs automatically on first boot and creates
all collections. `pb_hooks/retention.pb.js` prunes location history older than
14 days (`RETENTION_HOURS`) every hour.

Without Docker: download the binary from https://pocketbase.io/docs/ , drop it
in this folder, then `./pocketbase serve --http=0.0.0.0:8090`.

## Deploy to Render

`Dockerfile` + `render.yaml` are set up for it.

1. Push this repo to GitHub.
2. Render dashboard → **New + → Blueprint** → select the repo. It reads
   `render.yaml` and creates a Docker web service with a 1 GB persistent disk
   mounted at `/pb/pb_data`.
3. It needs a **paid instance** (Starter, ~$7/mo) — the free tier has no
   persistent disk and cold-starts, both fatal for a location backend.
4. First deploy: open `https://<your-service>.onrender.com/_/` and create the
   superuser account (or use the service's **Shell** tab:
   `/pb/pocketbase superuser create you@example.com <password>`).
5. The migration provisions all collections automatically on that first boot.
6. Point the app at it: set `EXPO_PUBLIC_POCKETBASE_URL=https://<your-service>.onrender.com`
   in `app/eas.json` (`preview` / `production` profiles) and rebuild. HTTPS is
   automatic on `onrender.com`, so no ATS/cleartext config needed.

Redeploys restart the service (a few seconds of downtime) — the disk persists,
so data and superusers survive. Back it up with the Shell tab or Render disk
snapshots.

## Production

- **TLS is mandatory.** Background location sync sends coordinates continuously —
  never over plain HTTP. Put Caddy or Cloudflare in front, or use
  `./pocketbase serve --https=yourdomain.com:443` (built-in Let's Encrypt).
- Back up the `pb_data/` directory (it's just SQLite + uploads).
- Set a strong admin password; consider disabling admin UI on the public port.
- **Auth token duration** — Dashboard → `users` collection → *Options* → set
  "Auth token duration" to e.g. `5184000` (60 days). The default is 14 days; a
  device that never opens the app and stays offline past that window can't
  refresh and the user must re-open the app once. Longer token = longer
  unattended runs, at the cost of a stolen token staying valid longer.
- **Retention** — `pb_hooks/retention.pb.js` keeps 14 days of history by
  default (`RETENTION_HOURS`). It prunes by device timestamp, so a batch that
  syncs after 3 weeks offline is pruned on arrival — raise it if you need that
  history to stick.

## Collections (build by hand if not on PocketBase v0.23+)

### `users` (built-in auth collection)
| field | type | notes |
|-------|------|-------|
| name  | text | display name |

### `families`
| field | type | notes |
|-------|------|-------|
| name | text | required |
| owner | relation → users | required, single |
| invite_code | text | required, unique index |

Rules:
- list / view: `@request.auth.id ?= memberships_via_family.user`
- create: `@request.auth.id != ""`
- update / delete: `owner = @request.auth.id`

### `memberships`
| field | type | notes |
|-------|------|-------|
| family | relation → families | required, cascade delete |
| user | relation → users | required, cascade delete |
| role | select | `owner`, `member` |
| sharing_enabled | bool | per-member kill switch |

Unique index on `(family, user)`.

Rules:
- list / view: `@request.auth.id = user || @request.auth.id ?= family.memberships_via_family.user`
- create / update: `@request.auth.id = user`
- delete: `@request.auth.id = user || @request.auth.id = family.owner`

### `positions`
| field | type | notes |
|-------|------|-------|
| user | relation → users | required |
| family | relation → families | required |
| lat, lng | number | required |
| accuracy, speed, heading, altitude, battery_level | number | |
| is_moving | bool | |
| activity | text | `still`, `walking`, `in_vehicle`, … |
| recorded_at | date | required — device timestamp |

Indexes on `(family, recorded_at)` and `(user, recorded_at)`.

Rules:
- list / view: `@request.auth.id ?= family.memberships_via_family.user`
- create: `@request.auth.id = user && @request.auth.id ?= family.memberships_via_family.user`
- update: disabled (rows are immutable)
- delete: `@request.auth.id = user || @request.auth.id = family.owner`

## How the app writes here

The native background-geolocation SDK POSTs straight to
`POST /api/collections/positions/records` with the user's auth token in the
`Authorization` header. Queued rows flush automatically when the device is back
online — the app process does not need to be running.
