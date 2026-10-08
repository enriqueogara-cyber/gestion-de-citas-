# Preparación de un piloto

Esta versión está pensada para **un único centro y un único proceso Node**. Los campos clinicId no convierten todavía la aplicación en un SaaS con varias clínicas aisladas.

## Actualizar una instalación existente

1. Detén la aplicación y guarda una copia de la base de datos fuera del repositorio.
2. Descarga la última versión de main.
3. Ejecuta `npm ci`, `npx prisma generate` y `npx prisma migrate deploy`.
4. Ejecuta `npm run build` y arranca con `npm start`.
5. Revisa Ajustes: un profesional sin servicios asignados ya no puede recibir citas. Si no hay profesionales activos, tampoco se ofrece disponibilidad.

No uses `prisma migrate reset` para actualizar: elimina datos. Las migraciones de esta versión conservan citas, pacientes y configuración existentes. Los estados históricos que la versión anterior marcó automáticamente como COMPLETED/NO_SHOW deben revisarse; no pueden deducirse retrospectivamente.

## Equipo

Configura ADMIN_EMAIL y ADMIN_PASSWORD (12–256 caracteres) en el entorno para crear el primer administrador. Una vez creado, elimina ADMIN_PASSWORD del entorno. Las contraseñas se guardan con scrypt y sal aleatoria; las sesiones guardan únicamente el hash del token y caducan a las ocho horas.

El administrador crea usuarios y los desactiva desde Recepción. El usuario de recepción gestiona agenda, asistencia y conversaciones; no modifica servicios, configuración, equipo, controles de demo ni copias. Las rutas verifican los permisos en el servidor.

En producción configura NODE_ENV=production y publica detrás de HTTPS: las cookies requieren conexión segura. El arranque falla sin un administrador activo. En desarrollo, si aún no existen usuarios, se permite una demo únicamente desde localhost/loopback; crear el primer usuario obliga a iniciar sesión. El primer usuario debe ser administrador. No hay recuperación automática de contraseñas ni MFA en esta versión.

## Trabajo de recepción

- La fecha del panel y las horas usan la zona horaria configurada en el centro.
- Crear y cambiar citas usan el mismo motor que el asistente, con validación de horario, antelación, profesional y solapamientos.
- El teléfono se introduce con prefijo internacional, solo dígitos, por ejemplo 34600111222.
- Ha llegado, Completada y No ha acudido son registros humanos. El reloj no decide la asistencia. Las citas pasadas permanecen pendientes hasta revisarlas. No ha acudido solo está disponible después del inicio.
- Un bloqueo puede afectar a un profesional o a todo el centro; no se permite crearlo sobre citas activas ni ofertas vigentes. Se puede quitar desde la agenda del día.
- Un cobro es el importe total registrado para una cita completada, no una suma incremental. Guardar el mismo importe dos veces no lo duplica. No se realiza una transacción ni se conecta una pasarela de pagos.
- Los periodos de resultados son semana, mes o todo el historial y se basan en la **fecha de la cita**, no en la fecha del cobro.

## Resultados

- Valor de reservas recuperadas: precio fotografiado al reservar, de citas procedentes de lista de espera que no estén canceladas ni marcadas como ausencia.
- Recuperadas atendidas: número de esas citas en COMPLETED.
- Valor de citas atendidas: precio de reserva de las recuperadas en COMPLETED.
- Cobros recuperados registrados: suma de paidCents de las recuperadas en COMPLETED.

Una reserva aún no atendida no se presenta como ingreso cobrado. Al cambiar una cita recuperada se mantiene su origen; la antigua cancelada deja de contabilizarse.

## Atención humana

La petición de derivación pausa inmediatamente la IA para ese paciente y aparece en Recepción, incluyendo las últimas 50 intervenciones. Los mensajes siguientes se guardan sin llamar al modelo ni responder automáticamente. Una persona se hace cargo, responde y devuelve explícitamente la conversación al asistente. Otra persona no puede apropiarse de una conversación ya asignada.

Las respuestas humanas usan el mismo número de WhatsApp cuando está conectado. La ventana de mensajes de Meta también aplica a ellas: si la entrega falla, la pantalla informa del fallo. En la demo, la respuesta se guarda como mensaje del centro.

## WhatsApp y recuperación

Configura WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN, WHATSAPP_TOKEN y WHATSAPP_PHONE_NUMBER_ID. El webhook verifica X-Hub-Signature-256 sobre el cuerpo original. Guarda el mensaje y su identificador único de Meta antes de responder 200; los reenvíos con el mismo identificador no vuelven a ejecutar al agente. La bandeja persistente se procesa al arrancar y cada 30 segundos.

La respuesta se guarda antes de enviarla. Los fallos de entrega se reintentan sin ejecutar otra vez las herramientas de reserva. Una ejecución interrumpida antes de guardar la respuesta exige revisión humana porque puede haber realizado ya cambios. Los mensajes fallidos aparecen en Recepción; Marcado revisado los archiva después de revisar el caso.

Los recordatorios recuperan trabajos PROCESSING bloqueados más de diez minutos, con un token que identifica a su propietario y un máximo de tres intentos. La reserva y sus dos recordatorios se guardan en una sola transacción. Se comprueba la marca de recordatorio enviado antes de repetir una entrega.

**Límite:** SQLite y WhatsApp no comparten una transacción. Una caída después de enviar un mensaje y antes de guardar la confirmación puede ocasionar una entrega repetida. No se garantiza exactamente una entrega. Esta versión no admite varios procesos de servidor compartiendo la base de datos; la coordinación de conversaciones es local al proceso.

La oferta de lista de espera sigue usando texto libre; antes de conectar pacientes hay que configurar una plantilla aprobada para ofertas fuera de la ventana de 24 horas. WhatsApp y Google Calendar requieren credenciales y verificación con una cuenta real; las pruebas automáticas no llaman a esos proveedores ni al LLM.

## Copias y restauración

`npm run backup` y el botón de Recepción crean una copia consistente de SQLite mediante VACUUM INTO. También se ejecuta una copia diaria a las 03:00 en la zona del centro mientras el servidor está encendido. BACKUP_DIR permite elegir la ubicación. La carpeta backups queda excluida de Git. Se conservan las últimas 30 copias generadas por esta aplicación.

Las copias contienen datos de pacientes: el directorio debe estar protegido con permisos del sistema y almacenamiento cifrado. Los permisos de archivo POSIX se ajustan cuando el sistema los admite; en Windows revisa los permisos heredados de la carpeta. No se envían copias a servicios externos.

Para restaurar: detén el servidor, conserva la base actual, copia el snapshot a la ruta de DATABASE_URL y arranca con esa copia. No sobrescribas una base abierta ni mezcles su snapshot con archivos WAL/journal antiguos. Antes de atender pacientes, comprueba pacientes, citas y acceso del equipo. La prueba de restauración abre un snapshot con un cliente Prisma independiente y comprueba citas y recordatorios.

## Comprobación del piloto

1. Configura profesionales, servicios y horario de un centro concreto.
2. Prueba crear, cambiar y cancelar desde recepción y desde el chat.
3. Prueba descanso/vacaciones, llegada, ausencia y completado.
4. Ejecuta la recuperación de hueco y registra su asistencia y cobro.
5. Prueba una derivación y una respuesta humana.
6. Prueba reinicio del servidor, copia y restauración en una instalación de ensayo.
7. Conecta y verifica Meta y Calendar con datos de prueba antes de incorporar pacientes.

La agenda de Google sigue siendo un calendario compartido: para disponibilidad externa independiente por profesional falta configurar calendarios por profesional. Recursos físicos (cabinas, gabinetes, máquinas), festivos recurrentes, facturación fiscal, integración de cobros y políticas de conservación de datos quedan fuera de esta versión.
