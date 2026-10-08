/**
 * Logger estructurado mínimo, sin dependencias nuevas. Sustituye a los
 * `console.log`/`console.error` sueltos: cada línea es JSON con nivel,
 * timestamp y evento, para poder reconstruir qué pasó sin adivinar el
 * formato de cada mensaje suelto.
 *
 * Deliberadamente simple: para un MVP de un solo proceso, escribir a
 * stdout/stderr en JSON ya es suficiente (cualquier proveedor de hosting
 * moderno lo captura e indexa). No hace falta Winston/Pino todavía.
 */

type Level = "info" | "warn" | "error";

function write(level: Level, event: string, meta?: Record<string, unknown>) {
  const line = {
    ts: new Date().toISOString(),
    level,
    event,
    ...(meta && Object.keys(meta).length ? { meta } : {}),
  };
  const serialized = JSON.stringify(line, (_key, value) =>
    value instanceof Error ? { message: value.message, stack: value.stack } : value
  );
  if (level === "error") console.error(serialized);
  else if (level === "warn") console.warn(serialized);
  else console.log(serialized);
}

export const logger = {
  info: (event: string, meta?: Record<string, unknown>) => write("info", event, meta),
  warn: (event: string, meta?: Record<string, unknown>) => write("warn", event, meta),
  error: (event: string, meta?: Record<string, unknown>) => write("error", event, meta),
};
