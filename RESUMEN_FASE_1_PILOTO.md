# Fase 1 del piloto: consistencia de citas y lista de espera

**Fecha:** 19 de octubre de 2026. Este documento actualiza los riesgos de consistencia descritos en `ESTADO_ACTUAL_PROYECTO.md`. Los ensayos se hicieron con `prisma/test.db` y pacientes ficticios `demo-test-*`; no se enviaron mensajes externos ni se tocaron credenciales. Se mantiene Node.js, Express, Prisma, SQLite y los proveedores existentes.

## Resultado implementado

- **Cancelación y cambio de cita:** después de confirmar `CANCELLED`, un fallo al limpiar recordatorios o iniciar la oferta se registra sin convertir la cancelación en un supuesto fracaso. Si `rescheduleAppointment` recibe una excepción, lee de nuevo el estado de la cita antigua. Si aún está activa, la comprobación de ese estado y la compensación de la nueva se hacen en una misma transacción SQLite. Si otra cancelación ganó antes, la cita nueva se conserva y el caso se registra como `RESCHEDULE_INCONSISTENT` para revisión humana. Tras compensar, se comprueban de nuevo ambos estados antes de informar al paciente.
- **Oferta atómica:** el cambio a `OFFERED`, el `SlotHold` y el trabajo persistente de caducidad se crean dentro de una única transacción. Una escritura fallida revierte los tres elementos. La oferta comprueba ocupación y holds activos del profesional, y usa compare-and-swap sobre la entrada `WAITING` para evitar duplicados en reintentos concurrentes.
- **Profesional correcto:** `offeredProfessionalId` guarda el profesional del hueco liberado, separado del profesional que el paciente indicó como preferencia. La aceptación y el encadenado conservan ese profesional. Se añade una migración SQLite aditiva; para bases existentes hay que ejecutar `npx prisma migrate deploy` antes de arrancar la versión nueva. Las ofertas históricas mantienen el campo nulo y usan la preferencia anterior como alternativa.
- **Avisos y caducidad:** un fallo de notificación deja la oferta con un vencimiento persistido, sin reenviar inmediatamente un mensaje de entrega incierta. Al caducar, el estado y el hold se resuelven juntos; un fallo del aviso no detiene el paso al siguiente candidato. El hold se identifica también por su vencimiento para que reintentar una caducidad antigua no borre una oferta posterior del mismo paciente y hueco. Si falla el encadenado, el job puede retomarlo desde `EXPIRED` sin crear otra oferta para un hueco ya retenido o reservado. La limpieza periódica recupera ofertas vencidas cuyos jobs fallaron y marca como completados los trabajos reparados.
- **Aceptación interrumpida:** la reserva valida dentro de su transacción que la oferta sigue en `ACCEPTING` y corresponde al paciente, hora y profesional. Si la cita se guardó pero falló marcar `BOOKED`, el reintento recupera la misma cita. Una aceptación abandonada más de diez minutos se reconcilia con la cita existente o libera el hueco y reactiva su job de caducidad. Una oferta vencida no puede aceptarse antes de que pase el scheduler.
- **Baja de lista de espera:** cancelar una oferta usa una actualización condicionada al estado para no competir silenciosamente con su aceptación; libera su hold y ofrece el hueco al siguiente candidato. El job original queda como respaldo si el encadenado inmediato se interrumpe.

## Fallos reproducidos antes de corregir

Las pruebas nuevas fallaron sobre la versión anterior en cuatro escenarios: (1) un error al limpiar jobs después de cancelar la cita antigua hacía que `rescheduleAppointment` cancelara también la nueva y afirmara que la antigua seguía activa; (2) un error al crear el hold dejaba una entrada `OFFERED` sin hold ni job; (3) reintentar la oferta del mismo hueco creaba otra oferta; (4) un error al notificar la caducidad impedía pasar el hueco al siguiente candidato incluso al reintentar. Después se añadieron regresiones para fallo del aviso inicial, fallo al encadenar tras `EXPIRED`, fallo al marcar `BOOKED`, cancelación de oferta, profesional del hueco, aceptación caducada, trabajo fallido y recuperación de `ACCEPTING`.

## Verificación

| Comprobación | Resultado |
|---|---|
| `npm run typecheck` | Correcto |
| `npm run build` | Correcto |
| `npm test` | 53/53 unitarias correctas |
| `npm run test:integration` | 67/67 integraciones correctas; ocho migraciones aplicadas en `prisma/test.db` |

**Total: 120 pruebas correctas.** Las pruebas HTTP usaron exclusivamente `127.0.0.1`; las notificaciones de pruebas se guardaron en la conversación de pacientes ficticios. Los mensajes de error que aparecen en algunos logs son fallos inducidos por las pruebas de recuperación.

## Límites todavía pendientes

1. **Entrega WhatsApp real no verificada.** Una respuesta ambigua de Meta puede haber enviado un aviso aunque la aplicación reciba error. No se promete entrega exactamente una vez. Las ofertas siguen usando texto libre y pueden necesitar una plantilla aprobada fuera de la ventana de conversación.
2. **Efectos externos no transaccionales.** SQLite no comparte una transacción con Meta ni Google Calendar. Es posible que un evento de calendario quede desincronizado y requiera reconciliación.
3. **Oportunidad de lista de espera perdida si falla su creación.** Tras cancelar una cita, si la transacción de creación de la oferta falla, la cancelación queda válida y el hueco queda libre, pero no existe todavía un trabajo persistente que reintente iniciar esa primera oferta. Se registra en logs.
4. **Enlaces de paciente tras un cambio.** El traslado de `portalAccess` ocurre después de los cambios de citas; un fallo aislado ahí puede dejar temporalmente el enlace apuntando a la cita antigua. Se debe integrar en una recuperación posterior.
5. **Despliegue y escala no ensayados.** No se ha probado con Meta, Google real, varios procesos ni carga comercial. La compensación se apoya en las transacciones de SQLite y debe volver a evaluarse si se cambia de base de datos. La recuperación de ofertas `ACCEPTING` usa una espera de diez minutos y barridos de hasta 100 registros por ciclo; conviene vigilar estos límites durante el piloto.

## Archivos de implementación

`src/services/appointments.ts`, `src/services/waitlist.ts`, `src/services/waitlistOrchestrator.ts`, `src/domain/bookingEngine.ts`, `src/scheduler/persistentJobs.ts`, `prisma/schema.prisma`, `prisma/migrations/20261019120000_waitlist_offer_professional/migration.sql`. Las regresiones están en `src/tests/integration/reschedule.test.ts` y `src/tests/integration/waitlist.test.ts`.
