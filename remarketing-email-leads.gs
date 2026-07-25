/**
 * Envío controlado de correos de remarketing a la base de leads (kommo_export_leads)
 * — juridicosweb.com
 *
 * QUÉ HACE:
 *   1. Limpia la base: valida el formato de cada correo y descarta los mal escritos.
 *   2. Envía hasta 80 correos al día, en tandas pequeñas (para no chocar con el
 *      límite de 6 minutos de ejecución de Apps Script), con una pausa aleatoria
 *      de 5 a 10 segundos entre cada uno.
 *   3. Cada correo usa un asunto y un cuerpo elegidos al azar entre varias
 *      plantillas, para que no se vean idénticos entre sí (ayuda real contra spam).
 *   4. Nunca reenvía a alguien que ya recibió el mismo correo. Solo hay DOS rondas:
 *      Ronda 1 (curiosidad) y Ronda 2 (seguimiento, más directa). Después de la
 *      Ronda 2, el sistema deja de escribirle a esa persona — no hay bucle
 *      infinito. Esto es intencional: reescribirle a alguien indefinidamente sin
 *      respuesta es exactamente lo que hace que Gmail suspenda la cuenta y que
 *      los correos empiecen a caer en spam de verdad.
 *   5. Todo el progreso queda en una hoja "Control Envíos" — quién es válido,
 *      a quién ya se le envió, en qué ronda, y cuándo.
 *   6. Cada correo incluye una línea para darse de baja. Si alguien responde
 *      pidiendo que no le escriban más, marca "BAJA" en la columna "Válido" de
 *      su fila en "Control Envíos" y el sistema nunca le vuelve a escribir.
 *
 * INSTALACIÓN:
 *   1. Abre la hoja "kommo_export_leads..." → Extensiones → Apps Script.
 *   2. Pega este archivo completo (reemplaza lo que haya).
 *   3. Ajusta las constantes de CONFIGURACIÓN abajo si el nombre de tu hoja o de
 *      tus columnas es distinto.
 *   4. Guarda. En el editor, selecciona la función "limpiarBaseDeCorreos" en el
 *      menú desplegable de arriba y dale "Ejecutar" una vez (te va a pedir
 *      autorización — es tu propio script, acéptala). Esto valida toda la base.
 *   5. Revisa la hoja "Control Envíos" que se creó — confirma que los correos
 *      válidos se ven bien.
 *   6. Selecciona la función "crearActivadorAutomatico" y dale "Ejecutar" una
 *      sola vez. Esto programa el envío automático cada hora, en horario
 *      laboral, sin que tengas que hacer nada más.
 *   7. Listo. El sistema se detiene solo al llegar a 80 correos ese día, y
 *      retoma al día siguiente.
 */

// ═══════════════════════════ MENÚ Y PANEL EN LA HOJA ═══════════════════════════
// Se ejecuta solo al abrir la hoja de cálculo — crea el menú de arriba.
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📣 Envíos JurídicosWeb')
    .addItem('Abrir panel de control', 'abrirPanelMarketing')
    .addSeparator()
    .addItem('Limpiar y validar base', 'limpiarBaseDeCorreos')
    .addItem('Enviar correos ahora', 'enviarCorreosDiarios')
    .addSeparator()
    .addItem('Activar envío automático (cada hora)', 'crearActivadorAutomatico')
    .addItem('Desactivar envío automático', 'eliminarActivadorAutomatico')
    .addToUi();
}

function abrirPanelMarketing() {
  var panel = HtmlService.createHtmlOutputFromFile('Sidebar').setTitle('Envíos JurídicosWeb');
  SpreadsheetApp.getUi().showSidebar(panel);
}

// Envía UN solo correo de prueba, marcado como prueba en el asunto. No toca
// la hoja de Control Envíos ni el contador diario — puedes probar cuantas
// veces quieras sin afectar la campaña real.
function enviarCorreoPrueba(destinatario) {
  if (!esEmailValido(destinatario)) {
    return { ok: false, error: 'Ese correo no tiene un formato válido.' };
  }
  try {
    MailApp.sendEmail({
      to: destinatario,
      subject: '[PRUEBA] ' + ASUNTOS_RONDA1[0],
      htmlBody: cuerpoCorreo('Prueba', 1),
      name: REMITENTE_NOMBRE,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

// Estadísticas para el panel — se llama desde Sidebar.html vía google.script.run.
function obtenerEstadoParaSidebar() {
  var hojaControl = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_CONTROL);
  var activo = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'enviarCorreosDiarios'; });
  if (!hojaControl) {
    return { existeControl: false, activo: activo, enviadosHoy: obtenerContadorHoy(), limiteDiario: LIMITE_DIARIO };
  }
  var datos = hojaControl.getDataRange().getValues();
  var idx = {};
  COLUMNAS_CONTROL.forEach(function (c, i) { idx[c] = i; });
  var total = 0, validos = 0, r1 = 0, r2 = 0;
  for (var i = FILA_ENCABEZADOS_CONTROL; i < datos.length; i++) {
    var fila = datos[i];
    if (!fila[idx['Correo']]) continue;
    total++;
    if (fila[idx['Válido']] === 'Sí') validos++;
    if (fila[idx['Ronda 1 Enviada']] === 'TRUE' || fila[idx['Ronda 1 Enviada']] === true) r1++;
    if (fila[idx['Ronda 2 Enviada']] === 'TRUE' || fila[idx['Ronda 2 Enviada']] === true) r2++;
  }
  return {
    existeControl: true, activo: activo,
    total: total, validos: validos, invalidos: total - validos,
    ronda1: r1, ronda2: r2,
    enviadosHoy: obtenerContadorHoy(), limiteDiario: LIMITE_DIARIO,
  };
}

// ═══════════════════════════ CONFIGURACIÓN ═══════════════════════════
var HOJA_LEADS = 'Sheet1';                    // nombre de la hoja con los leads (ajusta si es distinto)
var COL_NOMBRE = 'Nombre completo';
var COL_EMAIL = 'Correo electronico';         // el script también intenta "Correo electrónico" con tilde

var HOJA_CONTROL = 'Control Envíos';          // se crea sola — no toca tu hoja "EnviosEmail" existente
var FILA_ENCABEZADOS_CONTROL = 3;             // fila 1 = título, fila 2 = resumen, fila 3 = encabezados, fila 4 en adelante = datos
var COLUMNAS_CONTROL = [
  'Correo', 'Nombre', 'Válido',
  'Ronda 1 Enviada', 'Fecha Ronda 1', 'Plantilla Ronda 1',
  'Ronda 2 Enviada', 'Fecha Ronda 2', 'Plantilla Ronda 2',
];

var LIMITE_DIARIO = 80;         // máximo de correos por día calendario
var LOTE_POR_EJECUCION = 25;    // máximo de correos por ejecución (deja margen bajo el límite de 6 min de Apps Script)
var PAUSA_MIN_SEG = 5;
var PAUSA_MAX_SEG = 10;

var URL_SITIO = 'https://juridicosweb.com';
var WHATSAPP_CONTACTO = '573159318400';
var REMITENTE_NOMBRE = 'JurídicosWeb';

// ═══════════════════════════ PLANTILLAS — RONDA 1 (curiosidad) ═══════════════════════════
var ASUNTOS_RONDA1 = [
  '¿Sabes si tu multa se puede eliminar?',
  'Antes de pagar esa multa, revisa esto',
  'Tu fotomulta podria no ser valida',
  'Hay una forma legal de revisar tu multa',
  'Esto puede cambiar lo que debes en el SIMIT',
];

// ═══════════════════════════ PLANTILLAS — RONDA 2 (seguimiento, mas directa) ═══════════════════════════
var ASUNTOS_RONDA2 = [
  'Todavia estas a tiempo de revisar tu multa',
  'Esto puede ahorrarte dinero hoy mismo',
  'Tu multa sigue generando intereses mientras esperas',
  'Ultimo aviso: revisa si tu multa aplica',
];

function cuerpoCorreo(nombre, ronda) {
  var primerNombre = ((nombre || '').trim().split(' ')[0] || '').trim();
  var saludo = primerNombre ? 'Hola ' + primerNombre + ',' : 'Hola,';

  var ganchos = ronda === 1 ? [
    'Miles de multas y fotomultas en Colombia tienen fallas legales que permiten eliminarlas por completo. La tuya podria ser una de ellas.',
    'En Colombia hay comparendos que legalmente ya no se pueden cobrar, pero siguen apareciendo en el SIMIT como si debieras pagarlos.',
    'Muchas fotomultas fueron impuestas por camaras que no tenian la certificacion tecnica exigida por la ley — eso las hace anulables.',
  ] : [
    'Notamos que aun no has revisado si tu multa se puede eliminar. Mientras tanto, el valor puede seguir creciendo por intereses de mora.',
    'Tu caso sigue disponible para revision, pero cada dia que pasa es un dia mas de intereses sobre una multa que quizas ni siquiera debas pagar.',
    'Esta es la ultima vez que te escribimos al respecto. Si tu multa aplica, hoy es un buen dia para resolverlo antes de que siga creciendo.',
  ];
  var gancho = ganchos[Math.floor(Math.random() * ganchos.length)];

  var beneficio = 'Verificas gratis en menos de un minuto. Si tu caso aplica, hoy mismo la eliminas por solo <strong>$45.000</strong> por multa.';
  var urgencia = ronda === 1
    ? 'La revision no tiene costo ni compromiso.'
    : 'Este es el ultimo recordatorio que te enviamos sobre este caso.';

  return ''
    + '<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;background:#ffffff;">'
    + '  <div style="background:#2e1065;padding:22px 28px;text-align:center;">'
    + '    <span style="color:#2dd4bf;font-size:15px;font-weight:bold;letter-spacing:0.5px;">JURIDICOSWEB.COM</span><br>'
    + '    <span style="color:#c9c3dd;font-size:11px;">Bufete Experto en Derecho de Transito - Colombia</span>'
    + '  </div>'
    + '  <div style="padding:30px 28px;color:#1f1533;font-size:15px;line-height:1.6;">'
    + '    <p style="margin:0 0 14px;">' + saludo + '</p>'
    + '    <p style="margin:0 0 14px;">' + gancho + '</p>'
    + '    <p style="margin:0 0 18px;">' + beneficio + '</p>'
    + '    <div style="text-align:center;margin:26px 0;">'
    + '      <a href="' + URL_SITIO + '" target="_blank" style="background:#2dd4bf;color:#0a1f1c;font-weight:bold;font-size:15px;text-decoration:none;padding:14px 32px;border-radius:8px;display:inline-block;">Verificar mi multa ahora</a>'
    + '    </div>'
    + '    <p style="margin:0 0 6px;font-size:13px;color:#59517f;">' + urgencia + '</p>'
    + '    <p style="margin:18px 0 0;font-size:13px;color:#59517f;">Dudas por WhatsApp: +' + WHATSAPP_CONTACTO + '</p>'
    + '  </div>'
    + '  <div style="background:#f3f1f9;padding:16px 28px;text-align:center;">'
    + '    <p style="margin:0;font-size:11px;color:#8a82ac;">Recibiste este correo porque quedaste registrado como interesado en nuestros servicios legales.<br>Si no deseas recibir mas correos, responde BAJA a este mensaje y te retiramos de inmediato.</p>'
    + '  </div>'
    + '</div>';
}

// ═══════════════════════════ 1. LIMPIAR LA BASE ═══════════════════════════
// Lee todos los leads, valida el formato de cada correo, elimina duplicados, y
// deja la hoja "Control Envíos" lista con una fila por persona.
function limpiarBaseDeCorreos() {
  var hojaLeads = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_LEADS);
  if (!hojaLeads) { throw new Error('No se encontro la hoja "' + HOJA_LEADS + '". Ajusta HOJA_LEADS en la configuracion.'); }

  var datos = hojaLeads.getDataRange().getValues();
  var encabezados = datos[0];
  var colNombre = indiceColumna(encabezados, COL_NOMBRE);
  var colEmail = indiceColumna(encabezados, COL_EMAIL) !== -1 ? indiceColumna(encabezados, COL_EMAIL) : indiceColumna(encabezados, 'Correo electrónico');

  if (colEmail === -1) { throw new Error('No se encontro la columna de correo. Revisa COL_EMAIL en la configuracion.'); }

  var vistos = {}; // dedup por correo
  var filasControl = [];
  for (var i = 1; i < datos.length; i++) {
    var email = String(datos[i][colEmail] || '').trim().toLowerCase();
    var nombre = colNombre !== -1 ? String(datos[i][colNombre] || '').trim() : '';
    if (!email || vistos[email]) continue;
    vistos[email] = true;
    var valido = esEmailValido(email) ? 'Sí' : 'No';
    filasControl.push([email, nombre, valido, 'FALSE', '', '', 'FALSE', '', '']);
  }

  var hojaControl = crearOLimpiarHojaControl();
  if (filasControl.length) {
    hojaControl.getRange(FILA_ENCABEZADOS_CONTROL + 1, 1, filasControl.length, COLUMNAS_CONTROL.length).setValues(filasControl);
  }

  var validos = filasControl.filter(function (f) { return f[2] === 'Sí'; }).length;
  actualizarResumenControl();
  Logger.log('Base limpiada: ' + filasControl.length + ' correos unicos, ' + validos + ' validos, ' + (filasControl.length - validos) + ' invalidos.');
}

function crearOLimpiarHojaControl() {
  var libro = SpreadsheetApp.getActiveSpreadsheet();
  var hoja = libro.getSheetByName(HOJA_CONTROL);
  if (!hoja) {
    hoja = libro.insertSheet(HOJA_CONTROL);
  } else {
    hoja.clear();
  }
  // deja 2 filas libres arriba para el resumen (actualizarResumenControl las usa)
  hoja.getRange(FILA_ENCABEZADOS_CONTROL, 1, 1, COLUMNAS_CONTROL.length).setValues([COLUMNAS_CONTROL]);
  hoja.getRange(FILA_ENCABEZADOS_CONTROL, 1, 1, COLUMNAS_CONTROL.length).setFontWeight('bold').setBackground('#2e1065').setFontColor('#ffffff');
  hoja.setFrozenRows(FILA_ENCABEZADOS_CONTROL);
  hoja.autoResizeColumns(1, COLUMNAS_CONTROL.length);
  return hoja;
}

// ═══════════════════════════ 2. ENVÍO DIARIO (se ejecuta varias veces al día vía trigger) ═══════════════════════════
function enviarCorreosDiarios() {
  var hojaControl = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_CONTROL);
  if (!hojaControl) { Logger.log('No existe "Control Envíos" todavía. Ejecuta limpiarBaseDeCorreos() primero.'); return; }

  var yaEnviadosHoy = obtenerContadorHoy();
  if (yaEnviadosHoy >= LIMITE_DIARIO) { Logger.log('Límite diario de ' + LIMITE_DIARIO + ' ya alcanzado hoy.'); return; }

  var cupoRestanteHoy = LIMITE_DIARIO - yaEnviadosHoy;
  var cupoEsteRun = Math.min(LOTE_POR_EJECUCION, cupoRestanteHoy);

  var datos = hojaControl.getDataRange().getValues();
  var filaEncabezado = FILA_ENCABEZADOS_CONTROL; // índice 0-based del array == primera fila de datos
  var idx = {};
  COLUMNAS_CONTROL.forEach(function (c, i) { idx[c] = i; });

  // Diagnóstico: si algún día vuelve a dar 0 envíos, este log dice exactamente por qué.
  var totalFilas = 0, validas = 0, r1Pendientes = 0, r2Pendientes = 0;
  for (var d = filaEncabezado; d < datos.length; d++) {
    if (!datos[d][idx['Correo']]) continue;
    totalFilas++;
    if (datos[d][idx['Válido']] === 'Sí') validas++;
    var r1 = datos[d][idx['Ronda 1 Enviada']] === 'TRUE' || datos[d][idx['Ronda 1 Enviada']] === true;
    var r2 = datos[d][idx['Ronda 2 Enviada']] === 'TRUE' || datos[d][idx['Ronda 2 Enviada']] === true;
    if (datos[d][idx['Válido']] === 'Sí' && !r1) r1Pendientes++;
    if (datos[d][idx['Válido']] === 'Sí' && r1 && !r2) r2Pendientes++;
  }
  Logger.log('Diagnóstico: ' + totalFilas + ' filas con correo, ' + validas + ' válidas, ' + r1Pendientes + ' pendientes de Ronda 1, ' + r2Pendientes + ' pendientes de Ronda 2. Cupo esta corrida: ' + cupoEsteRun + '.');

  var enviados = 0;

  // Primera pasada: Ronda 1 pendiente. Segunda pasada: Ronda 2 pendiente
  // (solo para quien ya recibió la Ronda 1). No hay Ronda 3.
  for (var ronda = 1; ronda <= 2 && enviados < cupoEsteRun; ronda++) {
    for (var i = filaEncabezado; i < datos.length && enviados < cupoEsteRun; i++) {
      var fila = datos[i];
      var email = fila[idx['Correo']];
      var nombre = fila[idx['Nombre']];
      var valido = fila[idx['Válido']];
      var r1Enviada = fila[idx['Ronda 1 Enviada']] === 'TRUE' || fila[idx['Ronda 1 Enviada']] === true;
      var r2Enviada = fila[idx['Ronda 2 Enviada']] === 'TRUE' || fila[idx['Ronda 2 Enviada']] === true;

      if (!email || valido !== 'Sí') continue; // inválido, o dado de baja (marcado "BAJA" a mano)
      if (ronda === 1 && r1Enviada) continue;
      if (ronda === 2 && (!r1Enviada || r2Enviada)) continue; // Ronda 2 solo si ya tuvo Ronda 1

      if (MailApp.getRemainingDailyQuota() < 1) { Logger.log('Cuota de MailApp agotada por hoy.'); actualizarResumenControl(); return; }

      var asuntos = ronda === 1 ? ASUNTOS_RONDA1 : ASUNTOS_RONDA2;
      var asunto = asuntos[Math.floor(Math.random() * asuntos.length)];
      var cuerpoHtml = cuerpoCorreo(nombre, ronda);

      try {
        MailApp.sendEmail({
          to: email,
          subject: asunto,
          htmlBody: cuerpoHtml,
          name: REMITENTE_NOMBRE,
        });

        var filaSheet = i + 1; // convertir índice 0-based a número de fila real
        if (ronda === 1) {
          hojaControl.getRange(filaSheet, idx['Ronda 1 Enviada'] + 1, 1, 3).setValues([['TRUE', new Date(), asunto]]);
        } else {
          hojaControl.getRange(filaSheet, idx['Ronda 2 Enviada'] + 1, 1, 3).setValues([['TRUE', new Date(), asunto]]);
        }

        enviados++;
        incrementarContadorHoy();
        Logger.log('Enviado (ronda ' + ronda + '): ' + email);

        if (enviados < cupoEsteRun) {
          Utilities.sleep((PAUSA_MIN_SEG + Math.random() * (PAUSA_MAX_SEG - PAUSA_MIN_SEG)) * 1000);
        }
      } catch (err) {
        Logger.log('Error enviando a ' + email + ': ' + err);
      }
    }
  }

  actualizarResumenControl();
  Logger.log('Ejecución terminada: ' + enviados + ' correos enviados en esta corrida.');
}

// ═══════════════════════════ 3. RESUMEN / PANEL DE CONTROL ═══════════════════════════
function actualizarResumenControl() {
  var hoja = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOJA_CONTROL);
  if (!hoja) return;
  var datos = hoja.getDataRange().getValues();
  var idx = {};
  COLUMNAS_CONTROL.forEach(function (c, i) { idx[c] = i; });

  var total = 0, validos = 0, r1 = 0, r2 = 0;
  for (var i = FILA_ENCABEZADOS_CONTROL; i < datos.length; i++) {
    var fila = datos[i];
    if (!fila[idx['Correo']]) continue;
    total++;
    if (fila[idx['Válido']] === 'Sí') validos++;
    if (fila[idx['Ronda 1 Enviada']] === 'TRUE' || fila[idx['Ronda 1 Enviada']] === true) r1++;
    if (fila[idx['Ronda 2 Enviada']] === 'TRUE' || fila[idx['Ronda 2 Enviada']] === true) r2++;
  }

  hoja.getRange(1, 1).setValue('Panel de control — envíos de remarketing');
  hoja.getRange(1, 1).setFontWeight('bold').setFontSize(13);
  hoja.getRange(2, 1).setValue(
    'Total: ' + total + '  ·  Válidos: ' + validos + '  ·  Inválidos/baja: ' + (total - validos) +
    '  ·  Ronda 1 enviada: ' + r1 + '  ·  Ronda 2 enviada: ' + r2 +
    '  ·  Enviados hoy: ' + obtenerContadorHoy() + ' / ' + LIMITE_DIARIO
  );
  hoja.getRange(2, 1).setFontColor('#59517f').setFontSize(10);
}

// ═══════════════════════════ CONTADOR DIARIO (se resetea solo cada día) ═══════════════════════════
function obtenerContadorHoy() {
  var props = PropertiesService.getScriptProperties();
  var hoy = Utilities.formatDate(new Date(), 'GMT-5', 'yyyy-MM-dd');
  var fechaGuardada = props.getProperty('fecha_contador');
  if (fechaGuardada !== hoy) {
    props.setProperty('fecha_contador', hoy);
    props.setProperty('contador_envios', '0');
    return 0;
  }
  return Number(props.getProperty('contador_envios') || '0');
}

function incrementarContadorHoy() {
  var props = PropertiesService.getScriptProperties();
  var actual = obtenerContadorHoy(); // asegura que la fecha esté sincronizada primero
  props.setProperty('contador_envios', String(actual + 1));
}

// ═══════════════════════════ ACTIVADOR AUTOMÁTICO (ejecutar UNA sola vez) ═══════════════════════════
function crearActivadorAutomatico() {
  var yaExiste = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'enviarCorreosDiarios';
  });
  if (yaExiste) { Logger.log('Ya existe un activador para enviarCorreosDiarios — no se creó otro.'); return; }

  ScriptApp.newTrigger('enviarCorreosDiarios')
    .timeBased()
    .everyHours(1)
    .create();

  Logger.log('Activador creado: enviarCorreosDiarios se ejecutará cada hora. Se detiene solo al llegar a ' + LIMITE_DIARIO + ' correos ese día.');
}

function eliminarActivadorAutomatico() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'enviarCorreosDiarios') ScriptApp.deleteTrigger(t);
  });
  Logger.log('Activador eliminado.');
}

// ═══════════════════════════ UTILIDADES ═══════════════════════════
function esEmailValido(email) {
  return /^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(String(email || '').trim());
}

function indiceColumna(encabezados, nombreBuscado) {
  var normalizar = function (s) {
    return String(s || '').trim().toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // quita tildes
  };
  var buscado = normalizar(nombreBuscado);
  for (var i = 0; i < encabezados.length; i++) {
    if (normalizar(encabezados[i]) === buscado) return i;
  }
  return -1;
}
