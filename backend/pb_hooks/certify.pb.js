/// <reference path="../pb_data/types.d.ts" />

// Verification lifecycle:
//   active --(window ends: hourly cron assesses)--> pending_review
//   pending_review --(staff issues from the console)--> certified  + email holder
//
// Shared logic in ./lib/scoring.js (hook callbacks run in isolated runtimes).

// Hourly: assess any window that has ended, move it to pending_review.
cronAdd("assess_finished_windows", "5 * * * *", () => {
  require(`${__hooks}/lib/scoring.js`).assessDue($app);
});

// Force an assessment pass now (superuser).
routerAdd(
  "POST",
  "/api/kyc/run-assess",
  (e) => e.json(200, { assessed: require(`${__hooks}/lib/scoring.js`).assessDue(e.app) }),
  $apis.requireSuperuserAuth()
);

// Staff issues a certificate for a pending_review verification.
//   body: { verification: "<id>", verdict?: "verified"|"insufficient_data"|"failed", note?: "..." }
routerAdd(
  "POST",
  "/api/kyc/issue",
  (e) => {
    const body = e.requestInfo().body || {};
    if (!body.verification) throw new BadRequestError("verification is required");
    const cert = require(`${__hooks}/lib/scoring.js`).issueCertificate(
      e.app,
      body.verification,
      e.auth, // the authenticated staff record
      { verdict: body.verdict, note: body.note }
    );
    return e.json(200, {
      reference: cert.getString("reference"),
      verdict: cert.getString("verdict"),
      url: require(`${__hooks}/lib/scoring.js`).certUrl(e.app, cert.getString("reference")),
    });
  },
  $apis.requireAuth("staff")
);

// Staff previews the certificate BEFORE issuing (watermarked, unsigned).
//   body: { verification, verdict?, note? }
routerAdd(
  "POST",
  "/api/kyc/preview",
  (e) => {
    const body = e.requestInfo().body || {};
    if (!body.verification) throw new BadRequestError("verification is required");
    const scoring = require(`${__hooks}/lib/scoring.js`);
    const d = scoring.previewData(e.app, body.verification, e.auth, {
      verdict: body.verdict,
      note: body.note,
    });
    return e.html(200, scoring.renderCertHTML(d, { preview: true }));
  },
  $apis.requireAuth("staff")
);

// Public certificate page — the link in the holder's email. Printable.
routerAdd("GET", "/cert/{reference}", (e) => {
  const ref = e.request.pathValue("reference");
  let cert;
  try {
    cert = e.app.findFirstRecordByFilter("certificates", "reference = {:r}", { r: ref });
  } catch (_) {
    return e.html(404, "<h1>Certificate not found</h1>");
  }
  const scoring = require(`${__hooks}/lib/scoring.js`);
  return e.html(
    200,
    scoring.renderCertHTML(scoring.certRecordToData(cert), {
      signatureValid: scoring.verifySignature(cert),
    })
  );
});
