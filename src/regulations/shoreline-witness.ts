/** Exact rational predicates over binary64 coordinates. A whole polygon lies
 * in a convex segment strip if all its vertices lie there; no ring editing or
 * area threshold is used. Units are 2^-1074, including subnormal numbers. */
function integer(value: number): bigint {
  if (!Number.isFinite(value)) throw Error("nonfinite witness coordinate");
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  const bits = view.getBigUint64(0, false);
  const sign = bits >> 63n ? -1n : 1n;
  const exponent = Number((bits >> 52n) & 2047n);
  const fraction = bits & ((1n << 52n) - 1n);
  return (
    sign *
    (exponent === 0
      ? fraction
      : ((1n << 52n) | fraction) << BigInt(exponent - 1))
  );
}
export function withinOriginalSegmentStrip(
  points: Array<[number, number]>,
  segment: [[number, number], [number, number]],
): boolean {
  const [a, b] = segment.map((p) => p.map(integer));
  const x = b[0] - a[0];
  const y = b[1] - a[1];
  const norm = x * x + y * y;
  if (!norm) return false;
  const scaleSquared = 1n << 2148n;
  const decimalSquared = 10n ** 24n;
  return points.every((point) => {
    const px = integer(point[0]) - a[0];
    const py = integer(point[1]) - a[1];
    const dot = px * x + py * y;
    const cross = px * y - py * x;
    return (
      dot >= 0n &&
      dot <= norm &&
      cross * cross * decimalSquared <= norm * scaleSquared
    );
  });
}
