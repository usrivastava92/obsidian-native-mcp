type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

type LogValue = boolean | number | string | null | undefined;

export function createLogger(component: string) {
  return {
    debug: (message: string, fields?: Record<string, LogValue>) =>
      writeLog("DEBUG", component, message, fields),
    info: (message: string, fields?: Record<string, LogValue>) =>
      writeLog("INFO", component, message, fields),
    warn: (message: string, fields?: Record<string, LogValue>) =>
      writeLog("WARN", component, message, fields),
    error: (message: string, fields?: Record<string, LogValue>) =>
      writeLog("ERROR", component, message, fields),
  };
}

export function formatError(err: unknown): string {
  if (err instanceof Error) return err.stack || err.message;
  return String(err);
}

function writeLog(
  level: LogLevel,
  component: string,
  message: string,
  fields: Record<string, LogValue> = {},
): void {
  const serializedFields = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(" ");
  const line = [
    new Date().toISOString(),
    level,
    `component=${component}`,
    message,
    serializedFields,
  ]
    .filter(Boolean)
    .join(" ");
  process.stderr.write(`${line}\n`);
}
