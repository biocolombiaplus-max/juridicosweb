/**
 * Apps Script para juridicosweb.com — recibe cada lead/pago/seguimiento desde
 * el sitio (GOOGLE_SHEET_URL en index.html) y desde el panel admin.html, y lo
 * organiza en una sola hoja "📊 Control de Casos" que sirve como CRM completo:
 * quién pagó, quién no (para remarketing), cuándo vence el plazo legal de
 * 15 días hábiles, qué respondió la secretaría, y si toca tutela.
 *
 * INSTALACIÓN:
 *   1. Abre tu Google Sheet de casos → Extensiones → Apps Script.
 *   2. Reemplaza TODO el contenido por este archivo completo.
 *   3. Implementar → Nueva implementación → Tipo: Aplicación web.
 *      - Ejecutar como: Yo (tu cuenta)
 *      - Quién tiene acceso: Cualquier usuario
 *   4. Copia la URL que te da Google y pégala en index.html en
 *      GOOGLE_SHEET_URL, y en admin.html en SCRIPT_URL (debe ser la MISMA
 *      URL en ambos archivos — es un solo backend para todo).
 *   5. La primera vez que llegue un lead, este script crea automáticamente
 *      las hojas "📊 Control de Casos" y "Documentos Firmados" con
 *      encabezados y formato.
 *   6. IMPORTANTE — activa el recordatorio automático de 15 días:
 *      Apps Script → reloj (⏰ Activadores) → + Añadir activador →
 *      Función: revisarRecordatorios15Dias · Origen del evento: Basado en
 *      tiempo · Tipo: Temporizador de días · cada día, entre 7 y 8 a.m.
 *      Sin este paso, los recordatorios y la marca automática de tutela por
 *      falta de respuesta NO se ejecutan — todo lo demás sí funciona igual.
 */

var SHEET_CASOS = '📊 Control de Casos';
var SHEET_FIRMADOS = 'Documentos Firmados';
var CARPETA_DRIVE_FIRMAS = 'JuridicosWeb - Documentos Firmados'; // se crea sola en tu Drive

var VALOR_SALDO_DIFERIDO = 95900; // lo que falta pagar por multa en el Plan Pago al Eliminar
var DIAS_HABILES_RESPUESTA = 15;  // Art. 14 CPACA
var WHATSAPP_DESPACHO = '573159318400';

// Encabezados de la hoja principal, en el orden en que se ven — un solo
// caso (cliente) por fila, se actualiza en el sitio (nunca se duplica).
var COLUMNAS_CASOS = [
  'Fecha', 'Nombres', 'Apellidos', 'Cédula', 'Placa', 'WhatsApp', 'Email',
  'Dirección', 'Ciudad', 'Departamento', 'Plan', 'Multas Seleccionadas',
  'Monto Total', 'Estado de Pago', 'Pago OK', 'Saldo Pendiente',
  'Saldo Pagado', 'Fuente', 'Multas Reportadas', 'Tiene Captura SIMIT',
  'Autorizar', 'Doc Enviado', 'Fecha Radicación', 'Fecha Límite 15d',
  'Respuesta Secretaría', 'Fecha Respuesta', 'Tutela Requerida',
  'Tutela Enviada', 'Recordatorio Enviado', 'Cerrado', 'Notas',
];

var COLUMNAS_FIRMADOS = [
  'Fecha', 'Nombres', 'Apellidos', 'Cédula', 'Email', 'WhatsApp',
  'Secretarías', 'Enlace del archivo en Drive', 'Canal de radicación',
];

function doPost(e) {
  try {
    var datos = JSON.parse(e.postData.contents);
    switch (datos._accion) {
      case 'confirmar_pago':      return actualizarEstadoPago(datos);
      case 'autorizar_documento': return autorizarDocumento(datos);
      case 'marcar_enviado':      return marcarEnviado(datos);
      case 'marcar_respuesta':    return marcarRespuesta(datos);
      case 'marcar_saldo_pagado': return marcarSaldoPagado(datos);
      case 'marcar_tutela_enviada': return marcarTutelaEnviada(datos);
      case 'cerrar_caso':         return cerrarCaso(datos);
      case 'radicar_documento':   return manejarRadicacion(datos);
      case 'enviar_documento_correo': return enviarDocumentoCorreo(datos);
      default:                    return guardarLead(datos);
    }
  } catch (err) {
    return respuestaJson({ ok: false, error: String(err) });
  }
}

// ───────────────────────── crear / actualizar el caso ─────────────────────────

function guardarLead(datos) {
  var hoja = obtenerOCrearHoja(SHEET_CASOS, COLUMNAS_CASOS);
  var fila = buscarFilaPorCedulaOEmail(hoja, datos.cedula, datos.email);
  var esDiferido = /Adelanto/i.test(datos.plan || '');

  // Si ya existe un caso reciente de este cliente (por cédula o correo), lo
  // actualizamos en vez de duplicar — así "Clientes" y "Remarketing" quedan
  // siempre con una sola fila por persona.
  if (fila !== -1) {
    escribirFila(hoja, fila, {
      'Nombres': datos.nombres, 'Apellidos': datos.apellidos, 'Placa': datos.placa,
      'WhatsApp': datos.whatsapp, 'Email': datos.email, 'Dirección': datos.direccion,
      'Ciudad': datos.ciudad, 'Departamento': datos.dpto, 'Plan': datos.plan,
      'Multas Seleccionadas': datos.multasSeleccionadas, 'Monto Total': datos.montoTotal,
      'Estado de Pago': datos.estadoPago || 'PENDIENTE', 'Fuente': datos.fuente,
      'Multas Reportadas': datos.multasReportadas,
      'Tiene Captura SIMIT': datos.capturaSimitBase64 ? 'Sí' : 'No',
    });
    aplicarFormatoCondicional(hoja);
    return respuestaJson({ ok: true, actualizado: true });
  }

  var fila_ = {};
  fila_['Fecha'] = datos.fechaLead || new Date().toLocaleString('es-CO');
  fila_['Nombres'] = datos.nombres || '';
  fila_['Apellidos'] = datos.apellidos || '';
  fila_['Cédula'] = datos.cedula || '';
  fila_['Placa'] = datos.placa || '';
  fila_['WhatsApp'] = datos.whatsapp || '';
  fila_['Email'] = datos.email || '';
  fila_['Dirección'] = datos.direccion || '';
  fila_['Ciudad'] = datos.ciudad || '';
  fila_['Departamento'] = datos.dpto || '';
  fila_['Plan'] = datos.plan || '';
  fila_['Multas Seleccionadas'] = datos.multasSeleccionadas || '';
  fila_['Monto Total'] = datos.montoTotal || '';
  fila_['Estado de Pago'] = datos.estadoPago || 'PENDIENTE';
  fila_['Pago OK'] = 'FALSE';
  fila_['Saldo Pendiente'] = esDiferido ? VALOR_SALDO_DIFERIDO * (Number(datos.multasSeleccionadas) || 1) : '';
  fila_['Saldo Pagado'] = 'FALSE';
  fila_['Fuente'] = datos.fuente || '';
  fila_['Multas Reportadas'] = datos.multasReportadas || '';
  fila_['Tiene Captura SIMIT'] = datos.capturaSimitBase64 ? 'Sí' : 'No';
  fila_['Autorizar'] = 'FALSE';
  fila_['Doc Enviado'] = 'FALSE';
  fila_['Tutela Requerida'] = 'FALSE';
  fila_['Tutela Enviada'] = 'FALSE';
  fila_['Recordatorio Enviado'] = 'FALSE';
  fila_['Cerrado'] = 'FALSE';

  hoja.appendRow(COLUMNAS_CASOS.map(function (c) { return fila_[c] !== undefined ? fila_[c] : ''; }));
  aplicarFormatoCondicional(hoja);
  return respuestaJson({ ok: true });
}

// Pago aprobado (automático desde Wompi, o manual desde el panel) — busca la
// fila del cliente y la actualiza, nunca crea una fila nueva.
function actualizarEstadoPago(datos) {
  var hoja = obtenerOCrearHoja(SHEET_CASOS, COLUMNAS_CASOS);
  var fila = buscarFilaPorCedulaOEmail(hoja, datos.cedula, datos.email);
  if (fila === -1) return respuestaJson({ ok: false, error: 'No se encontró el caso de este cliente' });

  var valores = {};
  valores['Estado de Pago'] = datos.estadoPago || 'PAGADO';
  valores['Pago OK'] = 'TRUE';
  if (datos.montoTotal) valores['Monto Total'] = datos.montoTotal;
  if (datos.plan) valores['Plan'] = datos.plan;

  var plan = datos.plan || obtenerValorFila(hoja, fila, 'Plan');
  if (/Adelanto/i.test(plan || '')) {
    var n = Number(datos.multasSeleccionadas) || Number(obtenerValorFila(hoja, fila, 'Multas Seleccionadas')) || 1;
    valores['Saldo Pendiente'] = VALOR_SALDO_DIFERIDO * n;
  }

  escribirFila(hoja, fila, valores);
  aplicarFormatoCondicional(hoja);
  return respuestaJson({ ok: true });
}

function autorizarDocumento(datos) {
  return actualizarPorCedula(datos, { 'Autorizar': 'TRUE' });
}

// El documento quedó radicado (ante la secretaría) — desde aquí arranca el
// reloj legal de 15 días hábiles (Art. 14 CPACA).
function marcarEnviado(datos) {
  var hoy = new Date();
  var limite = sumarDiasHabiles(hoy, DIAS_HABILES_RESPUESTA);
  return actualizarPorCedula(datos, {
    'Doc Enviado': 'TRUE',
    'Fecha Radicación': Utilities.formatDate(hoy, 'GMT-5', 'yyyy-MM-dd'),
    'Fecha Límite 15d': Utilities.formatDate(limite, 'GMT-5', 'yyyy-MM-dd'),
  });
}

// respuesta: 'positiva' | 'negativa' | 'sin_respuesta'
function marcarRespuesta(datos) {
  var valores = {
    'Respuesta Secretaría': datos.respuesta === 'positiva' ? 'Positiva'
      : datos.respuesta === 'negativa' ? 'Negativa' : 'Sin respuesta',
    'Fecha Respuesta': Utilities.formatDate(new Date(), 'GMT-5', 'yyyy-MM-dd'),
  };
  if (datos.respuesta === 'negativa' || datos.respuesta === 'sin_respuesta') {
    valores['Tutela Requerida'] = 'TRUE';
  }
  return actualizarPorCedula(datos, valores);
}

// El cliente del Plan Pago al Eliminar ya pagó el saldo restante — se
// considera el caso resuelto.
function marcarSaldoPagado(datos) {
  return actualizarPorCedula(datos, { 'Saldo Pagado': 'TRUE', 'Cerrado': 'TRUE' });
}

function marcarTutelaEnviada(datos) {
  return actualizarPorCedula(datos, { 'Tutela Enviada': 'TRUE' });
}

function cerrarCaso(datos) {
  var valores = { 'Cerrado': 'TRUE' };
  if (datos.notas) valores['Notas'] = datos.notas;
  return actualizarPorCedula(datos, valores);
}

function actualizarPorCedula(datos, valores) {
  var hoja = obtenerOCrearHoja(SHEET_CASOS, COLUMNAS_CASOS);
  var fila = buscarFilaPorCedulaOEmail(hoja, datos.cedula, datos.email);
  if (fila === -1) return respuestaJson({ ok: false, error: 'No se encontró el caso de este cliente' });
  escribirFila(hoja, fila, valores);
  aplicarFormatoCondicional(hoja);
  return respuestaJson({ ok: true });
}

// Guarda el PDF/foto firmado en Drive (no en la hoja, para no volverla
// pesada) y además marca el caso como radicado — arranca el plazo de 15 días
// automáticamente, sin que el admin tenga que hacer nada más.
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

  var hojaFirmados = obtenerOCrearHoja(SHEET_FIRMADOS, COLUMNAS_FIRMADOS);
  hojaFirmados.appendRow([
    new Date().toLocaleString('es-CO'), datos.nombres || '', datos.apellidos || '',
    datos.cedula || '', datos.email || '', datos.whatsapp || '',
    (datos.secretarias || []).join(', '), enlace, 'Por radicar',
  ]);

  marcarEnviado(datos); // arranca el plazo de 15 días en el caso principal
  return respuestaJson({ ok: true, enlaceArchivo: enlace });
}

// Envía el PDF del Derecho de Petición como archivo adjunto real al correo
// del cliente, apenas se confirma el pago — no depende de ningún servicio
// externo de terceros, usa el correo de Google directamente.
function enviarDocumentoCorreo(datos) {
  if (!datos.email || !datos.archivoBase64) {
    return respuestaJson({ ok: false, error: 'Falta email o archivo del documento' });
  }
  try {
    var partes = datos.archivoBase64.split(',');
    var mime = (partes[0].match(/data:(.*);base64/) || [])[1] || 'application/pdf';
    var bytes = Utilities.base64Decode(partes[1] || partes[0]);
    var nombreArchivo = datos.archivoNombre || 'DerechoPeticion.pdf';
    var blob = Utilities.newBlob(bytes, mime, nombreArchivo);

    var asunto = '📄 Tu Derecho de Petición está listo — JurídicosWeb';
    var cuerpo =
      'Hola ' + (datos.nombres || '') + ',\n\n' +
      '¡Gracias por confiar en JurídicosWeb! Adjunto a este correo encontrarás tu Derecho de Petición, listo para radicar.\n\n' +
      (datos.firmado
        ? 'Ya quedó firmado digitalmente — puedes radicarlo directamente.\n\n'
        : 'Fírmalo (a mano o desde la página) antes de radicarlo.\n\n') +
      'Cualquier duda, escríbenos por WhatsApp al +' + WHATSAPP_DESPACHO + '.\n\n' +
      'JurídicosWeb.com — Bufete Experto en Derecho de Tránsito';

    MailApp.sendEmail({ to: datos.email, subject: asunto, body: cuerpo, attachments: [blob] });
    return respuestaJson({ ok: true });
  } catch (err) {
    return respuestaJson({ ok: false, error: String(err) });
  }
}

// ───────────────────────── recordatorio automático (Activador diario) ─────

// Revisa todos los casos radicados sin respuesta: al llegar la fecha límite
// le recuerda por correo al CLIENTE que revise si ya llegó la respuesta, y un
// día después de vencido el plazo sin respuesta registrada, marca la tutela
// como requerida automáticamente (igual que si respondieran negativo).
function revisarRecordatorios15Dias() {
  var hoja = obtenerOCrearHoja(SHEET_CASOS, COLUMNAS_CASOS);
  var valores = hoja.getDataRange().getValues();
  var idx = {};
  COLUMNAS_CASOS.forEach(function (c, i) { idx[c] = i; });
  var hoy = new Date(); hoy.setHours(0, 0, 0, 0);

  for (var i = 1; i < valores.length; i++) {
    var fila = valores[i];
    var docEnviado = fila[idx['Doc Enviado']] === 'TRUE' || fila[idx['Doc Enviado']] === true;
    var cerrado = fila[idx['Cerrado']] === 'TRUE' || fila[idx['Cerrado']] === true;
    var respuesta = fila[idx['Respuesta Secretaría']];
    var limiteRaw = fila[idx['Fecha Límite 15d']];
    if (!docEnviado || cerrado || respuesta || !limiteRaw) continue;

    var limite = new Date(limiteRaw); limite.setHours(0, 0, 0, 0);
    var recordatorioEnviado = fila[idx['Recordatorio Enviado']] === 'TRUE' || fila[idx['Recordatorio Enviado']] === true;
    var email = fila[idx['Email']];
    var nombres = fila[idx['Nombres']];

    if (!recordatorioEnviado && hoy.getTime() >= limite.getTime() && email) {
      enviarRecordatorioCliente(email, nombres);
      hoja.getRange(i + 1, idx['Recordatorio Enviado'] + 1).setValue('TRUE');
    }

    var unDiaDespues = new Date(limite); unDiaDespues.setDate(unDiaDespues.getDate() + 1);
    if (hoy.getTime() >= unDiaDespues.getTime()) {
      hoja.getRange(i + 1, idx['Respuesta Secretaría'] + 1).setValue('Sin respuesta (automático)');
      hoja.getRange(i + 1, idx['Fecha Respuesta'] + 1).setValue(Utilities.formatDate(hoy, 'GMT-5', 'yyyy-MM-dd'));
      hoja.getRange(i + 1, idx['Tutela Requerida'] + 1).setValue('TRUE');
    }
  }
  aplicarFormatoCondicional(hoja);
}

function enviarRecordatorioCliente(email, nombres) {
  var asunto = 'Ya se cumplieron los 15 días hábiles — revisa tu respuesta';
  var cuerpo =
    'Hola ' + (nombres || '') + ',\n\n' +
    'Ya se cumplió el plazo legal de 15 días hábiles (Art. 14 CPACA) desde que radicamos tu Derecho de Petición.\n\n' +
    'Por favor revisa tu correo (incluida la carpeta de spam) y el SIMIT para ver si la secretaría ya respondió.\n\n' +
    'Escríbenos por WhatsApp al +' + WHATSAPP_DESPACHO + ' contándonos qué pasó:\n' +
    '• Si respondieron a FAVOR: perfecto, seguimos con la eliminación.\n' +
    '• Si respondieron en CONTRA o no respondieron: procede una Acción de Tutela y ya podemos iniciarla.\n\n' +
    'JurídicosWeb.com — Bufete Experto en Derecho de Tránsito';
  try { MailApp.sendEmail(email, asunto, cuerpo); } catch (e) { /* cuota de correo agotada u otro error — no rompe el resto del chequeo */ }
}

// Suma N días HÁBILES (lunes a viernes) a una fecha. No descuenta festivos
// colombianos — si un festivo cae en el rango, ajusta la fecha límite a mano
// en la hoja si hace falta.
function sumarDiasHabiles(fechaInicio, dias) {
  var fecha = new Date(fechaInicio);
  var contados = 0;
  while (contados < dias) {
    fecha.setDate(fecha.getDate() + 1);
    var dow = fecha.getDay();
    if (dow !== 0 && dow !== 6) contados++;
  }
  return fecha;
}

// ───────────────────────── utilidades de hoja ─────────────────────────

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

// Devuelve el número de fila (1-based, incluye encabezado) de la ÚLTIMA
// coincidencia por cédula (o por email si no hay cédula), o -1 si no existe.
function buscarFilaPorCedulaOEmail(hoja, cedula, email) {
  var valores = hoja.getDataRange().getValues();
  var colCedula = COLUMNAS_CASOS.indexOf('Cédula');
  var colEmail = COLUMNAS_CASOS.indexOf('Email');
  for (var i = valores.length - 1; i >= 1; i--) {
    if (cedula && valores[i][colCedula] && String(valores[i][colCedula]) === String(cedula)) return i + 1;
  }
  for (var j = valores.length - 1; j >= 1; j--) {
    if (email && valores[j][colEmail] && String(valores[j][colEmail]).toLowerCase() === String(email).toLowerCase()) return j + 1;
  }
  return -1;
}

function obtenerValorFila(hoja, filaNum, columna) {
  var col = COLUMNAS_CASOS.indexOf(columna);
  if (col === -1) return '';
  return hoja.getRange(filaNum, col + 1).getValue();
}

// Escribe varias columnas de una fila de una sola vez (valores = {Columna: valor}).
function escribirFila(hoja, filaNum, valores) {
  Object.keys(valores).forEach(function (nombreCol) {
    var col = COLUMNAS_CASOS.indexOf(nombreCol);
    if (col === -1 || valores[nombreCol] === undefined) return;
    hoja.getRange(filaNum, col + 1).setValue(valores[nombreCol]);
  });
}

// Verde = pagado, amarillo = pendiente, morado = tutela — para ver de un
// vistazo el embudo de ventas.
function aplicarFormatoCondicional(hoja) {
  var ultimaFila = Math.max(hoja.getLastRow() - 1, 1);
  var colEstado = COLUMNAS_CASOS.indexOf('Estado de Pago') + 1;
  var colTutela = COLUMNAS_CASOS.indexOf('Tutela Requerida') + 1;
  var colCerrado = COLUMNAS_CASOS.indexOf('Cerrado') + 1;
  var rangoEstado = hoja.getRange(2, colEstado, ultimaFila, 1);
  var rangoTutela = hoja.getRange(2, colTutela, ultimaFila, 1);
  var rangoCerrado = hoja.getRange(2, colCerrado, ultimaFila, 1);
  var reglas = [
    SpreadsheetApp.newConditionalFormatRule().whenTextContains('PAGADO')
      .setBackground('#dcfce7').setFontColor('#166534').setRanges([rangoEstado]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextContains('PENDIENTE')
      .setBackground('#fef9c3').setFontColor('#854d0e').setRanges([rangoEstado]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('TRUE')
      .setBackground('#ede9fe').setFontColor('#5b21b6').setRanges([rangoTutela]).build(),
    SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo('TRUE')
      .setBackground('#f0fdf4').setFontColor('#166534').setRanges([rangoCerrado]).build(),
  ];
  hoja.setConditionalFormatRules(reglas);
}

function respuestaJson(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
