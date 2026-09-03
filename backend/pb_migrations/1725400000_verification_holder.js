/// <reference path="../pb_data/types.d.ts" />

// Denormalise the holder's name + email onto each verification so the staff
// console can show and group them (staff cannot read the users collection).

migrate(
  (app) => {
    const v = app.findCollectionByNameOrId("verifications");
    if (!v.fields.find((f) => f.name === "holder_name")) {
      v.fields.add(new Field({ type: "text", name: "holder_name", max: 120 }));
    }
    if (!v.fields.find((f) => f.name === "holder_email")) {
      v.fields.add(new Field({ type: "text", name: "holder_email", max: 160 }));
    }
    app.save(v);

    // Backfill existing rows.
    const rows = app.findRecordsByFilter("verifications", "id != ''", "", 5000, 0);
    for (const r of rows) {
      if (r.getString("holder_email")) continue;
      try {
        const u = app.findRecordById("users", r.getString("user"));
        r.set("holder_name", u.getString("full_name"));
        r.set("holder_email", u.getString("email"));
        app.save(r);
      } catch (_) {}
    }
  },
  (app) => {
    const v = app.findCollectionByNameOrId("verifications");
    v.fields.removeByName("holder_name");
    v.fields.removeByName("holder_email");
    app.save(v);
  }
);
