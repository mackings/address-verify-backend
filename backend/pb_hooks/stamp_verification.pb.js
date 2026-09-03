/// <reference path="../pb_data/types.d.ts" />

// Copy the holder's name + email onto a verification when it's created, so the
// staff console can attribute and group verifications (incl. cancelled ones)
// without read access to the users collection.

onRecordCreate((e) => {
  try {
    const u = e.app.findRecordById("users", e.record.getString("user"));
    e.record.set("holder_name", u.getString("full_name"));
    e.record.set("holder_email", u.getString("email"));
  } catch (_) {}
  e.next();
}, "verifications");
