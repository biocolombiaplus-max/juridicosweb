# Agente de WhatsApp con IA — JurídicosWeb

Contesta el WhatsApp como si fuera Valentina, una asesora real de 25 años: mensajes cortos, tono colombiano natural, sin sonar a bot. Resuelve dudas de precio/proceso/legalidad, y en cuanto el cliente da su cédula lo registra en tu misma hoja de cálculo y le manda el enlace para que revise su resultado y pague — igual que el resto del embudo del sitio.

Corre en **Cloudflare Workers** (la misma plataforma donde ya tienes `simit-proxy-worker.js`), habla con **Claude** (Anthropic) para generar las respuestas, y usa tu **Apps Script existente** (`google-sheets-leads.gs`, ya actualizado con 3 acciones nuevas) como memoria — todo queda en la misma hoja "📊 Control de Casos" que ya usas en admin.html.

Elegiste probarlo primero con un **número de WhatsApp nuevo** (no el que ya usa Kommo), así que nada de lo que hoy funciona se toca hasta que decidas migrar.

## 1. Antes de empezar: republica tu Apps Script

`google-sheets-leads.gs` tiene 3 acciones nuevas que el agente necesita (`buscar_caso_telefono`, `guardar_mensaje_ia`, `obtener_historial_ia`). Pega el archivo completo actualizado en tu editor de Apps Script y dale **Implementar → Nueva versión**, igual que siempre. Sin este paso el agente no va a poder guardar ni consultar nada.

## 2. Crea tu App de Meta y el número de prueba

1. Ve a [developers.facebook.com](https://developers.facebook.com) → **Mis Apps → Crear App → tipo "Empresa"**.
2. Dentro de la App, agrega el producto **WhatsApp**.
3. En **WhatsApp → Introducción**, Meta te da automáticamente un **número de prueba gratis** — es el que vas a usar para probar el agente.
4. En esa misma pantalla anota estos 2 datos (los vas a necesitar en el paso 4):
   - **Phone number ID** (un número largo, no es el número de teléfono).
   - Un **token de acceso temporal** (dura 24h — sirve para probar hoy mismo; en el paso 5 te explico cómo generar uno permanente).
5. En **WhatsApp → Introducción → Añadir número de teléfono de destinatario**, agrega tu propio celular (o el de quien vaya a probar) — con el número de prueba gratis, **solo pueden escribirle los números que agregues aquí a la lista**.

## 3. Genera un token permanente (para cuando ya no sea prueba)

El token temporal del paso anterior vence en 24h. Para uno que no vence:

1. Ve a [business.facebook.com/settings](https://business.facebook.com/settings) → **Usuarios → Usuarios del sistema → Añadir**.
2. Créalo con rol **Administrador**, asígnale la App de WhatsApp que creaste.
3. **Generar token** → selecciona la App, marca el permiso `whatsapp_business_messaging`, y elige "Nunca" en expiración.
4. Guarda ese token — es el que vas a poner como secreto `WHATSAPP_TOKEN` en el paso 4.

## 4. Publica el Worker en Cloudflare

1. **Cloudflare Dashboard → Workers & Pages → Create → Create Worker.**
2. Ponle un nombre, por ejemplo `agente-whatsapp-juridicosweb`.
3. Abre el editor y pega **todo el contenido** de `agente-whatsapp-worker.js` (reemplaza el ejemplo que trae por defecto). **Guardar y desplegar**.
4. **Settings → Variables and Secrets → Add**, agrega estos 6 secretos (todos como "Secret", no "Text"):

| Secreto | De dónde lo sacas |
|---|---|
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) → API Keys → Create Key |
| `WHATSAPP_TOKEN` | El token del paso 2 (temporal) o paso 3 (permanente) |
| `WHATSAPP_PHONE_NUMBER_ID` | El "Phone number ID" que anotaste en el paso 2 |
| `WHATSAPP_VERIFY_TOKEN` | Invéntate cualquier palabra secreta — solo la usas tú, en el siguiente paso |
| `WHATSAPP_APP_SECRET` | En tu App de Meta → **Configuración → Básica → Clave secreta de la app** (botón "Mostrar") |
| `SCRIPT_URL` | La misma URL de tu Apps Script que ya usas en `index.html` / `admin.html` |

Opcional: `CLAUDE_MODEL` — si no lo pones, usa `claude-haiku-4-5-20251001` (rápido y económico, ideal para chat).

5. Copia la URL que te dio Cloudflare al crear el Worker (algo como `https://agente-whatsapp-juridicosweb.tu-subdominio.workers.dev`).

## 5. Conecta el webhook en Meta

1. En tu App de Meta → **WhatsApp → Configuración** (Configuration) → **Webhook → Editar**.
2. **URL de devolución de llamada**: la URL de tu Worker + `/webhook` (ej: `https://agente-whatsapp-juridicosweb.tu-subdominio.workers.dev/webhook`).
3. **Verify token**: el mismo valor que pusiste en el secreto `WHATSAPP_VERIFY_TOKEN`.
4. Dale **Verificar y guardar** — si todo está bien conectado, Meta lo acepta al instante.
5. Abajo, en **Campos del webhook**, suscríbete a **`messages`**.

## 6. Prueba

Desde el celular que agregaste como "destinatario de prueba" (paso 2.5), escríbele al número de prueba de WhatsApp que te dio Meta. En unos segundos debería contestarte Valentina — mensajes cortos, sin sonar a bot.

Si no contesta: revisa **Cloudflare Dashboard → tu Worker → Logs** en tiempo real mientras mandas el mensaje — ahí ves exactamente en qué paso falla (token vencido, Apps Script sin republicar, etc.).

## Cómo ajustar cómo habla

Todo el "cómo es" de Valentina está en una sola variable al inicio de `agente-whatsapp-worker.js`, llamada `PERSONA_SISTEMA` — es texto plano en español, no código. Cámbiale el nombre, el tono, agrega más información del servicio, o ajusta cómo cierra — sin tocar el resto del archivo. Después de editar, vuelve a pegar el archivo completo en el Worker y dale **Desplegar**.

## Qué queda pendiente si más adelante quieres llevarlo a producción

- **Migrar el número real** (el que hoy usa Kommo) cuando confirmes que el agente responde bien — implica reconectar ese número a esta App de Meta en vez de a Kommo.
- **Verificación de negocio en Meta** (Business Verification) — Meta la pide para levantar el límite de mensajes/día y quitar el aviso de "número de prueba".
- El agente asume que **solo hay 1 multa por conversación** para simplificar el cierre por chat — si el cliente tiene varias, igual lo registra bien; el detalle de cuántas multas aplican se termina de ver en el sitio (`firmar.html`), como con el resto del embudo.
- No hay filtro anti-mensajes-duplicados (si Meta reenvía el mismo webhook por una falla de red, se podría procesar dos veces). Para un volumen pequeño no es un problema real; si crece mucho, se puede agregar con Cloudflare KV.
