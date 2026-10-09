# Recepción de citas por WhatsApp

Asistente para un centro con agenda: reserva, cambia, confirma y cancela citas; ofrece huecos liberados a una lista de espera y permite al equipo intervenir desde un panel de recepción.

La IA interpreta la conversación. El backend valida servicios, profesionales, horarios, bloqueos y solapamientos antes de modificar una reserva.

## Arranque local

Requiere Node.js 22 o posterior.

```sh
npm ci
```

Copia `.env.example` a `.env` y configura `DATABASE_URL`:

```sh
npx prisma generate
npx prisma migrate deploy
npm run prisma:seed
npm run dev
```

Abre http://localhost:3000/simulator/ para entrar en Overview. Con `OPENROUTER_API_KEY` configurada, el chat usa el modelo real. Sin credenciales de Google, la disponibilidad se calcula con los datos locales. WhatsApp requiere configuración de Meta.

En Windows, si una instalación nueva de Prisma no crea el fichero SQLite, crea primero un archivo vacío en la ruta de DATABASE_URL, por ejemplo `New-Item -ItemType File prisma/dev.db`, y repite `prisma migrate deploy`. No sobrescribas una base existente.

## Pantallas

- **Recepción**: agenda diaria por profesional; crear, cambiar o cancelar citas; registrar llegada, completado y ausencia; registrar cobros; bloquear vacaciones y descansos; atender conversaciones derivadas; ver mensajes fallidos. Los administradores también gestionan usuarios y copias.
- **Overview**: entrada principal con citas del mes, resultados de recuperación, actividad e incidencias. La demo reproduce una cancelación y una recuperación de hueco.
- **Chat** (`/simulator/chat`): simulador del canal de pacientes. Cabecera, bienvenida, accesos e historial se desplazan juntos, con escritura fija y botón para volver al final. El reinicio de conversación limpia mensajes, conservando sus reservas y trabajos.
- **Lista de espera**: entradas y ofertas activas.
- **Ajustes**: identidad del centro, catálogo, profesionales y horario semanal.

## Reglas del producto

Cada servicio requiere al menos un profesional activo con ese servicio asignado expresamente. Una lista de servicios vacía no significa que pueda realizar todos. Un centro sin profesionales activos no recibe reservas.

La asistencia la registra recepción: confirmar una cita no demuestra que el paciente haya acudido. El scheduler no asigna COMPLETED/NO_SHOW por el paso del tiempo. Las citas pasadas pendientes se señalan para revisar.

Los resultados separan valor reservado, citas recuperadas atendidas, valor atendido y cobros registrados. Las canceladas y ausencias no aportan valor recuperado. El periodo se elige en Recepción y corresponde a la fecha de la cita. Registrar un cobro no realiza un pago ni genera factura.

Una derivación pausa la IA para ese paciente. Recepción se hace cargo, revisa los mensajes, responde y devuelve la conversación al asistente. La propiedad impide que dos personas se apropien a la vez del mismo caso.

## Acceso y seguridad

Configura `ADMIN_EMAIL` y `ADMIN_PASSWORD` para crear el primer administrador. Retira la contraseña del entorno después. Se usa scrypt con sal aleatoria, sesiones persistentes de ocho horas, cookies HttpOnly/SameSite y protección CSRF. Los permisos ADMIN/RECEPTION se comprueban en cada ruta.

Sin usuarios configurados, el modo de desarrollo permite una demo solo desde loopback y un hostname local. En producción se requiere un administrador activo y HTTPS para las cookies. La demo de chat forma parte del panel protegido; no es un portal público de pacientes.

El webhook verifica la firma de Meta mediante `WHATSAPP_APP_SECRET`, guarda mensajes antes de reconocerlos y deduplica por su identificador. La cola conserva respuestas para reintentar entregas sin volver a ejecutar reservas. Las interrupciones ambiguas requieren revisión humana.

Reservas y recordatorios se guardan en una transacción. Los trabajos interrumpidos se recuperan con un token de propietario y reintentos limitados. Las copias SQLite consistentes se crean diariamente y con `npm run backup`; se conservan las últimas 30 y se excluyen de Git.

## Validación

```sh
npm run typecheck
npm test
npm run test:integration
npm run build
npm audit
```

Las pruebas de integración usan exclusivamente `prisma/test.db`, que el runner vuelve a crear. Cubren reservas concurrentes, cambios y compensaciones, listas de espera, servicios, agenda bloqueada, asistencia, resultados, derivaciones, sesiones/permisos/CSRF, recuperación y restauración de copias. No llaman al LLM, Meta ni Google reales.

## Alcance del piloto

Un único centro, SQLite y un único proceso de servidor. Antes de usar pacientes reales configura las credenciales, las plantillas de WhatsApp y prueba las integraciones. El calendario externo compartido todavía no permite disponibilidad independiente por profesional. No hay motor de gabinetes/máquinas, integración de pagos, facturación fiscal, MFA ni soporte multi-clínica.

La persistencia evita procesar dos veces un webhook recibido; no garantiza exactamente una entrega externa si el servidor cae entre el envío y su confirmación en base de datos.

Consulta [Preparación del piloto](docs/PILOTO.md) para actualizar sin perder datos, definir permisos, restaurar copias y comprobar los flujos.

Consulta la [revisión del producto y competidores](docs/REVISION_PRODUCTO_2026-10-09.md) para conocer el alcance comprobado, las diferencias respecto a alternativas y el orden recomendado de mejoras.

## Vista del paciente

La ruta `/reservar` permite reservar en cuatro pasos con disponibilidad real de la agenda: servicio, profesional, horario y datos de contacto. Guarda la cita y sus recordatorios. Las solicitudes repetidas con la misma clave no vuelven a reservar; las interrupciones ambiguas quedan para revisión en recepción.

Tras reservar, el paciente puede guardar un enlace privado para confirmar, cambiar o cancelar esa cita, sin crear una cuenta. El token aleatorio se guarda como hash en la base y viaja en la cabecera de autorización; el enlace usa un fragmento que no se envía en la URL al servidor. Caduca a los 90 días. Recepción puede generar otro enlace (revocando los anteriores) desde la búsqueda de pacientes. Un cambio de cita desde recepción conserva el enlace vigente.

«Avísame si queda un hueco» guarda preferencias reales en la lista de espera. «Hablar con recepción» registra una solicitud de contacto; no es un chat en directo. Ambos se ofrecen sin menús de configuración para el paciente.

Overview y Recepción incluyen «Pendiente de hoy»: confirmaciones, llegadas, conversaciones derivadas, solicitudes de contacto y avisos fallidos. Los avisos se pueden marcar revisados tras comprobarlos; no se reenvían automáticamente al pulsar. La búsqueda por nombre o teléfono abre la próxima cita o prepara una nueva con los datos existentes.

**Estado del piloto:** en desarrollo las reservas se guardan en la base local. No se verifica todavía la propiedad del teléfono mediante código; el enlace permite gestionar únicamente su cita, nunca consultar el historial por teléfono. La entrega por WhatsApp depende de las credenciales y plantillas de Meta. En producción las API públicas permanecen desactivadas salvo `PUBLIC_BOOKING_ENABLED=true`; antes de activarlas, preparar la verificación del teléfono, la información de privacidad del centro y la entrega real de avisos. El enlace debe compartirse solo con su titular. Actualizar con `prisma migrate deploy` y regenerar Prisma antes de arrancar.
