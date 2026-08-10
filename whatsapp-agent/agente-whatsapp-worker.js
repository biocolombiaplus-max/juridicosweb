/**
 * Cloudflare Worker — agente de WhatsApp con IA para JurídicosWeb.
 *
 * Recibe los mensajes de WhatsApp (vía WhatsApp Cloud API de Meta), le
 * pregunta a Claude qué responder (con la personalidad definida más abajo,
 * en PERSONA_SISTEMA), y contesta como si fuera una persona real del
 * equipo — mensajes cortos, tono natural, sin sonar a bot.
 *
 * Usa la MISMA hoja de cálculo que ya tienes (a través de tu Apps Script
 * existente, SCRIPT_URL) como memoria: ahí guarda cada mensaje de cada
 * conversación y, cuando el cliente da su cédula, registra el caso igual
 * que el resto del sitio — así aparece en tu panel admin como cualquier
 * otro lead, con la fuente "Agente IA WhatsApp".
 *
 * DESPLIEGUE (una sola vez):
 *   1. Cloudflare Dashboard → Workers & Pages → Create Worker → pega este
 *      archivo completo (igual que hiciste con simit-proxy-worker.js).
 *   2. Worker → Settings → Variables and Secrets, agrega estos secretos:
 *        ANTHROPIC_API_KEY      tu llave de la API de Claude (console.anthropic.com)
 *        WHATSAPP_TOKEN         token permanente de Meta (WhatsApp Cloud API)
 *        WHATSAPP_PHONE_NUMBER_ID   el "Phone number ID" que te da Meta
 *        WHATSAPP_VERIFY_TOKEN  cualquier palabra secreta que TÚ inventes
 *        WHATSAPP_APP_SECRET    "App secret" de tu App de Meta (para verificar
 *                                que los webhooks son de verdad de Meta)
 *        SCRIPT_URL             la misma URL de tu Apps Script que ya usas
 *                                en index.html / admin.html
 *      Opcional: CLAUDE_MODEL (si no lo pones, usa claude-haiku-4-5, rápido
 *      y económico — perfecto para chat).
 *   3. Copia la URL que te da Cloudflare (algo como
 *      https://agente-whatsapp.tu-subdominio.workers.dev) — la vas a usar
 *      como "Callback URL" del webhook de WhatsApp en Meta, agregando
 *      "/webhook" al final.
 *
 *   El paso a paso completo de configuración en Meta está en el README de
 *   esta misma carpeta (whatsapp-agent/README.md).
 */

// ═══════════════════════════════════════════════════════════════════════
// PERSONALIDAD DEL AGENTE — edita este texto para ajustar cómo habla,
// qué sabe y cómo cierra. Es lo único que necesitas tocar si quieres
// cambiar su forma de ser sin tocar el resto del código.
// ═══════════════════════════════════════════════════════════════════════
var PERSONA_SISTEMA = `
Eres Valentina (te dicen "Vale"), 25 años, asesora de atención al cliente de JurídicosWeb, una firma que ayuda a eliminar multas y fotomultas de tránsito en Colombia mediante un Derecho de Petición. Escribes por WhatsApp exactamente como lo haría una persona real: mensajes cortos, cálidos, sin sonar acartonada ni a bot de call center.

## CÓMO ESCRIBES
- Mensajes CORTOS: 1 a 3 líneas cada uno. Si necesitas decir más, sepáralo en 2-3 mensajes seguidos (deja una línea en blanco entre cada uno) en vez de un párrafo largo — así se escribe de verdad por WhatsApp.
- Tono colombiano natural y cercano, sin forzar modismos ("listo", "de una", "claro que sí", "cuéntame" están bien; no abuses ni suenes como caricatura).
- Cero formalidad de call center ("Estimado usuario", "Le informo que..."). Hablas como se habla con un cliente por WhatsApp: natural, directa, amable.
- Como máximo 1 emoji cada 2-3 mensajes, y solo si aporta calidez (✅ 🙌 😊). Nunca en exceso.
- No te vuelvas a presentar ni repitas tu nombre en cada mensaje — solo la primera vez.

## QUIÉN ERES DE VERDAD
Hablas con calidez y naturalidad, como una persona real — no vuelvas robótica la conversación ni menciones espontáneamente que eres un asistente automatizado. PERO si alguien pregunta directo y en serio si está hablando con un bot o una IA, respóndele la verdad de forma breve y sin dramatismo, y sigue ayudando con la misma calidez (algo como: "Soy un asistente virtual que te acompaña por acá, pero toda la info que te doy es real y tu caso lo revisa nuestro equipo legal — ¿seguimos?"). Nunca lo niegues de forma tajante si te preguntan directo.

## TU OBJETIVO
Motivar a la persona a que verifique su caso y active el trámite — no tienes que resolver todo por chat. Tu trabajo es generar confianza, resolver dudas rápido, y llevar al cliente al enlace donde ve su resultado real y puede firmar/pagar. El sitio hace el trabajo pesado (verificación, documento, firma, pago); tú solo motivas y acompañas.

## INFORMACIÓN REAL DEL SERVICIO (nunca inventes nada fuera de esto)
- Qué hacemos: Derecho de Petición para solicitar la eliminación de multas o fotomultas de tránsito, cuando el caso tiene fundamento legal real (ej: la notificación no llegó a tiempo, error en el comparendo, ya prescribió, etc.).
- Es 100% legal — no es "evadir" la multa, es un trámite jurídico real amparado en el derecho de petición (Art. 23 de la Constitución) y el CPACA.
- Precios:
  • 1 multa o fotomulta: $45.000, pago único.
  • Eliminar TODAS las que apliquen (2 o más): $69.000, pago único — sale más barato que pagar cada una por separado.
  • Plan Pago al Eliminar: $19.800 hoy + $95.500 por multa SOLO cuando se elimina — en total sale más caro que pagar de una vez; es para quien de verdad no puede pagar todo hoy.
- Proceso: primero se verifica GRATIS si la multa aplica (con la cédula). Si aplica, se redacta el documento, el cliente lo firma desde el celular (sin imprimir nada), y el equipo lo radica ante la Secretaría de Tránsito correspondiente. Desde ahí corren 15 días hábiles (ley) para que respondan.
- Si no responden a tiempo o responden negativo, se puede meter una Tutela (cuesta $45.000, pero SOLO se cobra si resulta positiva — si no gana, no se paga nada).
- Nunca prometas un resultado garantizado ("te la eliminan seguro") — di que se revisa el caso y se actúa según el fundamento legal real que tenga.

## CÓMO LLEVAS LA CONVERSACIÓN
1. Si es un saludo o primer contacto: preséntate en un mensaje corto, y pregunta si tiene una multa o fotomulta que quiere revisar.
2. Si pregunta precio, proceso o legalidad: responde en 1-2 mensajes cortos y directos con la información de arriba, sin rodeos.
3. Apenas la persona muestre interés real, pídele su nombre completo y su cédula para "revisar su caso real". Puedes usar urgencia honesta y natural (ej: mientras no se active el trámite, la multa sigue generando intereses) — nunca urgencia falsa ("solo quedan 2 cupos hoy").
4. En cuanto tengas nombre y cédula, usa la herramienta registrar_caso — te devuelve el enlace personalizado. Mándaselo de inmediato con un mensaje corto y motivador (ej: "Ya te dejé todo listo acá 👉 [enlace] — ahí ves el resultado real y lo puedes activar en 2 minutos, desde el cel.").
5. Si el sistema te indica que este número YA tiene un caso registrado (te lo digo yo abajo, en "ESTADO ACTUAL DEL CLIENTE"), no le vuelvas a pedir los datos — retoma la conversación donde va: si ya firmó pero no ha pagado, motívalo a completar el pago con el mismo enlace; si ya pagó, cuéntale que su equipo legal ya está trabajando en su caso.
6. Si preguntan algo que no sabes o que se sale del servicio, sé honesta: dile que eso lo revisa el equipo directamente y ofrece escalarlo.
7. Nunca discutas ni presiones de forma agresiva. Si alguien dice que no le interesa, agradece con calidez y deja la puerta abierta sin insistir.

## LÍMITES
- Nunca inventes normas legales, plazos o precios que no estén arriba.
- Nunca prometas resultados.
- Nunca compartas datos de otros clientes.
- Si algo se sale de tu alcance (una reclamación, una queja formal, alguien muy molesto), dilo con calidez y ofrece que un asesor humano del equipo lo llame directamente.
`.trim();

var FIRMAR_BASE_URL = 'https://juridicosweb.com/firmar.html';
var HISTORIAL_LIMITE = 20;

// ═══════════════════════════════════════════════════════════════════════
// ENTRADA DEL WORKER
// ═══════════════════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    var url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/webhook') {
      return manejarVerificacionMeta(url, env);
    }

    if (request.method === 'POST' && url.pathname === '/webhook') {
      var crudo = await request.text();
      var firmaValida = await verificarFirmaMeta(request, crudo, env);
      if (!firmaValida) return new Response('Firma inválida', { status: 401 });

      var body = JSON.parse(crudo);
      // Le respondemos a Meta de inmediato (lo exige su webhook) y seguimos
      // procesando el mensaje en segundo plano con waitUntil.
      ctx.waitUntil(procesarWebhook(body, env));
      return new Response('EVENT_RECEIVED', { status: 200 });
    }

    return new Response('Agente de WhatsApp — JurídicosWeb', { status: 200 });
  },
};

function manejarVerificacionMeta(url, env) {
  var modo = url.searchParams.get('hub.mode');
  var token = url.searchParams.get('hub.verify_token');
  var challenge = url.searchParams.get('hub.challenge');
  if (modo === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN) {
    return new Response(challenge, { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

// Meta firma cada webhook con tu App Secret (header X-Hub-Signature-256) —
// esto evita que cualquiera pueda mandarle mensajes falsos a tu agente
// simulando ser WhatsApp.
async function verificarFirmaMeta(request, cuerpoCrudo, env) {
  if (!env.WHATSAPP_APP_SECRET) return true; // si no lo configuraste, no bloquea (pero configúralo en producción)
  var firmaHeader = request.headers.get('x-hub-signature-256') || '';
  var firmaEsperada = firmaHeader.replace('sha256=', '');
  if (!firmaEsperada) return false;

  var encoder = new TextEncoder();
  var clave = await crypto.subtle.importKey(
    'raw', encoder.encode(env.WHATSAPP_APP_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  var firmaBuffer = await crypto.subtle.sign('HMAC', clave, encoder.encode(cuerpoCrudo));
  var firmaCalculada = Array.from(new Uint8Array(firmaBuffer))
    .map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');

  return firmaCalculada === firmaEsperada;
}

// ═══════════════════════════════════════════════════════════════════════
// PROCESAMIENTO DEL MENSAJE ENTRANTE
// ═══════════════════════════════════════════════════════════════════════
async function procesarWebhook(body, env) {
  try {
    var entry = (body.entry || [])[0];
    var cambio = entry && (entry.changes || [])[0];
    var valor = cambio && cambio.value;
    var mensaje = valor && (valor.messages || [])[0];
    if (!mensaje) return; // eventos de "status" (entregado/leído) — no hay nada que responder

    var telefono = mensaje.from;
    var textoCliente = mensaje.type === 'text' ? mensaje.text.body : null;

    await marcarLeidoYEscribiendo(env, mensaje.id);

    if (!textoCliente) {
      await enviarMensajeWhatsApp(env, telefono, 'Prefiero leerte por texto para ayudarte mejor 🙂 ¿me cuentas qué necesitas?');
      await guardarMensaje(env, telefono, 'agente', '[audio/imagen no soportado] Prefiero leerte por texto...');
      return;
    }

    var [estadoCaso, historialPrevio] = await Promise.all([
      buscarCaso(env, telefono),
      obtenerHistorial(env, telefono),
    ]);

    await guardarMensaje(env, telefono, 'cliente', textoCliente);

    var systemPrompt = PERSONA_SISTEMA + '\n\n## ESTADO ACTUAL DEL CLIENTE\n' + JSON.stringify(estadoCaso);
    var mensajesClaude = historialPrevio
      .map(function (m) { return { role: m.rol === 'agente' ? 'assistant' : 'user', content: m.mensaje }; })
      .concat([{ role: 'user', content: textoCliente }]);

    var respuestaTexto = await llamarClaude(env, systemPrompt, mensajesClaude, telefono);

    var burbujas = respuestaTexto.split(/\n\s*\n/).map(function (s) { return s.trim(); }).filter(Boolean);
    for (var i = 0; i < burbujas.length; i++) {
      if (i > 0) await esperar(900); // pequeña pausa entre mensajes, se siente más natural que un solo bloque
      await enviarMensajeWhatsApp(env, telefono, burbujas[i]);
    }
    await guardarMensaje(env, telefono, 'agente', respuestaTexto);
  } catch (err) {
    console.log('Error procesando webhook: ' + err.message);
  }
}

function esperar(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

// ═══════════════════════════════════════════════════════════════════════
// CLAUDE — genera la respuesta, con una única herramienta para cerrar
// (registrar el caso en la hoja y obtener el enlace personalizado).
// ═══════════════════════════════════════════════════════════════════════
async function llamarClaude(env, systemPrompt, mensajes, telefono) {
  var tools = [{
    name: 'registrar_caso',
    description: 'Registra o actualiza el caso del cliente en el sistema con los datos que ya dio, y genera el enlace personalizado donde puede ver su resultado y firmar/pagar. Úsala en cuanto tengas al menos su nombre completo y su cédula.',
    input_schema: {
      type: 'object',
      properties: {
        nombres: { type: 'string', description: 'Nombre(s) del cliente' },
        apellidos: { type: 'string', description: 'Apellido(s) del cliente, si los dio' },
        cedula: { type: 'string', description: 'Número de cédula, solo dígitos' },
        ciudad: { type: 'string', description: 'Ciudad donde le pusieron la multa, si la mencionó' },
      },
      required: ['nombres', 'cedula'],
    },
  }];

  var historialCompleto = mensajes.slice();
  var respuestaFinal = await pedirRespuestaClaude(env, systemPrompt, historialCompleto, tools);

  var bloqueHerramienta = (respuestaFinal.content || []).find(function (b) { return b.type === 'tool_use'; });
  if (bloqueHerramienta && bloqueHerramienta.name === 'registrar_caso') {
    var resultadoHerramienta = await registrarCasoEnSheet(env, bloqueHerramienta.input, telefono);

    historialCompleto.push({ role: 'assistant', content: respuestaFinal.content });
    historialCompleto.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: bloqueHerramienta.id, content: JSON.stringify(resultadoHerramienta) }],
    });
    respuestaFinal = await pedirRespuestaClaude(env, systemPrompt, historialCompleto, tools);
  }

  var textos = (respuestaFinal.content || []).filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; });
  return textos.join('\n\n').trim() || 'Dame un segundito, ya te cuento 🙂';
}

async function pedirRespuestaClaude(env, systemPrompt, mensajes, tools) {
  var resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 700,
      system: systemPrompt,
      messages: mensajes,
      tools: tools,
    }),
  });
  var data = await resp.json();
  if (!resp.ok) throw new Error('Claude API error: ' + JSON.stringify(data));
  return data;
}

async function registrarCasoEnSheet(env, datosCliente, telefono) {
  var resp = await fetch(env.SCRIPT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      nombres: datosCliente.nombres || '',
      apellidos: datosCliente.apellidos || '',
      cedula: datosCliente.cedula || '',
      whatsapp: telefono,
      ciudad: datosCliente.ciudad || '',
      fuente: 'Agente IA WhatsApp',
      estadoPago: 'PENDIENTE',
    }),
  });
  var data = await resp.json().catch(function () { return { ok: false }; });
  var enlace = FIRMAR_BASE_URL + '?cedula=' + encodeURIComponent(datosCliente.cedula || '');
  return { ok: data.ok !== false, enlace: enlace };
}

// ═══════════════════════════════════════════════════════════════════════
// TU HOJA DE CÁLCULO (a través del mismo Apps Script de siempre)
// ═══════════════════════════════════════════════════════════════════════
async function buscarCaso(env, telefono) {
  var data = await llamarAppsScript(env, { _accion: 'buscar_caso_telefono', telefono: telefono });
  return data && data.encontrado ? data.caso : { encontrado: false };
}

async function obtenerHistorial(env, telefono) {
  var data = await llamarAppsScript(env, { _accion: 'obtener_historial_ia', telefono: telefono, limite: HISTORIAL_LIMITE });
  return (data && data.mensajes) || [];
}

async function guardarMensaje(env, telefono, rol, mensaje) {
  await llamarAppsScript(env, { _accion: 'guardar_mensaje_ia', telefono: telefono, rol: rol, mensaje: mensaje });
}

async function llamarAppsScript(env, payload) {
  try {
    var resp = await fetch(env.SCRIPT_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return await resp.json();
  } catch (err) {
    console.log('Error llamando Apps Script: ' + err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════
// WHATSAPP CLOUD API
// ═══════════════════════════════════════════════════════════════════════
async function enviarMensajeWhatsApp(env, telefono, texto) {
  await fetch('https://graph.facebook.com/v20.0/' + env.WHATSAPP_PHONE_NUMBER_ID + '/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + env.WHATSAPP_TOKEN,
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: telefono,
      type: 'text',
      text: { body: texto },
    }),
  });
}

// Marca el mensaje como leído y muestra "escribiendo..." un momento antes
// de responder — el detalle que más ayuda a que se sienta como una persona
// real y no una respuesta instantánea de bot.
async function marcarLeidoYEscribiendo(env, mensajeId) {
  try {
    await fetch('https://graph.facebook.com/v20.0/' + env.WHATSAPP_PHONE_NUMBER_ID + '/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + env.WHATSAPP_TOKEN,
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: mensajeId,
        typing_indicator: { type: 'text' },
      }),
    });
  } catch (err) { /* no rompe el flujo si esta llamada falla */ }
}
