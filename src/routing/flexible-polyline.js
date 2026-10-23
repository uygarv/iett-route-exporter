// HERE Flexible Polyline v1: unsigned base-32 varints, zig-zag deltas and a
// precision/optional-third-dimension header. Output uses GeoJSON lng/lat order.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export function decodeFlexiblePolyline(encoded) {
  if (typeof encoded !== "string" || !encoded.length) throw new Error("Missing flexible polyline.");
  const values = [];
  let value = 0n, shift = 0n;
  for (const character of encoded) {
    const digit = ALPHABET.indexOf(character);
    if (digit < 0 || shift > 60n) throw new Error("Invalid flexible polyline.");
    value |= BigInt(digit & 31) << shift;
    if (digit & 32) shift += 5n;
    else { values.push(value); value = 0n; shift = 0n; }
  }
  if (shift || values.length < 2 || values[0] !== 1n) throw new Error("Invalid flexible polyline header.");
  const header = Number(values[1]), precision = header & 15, third = (header >> 4) & 7;
  if (header > 2047 || third === 4 || third === 5) throw new Error("Invalid flexible polyline dimension.");
  const stride = third ? 3 : 2, scale = 10 ** precision;
  if ((values.length - 2) % stride) throw new Error("Truncated flexible polyline.");
  const signed = n => Number(n & 1n ? ~(n >> 1n) : n >> 1n);
  const points = [];
  let lat = 0, lng = 0;
  for (let index = 2; index < values.length; index += stride) {
    lat += signed(values[index]); lng += signed(values[index + 1]);
    const point = [lng / scale, lat / scale];
    if (!point.every(Number.isFinite) || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90) {
      throw new Error("Invalid flexible polyline coordinate.");
    }
    points.push(point);
  }
  if (points.length < 2) throw new Error("Incomplete flexible polyline.");
  return { type: "LineString", coordinates: points };
}
