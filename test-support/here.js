import { haversineDistance } from "../src/routing/geometry.js";
import { AppError } from "../src/shared/errors.js";

export function encodePolyline(points, precision = 6, third = false) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const unsigned = n => { let s = ""; do { let v = Number(n & 31n); n >>= 5n; if (n) v |= 32; s += chars[v]; } while (n); return s; };
  const signed = n => unsigned(n < 0n ? (-n * 2n - 1n) : n * 2n);
  let encoded = unsigned(1n) + unsigned(BigInt(precision | (third ? 2 << 4 : 0)));
  let lat = 0n, lng = 0n;
  for (const p of points) {
    const a = BigInt(Math.round(p[1] * 10 ** precision)), b = BigInt(Math.round(p[0] * 10 ** precision));
    encoded += signed(a - lat) + signed(b - lng) + (third ? unsigned(0n) : ""); lat = a; lng = b;
  }
  return encoded;
}

export const length = points => points.slice(1).reduce((n, p, i) => n + haversineDistance(
  { lng: points[i][0], lat: points[i][1] }, { lng: p[0], lat: p[1] }), 0);

export function routeData(count = 4, spacing = 0.03) {
  const points = Array.from({ length: count }, (_, i) => [29 + i * spacing, 41]);
  return [{ line: `LINESTRING (${points.map(p => p.join(" ")).join(",")})`,
    stationPlaces: points.map(([lng, lat], i) => ({ stationName: `STOP ${i}`, lng, lat })) }];
}

export function section(points, departureTime, duration, dwell = 0) {
  const meters = Math.round(length(points)), base = Math.floor(duration * 0.75);
  return { type: "vehicle", transport: { mode: "car" }, polyline: encodePolyline(points),
    departure: { time: departureTime }, arrival: { time: new Date(Date.parse(departureTime) + duration * 1000).toISOString() },
    summary: { duration: duration + dwell, length: meters, baseDuration: base + dwell, typicalDuration: duration + dwell },
    travelSummary: { duration, length: meters, baseDuration: base, typicalDuration: duration },
    spans: [{ offset: 0, duration, length: meters, baseDuration: base, typicalDuration: duration }],
    ...(dwell ? { postActions: [{ action: "wait", duration: dwell }] } : {}) };
}

export class MockHereClient {
  constructor({ modify, repair } = {}) { Object.assign(this, { modify, repair, calls: [], handles: new Map(), invalidHandle: false }); }
  build(request, method) {
    const boundaries = [0, ...request.via.map(v => v.index), request.trace.length - 1];
    let timestamp = Date.parse(request.departureTime);
    const sections = boundaries.slice(1).map((to, i) => {
      const points = request.trace.slice(boundaries[i], to + 1).map(p => [p.lng, p.lat]);
      const duration = 200 + i * 50;
      const dwell = request.via[i]?.stopDuration ?? 0;
      const s = section(points, new Date(timestamp).toISOString(), duration, dwell);
      timestamp += (duration + dwell) * 1000;
      return s;
    });
    const data = { routes: [{ routeHandle: "handle-" + this.handles.size, sections }] };
    this.handles.set(data.routes[0].routeHandle, structuredClone(request));
    return this.modify?.(data, request, method) ?? data;
  }
  async importRoute(request) { this.calls.push({ method: "import", request: structuredClone(request) }); return this.build(request, "import"); }
  async getRouteByHandle(handle, options) {
    this.calls.push({ method: "handle", handle, request: options });
    if (this.invalidHandle) { this.invalidHandle = false; throw new AppError(502, "HERE_ROUTE_HANDLE_INVALID", "Invalid handle."); }
    return this.build({ ...this.handles.get(handle), ...options }, "handle");
  }
  async calculateRoute(request) {
    this.calls.push({ method: "repair", request });
    if (this.repair) return this.repair(request);
    throw new AppError(502, "HERE_NO_ROUTE", "No local route.");
  }
}

export function withPath(s, points) {
  const replacement = section(points, s.departure.time, s.travelSummary.duration,
    s.summary.duration - s.travelSummary.duration);
  return { ...s, ...replacement };
}
