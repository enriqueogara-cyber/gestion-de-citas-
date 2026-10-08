/**
 * Punto de entrada de `npm run test:integration` (ver
 * scripts/runIntegrationTests.js). Corre contra prisma/test.db, una base
 * de datos SQLite real y separada de dev.db — esto es justo lo que los
 * tests unitarios (src/tests/index.test.ts) NO pueden cubrir:
 * concurrencia real, transacciones, disponibilidad cruzando profesionales
 * a través de filas reales de la base de datos.
 */
import "./booking.test";
import "./reschedule.test";
import "./concurrency.test";
import "./professionals.test";
import "./scheduler.test";
import "./waitlist.test";
import "./settings.test";
import "./serviceProfessionalRule.test";
import "./reception.test";
