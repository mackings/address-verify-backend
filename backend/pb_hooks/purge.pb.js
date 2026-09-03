/// <reference path="../pb_data/types.d.ts" />

// Data minimisation: once a certificate is issued (plus a short grace period)
// the raw location samples are deleted — only the certificate is kept. Also
// clears samples from cancelled verifications. Logic in ./lib/scoring.js.

cronAdd("purge_raw_samples", "20 * * * *", () => {
  require(`${__hooks}/lib/scoring.js`).purgeDue($app);
});

routerAdd(
  "POST",
  "/api/kyc/run-purge",
  (e) => e.json(200, { purged: require(`${__hooks}/lib/scoring.js`).purgeDue(e.app) }),
  $apis.requireSuperuserAuth()
);
