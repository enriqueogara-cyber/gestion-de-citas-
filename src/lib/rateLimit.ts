import type { Request, Response, NextFunction } from "express";

/**
 * Rate limiting básico en memoria (ventana deslizante simple), sin
 * dependencias nuevas — suficiente para una demo/piloto de un solo
 * proceso, no pensado para aguantar un ataque serio. Protege sobre todo
 * los endpoints que llaman al LLM y las acciones de escritura/Demo Mode
 * (ver README, "Rate limiting").
 *
 * Se puede desactivar por completo con RATE_LIMIT_DISABLED=1 (para no
 * romper QA automatizado ni los scripts de esta misma auditoría, que
 * disparan ráfagas de peticiones a propósito).
 */

interface Bucket {
  count: number;
  windowStartedAt: number;
}

const buckets = new Map<string, Bucket>();
let limiterId = 0;

function clientKey(req: Request): string {
  // Suficiente para el simulador local: no hay proxy/usuarios reales
  // detrás todavía (ver README, "Qué falta para producción").
  return req.ip || "unknown";
}

export function rateLimit(opts: { windowMs: number; max: number }) {
  const id = ++limiterId;
  const disabled = process.env.RATE_LIMIT_DISABLED === "1";
  return (req: Request, res: Response, next: NextFunction) => {
    if (disabled) return next();

    const key = `${id}:${req.baseUrl}${req.path}:${clientKey(req)}`;
    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || now - bucket.windowStartedAt > opts.windowMs) {
      buckets.set(key, { count: 1, windowStartedAt: now });
      return next();
    }

    if (bucket.count >= opts.max) {
      const retryAfterSec = Math.ceil((opts.windowMs - (now - bucket.windowStartedAt)) / 1000);
      res.setHeader("Retry-After", String(retryAfterSec));
      return res.status(429).json({ error: "Demasiadas peticiones seguidas, espera un momento e inténtalo de nuevo." });
    }

    bucket.count += 1;
    next();
  };
}

// Limpieza periódica de buckets viejos para no crecer sin límite en un
// proceso de larga duración.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStartedAt > 10 * 60 * 1000) buckets.delete(key);
  }
}, 5 * 60 * 1000).unref();
