/**
 * Apps Script para juridicosweb.com — recibe cada lead/pago desde el sitio
 * (GUARDAR_LEAD_URL y RADICAR_UPLOAD_URL en index.html) y lo organiza en una
 * hoja de Google Sheets lista para marketing/remarketing (Mailchimp, Brevo,
 * WhatsApp Business, etc.)
 *
 * INSTALACIÓN:
 *   1. Abre tu Google Sheet de leads → Extensiones → Apps Script.
 *   2. Reemplaza el contenido por este archivo completo (o copia solo las
 *      funciones que te falten si ya tienes código allí).
 *   3. Implementar → Nueva implementación → Tipo: Aplicación web.
 *      - Ejecutar como: Yo (tu cuenta)
 *      - Quién tiene acceso: Cualquier usuario
 *   4. Copia la URL que te da Google y pégala en index.html en
 *      GOOGLE_SHEET_URL / GUARDAR_LEAD_URL y en RADICAR_UPLOAD_URL
 *      (puede ser la misma URL para ambas, este script distingue por
 *      el campo "_accion" que ya envía el sitio).
 *   5. La primera vez que llegue un lead, este script crea automáticamente
 *      las hojas "Leads" y "Documentos Firmados" con encabezados y formato.
 */

var SHEET_LEADS = 'Leads';
var SHEET_FIRMADOS = 'Documentos Firmados';
var CARPETA_DRIVE_FIRMAS = 'JuridicosWeb - Documentos Firmados'; // se crea sola en tu Drive

// Encabezados en el orden en que se ven en la hoja — los primeros 6 son los
// que más se usan para marketing/remarketing (exportables a CSV directo).
var COLUMNAS_LEADS = [
  'Fecha', 'Nombres', 'Apellidos', 'Email', 'WhatsApp', 'Ciudad',
  'Departamento', 'Cédula', 'Placa', 'Plan', 'Multas Seleccionadas',
  'Monto Total', 'Estado de Pago', 'Fuente', 'Dirección',
  'Multas Reportadas (detalle)', 'Tiene Captura SIMIT'
];

var COLUMNAS_FIRMADOS = [
  'Fecha', 'Nombres', 'Apellidos', 'Cédula', 'Email', 'WhatsApp',
  'Secretarías', 'Enlace del archivo en Drive', 'Canal de radicación'
];

function doPost(e) {
  try {
    var datos = JSON.parse(e.postData.contents);

    if (datos._accion === 'radicar_documento') {
      return manejarRadicacion(datos);
    }
    if (datos._accion === 'confirmar_pago') {
      return actualizarEstadoPago(datos);
    }
    return guardarLead(datos);
  } catch (err) {
    return respuestaJson({ ok: false, error: String(err) });
  }
}

function guardarLead(datos) {
  var hoja = obtenerOCrearHoja(SHEET_LEADS, COLUMNAS_LEADS);
  hoja.appendRow([
    datos.fechaLead || new Date().toLocaleString('es-CO'),
    datos.nombres || '',
    datos.apellidos || '',
    datos.email || '',
    datos.whatsapp || '',
    datos.ciudad || '',
    datos.dpto || '',
    datos.cedula || '',
    datos.placa || '',
    datos.plan || '',
    datos.multasSeleccionadas || '',
    datos.montoTotal || '',
    datos.estadoPago || 'PENDIENTE',
    datos.fuente || '',
    datos.direccion || '',
    datos.multasReportadas || '',
    datos.capturaSimitBase64 ? 'Sí' : 'No',
  ]);
  aplicarFormatoCondicional(hoja);
  return respuestaJson({ ok: true });
}

// Cuando el cliente ya pagó (Wompi aprobado, o confirmación manual de Nequi),
// buscamos su última fila por cédula/email y actualizamos el estado en vez de
// duplicar la fila — así la hoja queda limpia para remarketing.
function actualizarEstadoPago(datos) {
  var hoja = obtenerOCrearHoja(SHEET_LEADS, COLUMNAS_LEADS);
  var valores = hoja.getDataRange().getValues();
  var colCedula = COLUMNAS_LEADS.indexOf('Cédula');
  var colEstado = COLUMNAS_LEADS.indexOf('Estado de Pago');
  for (var i = valores.length - 1; i >= 1; i--) {
    if (valores[i][colCedula] === datos.cedula) {
      hoja.getRange(i + 1, colEstado + 1).setValue(datos.estadoPago || 'PAGADO');
      break;
    }
  }
  aplicarFormatoCondicional(hoja);
  return respuestaJson({ ok: true });
}

// Guarda el PDF/foto firmado en Drive (no en la hoja, para no volverla pesada)
// y deja el enlace + los datos del trámite en la hoja "Documentos Firmados".
function manejarRadicacion(datos) {
  var enlace = '';
  if (datos.archivoBase64 && datos.archivoNombre) {
    var carpeta = obtenerOCrearCarpeta(CARPETA_DRIVE_FIRMAS);
    var partes = datos.archivoBase64.split(',');
    var mime = (partes[0].match(/data:(.*);base64/) || [])[1] || 'application/pdf';
    var bytes = Utilities.base64Decode(partes[1] || partes[0]);
    var archivo = carpeta.createFile(Utilities.newBlob(bytes, mime, datos.archivoNombre));
    enlace = archivo.getUrl();
  }

  var hoja = obtenerOCrearHoja(SHEET_FIRMADOS, COLUMNAS_FIRMADOS);
  hoja.appendRow([
    new Date().toLocaleString('es-CO'),
    datos.nombres || '',
    datos.apellidos || '',
    datos.cedula || '',
    datos.email || '',
    datos.whatsapp || '',
    (datos.secretarias || []).join(', '),
    enlace,
    'Por radicar',
  ]);
  return respuestaJson({ ok: true, enlaceArchivo: enlace });
}

// ───────────────────────── utilidades ─────────────────────────
function obtenerOCrearHoja(nombre, columnas) {
  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = libro.getSheetByName(nombre);
  if (!hoja) {
    hoja = libro.insertSheet(nombre);
    hoja.appendRow(columnas);
    var encabezado = hoja.getRange(1, 1, 1, columnas.length);
    encabezado.setFontWeight('bold').setBackground('#0a1628').setFontColor('#ffffff');
    hoja.setFrozenRows(1);
    hoja.autoResizeColumns(1, columnas.length);
  }
  return hoja;
}

function obtenerOCrearCarpeta(nombre) {
  var carpetas = DriveApp.getFoldersByName(nombre);
  return carpetas.hasNext() ? carpetas.next() : DriveApp.createFolder(nombre);
}

// Verde = pagado, amarillo = pendiente — para ver de un vistazo el embudo de ventas.
function aplicarFormatoCondicional(hoja) {
  var colEstado = COLUMNAS_LEADS.indexOf('Estado de Pago') + 1;
  var rango = hoja.getRange(2, colEstado, Math.max(hoja.getLastRow() - 1, 1), 1);
  var reglas = [
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextContains('PAGADO')
      .setBackground('#dcfce7').setFontColor('#166534')
      .setRanges([rango]).build(),
    SpreadsheetApp.newConditionalFormatRule()
      .whenTextContains('PENDIENTE')
      .setBackground('#fef9c3').setFontColor('#854d0e')
      .setRanges([rango]).build(),
  ];
  hoja.setConditionalFormatRules(reglas);
}

function respuestaJson(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
