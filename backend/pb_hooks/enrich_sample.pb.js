/// <reference path="../pb_data/types.d.ts" />

// When the app posts a raw location sample, derive the only three things the
// verification needs: distance from the claimed address, whether it was
// recorded during night hours (local time), and which night it belongs to.
//
// NOTE: PocketBase runs this callback in an isolated runtime — everything it
// uses must be declared inside the function.

onRecordCreate((e) => {
  const NIGHT_START_HOUR = 1; // inclusive, local time
  const NIGHT_END_HOUR = 5; // exclusive

  const haversineMeters = (lat1, lon1, lat2, lon2) => {
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a =
      Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  };

  const rec = e.record;
  const verif = e.app.findRecordById(
    "verifications",
    rec.getString("verification")
  );

  const distM = haversineMeters(
    rec.getFloat("lat"),
    rec.getFloat("lng"),
    verif.getFloat("claimed_lat"),
    verif.getFloat("claimed_lng")
  );

  const tzOffsetMin = verif.getFloat("tz_offset_min");
  const recordedUtcMs = new Date(
    rec.getDateTime("recorded_at").string()
  ).valueOf();
  const local = new Date(recordedUtcMs + tzOffsetMin * 60 * 1000);
  const localHour = local.getUTCHours();

  const isNight = localHour >= NIGHT_START_HOUR && localHour < NIGHT_END_HOUR;
  const nightAnchor = new Date(local.valueOf() - 6 * 3600 * 1000);
  const nightKey = nightAnchor.toISOString().slice(0, 10);

  rec.set("dist_m", Math.round(distM));
  rec.set("is_night", isNight);
  rec.set("night_key", nightKey);

  e.next();
}, "location_samples");
