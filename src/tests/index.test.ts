/**
 * Punto de entrada único de `npm test` (ver package.json). node:test detecta
 * los `test()` registrados al importar cada módulo; centralizar los imports
 * aquí evita depender de que el shell expanda un glob (falla en cmd.exe de
 * Windows) y mantiene el comando de test igual en cualquier plataforma.
 *
 * Deliberadamente solo cubre lógica de dominio pura (sin tocar la base de
 * datos): horarios/disponibilidad, máquina de estados de citas, y
 * compatibilidad de lista de espera — es la lógica que, si falla, le
 * cuesta dinero de verdad a una clínica (reservas fuera de horario, una
 * cita cancelada que "revive", un hueco ofrecido a quien no toca...).
 *
 * Lo que NO cubre todavía (ver README, "Riesgos pendientes"): la
 * protección transaccional contra dobles reservas de
 * src/domain/bookingEngine.ts, que necesita una base de datos real
 * concurrente para probarse de verdad.
 */
import "./slots.test";
import "./appointmentStateMachine.test";
import "./waitlistMatching.test";
import "./dates.test";
import "./labels.test";
import "./singleFlight.test";
import "./demoScenarios.test";
import "./slotPresentation.test";
import "./rateLimit.test";
