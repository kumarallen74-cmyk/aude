import pino from 'pino';
import { config } from './config.js';

/**
 * Log redaction.
 *
 * Logs leave the host (journald, CloudWatch, a vendor's support ticket), so the
 * credentials and personal data that pass through the gateway and the API must
 * not be written in clear. Two classes:
 *
 *   secrets      passwords, tokens, API keys, Authorization / Cookie headers:
 *                replaced entirely.
 *   identifiers  RFID idTags (on UID-only cards the tag IS the credential),
 *                OCPP 2.0.1 idTokens, roaming token uids, eMAIDs / contract ids
 *                and phone numbers: masked to their last four characters, which
 *                is still enough to match a log line to a driver's complaint.
 *
 * Paths cover the keys the code actually logs (grep `logger.` for idTag, idToken,
 * uid, emaid, phone) at the top level and one level down (`*.x`), plus request
 * headers should a request object ever be logged.
 */
const SECRET_KEYS = ['password', 'newPassword', 'secret', 'clientSecret', 'token', 'accessToken', 'refreshToken',
  'apiKey', 'authorizationKey', 'authorization', 'cookie', 'otp', 'code_verifier'];
const IDENTIFIER_KEYS = ['idTag', 'idToken', 'uid', 'emaid', 'eMAID', 'contractId', 'contract_id', 'phone'];
const SECRET_SET = new Set(SECRET_KEYS);

export const REDACT_PATHS = [
  ...[...SECRET_KEYS, ...IDENTIFIER_KEYS].flatMap((k) => [k, `*.${k}`]),
  'req.headers.authorization', 'req.headers.cookie', 'headers.authorization', 'headers.cookie',
  '*.headers.authorization', '*.headers.cookie', 'res.headers["set-cookie"]',
];

const mask = (v: unknown) => {
  const s = typeof v === 'string' || typeof v === 'number' ? String(v) : '';
  return s.length > 6 ? `***${s.slice(-4)}` : '[Redacted]';
};

/** Secrets vanish; identifiers keep their last four characters. */
export function censor(value: unknown, path: string[]): unknown {
  const key = path[path.length - 1] ?? '';
  if (SECRET_SET.has(key) || path.includes('headers')) return '[Redacted]';
  // OCPP 2.0.1 IdTokenType: { idToken, type } — keep the type, mask the token.
  if (value && typeof value === 'object' && 'idToken' in value) {
    return { ...(value as Record<string, unknown>), idToken: mask((value as { idToken: unknown }).idToken) };
  }
  return mask(value);
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: REDACT_PATHS, censor },
  transport:
    config.env === 'development'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } }
      : undefined,
});

export type Logger = typeof logger;

/**
 * Last-resort handlers.
 *
 * Node 22 terminates on an unhandled rejection. In a gateway holding thousands
 * of charger WebSockets that turns one transient database error into a fleet-
 * wide outage, and under `Restart=always, StartLimitBurst=5` systemd stops
 * restarting after the fifth. Individual call sites still handle their own
 * errors; this is the net beneath them, and it is deliberately loud so a
 * swallowed fault is still visible in the logs.
 *
 * An uncaught EXCEPTION is different: it was thrown synchronously out of an
 * event handler or timer, so whatever that code was doing stopped half way —
 * a socket's state, a pool client or a lock may be left inconsistent, and Node's
 * documentation is explicit that resuming afterwards is unsafe. It is logged,
 * the log is flushed, and the process exits 1 so systemd / Docker restart it
 * clean (chargers reconnect within their retry interval).
 */
export function installProcessGuards() {
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'UNHANDLED REJECTION — surviving, but this is a bug');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'UNCAUGHT EXCEPTION — exiting so the supervisor restarts the process');
    exitAfterFlush(1);
  });
}

let exiting = false;
function exitAfterFlush(code: number) {
  if (exiting) return;
  exiting = true;
  // A flush that never calls back (a wedged transport) must not keep a broken process alive.
  setTimeout(() => process.exit(code), 2_000).unref();
  try {
    logger.flush(() => process.exit(code));
  } catch {
    process.exit(code);
  }
}
