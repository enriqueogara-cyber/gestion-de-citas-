# Preparación de la primera conversación bidireccional de WhatsApp

Estado a 19 de octubre de 2026: **preparado en código, sin activar envíos reales**. `WHATSAPP_SEND_ENABLED=false` y `PUBLIC_BOOKING_ENABLED=false`. No se ha probado todavía una respuesta saliente con Meta ni una llamada real del agente a OpenRouter en este flujo.

## Alcance de la primera prueba

- Solo el móvil verificado en Meta y la única entrada de `WHATSAPP_ALLOWED_TEST_NUMBERS` podrá activar el agente. No anotar el número en este documento ni en registros.
- El backend debe arrancarse explícitamente con `DATABASE_URL=file:./test.db` y `BACKEND_BIND_HOST=127.0.0.1`. **El valor de `DATABASE_URL` en `.env` no apunta a esta base de pruebas**; el arranque debe sobreescribirlo. Si se intenta activar el envío con otra base, el servidor falla al arrancar.
- El proxy de `127.0.0.1:3101` solo publica GET y POST `/webhook` hacia el backend de `127.0.0.1:3000`. Un Quick Tunnel proporciona HTTPS temporal. Comprobar de nuevo que la URL actual coincide con la registrada en Meta; puede cambiar al reiniciar el túnel.
- Al activar el piloto se exige `WHATSAPP_TEST_SEND_LIMIT` entre 1 y 5. Se recomienda **3**: el cupo cuenta todos los intentos salientes de la base de pruebas, persiste tras reinicios y una clave repetida no consume otro intento. Agotado el cupo, no se procesa una nueva solicitud del agente. No borrar la base para reiniciar el cupo sin revisar los resultados anteriores.
- `WHATSAPP_TEST_ALLOW_MUTATIONS=false` deja la primera conversación en modo consulta: el agente puede mostrar servicios y disponibilidad, pero sus herramientas no pueden reservar, confirmar, cambiar o cancelar citas ni alterar la lista de espera. Para probar esas acciones más adelante haría falta un paso separado con `true`, siempre sobre la base de pruebas.

**Primer intercambio propuesto:** desde el móvil autorizado, enviar «¿Qué huecos tienes para una revisión la semana que viene?». El agente consultará `check_availability` y, si OpenRouter responde correctamente, intentará enviar **una respuesta de texto libre** con los huecos disponibles o una pregunta aclaratoria. El texto literal no es determinista porque lo redacta el modelo; no se enviará una plantilla en este intercambio. No se creará una cita con el bloqueo de mutaciones activo. Si el agente detecta una consulta clínica, derivará a recepción en lugar de enviarla al modelo.

Cada webhook entrante requiere HMAC válida y el Phone Number ID configurado. El ID del mensaje entrante es único en SQLite; repetir el webhook no crea otra petición. La respuesta usa la clave `inbox:<id>` y un registro único `WhatsAppOutbound`; una respuesta HTTP de Meta con ID significa **aceptación**, mientras que `sent`, `delivered`, `read` y `failed` llegan después por webhooks firmados. Un timeout o respuesta ambigua queda `UNKNOWN` y no se reenvía automáticamente. Los errores de envío registran solo tipo, resultado y código de Meta cuando existe; no se escriben texto, teléfono ni credenciales en esos eventos.

## Costes y límites externos

Según la [FAQ oficial de WhatsApp Business](https://whatsappbusiness.com/resources/faq/), desde el 1 de octubre de 2026 los mensajes de servicio salientes se facturan por mensaje entregado **después de los primeros 1.000 por número empresarial y mes**. Las plantillas tienen tarifas según categoría y mercado. El coste de este número de prueba y el saldo/condiciones concretos **no se han verificado en WhatsApp Manager**; revisar allí el contador y la tarifa aplicable antes de activar. El cupo técnico de 3 limita intentos de esta aplicación, no sustituye los límites de facturación de Meta.

OpenRouter puede cobrar por los tokens de entrada y salida del modelo configurado, `anthropic/claude-sonnet-4.5`. La [ficha de OpenRouter](https://openrouter.ai/anthropic/claude-sonnet-4.5) publica 3 USD por millón de tokens de entrada y 15 USD por millón de tokens de salida; comprobar el precio al activar porque puede cambiar. Una petición puede necesitar varias llamadas al modelo para usar herramientas (el código limita el ciclo a seis). Un GET de solo lectura confirmó que la clave actual está activa y que el modelo admite herramientas, **pero la clave no comunica un límite de gasto propio**. Configurar un límite en OpenRouter y revisar los créditos antes de la prueba. No se ha realizado una llamada real de este flujo, por lo que no hay una estimación fiable del coste por conversación.

## Comprobaciones antes de permitir envíos

1. Confirmar de nuevo que la base activa es `prisma/test.db`, que sus diez migraciones están aplicadas y que no contiene datos reales. Conservar una copia antes de cualquier prueba de escritura.
2. Reiniciar el backend con el código actualizado, base de pruebas, un solo móvil permitido, `WHATSAPP_TEST_SEND_LIMIT=3`, `WHATSAPP_TEST_ALLOW_MUTATIONS=false` y `PUBLIC_BOOKING_ENABLED=false`. Solo en ese paso futuro se cambiaría `WHATSAPP_SEND_ENABLED` a `true`. Ahora permanece en `false`.
3. Comprobar que Meta muestra el móvil como destinatario de prueba y que el webhook HTTPS actual tiene `messages` suscrito. Un GET de solo lectura ya confirmó que el token funciona y que el Phone Number ID configurado pertenece al Business Account ID y es de Cloud API. No mostrar los valores de credenciales.
4. Verificar en WhatsApp Manager las condiciones de facturación y en OpenRouter el crédito y un límite de gasto: el GET de la clave no devolvió un límite propio. Confirmar que el token de Meta no está caducado.
5. Mandar solo la pregunta de disponibilidad anterior; observar aceptación y luego el estado de entrega. Si no hay respuesta o aparece `UNKNOWN`, detenerse y revisar antes de repetir.

La integración simulada prueba consulta, reserva, confirmación y cancelación con identidad de WhatsApp ficticia en SQLite de pruebas. Quedan pendientes la aceptación y entrega reales de Meta, la llamada real a OpenRouter, la estabilidad del túnel temporal y la revisión de privacidad antes de usar datos de pacientes.
