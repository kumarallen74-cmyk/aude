import pino from 'pino';
import { config } from './config.js';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
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
 */
export function installProcessGuards() {
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'UNHANDLED REJECTION — surviving, but this is a bug');
  });
  process.on('uncaughtException', (err) => {
    logger.error({ err }, 'UNCAUGHT EXCEPTION — surviving, but this is a bug');
  });
}
