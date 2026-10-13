/** Only deliberate source-precision checks may request weaker interval admission.
 * Identity, rather than an error message, distinguishes them from native failures.
 * The weak membership certificate does not retain a failed scene or exception.
 */
const certificates = new WeakSet<Error>();
const topologyAdmissions = new WeakSet<Error>();

export function sourcePrecisionCertificateError(message: string): Error {
  const error = new Error(message);
  certificates.add(error);
  return error;
}

export function isSourcePrecisionCertificateError(value: unknown): value is Error {
  return value instanceof Error && Object.getPrototypeOf(value) === Error.prototype && certificates.has(value);
}

/** A deliberate topology refusal may be memoized, but never weakens precision. */
export function sourceTopologyAdmissionError(message: string): Error {
  const error = new Error(message);
  topologyAdmissions.add(error);
  return error;
}

export function isSourceTopologyAdmissionError(value: unknown): value is Error {
  return value instanceof Error && Object.getPrototypeOf(value) === Error.prototype && topologyAdmissions.has(value);
}
