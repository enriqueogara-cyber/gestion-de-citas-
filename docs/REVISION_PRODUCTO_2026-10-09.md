# Revisión del producto y comparación con competidores

Fecha: 9 de octubre de 2026. Alcance: lectura del código, pruebas locales y documentación pública oficial. No se han probado cuentas de pago de los competidores ni se ha realizado una auditoría legal o de seguridad completa. Las prestaciones publicadas pueden variar por país, contrato y plan. Las prioridades comerciales son recomendaciones, no demanda validada.

## Valoración

El proyecto tiene un motor de citas funcional para un centro y una demostración útil de atención conversacional. Todavía necesita completar el recorrido público del paciente y verificar los proveedores externos antes de un piloto con pacientes reales. No debe presentarse como una plataforma clínica integral ni como un servicio multi-clínica terminado.

La oportunidad que propongo validar es una recepción digital para centros pequeños: gestionar citas por WhatsApp, transferir casos al equipo y medir el trabajo resuelto y las visitas recuperadas. La hipótesis inicial sería probarlo en fisioterapia de un solo centro, donde pueden observarse cancelaciones y tiempo de recepción. Hace falta entrevistar a clínicas para confirmar esa elección.

## Qué hay realmente en el repositorio

| Área | Estado comprobado | Límite actual |
|---|---|---|
| Motor de reservas | Servicios, profesionales cualificados, horarios, bloqueos, solapamientos y cambios de cita validados en el backend. | Solo un centro y un proceso. Google usa un calendario compartido; falta disponibilidad externa independiente por profesional. |
| Recepción | Agenda diaria, reserva manual, cambios, cancelaciones, asistencia, cobros anotados y derivaciones humanas. | No hay agenda semanal completa ni ficha operativa unificada de paciente; anotar cobros no procesa pagos ni factura. |
| Asistente | Usa OpenRouter y herramientas del dominio; guarda historial y permite pausar la IA. | No hay una batería de evaluaciones de conversaciones reales. En esta revisión una pregunta de horarios causó una derivación innecesaria: se añadió el horario vigente al contexto. |
| Lista de espera | Compatibilidad, oferta, retención temporal, aceptación y caducidad. | Falta verificar el envío real de ofertas y completar la plantilla apropiada para mensajes proactivos. Revisar recuperación ante fallo entre oferta, retención y creación del trabajo, que aparecen como escrituras separadas. |
| WhatsApp | Webhook firmado, bandeja persistente, deduplicación, reintentos y envío de plantillas. | Implementación disponible no equivale a integración verificada. El chat del navegador es un simulador protegido. Revisar también la versión de Graph API configurada antes del despliegue. |
| Página del paciente | `/reservar` muestra servicio, profesional, horarios de ejemplo y confirmación simulada. | No consulta disponibilidad real ni crea citas. Faltan verificación de teléfono y enlaces seguros de autogestión. |
| Overview | Estadísticas de citas por periodo y distinción entre valor reservado, atendido y cobrado para las recuperadas. | Mezcla datos de demo si comparten base. “Citas gestionadas” cuenta registros del periodo, incluidos cancelados; no mide trabajo resuelto por la IA. |
| Operación | Roles, sesiones, CSRF, copias y pruebas de recuperación. | Faltan despliegue público, supervisión del servicio y prueba operativa de restauración fuera del equipo local. No hay MFA ni recuperación automática de acceso. |
| Varias clínicas | Existen campos `clinicId`. | Hay consultas y restricciones de centro fijo; estos campos no proporcionan aislamiento entre clientes. |

Evidencia local: `src/domain/bookingEngine.ts`, `src/calendar/`, `src/services/reception.ts`, `src/services/waitlistOrchestrator.ts`, `src/services/reportingService.ts`, `src/services/staffAuth.ts`, `src/whatsapp/`, `src/patient/page.ts`, `src/agent/`, `prisma/schema.prisma` y `docs/PILOTO.md`.

## Comparación con alternativas

| Alternativa | Qué publica | Qué implica para este proyecto |
|---|---|---|
| Doctoralia | Reserva multicanal, cambios/cancelación del paciente, agenda y permisos de recepción. También documenta avisos automáticos para cubrir cancelaciones. | Reserva online y lista de espera ya son prestaciones competitivas básicas. Hay que demostrar mejor encaje en el trabajo diario de la clínica elegida. |
| Cliniko | Agenda con reservas online y repetidas, historias clínicas, facturas, informes, varias sedes y API. | Tiene más profundidad operativa. Una vía posible es complementar sistemas existentes mediante integraciones, sujeto a su API y condiciones. |
| Fresha | Lista de espera con avisos por WhatsApp, SMS y correo; pasa al siguiente candidato si caduca el plazo. También publica pagos y depósitos. | “Rellenar huecos por WhatsApp” por sí solo no es una ventaja exclusiva. Importan la experiencia completa, la fiabilidad y los resultados verificables. |
| Clinic Cloud | Caja, facturación y gestión financiera dentro de un producto de clínicas. | Nuestro registro de cobros es mucho más limitado. Para clínicas que ya facturan con otra herramienta, una integración puede aportar más que reconstruir ese módulo. |

Fuentes oficiales consultadas:

- [Doctoralia: reserva online y agenda](https://pro.doctoralia.es/productos/funcionalidades/reserva-online-de-cita).
- [Doctoralia: cubrir cancelaciones](https://pro.doctoralia.es/blog/clinicas/cubrir-citas-canceladas).
- [Cliniko: funcionalidades](https://www.cliniko.com/features/).
- [Fresha: avisos de lista de espera](https://www.fresha.com/help-center/knowledge-base/calendar/169-send-waitlist-updates).
- [Fresha: pagos y depósitos](https://www.fresha.com/help-center/knowledge-base/payments).
- [Clinic Cloud: caja y facturación](https://clinic-cloud.com/software-caja-facturacion).

No asigno puntuaciones ni precios comparativos: no hemos medido la calidad de sus productos y una tarifa aislada no refleja número de profesionales, mensajes, comisiones, país e implantación.

## Orden recomendado de trabajo

### 1. Completar un recorrido real del paciente

Conectar `/reservar` al mismo motor de disponibilidad y reserva, verificar teléfono, limitar abuso e introducir una clave de idempotencia para reintentos. Crear enlaces revocables y con caducidad para cambiar/cancelar sin exponer datos de terceros.

Criterio de aceptación: una reserva web aparece en recepción; dos solicitudes simultáneas no ocupan el mismo profesional y tramo; refrescar o reintentar no duplica la cita; un enlace inválido no revela datos.

### 2. Verificar WhatsApp de extremo a extremo

Configurar número, webhook y plantillas en una cuenta de prueba; comprobar reserva, recordatorio, cancelación, oferta y transferencia humana. Registrar recepción, intento de envío, entrega y fallo como estados distintos. Revisar la recuperación de ofertas ante interrupciones parciales.

Criterio: recepción identifica un mensaje fallido y puede intervenir; una repetición del webhook no duplica la acción; un reinicio no pierde recordatorios ni deja ofertas incoherentes.

### 3. Hacer que Overview ayude a decidir

Mostrar hoy y periodo seleccionado con citas pendientes, confirmadas, atendidas, canceladas y ausencias. Aclarar los denominadores de porcentajes y separar demo de operación real. Añadir ocupación únicamente cuando se disponga de capacidad real por profesional. Mantener reserva recuperada, asistencia y cobro como métricas diferentes.

Priorizar acciones: confirmar pendientes, registrar asistencia, resolver derivaciones y revisar entregas fallidas. Una gráfica atractiva sin datos fiables aporta menos que estas tareas.

### 4. Facilitar el trabajo diario y el alta de un centro

Agenda semanal por profesional, ficha de paciente con historial de citas y conversaciones, búsqueda, horario individual, descansos y festivos. Añadir un asistente de configuración que compruebe servicios, profesionales y conexiones antes de activar reservas. Mostrar al equipo si falta una integración, como ocurrió con la clave de IA.

### 5. Medir si el piloto merece la pena

Recoger una referencia previa y comparar semanas equivalentes: solicitudes resueltas sin intervención, minutos de recepción, cancelaciones recuperadas que acabaron en visita, ausencias y coste variable por conversación/reserva. El objetivo es medir, no prometer un porcentaje de mejora antes de observarlo.

Hacer entrevistas con 3–5 centros y elegir uno para el primer piloto. Preguntar cómo reservan hoy, qué software tienen, cuántas incidencias requieren llamadas y qué les impediría confiar en una reserva automática. No proponer sustituir su sistema sin entenderlo.

### 6. Preparar la operación comercial

Dominio y HTTPS, disponibilidad del servidor, alertas, límites de gasto, copias externas protegidas y ensayo de restauración. Definir conservación y exportación de datos, responsabilidades de proveedores y revisión de privacidad antes de pacientes reales. Para vender varias clínicas: implementar contexto de centro e aislamiento probado; no basta con cambiar la marca o añadir un selector.

## Cambios realizados en esta revisión

- Un único desplazamiento reúne cabecera, accesos, bienvenida e historial; los mensajes conservan la altura disponible.
- Campo de escritura anclado y adaptación al espacio de pantalla.
- Botón para volver a los últimos mensajes cuando se lee el historial; las respuestas no fuerzan bajar si se está leyendo arriba.
- Respeto de movimiento reducido, etiqueta del campo y región de mensajes accesible.
- Se bloquea el reinicio durante un envío y se conservan las horas originales al recargar mensajes.
- El asistente recibe el horario habitual configurado, separado de la disponibilidad concreta de citas.

El resto del plan es trabajo pendiente. Esta revisión no conecta todavía la página pública a reservas reales ni despliega WhatsApp de producción.

## Validación de esta entrega

- Compilación TypeScript y 52 pruebas unitarias correctas.
- 46 pruebas de integración correctas, incluida la actualización del horario que recibe el asistente cuando cambia la configuración.
- Navegador: historial vacío y conversación de 40–44 mensajes de prueba; bienvenida e historial sin desplazamientos independientes; campo de escritura visible y sin desbordamiento horizontal en 390 × 844 y en escritorio.
- Lectura del inicio durante una respuesta demorada: se conserva la posición y el botón permite volver al final. Escritura de varias líneas sin sacar el formulario de la pantalla.
- Consulta real al modelo: responde que los lunes abre de 09:00 a 14:00 y de 16:00 a 20:00, conforme al horario configurado, sin derivar esa consulta. Una prueba no garantiza todas las respuestas futuras del modelo.

Las dimensiones móviles se verificaron en navegador; queda pendiente probar teclado virtual y gestos en dispositivos físicos. Las pruebas de interfaz usaron un servidor local aislado sin reservas ni envíos externos. La comprobación del modelo se realizó con una conversación de demostración.
