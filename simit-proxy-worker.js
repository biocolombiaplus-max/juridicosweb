/**
 * Cloudflare Worker — proxy entre juridicosweb.com y Verifik.co (proveedor de
 * datos SIMIT) para consultas de comparendos por CÉDULA. El navegador del
 * cliente NUNCA debe tener el token privado de Verifik — por eso esta llamada
 * pasa por aquí, no directo desde index.html.
 *
 * DESPLIEGUE (una sola vez):
 *   1. En Cloudflare Dashboard → Workers & Pages → Create Worker, pega este
 *      archivo completo.
 *   2. En el Worker → Settings → Variables and Secrets, agrega un secreto
 *      llamado VERIFIK_TOKEN con el Bearer token que te dio Verifik
 *      (ai.verifik.co → tu perfil / API Keys).
 *   3. Copia la URL que te da Cloudflare (algo como
 *      https://simit-proxy.tu-subdominio.workers.dev) y pégala en index.html,
 *      en la variable SIMIT_PROXY_URL (línea ~1113).
 *
 * ENDPOINT (ai.verifik.co/postman?code=colombia_api_simit_complete →
 * "SIMIT - Consulta General por Documento de Identificación"):
 *   GET https://api.verifik.co/v2/co/simit/consultar
 *   Headers: Accept: application/json, Authorization: Bearer <token>
 *   Params:  documentType (CC|CE|PA|RC|TI), documentNumber, includeCosts (true)
 *   Costo:   0.4 créditos por consulta
 *
 *   Nota: el 401 inicial en este endpoint era un problema puntual de
 *   cuenta en Verifik, ya confirmado y resuelto por su soporte.
 *
 *   Respuesta esperada:
 *     {
 *       "data": {
 *         "comparendos": [
 *           {
 *             "tipovehiculo": "AUTOMOVIL",
 *             "estadoComparendo": "Pendiente",
 *             "fechaComparendo": "2016/02/23",
 *             "fotodeteccion": false,
 *             "NúmeroComparendo": "25612001000152646662173",
 *             "placavehiculo": "AAA123",
 *             "secretariaComparendo": "Ricaurte",
 *             "total": 344730,
 *             "idOrganismoTransito": "25612123",
 *             "codigoInfraccion": "C35",
 *             "descripcionInfraccion": "No realizar la revisión técnico-mecánica...",
 *             "direccionComparendo": "CARRERA 9 CON CALLE 10 AGUA DE DIOS",
 *             "infractorComparendo": "CAR BER",
 *             "serviciovehiculo": "Particular"
 *           }
 *         ]
 *       },
 *       "signature": { "message": "Certified by Verifik.co", "dateTime": "..." }
 *     }
 *
 * IMPORTANTE: este endpoint solo acepta DOCUMENTO (cédula, CE, pasaporte,
 * tarjeta de identidad, registro civil) — NO acepta placa. Por eso, si el
 * frontend pide una consulta por placa, este Worker responde de inmediato
 * con success:false (sin gastar créditos) para que la app caiga al flujo
 * manual gratuito que ya existe. Cuando confirmes un endpoint real por placa,
 * se agrega aquí mismo.
 */

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': 'https://juridicosweb.com',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: cors });
    }

    const url = new URL(request.url);
    const cedula = url.searchParams.get('cedula');
    const placa = url.searchParams.get('placa');

    if (!cedula && !placa) {
      return json({ success: false, error: 'Falta cedula o placa' }, 400, cors);
    }

    // El endpoint confirmado solo funciona por documento. Placa cae al
    // flujo manual sin consumir créditos ni llamar a la API.
    if (!cedula) {
      return json({ success: false, error: 'Este proveedor solo consulta por cédula' }, 200, cors);
    }

    if (!env.VERIFIK_TOKEN) {
      return json({ success: false, error: 'VERIFIK_TOKEN no configurado en el Worker' }, 500, cors);
    }

    // Al copiar/pegar el token en el dashboard de Cloudflare a veces se cuela
    // un espacio, salto de línea o carácter invisible — eso rompe el header
    // Authorization (solo acepta ASCII) y hace fallar la consulta real. Se
    // limpia aquí para que el Worker no dependa de que el copy-paste sea
    // perfecto.
    const token = limpiarToken(env.VERIFIK_TOKEN);

    // Mientras la cuenta de Verifik esté en modo sandbox, sus resultados son
    // simulados (normalmente "sin comparendos"). Mostrar eso como una consulta
    // real sería engañoso, así que devolvemos success:false para que la app
    // caiga al flujo manual honesto. En cuanto reemplaces este secreto por el
    // token de Producción de Verifik, esto se activa solo — sin más cambios.
    if (esTokenSandbox(token)) {
      return json({ success: false, error: 'Verifik está en modo sandbox (verificación de identidad pendiente)' }, 200, cors);
    }

    try {
      const raw = await consultarVerifik(cedula, token);
      const normalizado = adaptarRespuestaVerifik(raw);
      return json(normalizado, 200, cors);
    } catch (err) {
      return json({ success: false, error: String(err) }, 502, cors);
    }
  },
};

// Un JWT válido solo contiene ASCII imprimible (base64url + puntos). Cualquier
// otra cosa (espacios, saltos de línea, comillas "curvas" pegadas por error)
// se descarta.
function limpiarToken(token) {
  return String(token).replace(/[^\x21-\x7E]/g, '');
}

// El JWT de Verifik incluye "mode":"sandbox" o "mode":"production" en su
// payload — lo leemos sin librerías externas (decodificación base64url nativa
// de Workers) para saber si los resultados son simulados o reales.
function esTokenSandbox(token) {
  try {
    const payload = token.split('.')[1];
    const normalizado = payload.replace(/-/g, '+').replace(/_/g, '/');
    const datos = JSON.parse(atob(normalizado));
    return datos.mode === 'sandbox';
  } catch (err) {
    return false;
  }
}

async function consultarVerifik(cedula, token) {
  const endpoint = `https://api.verifik.co/v2/co/simit/consultar?documentType=CC&documentNumber=${encodeURIComponent(cedula)}&includeCosts=true`;
  const res = await fetch(endpoint, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
    },
  });
  // 404 de Verifik = no tiene comparendos registrados (no es un error real)
  if (res.status === 404) return { data: { comparendos: [] } };
  if (!res.ok) throw new Error(`Verifik respondió ${res.status}`);
  return res.json();
}

/**
 * Convierte la respuesta real de Verifik al formato que espera index.html:
 *   { success: true, multas: [ { comparendo, fecha:'YYYY-MM-DD', valor:number,
 *     ciudad, estado }, ... ] }
 * Se busca la lista de comparendos en las rutas donde Verifik suele anidarla
 * (puede variar entre endpoints/versiones), para no romper si el nombre exacto
 * del campo cambia.
 */
function adaptarRespuestaVerifik(raw) {
  const lista = raw?.data?.comparendos || raw?.comparendos || raw?.data?.multas || raw?.multas || [];
  if (!Array.isArray(lista)) {
    return { success: false, error: 'Formato de respuesta inesperado de Verifik', raw };
  }
  const multas = lista.map((m) => ({
    comparendo: m['NúmeroComparendo'] || m.NumeroComparendo || '',
    fecha: normalizarFecha(m.fechaComparendo),
    valor: Number(m.total || 0),
    ciudad: m.secretariaComparendo || '',
    estado: m.estadoComparendo || '',
    causalSugerida: m.descripcionInfraccion || '',
    placa: m.placavehiculo || '',
    fotodeteccion: m.fotodeteccion === true,
  }));
  return { success: true, multas };
}

// Verifik entrega la fecha como "YYYY/MM/DD" (con barras) — la normalizamos a
// "YYYY-MM-DD" para que coincida con lo que espera el resto de la app.
function normalizarFecha(valor) {
  if (!valor) return '';
  const partes = String(valor).split('/');
  if (partes.length === 3) {
    const [y, m, d] = partes;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const d = new Date(valor);
  if (isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}
