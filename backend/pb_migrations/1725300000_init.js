/// <reference path="../pb_data/types.d.ts" />

// Address-verification schema. PocketBase v0.23+ (JSVM migrations API).
//
// Model: a user enrols ONE verification for a claimed home address. The app
// records periodic location samples for a bounded window (default 14 days).
// A server cron scores overnight presence at the claimed address and issues a
// certificate, then the raw samples are purged. There is no "admin watches a
// live map" — the output is a pass/fail certificate with a night count.

migrate(
  (app) => {
    // --- users: real name for the certificate --------------------------
    const users = app.findCollectionByNameOrId("users");
    if (!users.fields.find((f) => f.name === "full_name")) {
      users.fields.add(
        new Field({ type: "text", name: "full_name", required: false, max: 120 })
      );
      app.save(users);
    }

    // --- staff: app admins who review results (NOT PocketBase superusers,
    //     NOT able to read raw location samples) -----------------------
    const staff = new Collection({
      id: "staffaccounts0",
      type: "auth",
      name: "staff",
      listRule: null,
      viewRule: "id = @request.auth.id",
      createRule: null, // created by a superuser in the dashboard
      updateRule: null,
      deleteRule: null,
      fields: [
        { type: "text", name: "name", required: true, max: 120 },
        { type: "text", name: "title", required: false, max: 120 }, // e.g. "Verification Officer"
      ],
      passwordAuth: { enabled: true, identityFields: ["email"] },
    });
    app.save(staff);

    // Helper: a rule fragment that also grants any authenticated staff member.
    const orStaff = ' || @request.auth.collectionName = "staff"';

    // --- verifications -----------------------------------------------
    const verifications = new Collection({
      id: "verifications01",
      type: "base",
      name: "verifications",
      listRule: "@request.auth.id = user" + orStaff,
      viewRule: "@request.auth.id = user" + orStaff,
      createRule: "@request.auth.id = user",
      updateRule: '@request.auth.id = user && status = "active"',
      deleteRule: "@request.auth.id = user",
      fields: [
        {
          type: "relation",
          name: "user",
          required: true,
          maxSelect: 1,
          collectionId: "_pb_users_auth_",
          cascadeDelete: true,
        },
        { type: "text", name: "claimed_address", required: true, max: 400 },
        { type: "number", name: "claimed_lat", required: true },
        { type: "number", name: "claimed_lng", required: true },
        { type: "number", name: "radius_m", required: true }, // match radius
        { type: "number", name: "window_days", required: true },
        { type: "number", name: "nights_required", required: true },
        { type: "number", name: "tz_offset_min", required: true }, // device UTC offset at enrol
        { type: "date", name: "started_at", required: true },
        { type: "date", name: "window_end", required: true },
        {
          type: "select",
          name: "status",
          required: true,
          maxSelect: 1,
          // active -> (window ends) pending_review -> (staff issues) certified
          values: ["active", "pending_review", "cancelled", "certified"],
        },
        // Auto-computed when the window ends; staff review this before issuing.
        // { nights:[{date,status}], nights_present, nights_with_data, verdict, confidence }
        { type: "json", name: "assessment", maxSize: 30000 },
        { type: "date", name: "purge_after" }, // set when certified
        { type: "autodate", name: "created", onCreate: true },
        { type: "autodate", name: "updated", onCreate: true, onUpdate: true },
      ],
      indexes: [
        "CREATE INDEX idx_verif_user_status ON verifications (user, status)",
      ],
    });
    app.save(verifications);

    // --- location_samples ---------------------------------------------
    const samples = new Collection({
      id: "locationsamples",
      type: "base",
      name: "location_samples",
      listRule: "@request.auth.id = user",
      viewRule: "@request.auth.id = user",
      createRule: "@request.auth.id = user",
      updateRule: null, // enriched by a hook (superuser); clients can't edit
      deleteRule: "@request.auth.id = user",
      fields: [
        {
          type: "relation",
          name: "verification",
          required: true,
          maxSelect: 1,
          collectionId: "verifications01",
          cascadeDelete: true,
        },
        {
          type: "relation",
          name: "user",
          required: true,
          maxSelect: 1,
          collectionId: "_pb_users_auth_",
          cascadeDelete: true,
        },
        { type: "number", name: "lat", required: true },
        { type: "number", name: "lng", required: true },
        { type: "number", name: "accuracy" },
        { type: "date", name: "recorded_at", required: true },
        { type: "bool", name: "is_night" }, // hook: local time in night window
        { type: "number", name: "dist_m" }, // hook: metres from claimed address
        { type: "text", name: "night_key", max: 12 }, // hook: date the night belongs to
        { type: "autodate", name: "created", onCreate: true },
      ],
      indexes: [
        "CREATE INDEX idx_sample_verif ON location_samples (verification, recorded_at)",
      ],
    });
    app.save(samples);

    // --- certificates ----------------------------------------------
    const certificates = new Collection({
      id: "certificates001",
      type: "base",
      name: "certificates",
      listRule: '@request.auth.id = user || @request.auth.collectionName = "staff"',
      viewRule: '@request.auth.id = user || @request.auth.collectionName = "staff"',
      createRule: null, // issued by the certify hook only
      updateRule: null,
      deleteRule: null,
      fields: [
        {
          type: "relation",
          name: "verification",
          required: true,
          maxSelect: 1,
          collectionId: "verifications01",
          cascadeDelete: true,
        },
        {
          type: "relation",
          name: "user",
          required: true,
          maxSelect: 1,
          collectionId: "_pb_users_auth_",
          cascadeDelete: true,
        },
        { type: "text", name: "reference", required: true, max: 40 },
        { type: "text", name: "holder_name", required: false, max: 120 },
        { type: "text", name: "holder_email", required: false, max: 160 },
        { type: "text", name: "address", required: true, max: 400 },
        { type: "number", name: "lat", required: true },
        { type: "number", name: "lng", required: true },
        { type: "date", name: "window_start", required: true },
        { type: "date", name: "window_end", required: true },
        { type: "number", name: "nights_total", required: true },
        { type: "number", name: "nights_with_data", required: true },
        { type: "number", name: "nights_present", required: true },
        { type: "number", name: "confidence", required: true },
        // Per-night verdict for the window: [{date, status}] where status is
        // "present" | "absent" | "no_data". No times — nightly pass/fail only.
        { type: "json", name: "nights", maxSize: 20000 },
        {
          type: "select",
          name: "verdict",
          required: true,
          maxSelect: 1,
          values: ["verified", "insufficient_data", "failed"],
        },
        // --- issuance: a staff member signs off ---
        {
          type: "relation",
          name: "issued_by",
          required: true,
          maxSelect: 1,
          collectionId: "staffaccounts0",
          cascadeDelete: false,
        },
        { type: "text", name: "issued_by_name", required: true, max: 120 },
        { type: "text", name: "issued_by_title", required: false, max: 120 },
        { type: "text", name: "note", required: false, max: 600 }, // optional reviewer note
        // HMAC of the certificate's core fields — the /cert/<ref> page revalidates it.
        { type: "text", name: "signature", required: true, max: 80 },
        { type: "date", name: "issued_at", required: true },
        { type: "autodate", name: "created", onCreate: true },
      ],
      indexes: [
        "CREATE UNIQUE INDEX idx_cert_verif ON certificates (verification)",
        "CREATE UNIQUE INDEX idx_cert_reference ON certificates (reference)",
      ],
    });
    app.save(certificates);
  },

  (app) => {
    for (const name of [
      "certificates",
      "location_samples",
      "verifications",
      "staff",
    ]) {
      try {
        app.delete(app.findCollectionByNameOrId(name));
      } catch (_) {}
    }
    try {
      const users = app.findCollectionByNameOrId("users");
      users.fields.removeByName("full_name");
      app.save(users);
    } catch (_) {}
  }
);
