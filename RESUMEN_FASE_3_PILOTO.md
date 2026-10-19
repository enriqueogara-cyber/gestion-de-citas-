# Fase 3 del piloto: WhatsApp Business Cloud API

Fecha: 19 de octubre de 2026. Estado: **implementación local probada con Meta simulado; integración externa pendiente**. No se han enviado mensajes reales, usado datos de pacientes reales, activado el portal público ni modificado credenciales.

## Resultado implementado

Se reutilizaron el webhook Express, el buzón persistente, OpenRouter, el motor de reservas y los trabajos programados existentes. El transporte pasa de Graph API `v20.0` a `v26.0` por defecto, configurable mediante `WHATSAPP_GRAPH_VERSION`. La [colección oficial de Meta](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api) documenta `/{version}/{phone-number-id}/messages` y el ID de mensaje devuelto; [Meta anunció Graph API v26.0](https://developers.facebook.com/blog/post/2026/07/29/introducing-graph-api-v26-and-marketing-api-v26). Esto verifica la elección documental de versión, **no** que la cuenta y el número propios funcionen aún con Meta.

La salida tiene ahora un registro `WhatsAppOutbound` con clave de idempotencia, resumen criptográfico del contenido, ID del proveedor y estados distintos: `SENDING`, `UNKNOWN`, `REJECTED`, `ACCEPTED`, `SENT`, `DELIVERED`, `READ`, `FAILED`. `ACCEPTED` significa exclusivamente respuesta HTTP con ID; la entrega se registra únicamente al recibir un webhook firmado. Los eventos de estado se guardan en `WhatsAppStatusEvent`, se deduplican por ID/estado/momento y se reconcilian aunque lleguen antes de guardar la aceptación o fuera de orden. Las respuestas sin ID, timeout, 429, HTTP 5xx y cortes de red quedan `UNKNOWN`; HTTP 4xx definitivo queda `REJECTED`. Un proceso interrumpido recupera `SENDING` antiguo como `UNKNOWN`. Ninguno se reenvía automáticamente con la misma clave: un reintento ambiguo podría duplicar el mensaje en Meta. Esto no promete entrega exactamente una vez.

El webhook conserva la verificación HMAC SHA-256 sobre el cuerpo original. Solo procesa eventos del *Phone Number ID* configurado; las entradas se ignoran mientras el piloto esté desactivado o si el teléfono no está en la lista de prueba. Los estados de envíos anteriores sí se conservan. La deduplicación de entradas usa el ID de Meta y persiste también la marca temporal del mensaje, que permite calcular conservadoramente la ventana de atención. El texto libre solo sale durante los 23 h 55 min posteriores a un mensaje entrante firmado; fuera de ella se exige plantilla. Según la [documentación oficial de estados de Meta](https://www.postman.com/meta/whatsapp-business-platform/folder/fuaee8l/statuses-object), la ventana de servicio de 24 horas se reinicia con un mensaje del cliente. Las respuestas de recepción también pasan por esta comprobación.

Se prepararon nombres e idioma configurables de cinco plantillas: recordatorios de 24 h y 2 h, confirmación, oferta de lista de espera y caducidad de oferta. Los dos recordatorios y ambos avisos de lista de espera usan ahora plantillas en teléfonos de prueba, incluso cuando la ventana estuviese abierta; así no hay un segundo formato de envío tras un fallo ambiguo. Los parámetros externos son fecha/hora y plazo, sin tipo de servicio ni detalles médicos. La plantilla de confirmación está preparada, pero **no se envía automáticamente**: la confirmación conversacional existente continúa. El simulador conserva mensajes legibles. Las marcas `reminder24hSentAt`/`reminder2hSentAt` del esquema anterior se escriben tras aceptación HTTP en WhatsApp real o tras registrar el mensaje local de demo; su nombre histórico **no acredita entrega**. Para WhatsApp real, los nuevos eventos de auditoría se llaman `REMINDER_ACCEPTED`.

Para evitar activación accidental, el transporte real exige simultáneamente `WHATSAPP_SEND_ENABLED=true` y el número exacto en `WHATSAPP_ALLOWED_TEST_NUMBERS`; por defecto los envíos están desactivados. El portal público sigue desactivado. El panel de asuntos pendientes incluye resultados `UNKNOWN`, `REJECTED`, `FAILED` y aceptaciones sin estado tras una hora; no publica el número en ese resumen. Si un aviso de lista de espera falla o queda ambiguo, su oferta y retención temporal permanecen hasta el trabajo de caducidad existente; la recuperación libera el hueco y puede ofrecerlo al siguiente candidato sin bloquearlo indefinidamente.

## Pruebas realizadas

| Comprobación | Resultado |
| --- | --- |
| `npm run prisma:generate` | Correcto |
| `npm run typecheck` | Correcto |
| `npm run build` | Correcto |
| `npm test` | 55/55 correctas |
| `npm run test:integration` | 87/87 correctas; migración aplicada a `prisma/test.db` aislada |

Las 10 pruebas nuevas de WhatsApp utilizan respuestas simuladas: aceptación frente a entrega, estados firmado/duplicado/desordenado/fallido, evento previo a la aceptación, deduplicación de entrada, timeout, HTTP 4xx y 5xx, respuesta sin ID, recuperación de envío interrumpido, ventana de atención, bloqueo de tráfico real y plantillas de oferta/caducidad. Las pruebas existentes de reservas, lista de espera, seguridad y portal siguen pasando. La primera ejecución sin permiso de bucle local produjo `EACCES` en tres pruebas HTTP; al ejecutarlas con acceso a `127.0.0.1` pasó la suite. Una aserción nueva se adelantaba al procesamiento asíncrono del buzón y se corrigió la espera; la repetición completa pasó.

## Archivos modificados o añadidos

- Configuración y base de datos: `.env.example`, `prisma/schema.prisma`, `prisma/migrations/20261019140000_whatsapp_delivery/migration.sql`.
- Transporte, plantillas, registros y webhook: `src/whatsapp/transport.ts`, `src/whatsapp/outbound.ts`, `src/whatsapp/templates.ts`, `src/whatsapp/client.ts`, `src/whatsapp/webhook.ts`, `src/whatsapp/inbox.ts`.
- Avisos, trabajos y panel: `src/notifications/notify.ts`, `src/scheduler/reminders.ts`, `src/services/waitlistOrchestrator.ts`, `src/services/auditLog.ts`, `src/lib/labels.ts`.
- Pruebas: `src/tests/integration/whatsapp.test.ts`, `src/tests/integration/index.test.ts`, `src/tests/integration/setup.ts`.
- Documentación: `CONFIGURACION_WHATSAPP.md`, `RESUMEN_FASE_3_PILOTO.md`.

## Límites y riesgos pendientes

No se ha probado la conexión, el token, la aprobación de plantillas, la suscripción del webhook HTTPS, el número de prueba ni las conversaciones con Meta reales. El envío permanece desactivado. Meta puede cambiar políticas, rechazar plantillas o devolver errores distintos a los simulados; debe validarse con el teléfono autorizado antes de un piloto con usuarios. Un `UNKNOWN` necesita revisión humana: se prioriza evitar duplicados sobre asegurar un aviso automático. Un `ACCEPTED` sin webhook no acredita entrega. La confirmación con plantilla queda disponible solo como configuración y no forma parte del flujo automático. El simulador puede seguir mostrando avisos legibles que no equivalen a una entrega de WhatsApp.

Las tablas de mensajes y eventos requieren una política de retención, control de acceso, copia y borrado acorde al tratamiento de datos antes de usar información real. Deben revisarse privacidad, información al paciente, base legal y contratos con proveedores. El flujo de un único proceso y SQLite conserva las limitaciones de operación y observabilidad ya identificadas en fases anteriores; no se ha cambiado la arquitectura.

## Siguiente paso manual

Sigue [CONFIGURACION_WHATSAPP.md](CONFIGURACION_WHATSAPP.md): crear la aplicación y número de prueba en Meta, agregar tu teléfono autorizado, aprobar las cinco plantillas, publicar `https://TU_DOMINIO/webhook`, suscribir `messages` y configurar los valores privados. **Detenerse antes de poner `WHATSAPP_SEND_ENABLED=true`** hasta comprobar todo lo anterior. Después, realizar el checklist completo con datos ficticios y contrastar `ACCEPTED` con los estados firmados `SENT`/`DELIVERED`/`READ`/`FAILED`. Solo esa prueba externa permitirá declarar verificada la integración real.
