/**
 * Hub status codes (OCPI 2.2.1 status_codes § 4xxx "Hub errors", plus our 49xx customs; design §5.1).
 *
 * HTTP status that carries them [VERIFY 14.3-1]: the spec does not say. Routing errors about the RECEIVER
 * (4001, 4002, 4003) travel with HTTP 200, as the OCPI layer was reached; errors about the caller itself use
 * the HTTP status that fits (403 for 4903/4901, 429 for 4905, 400 for 4902/4904).
 */
export const HUB_STATUS = {
  GENERIC: 4000,
  UNKNOWN_RECEIVER: 4001,
  TIMEOUT: 4002,
  CONNECTION: 4003,
  NO_AGREEMENT: 4901,
  NOT_BROADCASTABLE: 4902,
  FROM_MISMATCH: 4903,
  AMBIGUOUS: 4904,
  RATE_LIMITED: 4905,
} as const;

export class HubError extends Error {
  constructor(public http: number, public ocpi: number, message: string, public headers: Record<string, string> = {}) {
    super(message);
  }
}

export const unknownReceiver = (what: string) => new HubError(200, HUB_STATUS.UNKNOWN_RECEIVER, `unknown receiver: ${what}`);
export const notConnected = (what: string) => new HubError(200, HUB_STATUS.CONNECTION, what);
export const noAgreement = (a: string, b: string, extra = '') =>
  new HubError(403, HUB_STATUS.NO_AGREEMENT, `no active roaming agreement between ${a} and ${b}${extra}`);
export const fromMismatch = (msg: string) => new HubError(403, HUB_STATUS.FROM_MISMATCH, msg);
export const invalid = (msg: string) => new HubError(400, 2001, msg);
