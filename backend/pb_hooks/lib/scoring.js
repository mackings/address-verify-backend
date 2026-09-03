/// <reference path="../../pb_data/types.d.ts" />

// Shared logic, require()'d by the hooks (each hook callback runs in its own
// isolated runtime, so require() is the only way to share code). Everything
// takes `app` as an argument.

const PURGE_GRACE_HOURS = 48;

function makeRef() {
  const s = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "AV-";
  for (let i = 0; i < 10; i++) out += s[Math.floor(Math.random() * s.length)];
  return out;
}

function signingSecret() {
  return $os.getenv("CERT_SIGNING_SECRET") || "dev-insecure-change-me";
}

// Deterministic HMAC over the certificate's core, human-meaningful fields.
function signPayload(fields) {
  const payload = [
    fields.reference,
    fields.holder_name,
    fields.address,
    fields.lat.toFixed(6),
    fields.lng.toFixed(6),
    fields.window_start,
    fields.window_end,
    fields.nights_present,
    fields.nights_total,
    fields.verdict,
    fields.issued_at,
  ].join("|");
  return $security.hs256(payload, signingSecret()).slice(0, 32);
}
function verifySignature(cert) {
  return (
    signPayload({
      reference: cert.getString("reference"),
      holder_name: cert.getString("holder_name"),
      address: cert.getString("address"),
      lat: cert.getFloat("lat"),
      lng: cert.getFloat("lng"),
      window_start: cert.getDateTime("window_start").string(),
      window_end: cert.getDateTime("window_end").string(),
      nights_present: cert.getFloat("nights_present"),
      nights_total: cert.getFloat("nights_total"),
      verdict: cert.getString("verdict"),
      issued_at: cert.getDateTime("issued_at").string(),
    }) === cert.getString("signature")
  );
}

// ---- assessment: run when a window ends. Computes the night breakdown and
//      moves the verification to "pending_review". Does NOT issue anything.
function assessDue(app) {
  const nowIso = new Date().toISOString().replace("T", " ");
  const due = app.findRecordsByFilter(
    "verifications",
    'status = "active" && window_end < {:now}',
    "",
    200,
    0,
    { now: nowIso }
  );

  let count = 0;
  for (const v of due) {
    v.set("assessment", assess(app, v));
    v.set("status", "pending_review");
    app.save(v);
    count++;
    app.logger().info("verification ready for review", "id", v.id);
  }
  return count;
}

function assess(app, v) {
  const samples = app.findRecordsByFilter(
    "location_samples",
    "verification = {:v} && is_night = true",
    "",
    20000,
    0,
    { v: v.id }
  );

  const radius = v.getFloat("radius_m");
  const withData = {};
  const present = {};
  for (const s of samples) {
    const key = s.getString("night_key");
    if (!key) continue;
    withData[key] = true;
    if (s.getFloat("dist_m") <= radius) present[key] = true;
  }

  const nightsTotal = v.getFloat("window_days");
  const nightsRequired = v.getFloat("nights_required");
  const startMs = new Date(v.getDateTime("started_at").string()).valueOf();
  const nights = [];
  for (let i = 0; i < nightsTotal; i++) {
    const date = new Date(startMs + i * 86400000).toISOString().slice(0, 10);
    nights.push({
      date: date,
      status: present[date] ? "present" : withData[date] ? "absent" : "no_data",
    });
  }

  const nPresent = Object.keys(present).length;
  const nWithData = Object.keys(withData).length;
  let verdict;
  if (nPresent >= nightsRequired) verdict = "verified";
  else if (nWithData < nightsRequired) verdict = "insufficient_data";
  else verdict = "failed";

  return {
    nights: nights,
    nights_total: nightsTotal,
    nights_with_data: nWithData,
    nights_present: nPresent,
    verdict: verdict,
    confidence:
      nightsTotal > 0 ? Math.round((nPresent / nightsTotal) * 100) / 100 : 0,
  };
}

// ---- issuance: a staff member signs off. `opts` = { verdict?, note? }.
function issueCertificate(app, verificationId, staff, opts) {
  opts = opts || {};
  const v = app.findRecordById("verifications", verificationId);
  if (v.getString("status") !== "pending_review") {
    throw new BadRequestError("Verification is not awaiting review.");
  }

  let a = v.get("assessment");
  if (typeof a === "string") {
    try {
      a = JSON.parse(a);
    } catch (_) {
      a = null;
    }
  }
  if (!a || typeof a.verdict !== "string") a = assess(app, v);

  const verdict = opts.verdict || a.verdict;
  if (["verified", "insufficient_data", "failed"].indexOf(verdict) === -1) {
    throw new BadRequestError("Invalid verdict.");
  }

  let holderName = "";
  let holderEmail = "";
  try {
    const holder = app.findRecordById("users", v.getString("user"));
    holderName = holder.getString("full_name");
    holderEmail = holder.getString("email");
  } catch (_) {}

  const nowIso = new Date().toISOString().replace("T", " ");
  const reference = makeRef();
  const core = {
    reference: reference,
    holder_name: holderName,
    address: v.getString("claimed_address"),
    lat: v.getFloat("claimed_lat"),
    lng: v.getFloat("claimed_lng"),
    window_start: v.getDateTime("started_at").string(),
    window_end: v.getDateTime("window_end").string(),
    nights_present: a.nights_present,
    nights_total: a.nights_total,
    verdict: verdict,
    issued_at: nowIso,
  };

  const cert = new Record(app.findCollectionByNameOrId("certificates"), {
    verification: v.id,
    user: v.getString("user"),
    reference: reference,
    holder_name: holderName,
    holder_email: holderEmail,
    address: core.address,
    lat: core.lat,
    lng: core.lng,
    window_start: core.window_start,
    window_end: core.window_end,
    nights_total: a.nights_total,
    nights_with_data: a.nights_with_data,
    nights_present: a.nights_present,
    confidence: a.confidence,
    nights: a.nights,
    verdict: verdict,
    issued_by: staff.id,
    issued_by_name: staff.getString("name"),
    issued_by_title: staff.getString("title"),
    note: (opts.note || "").slice(0, 600),
    signature: signPayload(core),
    issued_at: nowIso,
  });
  app.save(cert);

  v.set("status", "certified");
  v.set(
    "purge_after",
    new Date(Date.now() + PURGE_GRACE_HOURS * 3600 * 1000)
      .toISOString()
      .replace("T", " ")
  );
  app.save(v);

  emailHolder(app, cert);
  app.logger().info("certificate issued", "ref", reference, "by", staff.id);
  return cert;
}

function certUrl(app, reference) {
  let base = "";
  try {
    base = app.settings().meta.appURL || "";
  } catch (_) {}
  base = base || $os.getenv("APP_URL") || "http://localhost:8090";
  return base.replace(/\/$/, "") + "/cert/" + reference;
}

function emailHolder(app, cert) {
  const to = cert.getString("holder_email");
  if (!to) return;
  const verdict = cert.getString("verdict");
  const label =
    verdict === "verified"
      ? "verified"
      : verdict === "failed"
      ? "not verified"
      : "inconclusive";
  const url = certUrl(app, cert.getString("reference"));

  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#111">
      <h2 style="margin:0 0 4px">Address Verification Certificate</h2>
      <p style="color:#666;margin:0 0 20px">Reference ${cert.getString("reference")}</p>
      <p>Dear ${cert.getString("holder_name") || "applicant"},</p>
      <p>Your address verification has been reviewed and a certificate issued.
      Result: <strong>${label.toUpperCase()}</strong>
      (${cert.getFloat("nights_present")} of ${cert.getFloat("nights_total")} nights confirmed at the address).</p>
      <p style="margin:24px 0">
        <a href="${url}" style="background:#2048d6;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;display:inline-block">
          View &amp; download certificate
        </a>
      </p>
      <p style="color:#666;font-size:13px">Issued by ${cert.getString("issued_by_name")}${
    cert.getString("issued_by_title") ? ", " + cert.getString("issued_by_title") : ""
  }. This certificate is digitally signed; anyone can confirm it at the link above.</p>
    </div>`;

  try {
    const settings = app.settings();
    const msg = new MailerMessage({
      from: {
        address: settings.meta.senderAddress,
        name: settings.meta.senderName,
      },
      to: [{ address: to }],
      subject: `Your address verification certificate — ${cert.getString("reference")}`,
      html: html,
    });
    app.newMailClient().send(msg);
  } catch (e) {
    app.logger().warn("certificate email failed (SMTP not configured?)", "err", String(e));
  }
}

// ---- raw-sample purge ----
function purgeSamplesFor(app, verificationId) {
  const samples = app.findRecordsByFilter(
    "location_samples",
    "verification = {:v}",
    "",
    20000,
    0,
    { v: verificationId }
  );
  for (const s of samples) app.delete(s);
  return samples.length;
}
function purgeDue(app) {
  const nowIso = new Date().toISOString().replace("T", " ");
  let total = 0;
  const certified = app.findRecordsByFilter(
    "verifications",
    'status = "certified" && purge_after != "" && purge_after < {:now}',
    "",
    200,
    0,
    { now: nowIso }
  );
  for (const v of certified) total += purgeSamplesFor(app, v.id);
  const cancelled = app.findRecordsByFilter(
    "verifications",
    'status = "cancelled"',
    "",
    200,
    0
  );
  for (const v of cancelled) total += purgeSamplesFor(app, v.id);
  if (total) app.logger().info("purged raw samples", "count", total);
  return total;
}

// ---- certificate document (shared by /cert/<ref> and the staff preview) ----
function renderCertHTML(d, opts) {
  opts = opts || {};
  const preview = !!opts.preview;
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
    );
  const fd = (s) =>
    s
      ? new Date(s).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })
      : "—";
  const verdictText =
    d.verdict === "verified" ? "VERIFIED" : d.verdict === "failed" ? "NOT VERIFIED" : "INCONCLUSIVE";
  const verdictColor =
    d.verdict === "verified" ? "#0f9d58" : d.verdict === "failed" ? "#d93025" : "#c77700";

  const grid = (d.nights || [])
    .map((n) => {
      const bg =
        n.status === "present" ? "#0f9d58" : n.status === "absent" ? "#d93025" : "#e5e7eb";
      const fg = n.status === "no_data" ? "#9ca3af" : "#fff";
      const mark = n.status === "present" ? "✓" : n.status === "absent" ? "✕" : "–";
      return `<td style="width:26px;height:26px;text-align:center;background:${bg};color:${fg};font-size:12px;border:2px solid #fff;border-radius:5px">${mark}</td>`;
    })
    .join("");

  const conf = Math.round((d.confidence || 0) * 100);
  const watermark = preview
    ? `<div style="position:fixed;inset:0;pointer-events:none;display:flex;align-items:center;justify-content:center;z-index:5">
         <div style="font-family:Arial,sans-serif;font-weight:800;font-size:96px;color:rgba(200,0,0,.08);transform:rotate(-24deg);letter-spacing:.1em">DRAFT — NOT ISSUED</div>
       </div>`
    : "";

  const footer = preview
    ? `This is a <strong>preview</strong>. No certificate has been issued and this document is not signed. Issue from the staff console to finalise.`
    : `Digital signature <code>${esc(d.signature)}</code> —
       <span style="color:${opts.signatureValid ? "#0f9d58" : "#d93025"};font-weight:700">${
        opts.signatureValid ? "VALID" : "INVALID — do not accept"
      }</span>. Regenerated from the signed record on ${new Date().toLocaleString("en-US")} and revalidated on load.`;

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${preview ? "PREVIEW — " : ""}Address Verification Certificate${d.reference ? " — " + esc(d.reference) : ""}</title>
<style>
  @media print { .noprint { display:none } body { padding:0 } }
  body { font-family: Georgia, "Times New Roman", serif; color:#1a1a1a; background:#f3f4f6; margin:0; padding:32px; }
  .sheet { position:relative; max-width:760px; margin:0 auto; background:#fff; border:1px solid #d1d5db; padding:56px 60px; z-index:1 }
  .top { display:flex; justify-content:space-between; align-items:flex-start; border-bottom:2px solid #1a1a1a; padding-bottom:16px; }
  .brand { font-size:13px; letter-spacing:.18em; text-transform:uppercase; font-family:Arial,sans-serif; }
  .ref { font-family:"Courier New",monospace; font-size:13px; }
  h1 { font-size:26px; text-align:center; margin:34px 0 6px; letter-spacing:.02em; }
  .sub { text-align:center; color:#555; font-size:13px; font-family:Arial,sans-serif; margin-bottom:30px; }
  .verdict { text-align:center; font-family:Arial,sans-serif; font-weight:700; letter-spacing:.14em; font-size:18px; padding:12px; border:2px solid ${verdictColor}; color:${verdictColor}; margin:0 auto 30px; max-width:340px; }
  .body p { line-height:1.7; font-size:15px; }
  .grid table { border-collapse:separate; border-spacing:3px; margin:10px 0 4px; }
  .legend { font-family:Arial,sans-serif; font-size:11px; color:#666; }
  .facts { width:100%; font-family:Arial,sans-serif; font-size:13px; margin:24px 0; border-collapse:collapse; }
  .facts td { padding:7px 0; border-bottom:1px solid #eee; vertical-align:top; }
  .facts td:first-child { color:#666; width:190px; }
  .sig { margin-top:44px; display:flex; justify-content:space-between; align-items:flex-end; }
  .sigline { border-top:1px solid #1a1a1a; padding-top:6px; width:260px; font-family:Arial,sans-serif; font-size:12px; }
  .signame { font-family:Georgia,serif; font-size:20px; font-style:italic; margin-bottom:2px; ${preview ? "color:#9ca3af" : ""} }
  .seal { font-family:Arial,sans-serif; font-size:10px; text-align:center; color:#666; border:1px solid #999; border-radius:50%; width:96px; height:96px; display:flex; flex-direction:column; align-items:center; justify-content:center; line-height:1.3; ${preview ? "opacity:.4" : ""} }
  .foot { margin-top:40px; border-top:1px solid #ddd; padding-top:14px; font-family:Arial,sans-serif; font-size:11px; color:#666; }
  .btn { font-family:Arial,sans-serif; background:#2048d6; color:#fff; border:0; padding:9px 16px; border-radius:7px; cursor:pointer; font-size:13px; }
</style></head><body>
${watermark}
${preview ? "" : `<div class="noprint" style="max-width:760px;margin:0 auto 14px;text-align:right"><button class="btn" onclick="window.print()">Print / Save as PDF</button></div>`}
<div class="sheet">
  <div class="top">
    <div class="brand">Address&nbsp;Verify</div>
    <div class="ref">Ref&nbsp;${esc(d.reference || "— DRAFT —")}</div>
  </div>
  <h1>Certificate of Address Verification</h1>
  <div class="sub">Issued under the Address Verify residency-confirmation program</div>
  <div class="verdict">${verdictText}</div>
  <div class="body">
    <p>This is to certify that <strong>${esc(d.holder_name || "the applicant")}</strong>
    ${d.holder_email ? "(" + esc(d.holder_email) + ")" : ""}
    submitted the residential address below for verification, and that over the
    verification period the applicant's device was confirmed present at that
    address on <strong>${d.nights_present} of ${d.nights_total}</strong> monitored nights.</p>
    <table class="facts">
      <tr><td>Residential address</td><td>${esc(d.address)}</td></tr>
      <tr><td>Coordinates</td><td>${(+d.lat).toFixed(6)}, ${(+d.lng).toFixed(6)}</td></tr>
      <tr><td>Verification period</td><td>${fd(d.window_start)} &ndash; ${fd(d.window_end)}</td></tr>
      <tr><td>Nights present / total</td><td>${d.nights_present} / ${d.nights_total} &nbsp;(${conf}% confidence)</td></tr>
      <tr><td>Nights with data</td><td>${d.nights_with_data}</td></tr>
      ${d.note ? `<tr><td>Reviewer note</td><td>${esc(d.note)}</td></tr>` : ""}
    </table>
    <div class="grid">
      <div class="legend">Night-by-night&nbsp;&nbsp;<span style="color:#0f9d58">✓ present</span> &nbsp;
        <span style="color:#d93025">✕ away</span> &nbsp; <span style="color:#9ca3af">– no data</span></div>
      <table><tr>${grid}</tr></table>
    </div>
  </div>
  <div class="sig">
    <div>
      <div class="signame">${esc(d.issued_by_name || "—")}</div>
      <div class="sigline">${esc(d.issued_by_name || "Pending signature")}${
    d.issued_by_title ? " &mdash; " + esc(d.issued_by_title) : ""
  }<br>Date issued: ${preview ? "—" : fd(d.issued_at)}</div>
    </div>
    <div class="seal">ADDRESS<br>VERIFY<br>&#9679;<br>OFFICIAL</div>
  </div>
  <div class="foot">${footer}</div>
</div>
</body></html>`;
}

// Build the document-shaped object for a not-yet-issued verification.
function previewData(app, verificationId, staff, opts) {
  opts = opts || {};
  const v = app.findRecordById("verifications", verificationId);
  let a = v.get("assessment");
  if (typeof a === "string") {
    try {
      a = JSON.parse(a);
    } catch (_) {
      a = null;
    }
  }
  if (!a || typeof a.verdict !== "string") a = assess(app, v);

  let holderName = "";
  let holderEmail = "";
  try {
    const u = app.findRecordById("users", v.getString("user"));
    holderName = u.getString("full_name");
    holderEmail = u.getString("email");
  } catch (_) {}

  return {
    reference: "",
    holder_name: holderName,
    holder_email: holderEmail,
    address: v.getString("claimed_address"),
    lat: v.getFloat("claimed_lat"),
    lng: v.getFloat("claimed_lng"),
    window_start: v.getDateTime("started_at").string(),
    window_end: v.getDateTime("window_end").string(),
    nights_present: a.nights_present,
    nights_total: a.nights_total,
    nights_with_data: a.nights_with_data,
    confidence: a.confidence,
    nights: a.nights,
    verdict: opts.verdict || a.verdict,
    note: (opts.note || "").slice(0, 600),
    issued_by_name: staff ? staff.getString("name") : "",
    issued_by_title: staff ? staff.getString("title") : "",
    signature: "",
    issued_at: "",
  };
}

function certRecordToData(cert) {
  return {
    reference: cert.getString("reference"),
    holder_name: cert.getString("holder_name"),
    holder_email: cert.getString("holder_email"),
    address: cert.getString("address"),
    lat: cert.getFloat("lat"),
    lng: cert.getFloat("lng"),
    window_start: cert.getDateTime("window_start").string(),
    window_end: cert.getDateTime("window_end").string(),
    nights_present: cert.getFloat("nights_present"),
    nights_total: cert.getFloat("nights_total"),
    nights_with_data: cert.getFloat("nights_with_data"),
    confidence: cert.getFloat("confidence"),
    nights: (function () {
      let n = cert.get("nights");
      if (typeof n === "string") {
        try {
          n = JSON.parse(n);
        } catch (_) {
          n = [];
        }
      }
      return n || [];
    })(),
    verdict: cert.getString("verdict"),
    note: cert.getString("note"),
    issued_by_name: cert.getString("issued_by_name"),
    issued_by_title: cert.getString("issued_by_title"),
    signature: cert.getString("signature"),
    issued_at: cert.getDateTime("issued_at").string(),
  };
}

module.exports = {
  assessDue,
  assess,
  issueCertificate,
  purgeDue,
  verifySignature,
  certUrl,
  renderCertHTML,
  previewData,
  certRecordToData,
};
