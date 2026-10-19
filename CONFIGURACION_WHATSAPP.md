# Configurar WhatsApp para el piloto controlado

Esta guía prepara **un número de prueba y un teléfono propio autorizado**. La aplicación no envía mensajes reales por defecto. No actives el portal público ni uses datos de pacientes reales durante estas pruebas.

## 1. Preparar Meta (paso manual)

1. Entra en [Meta for Developers](https://developers.facebook.com/apps/) con una cuenta que pueda gestionar el negocio. Crea una aplicación de tipo empresarial y añade el producto **WhatsApp**.
2. En **WhatsApp > API Setup**, anota en un lugar privado el *Phone Number ID*, el *WhatsApp Business Account ID* y el número de prueba. Añade **tu propio teléfono** como destinatario de prueba siguiendo el asistente de Meta.
3. Genera un token con permisos para WhatsApp. El token temporal del panel sirve para una prueba inicial y caduca; para un piloto sostenido prepara un token de usuario del sistema con los permisos que Meta indique para mensajería. Nunca lo pegues en GitHub, capturas, chats o tickets.
4. En **App Settings > Basic**, localiza el *App Secret*. Escoge también una cadena larga y aleatoria para el *Verify Token*: es una contraseña creada por ti, que debes poner idéntica en Meta y en la configuración local.

**Detente aquí hasta tener acceso a Meta y un teléfono propio agregado a la lista de destinatarios de prueba.** El equipo no puede verificar esos pasos desde este repositorio.

## 2. Aprobar plantillas (paso manual)

En el administrador de plantillas de WhatsApp, solicita estas plantillas en español (`es`). Los nombres se pueden cambiar en `.env`, pero el número y orden de variables deben coincidir exactamente con el código. Elige la categoría de utilidad si Meta la acepta para el contenido; la aprobación final depende de Meta.

| Nombre predeterminado | Texto sugerido para aprobación | Variables |
| --- | --- | --- |
| `recordatorio_cita_24h` | `Te recordamos tu cita el {{1}}. Responde SI para confirmar o NO para cancelar.` | Fecha y hora |
| `recordatorio_cita_2h` | `Te esperamos hoy a las {{1}}. Si no puedes venir, avísanos.` | Hora |
| `confirmacion_cita` | `Tu cita está confirmada para {{1}}.` | Fecha y hora |
| `oferta_lista_espera` | `Hay un hueco disponible el {{1}}. Responde SI en los próximos {{2}} minutos si lo quieres.` | Fecha y hora; minutos |
| `oferta_caducada` | `El tiempo para confirmar el hueco ha terminado. Sigues en la lista de espera.` | Ninguna |

Los recordatorios y avisos de lista de espera usan plantillas. La plantilla de confirmación queda **configurada pero todavía no se envía automáticamente**: la respuesta de confirmación existente del agente sigue dentro de la conversación. No se incluyen tipo de servicio, síntomas ni otros datos clínicos en los parámetros enviados a Meta.

## 3. Publicar un webhook HTTPS (paso manual)

1. Publica esta aplicación en un entorno de prueba con una URL **HTTPS** accesible desde Meta y TLS válido. La ruta de callback es `https://TU_DOMINIO/webhook`. `localhost` no es accesible desde Meta. Protege el resto del sitio; esta guía no activa `/reservar` para pacientes reales.
2. En **WhatsApp > Configuration > Webhook**, introduce esa URL y el *Verify Token*. Meta hará una petición `GET /webhook` y deberá recibir el reto de verificación.
3. Suscribe el campo **messages** de la cuenta de WhatsApp Business. Este campo trae mensajes entrantes y actualizaciones de estado de mensajes salientes.
4. Comprueba en Meta que la suscripción y el número corresponden al *Phone Number ID* configurado. El servidor rechaza cargas sin firma HMAC SHA-256 válida y omite eventos de otro número.

No desactives la comprobación de firma ni publiques secretos para resolver un fallo de verificación. Revisa URL, token, App Secret y suscripción.

## 4. Configurar el servidor sin publicar credenciales

Aplica primero la migración de base de datos: `npx prisma migrate deploy`. En el entorno de prueba, copia los nombres de `.env.example` a una configuración privada y rellena `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_VERIFY_TOKEN` y `WHATSAPP_APP_SECRET`. Mantén `WHATSAPP_GRAPH_VERSION=v26.0`, `WHATSAPP_TEMPLATE_LANGUAGE=es` y ajusta los cinco nombres de plantilla si los aprobados en Meta son distintos. No compartas el archivo `.env`.

Para la prueba **solo con tu teléfono** escribe su número internacional solo con dígitos en `WHATSAPP_ALLOWED_TEST_NUMBERS` (ejemplo de formato: `34XXXXXXXXX`, sin `+`). El webhook ignora mensajes de otros números y el transporte impide enviar a destinos fuera de esa lista. Con `WHATSAPP_SEND_ENABLED=false` tampoco se procesan mensajes entrantes, aunque sí se guardan estados de envíos anteriores. Deja ese valor en `false` hasta comprobar las plantillas, la URL HTTPS y la firma. Solo entonces, **tú** podrás cambiarlo temporalmente a `true` en el entorno de prueba y reiniciar el servidor. El portal público debe permanecer con `PUBLIC_BOOKING_ENABLED=false`.

## 5. Qué significa cada estado

- `ACCEPTED`: Meta devolvió un ID de mensaje. **No significa que haya llegado al teléfono**.
- `SENT`, `DELIVERED`, `READ`: estados posteriores recibidos por webhook firmado. Un `READ` puede no llegar, por ejemplo según la configuración de privacidad del destinatario.
- `FAILED`: Meta informó un fallo posterior a la aceptación.
- `REJECTED`: Meta rechazó la solicitud con un error HTTP definitivo.
- `UNKNOWN`: timeout, problema de red, HTTP 5xx, respuesta sin ID o caída del proceso durante el envío. **No se reenvía automáticamente**, pues podría haber llegado a Meta.

Los intentos y eventos quedan en `WhatsAppOutbound` y `WhatsAppStatusEvent`; el panel de recepción muestra los estados que requieren atención. Los webhooks repetidos se deduplican. El sistema evita reintentos automáticos duplicados con claves propias, pero Meta y la red **no garantizan entrega exactamente una vez**. Si hay un `UNKNOWN`, consulta el panel de Meta y el teléfono antes de decidir manualmente cómo proceder.

## 6. Checklist de prueba con tu teléfono

Usa solo datos ficticios y cita de prueba. Para cada mensaje saliente, comprueba por separado el ID/`ACCEPTED` y el estado posterior del webhook.

- [ ] Enviar un mensaje desde el teléfono autorizado: aparece **una sola** entrada aunque Meta reenvíe el webhook.
- [ ] Pedir una reserva: el agente ofrece horarios y se crea **una** cita de prueba.
- [ ] Cambiar la cita: la anterior deja de estar activa y la nueva aparece una sola vez.
- [ ] Cancelar la cita: queda cancelada y el hueco se libera.
- [ ] Crear una cita de prueba para recordar: el aviso de 24 h y el de 2 h usan las plantillas aprobadas; comprobar `ACCEPTED` y luego `DELIVERED`/`READ` o `FAILED`.
- [ ] Liberar un hueco con una entrada ficticia en lista de espera: llega la plantilla de oferta; una respuesta `SI` crea una sola cita; dejar caducar otra oferta libera el hueco y usa la plantilla de caducidad.
- [ ] Pedir ayuda humana: el agente deriva a recepción; el empleado se hace cargo y responde dentro de la ventana de 24 h.
- [ ] Repetir un webhook de estado y un mensaje entrante: no aparecen ofertas ni reservas adicionales.
- [ ] Simular pérdida de conexión en el entorno de prueba: el resultado queda `UNKNOWN` y requiere revisión, sin segundo envío automático.

Si falla la prueba, anota el paso, el estado y el ID interno sin copiar números, mensajes, tokens ni datos personales en un informe compartido.

Fuentes oficiales: [Meta WhatsApp Cloud API (colección oficial de Postman)](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api), [estados y ventana de atención (Meta)](https://www.postman.com/meta/whatsapp-business-platform/folder/fuaee8l/statuses-object), [anuncio de Graph API v26.0 (Meta)](https://developers.facebook.com/blog/post/2026/07/29/introducing-graph-api-v26-and-marketing-api-v26).
