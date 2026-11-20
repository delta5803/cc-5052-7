// Device clock models and two-point calibration.
//
// Each device stamps events on its own clock. The true mapping from media
// time t (the phrase timeline) to a device reading is affine:
//
//   deviceTime(t) = origin + offset + t * (1 + rate)
//
// Device 1 has a stable fixed latency (rate 0). Device 2's clock runs slow,
// so its rate is positive: equal score positions land progressively later.
//
// A hit record stores the device reading and the media sample as observed.
// Nothing in a record is a judgment — calibration and judging are separate,
// recomputable steps operating on those raw observations.

export const SAMPLE_RATE = 48000;

export const DEVICES = Object.freeze({
  dev1: Object.freeze({
    id: 'dev1',
    label: '一号设备 · 稳定延迟',
    offset: 0.04,          // fixed 40 ms capture/output latency
    rate: 0,               // no drift
    sampleRate: SAMPLE_RATE
  }),
  dev2: Object.freeze({
    id: 'dev2',
    label: '二号设备 · 缓慢时钟漂移',
    offset: 0.02,          // small base latency
    rate: 0.0085,          // clock runs ~0.85% slow; 19.2s -> 163ms drift
    sampleRate: SAMPLE_RATE
  })
});

// Phrase origin as it appears on each device clock before any calibration.
export const DEVICE_ORIGIN = Object.freeze({ dev1: 100, dev2: 200 });

export function deviceReading(device, mediaTime, origin = DEVICE_ORIGIN[device.id]) {
  return origin + device.offset + mediaTime * (1 + device.rate);
}

// Sample frame stamped by the device at a media instant. The device counts
// samples on its own clock, so a slow clock accumulates extra frames.
export function sampleAt(device, mediaTime, origin = DEVICE_ORIGIN[device.id]) {
  return Math.round(deviceReading(device, mediaTime, origin) * device.sampleRate);
}

// Naive mapping a game uses before calibration: it learned the origin reading
// but assumes the device clock runs at true rate. Removes the origin only;
// fixed latency and drift both survive as raw timing error.
export function naiveMediaTime(device, reading, origin = DEVICE_ORIGIN[device.id]) {
  return reading - origin;
}

// --- Calibration -----------------------------------------------------------
// A sync marker pairs a known media position with the device clock reading
// observed there. Two markers span the phrase and recover offset and rate.
export function makeMarker(mediaTime, device, origin = DEVICE_ORIGIN[device.id]) {
  return Object.freeze({
    mediaTime,
    deviceTime: deviceReading(device, mediaTime, origin)
  });
}

export function defaultMarkers(device, origin = DEVICE_ORIGIN[device.id]) {
  return Object.freeze([
    makeMarker(0, device, origin),
    makeMarker(24, device, origin)
  ]);
}

// Fit reading = origin + a + (1+r) * t from two or more markers. With exactly
// two markers this is the exact two-point line; more markers use least squares
// so a moved marker behaves like a noisy observation.
export function fitCalibration(markers) {
  const n = markers.length;
  if (n < 2) throw new Error('need at least two sync markers');
  let st = 0, sr = 0, stt = 0, str = 0;
  for (const m of markers) {
    st += m.mediaTime;
    sr += m.deviceTime;
    stt += m.mediaTime * m.mediaTime;
    str += m.mediaTime * m.deviceTime;
  }
  const denom = n * stt - st * st;
  const slope = denom === 0 ? 1 : (n * str - st * sr) / denom;
  const intercept = (sr - slope * st) / n;
  // intercept = origin + offset  ->  offset = intercept - origin
  return Object.freeze({
    origin: markers[0].origin ?? null,
    intercept,
    slope,
    offset: null, // filled by calibrateToMedia once origin is known
    rate: slope - 1
  });
}

// Invert the fitted line to recover true media time from a device reading.
export function calibrateToMedia(markers, origin) {
  const fit = fitCalibration(markers);
  const offset = fit.intercept - origin;
  const map = (reading) => (reading - origin - offset) / (1 + fit.rate);
  return Object.freeze({
    origin,
    offset,
    rate: fit.rate,
    map,
    fit: Object.freeze({ ...fit, offset })
  });
}

// Convenience: calibration built directly from a device's true model. Used by
// the generator for the "factory" calibration and by tests as the oracle.
export function trueCalibration(device, origin = DEVICE_ORIGIN[device.id]) {
  return calibrateToMedia(defaultMarkers(device, origin), origin);
}
