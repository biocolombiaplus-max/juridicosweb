/**
 * Cloudflare Worker — proxy entre juridicosweb.com y un proveedor de datos SIMIT
 * (Verifik o Apitude). El navegador del cliente NUNCA debe tener la llave privada
 * del proveedor — por eso esta llamada pasa por aquí, no directo desde index.html.
 *
 * DESPLIEGUE (una sola vez):
 *   1. Crea una cuenta en https://verifik.co o https://apitude.co y contrata el
 *      servicio de consulta SIMIT (te dan una API key privada).
 *   2. En Cloudflare Dashboard → Workers & Pages → Create Worker, pega este archivo.
 *   3. En el Worker → Settings → Variables, agrega un secreto llamado
 *      PROVIDER_API_KEY con la llave que te dio Verifik/Apitude.
 *   4. Copia la URL que te da Cloudflare (algo como
 *      https://simit-proxy.tu-subdominio.workers.dev) y pégala en index.html,
 *      en la variable SIMIT_PROXY_URL (línea ~1113).
 *
 * IMPORTANTE — lo único que falta ajustar aquí:
 *   No tengo acceso verificado a la documentación exacta de Verifik/Apitude
 *   (sus páginas de docs bloquean la lectura automática). La función
 *   `adaptarRespuestaProveedor()` de abajo tiene la ESTRUCTURA correcta que
 *   espera el frontend, pero los nombres de campo de la respuesta real del
 *   proveedor pueden ser distintos. Cuando tengas tu cuenta:
 *     1. Haz una consulta de prueba en su dashboard/Postman.
 *     2. Pásame (a Claude) la respuesta JSON real de ejemplo.
 *     3. Ajusto `adaptarRespuestaProveedor()` en 5 minutos y listo.
 */

const PROVIDER = 'verifik'; // cambia a 'apitude' si contratas ese en vez de Verifik

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

    if (!env.PROVIDER_API_KEY) {
      return json({ success: false, error: 'PROVIDER_API_KEY no configurada en el Worker' }, 500, cors);
    }

    try {
      const raw = PROVIDER === 'apitude'
        ? await consultarApitude(cedula, placa, env.PROVIDER_API_KEY)
        : await consultarVerifik(cedula, placa, env.PROVIDER_API_KEY);

      const normalizado = adaptarRespuestaProveedor(raw);
      return json(normalizado, 200, cors);
    } catch (err) {
      return json({ success: false, error: String(err) }, 502, cors);
    }
  },
};

// ───────────────────────── Verifik ─────────────────────────
// NOTA: endpoint/headers de ejemplo — confirmar contra la documentación real
// que Verifik entrega al abrir la cuenta (docs.verifik.co, sección SIMIT).
async function consultarVerifik(cedula, placa, apiKey) {
  const endpoint = cedula
    ? `https://api.verifik.co/v2/co/police/simit?documentNumber=${encodeURIComponent(cedula)}&documentType=CC`
    : `https://api.verifik.co/v2/co/police/simit-plate?plate=${encodeURIComponent(placa)}`;

  const res = await fetch(endpoint, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`Verifik respondió ${res.status}`);
  return res.json();
}

// ───────────────────────── Apitude ─────────────────────────
// NOTA: endpoint/headers de ejemplo — confirmar contra la documentación real
// (apitude.co/es/docs/services/simit-co/).
async function consultarApitude(cedula, placa, apiKey) {
  const res = await fetch('https://apitude.co/api/v1.0/requests/simit-co/', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(
      cedula
        ? { documentType: 'CC', documentNumber: cedula }
        : { plate: placa }
    ),
  });
  if (!res.ok) throw new Error(`Apitude respondió ${res.status}`);
  return res.json();
}

/**
 * Convierte la respuesta del proveedor al formato que espera index.html:
 *   { success: true, multas: [ { comparendo, fecha:'YYYY-MM-DD', valor:number,
 *     ciudad, estado }, ... ] }
 * AJUSTAR los nombres de campo (m.xxx) según la respuesta real una vez la tengas.
 */
function adaptarRespuestaProveedor(raw) {
  const lista = raw?.data?.fines || raw?.data || raw?.multas || raw?.result || [];
  if (!Array.isArray(lista)) {
    return { success: false, error: 'Formato de respuesta inesperado del proveedor', raw };
  }
  const multas = lista.map((m) => ({
    comparendo: m.ticketNumber || m.comparendo || m.number || '',
    fecha: normalizarFecha(m.date || m.fecha || m.infractionDate),
    valor: Number(m.value || m.valor || m.amount || 0),
    ciudad: m.entity || m.organismo || m.city || m.ciudad || '',
    estado: m.status || m.estado || '',
  }));
  return { success: true, multas };
}

function normalizarFecha(valor) {
  if (!valor) return '';
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
