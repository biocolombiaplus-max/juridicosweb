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
 * RESPUESTA REAL CONFIRMADA (cédula de prueba con 2 multas reales en cobro
 * coactivo, verificada contra el SIMIT oficial el 24/07/2026):
 *   data.comparendos SIEMPRE viene como [] en este endpoint — los datos
 *   reales están en data.multas, con este esquema por elemento:
 *     {
 *       "estadoCartera": "Cobro coactivo",
 *       "fechaComparendo": "06/12/2021 00:00:00",   // DD/MM/YYYY, con hora
 *       "organismoTransito": "Cucuta",
 *       "placa": "CCM141",
 *       "comparendoElectronico": false,               // true = fotomulta
 *       "numeroComparendo": "54001000000032092975",
 *       "valor": "447555",                             // multa base
 *       "valorPagar": "841539",                         // con intereses/gestión
 *       "infracciones": [{ "descripcionInfraccion": "..." }]
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
 *
 * data.comparendos viene SIEMPRE como [] en este endpoint aunque sí existan
 * multas reales — los datos reales están en data.multas. Por eso NO se puede
 * usar un simple "||" entre ambos (un array vacío es "truthy" en JS y ganaría
 * siempre); se elige explícitamente el primer campo que tenga elementos.
 */
function adaptarRespuestaVerifik(raw) {
  const candidatos = [raw?.data?.multas, raw?.multas, raw?.data?.comparendos, raw?.comparendos];
  let lista = candidatos.find((arr) => Array.isArray(arr) && arr.length > 0);
  if (!lista) lista = candidatos.find((arr) => Array.isArray(arr)) || [];

  const multas = lista.map((m) => {
    const infraccion = Array.isArray(m.infracciones) && m.infracciones[0] ? m.infracciones[0] : null;
    return {
      comparendo: m.numeroComparendo || m['NúmeroComparendo'] || m.NumeroComparendo || m.nroCoactivo || '',
      fecha: normalizarFecha(m.fechaComparendo || m.fechaResolucion),
      valor: Number(m.valor || m.valorPagar || m.total || 0),
      ciudad: m.organismoTransito || m.secretariaComparendo || m.departamento || '',
      estado: m.estadoCartera || m.estadoComparendo || '',
      causalSugerida: (infraccion && infraccion.descripcionInfraccion) || m.descripcionInfraccion || '',
      placa: m.placa || m.placavehiculo || '',
      fotodeteccion: m.comparendoElectronico === true || m.fotodeteccion === true,
    };
  });
  return { success: true, multas };
}

// La fecha real llega como "DD/MM/YYYY HH:mm:ss" (con hora incluida). Algunos
// endpoints de Verifik la entregan como "YYYY/MM/DD" — se detecta por la
// longitud del primer segmento para soportar ambos formatos sin romper.
function normalizarFecha(valor) {
  if (!valor) return '';
  const soloFecha = String(valor).split(' ')[0];
  const partes = soloFecha.split('/');
  if (partes.length === 3) {
    const [a, b, c] = partes;
    if (a.length === 4) return `${a}-${b.padStart(2, '0')}-${c.padStart(2, '0')}`;
    return `${c}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`;
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
