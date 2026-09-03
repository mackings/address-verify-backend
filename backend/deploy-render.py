#!/usr/bin/env python3
"""
One-shot Render deploy for the Address Verify backend, with optional
Cloudflare R2 persistence via Litestream.

    export RENDER_API_KEY=rnd_xxx
    # optional but STRONGLY recommended (free tier has no disk):
    export R2_ACCOUNT_ID=xxx
    export R2_ACCESS_KEY_ID=xxx
    export R2_SECRET_ACCESS_KEY=xxx
    export R2_BUCKET_NAME=xxx
    python3 backend/deploy-render.py

Creates a free Docker web service from github.com/mackings/address-verify-backend,
sets env vars (generating CERT_SIGNING_SECRET + the superuser password), prints
the credentials, and polls the first deploy until live. Re-run to just check
status, or with --sync-env to push updated env vars to an existing service.
"""
import json
import os
import secrets
import string
import sys
import time
import urllib.error
import urllib.request

API = "https://api.render.com/v1"
REPO = "https://github.com/mackings/address-verify-backend"
SERVICE_NAME = "address-verify"
SUPERUSER_EMAIL = os.environ.get("PB_SUPERUSER_EMAIL", "macsonline500@gmail.com")

KEY = os.environ.get("RENDER_API_KEY")
if not KEY:
    sys.exit("Set RENDER_API_KEY first:  export RENDER_API_KEY=rnd_xxx")


def api(method, path, body=None):
    req = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={
            "Authorization": "Bearer " + KEY,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        method=method,
    )
    try:
        raw = urllib.request.urlopen(req).read().decode()
        return 200, json.loads(raw or "null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()[:1500]


def litestream_env():
    acc = os.environ.get("R2_ACCOUNT_ID")
    ak = os.environ.get("R2_ACCESS_KEY_ID")
    sk = os.environ.get("R2_SECRET_ACCESS_KEY")
    bucket = os.environ.get("R2_BUCKET_NAME")
    if not all([acc, ak, sk, bucket]):
        print("!! No R2_* vars — deploying WITHOUT persistence (data lost on redeploy/idle).")
        return []
    print(f"R2 persistence: bucket={bucket}")
    return [
        {"key": "LITESTREAM_BUCKET", "value": bucket},
        {"key": "LITESTREAM_ENDPOINT", "value": f"https://{acc}.r2.cloudflarestorage.com"},
        {"key": "LITESTREAM_ACCESS_KEY_ID", "value": ak},
        {"key": "LITESTREAM_SECRET_ACCESS_KEY", "value": sk},
        {"key": "LITESTREAM_PATH", "value": "pocketbase"},
    ]


def base_env(app_url):
    su_pass = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(20))
    cert_secret = secrets.token_urlsafe(48)
    print("\n=== SAVE THESE ===")
    print("superuser email:    ", SUPERUSER_EMAIL)
    print("superuser password: ", su_pass)
    print("CERT_SIGNING_SECRET:", cert_secret)
    print()
    return [
        {"key": "PORT", "value": "8080"},
        {"key": "PB_SUPERUSER_EMAIL", "value": SUPERUSER_EMAIL},
        {"key": "PB_SUPERUSER_PASSWORD", "value": su_pass},
        {"key": "CERT_SIGNING_SECRET", "value": cert_secret},
        {"key": "APP_URL", "value": app_url},
    ] + litestream_env()


def find_service():
    code, res = api("GET", f"/services?name={SERVICE_NAME}&limit=1")
    if code == 200 and res:
        return res[0]["service"]
    return None


def main():
    code, owners = api("GET", "/owners?limit=20")
    if code != 200:
        sys.exit(f"Auth failed ({code}): {owners}")
    owner_id = owners[0]["owner"]["id"]
    print(f"owner: {owners[0]['owner']['name']} ({owner_id})")

    svc = find_service()
    app_url = f"https://{SERVICE_NAME}.onrender.com"

    if svc:
        print(f"service exists: {svc['id']}  {svc.get('serviceDetails', {}).get('url', '')}")
        if "--sync-env" in sys.argv:
            ls = litestream_env()
            if ls:
                code, res = api("PUT", f"/services/{svc['id']}/env-vars", ls)
                print("env sync:", code, str(res)[:200])
                api("POST", f"/services/{svc['id']}/deploys", {"clearCache": "do_not_clear"})
                print("redeploy triggered")
        return poll(svc["id"])

    payload = {
        "type": "web_service",
        "name": SERVICE_NAME,
        "ownerId": owner_id,
        "repo": REPO,
        "branch": "main",
        "autoDeploy": "yes",
        "serviceDetails": {
            "env": "docker",
            "region": "oregon",
            "plan": "free",
            "healthCheckPath": "/api/health",
            "envSpecificDetails": {
                "dockerfilePath": "./backend/Dockerfile",
                "dockerContext": "./backend",
            },
        },
        "envVars": base_env(app_url),
    }
    code, res = api("POST", "/services", payload)
    if code not in (200, 201):
        sys.exit(f"create failed ({code}):\n{res}")
    svc = res["service"]
    print("service id:", svc["id"])
    print("dashboard: ", svc.get("dashboardUrl"))
    poll(svc["id"])


def poll(service_id):
    print("\nwaiting for deploy (Docker build ~5-10 min)…")
    for _ in range(90):
        code, deploys = api("GET", f"/services/{service_id}/deploys?limit=1")
        if code == 200 and deploys:
            d = deploys[0]["deploy"]
            print(f"  {d['id']}: {d['status']}")
            if d["status"] == "live":
                print("\nLIVE  https://address-verify.onrender.com")
                print("  admin UI:  https://address-verify.onrender.com/_/")
                return
            if d["status"] in ("build_failed", "update_failed", "canceled", "deactivated", "pre_deploy_failed"):
                print(f"\ndeploy {d['status']} — open the Render dashboard for logs.")
                return
        time.sleep(15)
    print("still going — check the Render dashboard.")


if __name__ == "__main__":
    main()
