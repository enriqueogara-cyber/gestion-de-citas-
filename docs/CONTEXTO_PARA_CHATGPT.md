# Contexto del proyecto para otro asistente de IA

Actualizado el 19 de octubre de 2026. Repositorio: https://github.com/enriqueogara-cyber/gestion-de-citas-

## Idea y público

Queremos crear una recepción digital sencilla para clínicas y centros de servicios con cita previa. El primer piloto está pensado para **un solo centro**. El paciente puede reservar por una página web o hablar con un asistente conversacional; recepción dispone de una agenda y puede intervenir. La oportunidad que queremos validar es reducir trabajo repetitivo de recepción y recuperar cancelaciones con una lista de espera. La elección de una especialidad concreta y la demanda comercial aún requieren entrevistas con centros.

## Qué funciona ya en el código

- Motor de citas con servicios, profesionales habilitados por servicio, horario semanal, bloqueos, antelación mínima, disponibilidad y protección contra solapamientos. Permite reservar, confirmar, cambiar y cancelar. Los cambios conservan la cita original hasta reservar la nueva.
- Página del paciente en `/reservar`: consulta huecos reales, guarda reservas en la agenda y permite apuntarse a la lista de espera. Tras reservar crea un enlace privado que caduca a los 90 días para confirmar, cambiar o cancelar **esa** cita. El paciente puede pedir que recepción le contacte. Los reintentos de reserva usan una clave para evitar duplicados y los casos ambiguos quedan para revisión humana.
- Panel de clínica: Overview como entrada principal; Recepción con agenda, reserva manual para llamadas, cambios, cancelaciones, asistencia registrada por personas, bloqueos y cobros anotados. Hay búsqueda por nombre/teléfono y tareas de hoy: confirmaciones, llegadas, solicitudes de contacto, conversaciones derivadas y fallos de mensajes.
- Asistente conversacional conectado a OpenRouter en un chat de simulación, con herramientas que llaman al motor de citas. El chat permite derivar la conversación a una persona y pausar la IA para ese paciente. Se guarda el historial.
- Lista de espera que contempla preferencias y ofrece huecos liberados. Recordatorios y mensajes se gestionan mediante trabajos persistentes, con reintentos y revisión de errores.
- Integración de WhatsApp implementada a nivel de webhook firmado, bandeja persistente, deduplicación y envío. La entrega real con Meta **no se ha validado de extremo a extremo**. Google Calendar usa simulación si faltan credenciales.
- Roles de administrador y recepción, sesiones, protección CSRF, copias de seguridad SQLite y pruebas. En la última entrega de código pasaron 53 pruebas unitarias y 53 de integración.

## Estado y límites importantes

Es un **piloto local**, no una plataforma clínica lista para atender pacientes reales. Usa Node.js, TypeScript, Express, Prisma y SQLite; está preparado para un solo centro y un solo proceso. Los campos `clinicId` existentes no proporcionan todavía aislamiento entre varias clínicas.

La propiedad del teléfono del paciente todavía **no se verifica** con código. Por ello las API públicas están desactivadas en producción salvo activación expresa; antes de abrirlas a pacientes hay que añadir verificación de identidad, información y tratamiento de datos apropiados, HTTPS y pruebas de las notificaciones. El enlace privado solo autoriza su cita concreta y debe mantenerse secreto. No hay historial clínico, pagos reales ni facturación. Un cobro en el panel es un apunte, no una transacción.

El chat del navegador es una simulación protegida para la clínica. WhatsApp real requiere cuenta Meta, número, webhook, plantillas aprobadas y pruebas de envío/entrega. El calendario externo compartido no ofrece todavía disponibilidad independiente por profesional. Las estadísticas deben distinguir reservas, asistencia y cobros y separar datos de demostración de los reales.

La revisión de competidores del 9 de octubre está en `docs/REVISION_PRODUCTO_2026-10-09.md`. **Es una foto anterior** a la página de reservas actual: sus frases sobre horarios ficticios y reservas simuladas ya quedaron obsoletas. El estado actualizado de esa parte está en el `README.md` y en este documento.

## Cómo podría ayudar un agente de IA

El agente más útil para el producto sería una **recepcionista digital para pacientes**. Entendería mensajes sencillos como «quiero una revisión el martes por la tarde», pediría solo los datos necesarios, consultaría los huecos verdaderos mediante herramientas del backend, propondría opciones, confirmaría la elección y llamaría al motor para reservar. También ayudaría a cambiar o cancelar una cita cuando exista un modo seguro de identificar al paciente, y derivaría casos ambiguos, urgentes o fuera de su alcance al equipo.

La IA **no debe inventar huecos ni modificar citas directamente**: el motor actual valida servicios, profesionales, horarios, bloqueos, antelación y solapamientos. Tampoco debe recibir datos médicos innecesarios ni prometer que se envió un mensaje sin confirmación del proveedor. Una persona debe poder hacerse cargo de la conversación y revisar fallos de entrega.

Ya existe una primera versión de ese asistente en el simulador. El trabajo siguiente debería centrarse en definir tareas y criterios de éxito, probar conversaciones reales anonimizadas, verificar identidad antes de gestionar citas ajenas, conectar y ensayar WhatsApp de extremo a extremo, y medir cuánto trabajo resuelve sin intervención y cuántas citas recuperadas acaban en visita. También sería útil un **agente de desarrollo** para revisar flujos y ejecutar pruebas, pero es distinto del asistente que usarían los pacientes.

## Pregunta para continuar en ChatGPT

«Lee este contexto y el repositorio enlazado. Quiero diseñar el próximo agente de IA para este producto sin complicar la experiencia del paciente ni la del personal. Distingue lo que ya existe de lo que falta. Propón un único primer caso de uso, sus herramientas, límites, cuándo debe derivar a recepción, cómo comprobar su calidad con conversaciones de prueba y un plan de piloto pequeño. No supongas que WhatsApp real, verificación de teléfono o varias clínicas ya están listos. Si un detalle del repositorio no se puede verificar, indícalo como hipótesis».

## Archivos útiles

- `README.md`: funciones y arranque actual.
- `docs/PILOTO.md`: trabajo de recepción, seguridad y preparación de un piloto.
- `docs/REVISION_PRODUCTO_2026-10-09.md`: comparación con alternativas y prioridades; atención a la fecha de la revisión.
- `src/agent/`: asistente conversacional.
- `src/domain/bookingEngine.ts`: reglas de reserva.
- `src/patient/`: página y API del paciente.
- `src/simulator/`: panel de clínica y chat de demostración.
- `src/whatsapp/`: integración de mensajes.

No compartas el archivo local `.env`, claves de API ni bases de datos con pacientes reales para explicar el proyecto.
