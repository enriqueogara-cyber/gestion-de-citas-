# Fase 2 del piloto: identidad y seguridad del paciente

**Fecha:** 19 de octubre de 2026. Esta fase conserva Node.js, TypeScript, Express, Prisma y SQLite. No se usaron datos personales reales, no se enviaron códigos ni mensajes externos y no se modificaron credenciales. El sistema **no está preparado para abrirse a pacientes reales**.

## Controles técnicos implementados

| Área | Estado y comportamiento |
|---|---|
| Verificación del teléfono | Una solicitud web usa un token aleatorio de 256 bits y un código de seis cifras ligado a ese token y al teléfono normalizado. Caduca a los 10 minutos, permite cinco intentos y se consume de forma transaccional al iniciar la reserva o la inscripción en espera. El código solo se guarda mediante `scrypt` con sal aleatoria; el código y el token en claro no se almacenan en SQLite. |
| Protección contra abuso | Límite de tres solicitudes por teléfono y hora, separación mínima de un minuto entre solicitudes, límite por IP en las rutas HTTP y respuesta idempotente si se repite la misma petición activa. La verificación fallida y la caducidad no habilitan la creación. Los controles de IP son locales al proceso; el límite por teléfono está en SQLite. |
| Proveedor | `PhoneCodeProvider` permite inyectar una entrega simulada en memoria en las pruebas. No hay adaptador SMS/WhatsApp configurado por defecto y no se devuelve el código en la respuesta HTTP. Sin proveedor, una reserva web nueva se detiene antes de crear la cita. |
| Enlaces privados | El token se envía en el fragmento de URL, se guarda únicamente su SHA-256, caduca a los 90 días y admite revocación. `PortalAccess` queda vinculado al `patientId`, teléfono y una única cita. Los enlaces web anteriores sin prueba de posesión se bloquean; la migración conserva los emitidos por recepción, vinculándolos al paciente de esa cita. El portal añade `Referrer-Policy: no-referrer`; la aplicación ya tenía `Cache-Control: no-store` y protección contra marcos. |
| Cambios de cita | Antes de cancelar la cita original se persiste el identificador de la sustituta. Si falla la actualización posterior de `PortalAccess`, la lectura del enlace sigue esa relación y repara la referencia; un nuevo fallo de escritura no impide ver la cita correcta. Si falla guardar la relación, se compensa la nueva cita. |
| Herramientas de IA | Las herramientas que reservan, cambian, confirman, cancelan, aceptan ofertas o solicitan derivación exigen un origen interno reconocido y que el teléfono coincida con el paciente persistido. La consulta previa de citas y lista de espera se bloquea sin ese control. WhatsApp solo marca el origen tras aceptar un webhook firmado; el simulador únicamente usa números `demo-*`. Los servicios vuelven a comprobar titularidad por `patientId`. |
| Información al modelo | El historial remitido al proveedor se reduce de 20 a 8 mensajes y se filtran teléfonos, correos, documentos y frases de identificación. El estado de citas enviado al modelo omite servicio y profesional. Las consultas que coinciden con patrones clínicos se derivan a recepción antes de llamar al modelo y se omiten del historial posterior. Los mensajes originales permanecen localmente para la atención humana. |

## Escenarios verificados

Las regresiones cubren suplantación mediante teléfono conocido sin código, código equivocado, cinco intentos agotados, caducidad, entrega fallida, reintentos y duplicados, límites por teléfono, uso de otro token, consulta o gestión sin autorización, enlace restringido a una cita, derivación clínica sin llamada al modelo, caída de `portalAccess` al mover una cita y fallo al guardar el vínculo de sustitución. Se usaron números ficticios y una base SQLite separada. La prueba HTTP utiliza exclusivamente `127.0.0.1`.

| Comprobación | Resultado |
|---|---|
| `npm run prisma:generate` | Correcto |
| `npm run typecheck` | Correcto |
| `npm run build` | Correcto |
| `npm test` | 55/55 pruebas unitarias correctas |
| `npm run test:integration` | 77/77 pruebas de integración correctas; nueve migraciones aplicadas en la base de pruebas |

Los errores de escritura visibles en algunos logs de la suite son fallos simulados para probar la recuperación. No se comprobaron SMS, WhatsApp, OpenRouter ni Google Calendar reales.

## Archivos modificados

**Persistencia:** `prisma/schema.prisma`, `prisma/migrations/20261019130000_patient_identity/migration.sql`.

**Portal:** `src/patient/phoneVerification.ts`, `src/patient/service.ts`, `src/patient/router.ts`, `src/patient/client.ts`, `src/services/appointments.ts`, `src/simulator/dailyRouter.ts`.

**Agente y canales:** `src/agent/privacy.ts`, `src/agent/claude.ts`, `src/agent/tools.ts`, `src/whatsapp/inbox.ts`, `src/simulator/router.ts`.

**Pruebas y documentación:** `src/tests/privacy.test.ts`, `src/tests/index.test.ts`, `src/tests/integration/patientPortal.test.ts`, `src/tests/integration/setup.ts`, `README.md`, este resumen.

## Riesgos y requisitos pendientes

**Técnicos:** falta seleccionar, integrar y ensayar un proveedor real de códigos, incluyendo entrega, latencia, fallos ambiguos, monitorización y recuperación; hasta entonces la reserva web nueva no funciona fuera de las pruebas. El control por IP y los bloqueos en memoria asumen un único proceso; varios procesos requerirían coordinación. La detección de información clínica mediante patrones no garantiza eliminar cualquier dato sensible escrito libremente; el catálogo de servicios, fechas e identificadores se siguen enviando al modelo cuando son necesarios para operar. Un teléfono compartido, perdido o reasignado puede superar la verificación de posesión sin demostrar identidad civil; se necesita un criterio de vinculación más fuerte antes de mostrar historial sensible. Los enlaces siguen siendo capacidades transferibles: quien consiga el enlace puede gestionar esa cita hasta que caduque o se revoque. También siguen pendientes los riesgos de sincronización externa con Meta y Google identificados en la fase 1.

**Privacidad y aspectos legales por revisar con especialistas:** información y bases del tratamiento aplicables al centro, tratamiento de datos de salud, conservación y borrado de conversaciones/códigos, control de acceso del personal, contratos y transferencias con proveedores, ejercicio de derechos y evaluación formal del flujo de WhatsApp y del modelo. Estos puntos no quedan satisfechos por las pruebas técnicas ni por este documento.

## Pasos para conectar un proveedor real

1. Elegir el canal y proveedor, revisar sus condiciones de privacidad y operación y definir la identidad del remitente. Mantener el adaptador separado de `PhoneCodeProvider` y configurar sus credenciales fuera del repositorio.
2. Implementar `sendCode(phone, code)` con manejo explícito de entrega confirmada, fallo y timeout ambiguo. No registrar códigos, tokens ni respuestas completas del proveedor. No exponer jamás el código mediante el mismo navegador que lo solicitó.
3. Probar en un entorno de ensayo con teléfonos autorizados: recepción, caducidad, reenvíos, límites, cambio de número, números compartidos, caída del proveedor y revisión de eventos. Verificar la compatibilidad de plantillas y costes si se elige WhatsApp.
4. Aplicar `prisma migrate deploy` y regenerar el cliente Prisma antes de arrancar la nueva versión. Completar revisión de privacidad, monitorización y controles de acceso. Mantener `PUBLIC_BOOKING_ENABLED=false` hasta aprobar y verificar el piloto de extremo a extremo.
