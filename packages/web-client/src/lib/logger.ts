export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  NONE = 4,
}

const LOG_LEVEL = import.meta.env.PROD ? LogLevel.WARN : LogLevel.DEBUG;

export const logger = {
  debug: (context: string, ...args: unknown[]) => {
    if (LOG_LEVEL <= LogLevel.DEBUG) console.debug(`[${context}]`, ...args);
  },
  info: (context: string, ...args: unknown[]) => {
    if (LOG_LEVEL <= LogLevel.INFO) console.info(`[${context}]`, ...args);
  },
  warn: (context: string, ...args: unknown[]) => {
    if (LOG_LEVEL <= LogLevel.WARN) console.warn(`[${context}]`, ...args);
  },
  error: (context: string, ...args: unknown[]) => {
    if (LOG_LEVEL <= LogLevel.ERROR) console.error(`[${context}]`, ...args);
  },
};

// Helper to mask sensitive data
export const mask = (value: string, visibleChars = 2): string => {
  if (value.length <= visibleChars) return '****';
  return `${value.slice(0, visibleChars)}****`;
};
