/**
 * The API error type. Lives in its own module so the transport layer
 * (pinnedHttp.ts) and the API layer (api.ts) can both construct errors
 * without a circular import.
 */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Status code for a certificate that does not match its pin. Deliberately
 * NOT `0`: a pin mismatch is not offline-ness — the server answered the
 * phone by trojan rule — so it must never be swallowed by the offline
 * queue (ADR 0019). 511 (Network Authentication Required) is the closest
 * honest meaning; the message tells the user to re-pair.
 */
export const PIN_MISMATCH_STATUS = 511;
