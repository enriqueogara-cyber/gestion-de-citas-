/**
 * Mutex en memoria, por clave, para que una acción sensible no se pueda
 * ejecutar dos veces en paralelo (p.ej. doble clic en "Simular recuperar
 * hueco" antes de que el botón se deshabilite, o dos pestañas a la vez).
 * Suficiente para un proceso único como este MVP; si se pasara a varias
 * instancias, la vía natural sería un lock a nivel de base de datos
 * (p.ej. un `UPDATE ... WHERE status = 'IDLE'` sobre una fila de control).
 */
const inFlight = new Set<string>();

export class AlreadyRunningError extends Error {
  constructor(key: string) {
    super(`Ya se está ejecutando "${key}", espera a que termine antes de repetirlo.`);
  }
}

export async function singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (inFlight.has(key)) throw new AlreadyRunningError(key);
  inFlight.add(key);
  try {
    return await fn();
  } finally {
    inFlight.delete(key);
  }
}
