import winston, { format, Logger, transports } from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';
import * as crypto from 'crypto';
import path from 'path';
import * as Sentry from '@sentry/nextjs';
import { correlationId, CORRELATION_ID_HEADER } from './correlation';
import { spikeDetector, SpikeAlertPayload } from './spike-alert';

// ---------------------------------------------------------------------------
// Transports
// ---------------------------------------------------------------------------

const LOG_DIR = process.env.LOG_DIR || '/home/scott/.pm2/logs';

// Production: JSON console (structured, parseable by log aggregation)
const consoleTransport = new winston.transports.Console({
  format: format.combine(
    format.timestamp(),
    format.errors(),
    format.json(),
  ),
});

// Daily rotated file — keeps 14 days, compresses old files
const fileTransport = new DailyRotateFile({
  filename: path.join(LOG_DIR, 'h2h-app-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '50m',
  maxFiles: '14d',
  zippedArchive: true,
  format: format.combine(
    format.timestamp(),
    format.errors(),
    format.json(),
  ),
});

// Error-only daily rotation
const errorFileTransport = new DailyRotateFile({
  filename: path.join(LOG_DIR, 'h2h-app-error-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '30d',
  zippedArchive: true,
  level: 'error',
  format: format.combine(
    format.timestamp(),
    format.errors(),
    format.json(),
  ),
});

// Sentry transport — only in production, only errors and above
const sentryTransport = process.env.SENTRY_DSN
  ? new winston.transports.Http({
      level: 'error',
      host: 'sentry.io',
      path: `/api/0/${extractSentryProject(process.env.SENTRY_DSN)}/store/?sentry_key=${extractSentryKey(process.env.SENTRY_DSN)}`,
      ssl: true,
      format: format.combine(
        format.timestamp(),
        format((info) => {
          info.tags = { environment: process.env.NODE_ENV || 'development' };
          // Pass fingerprint to Sentry for deduplication grouping
          if (info.fingerprint) {
            info.fingerprint = [`hash:${info.fingerprint}`];
          }
          return info;
        })(),
        format.json(),
      ),
    })
  : null;

// ---------------------------------------------------------------------------
// Error fingerprinting
// ---------------------------------------------------------------------------

/**
 * Stack frame extracted from an Error.stack string.
 */
interface StackFrame {
  func: string;
  file: string;
  line: number;
}

/**
 * Parse stack frames from an Error.stack string.
 */
function parseStackFrames(stack?: string): StackFrame[] {
  if (!stack) return [];
  const frames: StackFrame[] = [];
  for (const line of stack.split('\n').slice(1)) {
    // Typical: '    at functionName (file:line:col)' or 'at file:line:col'
    const m = line.match(/\s+at\s+(.+?):(\d+):\d+/);
    if (m) {
      const funcOrFile = m[1];
      const lineNum = parseInt(m[2], 10);
      // If it contains '(', split into func and file
      const parenIdx = funcOrFile.lastIndexOf('(');
      if (parenIdx > 0) {
        const func = funcOrFile.slice(0, parenIdx).trim();
        const file = funcOrFile.slice(parenIdx + 1).replace(')', '').trim();
        frames.push({ func, file, line: lineNum });
      } else {
        frames.push({ func: '?', file: funcOrFile, line: lineNum });
      }
    }
  }
  return frames;
}

/**
 * Generate a deterministic fingerprint for an error so identical errors
 * cluster together in Sentry and log aggregation.
 *
 * Fingerprint strategy:
 *   1. Error type (constructor name)
 *   2. Normalized first line of message (numbers, UUIDs, timestamps → wildcards)
 *   3. Top stack frame function name (when available) — improves granularity
 */
export function errorFingerprint(error: unknown): string {
  if (error instanceof Error) {
    const type = error.constructor.name;
    const msg = error.message.trim().split('\n')[0];
    const normalized = msg
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<UUID>')
      .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/g, '<TIMESTAMP>')
      .replace(/\d+/g, '<N>');

    // Include the originating function from the stack for better granularity
    const frames = parseStackFrames(error.stack);
    const originFunc = frames.length > 0 ? frames[0].func : '';

    if (originFunc) {
      return `${type}:${normalized}@${originFunc}`;
    }
    return `${type}:${normalized}`;
  }
  return `Unknown:${String(error)}`;
}

/**
 * Hash the fingerprint to a short hex string for log indexing.
 */
export function fingerprintHash(fingerprint: string): string {
  return crypto.createHash('sha256').update(fingerprint).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// Child logger factory — binds static context (service, component, etc.)
// ---------------------------------------------------------------------------

export interface ChildLoggerContext {
  service?: string;
  component?: string;
  [key: string]: unknown;
}

export function createChildLogger(context: ChildLoggerContext): Logger {
  const childTransports: winston.transport[] = [];

  for (const t of rootLogger.transports) {
    childTransports.push(new winston.transports.Stream({
      stream: {
        write(chunk: string): boolean {
          try {
            const parsed = JSON.parse(chunk);
            parsed.service = context.service || 'h2h-arbitrage';
            if (context.component) parsed.component = context.component;
            for (const [k, v] of Object.entries(context)) {
              if (k !== 'service' && k !== 'component') {
                parsed[k] = v;
              }
            }
            t.write(JSON.stringify(parsed));
          } catch {
            t.write(chunk);
          }
          return true;
        },
      } as any,
    }));
  }

  return winston.createLogger({
    level: rootLogger.level,
    levels: winston.config.npm.levels,
    transports: childTransports,
    format: rootLogger.format,
    exitOnError: false,
  });
}

// ---------------------------------------------------------------------------
// Root logger
// ---------------------------------------------------------------------------

const transportsList: winston.transport[] = [consoleTransport, fileTransport, errorFileTransport];
if (sentryTransport) {
  transportsList.push(sentryTransport);
}

const rootLogger: Logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  levels: winston.config.npm.levels,
  transports: transportsList,
  format: format.combine(
    format((info) => {
      if (correlationId.current) {
        info.correlationId = correlationId.current;
      }
      if (info.level === 'error' && info.error) {
        info.fingerprint = errorFingerprint(info.error);
        info.fingerprintHash = fingerprintHash(String(info.fingerprint));
      }
      return info;
    })(),
    format.timestamp(),
    format.errors(),
    format.json(),
  ),
  exitOnError: false,
});

// Development convenience: colorized console
if (process.env.NODE_ENV !== 'production') {
  rootLogger.add(new winston.transports.Console({
    format: format.combine(
      format.colorize(),
      format.simple(),
    ),
  }));
}

// Initialize Sentry if DSN is configured
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || '0.1'),
    integrations: [
      // @ts-expect-error — Sentry SDK version differences; Integrations.Winston may not exist in all versions
      new Sentry.Integrations.Winston({
        // @ts-expect-error — Severity enum removed in newer Sentry SDKs
        levels: { error: Sentry.Severity.Error, warn: Sentry.Severity.Warning },
      }),
    ],
  });
}

// Wire up spike alert → logger feedback loop
// spikeDetector fires onAlert; we log it. No circular dependency at init time.
spikeDetector.onAlert = (payload: SpikeAlertPayload) => {
  const topLines = payload.topErrors.join('\n');
  rootLogger.warn(
    `SPIKE ALERT: ${payload.count} errors in the last minute (threshold: ${payload.threshold})\nTop errors:\n${topLines}`,
    { count: payload.count, threshold: payload.threshold, breakdown: payload.breakdown },
  );
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const logger: Logger & {
  child: (ctx: ChildLoggerContext) => Logger;
  trackError: (error: unknown, context?: Record<string, unknown>) => void;
} = ({
  ...rootLogger,
  level: rootLogger.level,
  levels: rootLogger.levels,
  transports: rootLogger.transports,
  format: rootLogger.format,

  log: rootLogger.log.bind(rootLogger),
  info: rootLogger.info.bind(rootLogger),
  warn: rootLogger.warn.bind(rootLogger),
  error: rootLogger.error.bind(rootLogger),
  debug: rootLogger.debug.bind(rootLogger),
  verbose: rootLogger.verbose.bind(rootLogger),
  silly: rootLogger.silly.bind(rootLogger),
  add: rootLogger.add.bind(rootLogger) as any,
  remove: rootLogger.remove.bind(rootLogger) as any,
  clear: rootLogger.clear.bind(rootLogger) as any,
  child: (ctx: ChildLoggerContext) => createChildLogger(ctx) as any,

  /**
   * Log an error and automatically feed it to the spike detector.
   * Call this instead of logger.error() when you want spike tracking.
   */
  trackError(error: unknown, context?: Record<string, unknown>): void {
    const fp = errorFingerprint(error);
    const msg = error instanceof Error ? error.message : String(error);

    const alerted = spikeDetector.record({ fingerprint: fp, message: msg });

    rootLogger.error(msg, {
      error,
      fingerprint: fp,
      fingerprintHash: fingerprintHash(fp),
      spikeAlert: alerted,
      ...context,
    });
  },
} as any);

export default logger;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractSentryProject(dsn: string): string {
  const match = dsn.match(/\/(\d+)$/);
  return match ? match[1] : '0';
}

function extractSentryKey(dsn: string): string {
  const match = dsn.match(/^https?:\/\/([^@]+)@/);
  return match ? match[1] : '';
}
