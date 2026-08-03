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

// Hoja externa (la que tú administras) con el correo oficial de radicación de
// cada ciudad/organismo de tránsito. Debe tener una columna con "Ciudad" (o
// "Municipio"/"Organismo") y otra con "Correo" (o "Email") — el nombre exacto
// no importa, esta función busca por lo que contenga esas palabras.
var CORREOS_RADICACION_SHEET_ID = '1RB8EfYBtsn3zZ2BayYxJjD8p7w3M7ElGGqFazcnhObU';

var VALOR_SALDO_DIFERIDO = 95900; // lo que falta pagar por multa en el Plan Pago al Eliminar
var DIAS_HABILES_RESPUESTA = 15;  // Art. 14 CPACA
var VALOR_TUTELA = 45000; // se cobra SOLO si la tutela resulta positiva — es la garantía
var WHATSAPP_DESPACHO = '573159318400';
var EMAIL_DESPACHO = 'juridicoswebcasos@gmail.com';
var FIRMAR_BASE_URL = 'https://juridicosweb.com/firmar.html';

// Encabezados de la hoja principal, en el orden en que se ven — un solo
// caso (cliente) por fila, se actualiza en el sitio (nunca se duplica).
// IMPORTANTE: si agregas columnas nuevas, ponlas siempre AL FINAL de este
// arreglo — el orden aquí debe coincidir con el orden real de columnas en la
// hoja, y asegurarColumnas() solo AGREGA columnas nuevas al final, nunca
// reordena las existentes.
var COLUMNAS_CASOS = [
  'Fecha', 'Nombres', 'Apellidos', 'Cédula', 'Placa', 'WhatsApp', 'Email',
  'Dirección', 'Ciudad', 'Departamento', 'Plan', 'Multas Seleccionadas',
  'Monto Total', 'Estado de Pago', 'Pago OK', 'Saldo Pendiente',
  'Saldo Pagado', 'Fuente', 'Multas Reportadas', 'Tiene Captura SIMIT',
  'Autorizar', 'Doc Enviado', 'Fecha Radicación', 'Fecha Límite 15d',
  'Respuesta Secretaría', 'Fecha Respuesta', 'Tutela Requerida',
  'Tutela Enviada', 'Recordatorio Enviado', 'Cerrado', 'Notas',
  'Firmado', 'Enlace PDF Firmado',
  'Tutela Firmada', 'Enlace PDF Tutela', 'Tutela Valor', 'Resultado Tutela', 'Tutela Pagada',
];

var COLUMNAS_FIRMADOS = [
  'Fecha', 'Nombres', 'Apellidos', 'Cédula', 'Email', 'WhatsApp',
  'Secretarías', 'Enlace del archivo en Drive', 'Canal de radicación',
];

// Lectura pública de los casos para admin.html y firmar.html — pasa por
// esta MISMA implementación web (ya desplegada como "Cualquiera" puede
// llamarla), así que no depende para nada de cómo esté configurado
// "Compartir" en la hoja de cálculo. Si alguna vez la lectura directa del
// Sheet vuelve a fallar por permisos, esta vía siempre funciona porque usa
// el mismo mecanismo que ya usa guardarLead() para escribir.
function doGet(e) {
  try {
    var accion = e.parameter.accion;
    if (accion === 'listar_casos') {
      var hoja = obtenerOCrearHoja(SHEET_CASOS, COLUMNAS_CASOS);
      var valores = hoja.getDataRange().getValues();
      if (valores.length < 2) return respuestaJson({ ok: true, casos: [] });
      var encabezados = valores[0];
      var casos = valores.slice(1)
        .filter(function (fila) { return fila.some(function (v) { return v !== ''; }); })
        .map(function (fila) {
          var obj = {};
          encabezados.forEach(function (h, i) {
            var v = fila[i];
            // Normaliza fechas (vienen como objeto Date real de Sheets) y
            // booleanos, para que el frontend reciba siempre texto plano
            // igual a como lo esperaba con el método anterior.
            if (v instanceof Date) obj[h] = Utilities.formatDate(v, 'GMT-5', 'yyyy-MM-dd HH:mm:ss');
            else if (v === true) obj[h] = 'TRUE';
            else if (v === false) obj[h] = 'FALSE';
            else obj[h] = v;
          });
          return obj;
        });
      return respuestaJson({ ok: true, casos: casos });
    }
    return respuestaJson({ ok: false, error: 'Acción GET no reconocida: ' + accion });
  } catch (err) {
    return respuestaJson({ ok: false, error: String(err) });
  }
}

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
      case 'marcar_firmado':      return marcarFirmado(datos);
      case 'reenviar_firmado':    return reenviarFirmado(datos);
      case 'radicar_por_correo':  return radicarPorCorreo(datos);
      case 'enviar_recordatorio_manual': return enviarRecordatorioManual(datos);
      case 'activar_tutela':      return activarTutela(datos);
      case 'marcar_tutela_firmada': return marcarTutelaFirmada(datos);
      case 'marcar_tutela_resultado': return marcarTutelaResultado(datos);
      case 'marcar_tutela_pagada': return marcarTutelaPagada(datos);
      case 'guardar_multas':      return guardarMultasEstructuradas(datos);
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
  // Si el caso llega ya pagado (ej. cliente de WhatsApp registrado a mano
  // desde el panel, que confirmó el pago por fuera de la página), lo
  // reflejamos de una vez — así no queda perdido en "Remarketing".
  var yaPago = /pagad/i.test(datos.estadoPago || '');

  // Si ya existe un caso reciente de este cliente (por cédula o correo), lo
  // actualizamos en vez de duplicar — así "Clientes" y "Remarketing" quedan
  // siempre con una sola fila por persona.
  if (fila !== -1) {
    var valoresUpd = {
      'Nombres': datos.nombres, 'Apellidos': datos.apellidos, 'Placa': datos.placa,
      'WhatsApp': datos.whatsapp, 'Email': datos.email, 'Dirección': datos.direccion,
      'Ciudad': datos.ciudad, 'Departamento': datos.dpto, 'Plan': datos.plan,
      'Multas Seleccionadas': datos.multasSeleccionadas, 'Monto Total': datos.montoTotal,
      'Estado de Pago': datos.estadoPago || 'PENDIENTE', 'Fuente': datos.fuente,
      'Multas Reportadas': datos.multasReportadas,
      'Tiene Captura SIMIT': datos.capturaSimitBase64 ? 'Sí' : 'No',
    };
    if (yaPago) {
      valoresUpd['Pago OK'] = 'TRUE';
      if (esDiferido) valoresUpd['Saldo Pendiente'] = VALOR_SALDO_DIFERIDO * (Number(datos.multasSeleccionadas) || 1);
    }
    escribirFila(hoja, fila, valoresUpd);
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
  fila_['Pago OK'] = yaPago ? 'TRUE' : 'FALSE';
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
  fila_['Firmado'] = 'FALSE';

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

// Se llama desde firmar.html apenas el cliente firma en su teléfono: sube el
// PDF firmado a Drive, guarda el enlace en el caso, y le manda el documento
// firmado por correo de una vez — el mismo camino tanto si firmó desde la
// página principal como si firmó desde este enlace remoto.
function marcarFirmado(datos) {
  if (!datos.archivoBase64 || !datos.cedula) {
    return respuestaJson({ ok: false, error: 'Falta el archivo firmado o la cédula del caso' });
  }
  var hoja = obtenerOCrearHoja(SHEET_CASOS, COLUMNAS_CASOS);
  var fila = buscarFilaPorCedulaOEmail(hoja, datos.cedula, datos.email);
  if (fila === -1) return respuestaJson({ ok: false, error: 'No se encontró el caso de este cliente' });

  var carpeta = obtenerOCrearCarpeta(CARPETA_DRIVE_FIRMAS);
  var partes = datos.archivoBase64.split(',');
  var mime = (partes[0].match(/data:(.*);base64/) || [])[1] || 'application/pdf';
  var bytes = Utilities.base64Decode(partes[1] || partes[0]);
  var nombreArchivo = datos.archivoNombre || ('DerechoPeticion_Firmado_' + datos.cedula + '.pdf');
  var archivo = carpeta.createFile(Utilities.newBlob(bytes, mime, nombreArchivo));
  archivo.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  escribirFila(hoja, fila, { 'Firmado': 'TRUE', 'Enlace PDF Firmado': archivo.getUrl() });

  var emailDestino = datos.email || obtenerValorFila(hoja, fila, 'Email');
  if (emailDestino) {
    enviarDocumentoCorreo({
      email: emailDestino,
      nombres: datos.nombres || obtenerValorFila(hoja, fila, 'Nombres'),
      archivoBase64: datos.archivoBase64,
      archivoNombre: nombreArchivo,
      firmado: true,
    });
  }
  return respuestaJson({ ok: true, enlaceArchivo: archivo.getUrl() });
}

// Botón "Reenviar documento firmado" en el panel — usa el PDF que ya está
// guardado en Drive, no pide que el cliente vuelva a firmar.
function reenviarFirmado(datos) {
  var hoja = obtenerOCrearHoja(SHEET_CASOS, COLUMNAS_CASOS);
  var fila = buscarFilaPorCedulaOEmail(hoja, datos.cedula, datos.email);
  if (fila === -1) return respuestaJson({ ok: false, error: 'No se encontró el caso de este cliente' });

  var enlace = obtenerValorFila(hoja, fila, 'Enlace PDF Firmado');
  var idArchivo = extraerIdDrive(enlace);
  if (!idArchivo) return respuestaJson({ ok: false, error: 'Este caso todavía no tiene un documento firmado guardado' });

  var emailDestino = datos.email || obtenerValorFila(hoja, fila, 'Email');
  if (!emailDestino) return respuestaJson({ ok: false, error: 'El caso no tiene correo registrado' });

  try {
    var blob = DriveApp.getFileById(idArchivo).getBlob();
    var nombres = obtenerValorFila(hoja, fila, 'Nombres');
    MailApp.sendEmail({
      to: emailDestino,
      subject: '📄 Tu Derecho de Petición firmado — JurídicosWeb',
      body: 'Hola ' + nombres + ',\n\nTe reenviamos tu Derecho de Petición ya firmado, listo para radicar.\n\n' +
        'Cualquier duda, escríbenos por WhatsApp al +' + WHATSAPP_DESPACHO + '.\n\nJurídicosWeb.com',
      attachments: [blob],
    });
    return respuestaJson({ ok: true });
  } catch (err) {
    return respuestaJson({ ok: false, error: String(err) });
  }
}

// ───────────────────────── radicación automática por correo ─────────────
//
// Radica el Derecho de Petición directamente ante la secretaría por correo
// electrónico, con respaldo jurídico explícito para que la entidad no pueda
// alegar que "solo reciben por el formulario web" — el correo es un canal
// válido conforme a la ley, y muchas plataformas de las secretarías fallan o
// entorpecen el trámite sin justificación legal.
//
// IMPORTANTE: revisa con tu abogado el texto de construirCorreoRadicacionLegal()
// antes de usarlo a gran escala — cita normas vigentes y de uso común en este
// tipo de trámite, pero como cualquier plantilla legal conviene que la
// valide tu equipo jurídico antes de radicar casos reales con ella.
function radicarPorCorreo(datos) {
  var hoja = obtenerOCrearHoja(SHEET_CASOS, COLUMNAS_CASOS);
  var fila = buscarFilaPorCedulaOEmail(hoja, datos.cedula, datos.email);
  if (fila === -1) return respuestaJson({ ok: false, error: 'No se encontró el caso de este cliente' });

  var ciudad = obtenerValorFila(hoja, fila, 'Ciudad');
  var enlacePdf = obtenerValorFila(hoja, fila, 'Enlace PDF Firmado');
  var nombres = obtenerValorFila(hoja, fila, 'Nombres');
  var apellidos = obtenerValorFila(hoja, fila, 'Apellidos');
  var cedula = obtenerValorFila(hoja, fila, 'Cédula');
  var placa = obtenerValorFila(hoja, fila, 'Placa');
  var emailCliente = obtenerValorFila(hoja, fila, 'Email');

  if (!enlacePdf) {
    return respuestaJson({ ok: false, error: 'Este caso todavía no tiene un documento firmado. Envía primero el enlace de firma.' });
  }
  var idArchivo = extraerIdDrive(enlacePdf);
  var blob = idArchivo ? DriveApp.getFileById(idArchivo).getBlob() : null;

  var correoSecretaria = buscarCorreoRadicacion(ciudad);
  if (!correoSecretaria) {
    return respuestaJson({ ok: false, error: 'No encontramos el correo oficial de radicación para "' + ciudad + '" en tu hoja de correos. Agrégalo ahí y vuelve a intentar.' });
  }

  var asunto = 'DERECHO DE PETICIÓN — Radicación electrónica — ' + nombres + ' ' + apellidos + ' — C.C. ' + cedula;
  var cuerpoHtml = construirCorreoRadicacionLegal(nombres, apellidos, cedula, placa, emailCliente);

  MailApp.sendEmail({
    to: correoSecretaria,
    cc: EMAIL_DESPACHO,
    subject: asunto,
    htmlBody: cuerpoHtml,
    attachments: blob ? [blob] : [],
  });

  if (emailCliente) {
    try {
      MailApp.sendEmail({
        to: emailCliente,
        subject: '📨 Tu Derecho de Petición ya fue radicado',
        body: 'Hola ' + nombres + ',\n\n' +
          'Tu Derecho de Petición quedó radicado hoy, por correo electrónico, ante: ' + correoSecretaria + '.\n\n' +
          'Desde hoy corre el plazo legal de 15 días hábiles (Art. 14 de la Ley 1437 de 2011 — CPACA) para que te respondan. ' +
          'Apenas se cumpla ese plazo te avisamos automáticamente para revisar juntos la respuesta.\n\n' +
          'JurídicosWeb.com — Bufete Experto en Derecho de Tránsito',
      });
    } catch (e) { /* no rompe la radicación si falla el aviso al cliente */ }
  }

  marcarEnviado({ cedula: cedula, email: emailCliente }); // arranca el plazo de 15 días hábiles
  var notaActual = obtenerValorFila(hoja, fila, 'Notas') || '';
  escribirFila(hoja, fila, {
    'Notas': notaActual + (notaActual ? ' | ' : '') + 'Radicado por correo a ' + correoSecretaria + ' el ' + new Date().toLocaleString('es-CO'),
  });

  return respuestaJson({ ok: true, correo: correoSecretaria });
}

// Busca en TU hoja externa de correos (CORREOS_RADICACION_SHEET_ID) el
// correo oficial de radicación para una ciudad — por nombre de columna, así
// que no importa el orden ni el nombre exacto de tus columnas, siempre que
// una contenga "ciudad"/"municipio"/"organismo" y otra "correo"/"email".
function buscarCorreoRadicacion(ciudad) {
  if (!ciudad) return null;
  try {
    var libro = SpreadsheetApp.openById(CORREOS_RADICACION_SHEET_ID);
    var hoja = libro.getSheets()[0];
    var valores = hoja.getDataRange().getValues();
    if (!valores.length) return null;
    var encabezados = valores[0].map(function (h) { return normalizarTexto(String(h)); });
    var colCiudad = -1, colCorreo = -1;
    encabezados.forEach(function (h, i) {
      if (colCiudad === -1 && /ciudad|municipio|organismo/.test(h)) colCiudad = i;
      if (colCorreo === -1 && /correo|email|mail/.test(h)) colCorreo = i;
    });
    if (colCiudad === -1 || colCorreo === -1) return null;
    var ciudadNorm = normalizarTexto(ciudad);
    for (var i = 1; i < valores.length; i++) {
      if (normalizarTexto(String(valores[i][colCiudad])) === ciudadNorm) {
        var correo = String(valores[i][colCorreo] || '').trim();
        return correo || null;
      }
    }
  } catch (err) {
    return null;
  }
  return null;
}

function normalizarTexto(s) {
  return (s || '').toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function extraerIdDrive(url) {
  var m = (url || '').match(/[-\w]{25,}/);
  return m ? m[0] : null;
}

// Carta de radicación con respaldo jurídico: exige que el correo sea
// aceptado como canal válido de radicación aunque la entidad tenga un
// formulario web propio (que en la práctica muchas veces falla o entorpece
// el trámite). Cita normas generales y de uso reconocido en Colombia sobre
// derecho de petición y validez de mensajes de datos — no inventa
// jurisprudencia puntual, precisamente para que el texto sea defendible.
function construirCorreoRadicacionLegal(nombres, apellidos, cedula, placa, emailCliente) {
  var hoy = Utilities.formatDate(new Date(), 'GMT-5', "d 'de' MMMM 'de' yyyy");
  return '' +
    '<div style="font-family:Georgia,serif;color:#1a1a1a;line-height:1.6;max-width:700px;">' +
    '<p>Bogotá D.C., ' + hoy + '</p>' +
    '<p><strong>Señores<br>SECRETARÍA DE TRÁNSITO Y MOVILIDAD</strong><br>E. S. D.</p>' +
    '<p><strong>REFERENCIA:</strong> Radicación de Derecho de Petición por correo electrónico — ' +
    'Peticionario: ' + nombres + ' ' + apellidos + ', C.C. No. ' + cedula + (placa ? ', placa ' + placa : '') + '</p>' +
    '<p>Respetados señores:</p>' +
    '<p>Adjunto a este correo remito el <strong>Derecho de Petición</strong> del ciudadano arriba referenciado, ' +
    'firmado y listo para radicar, solicitando de manera respetuosa pero firme que sea <strong>recibido, registrado y tramitado por este medio</strong>, ' +
    'por las siguientes razones de derecho:</p>' +
    '<ol>' +
    '<li>El artículo 23 de la Constitución Política consagra el derecho fundamental de petición sin sujetarlo a un canal exclusivo de presentación.</li>' +
    '<li>El artículo 5, numeral 1, de la Ley 1437 de 2011 (CPACA), modificado por la Ley 1755 de 2015, reconoce expresamente el derecho de toda persona a presentar peticiones respetuosas <strong>por cualquier medio idóneo</strong> ante las autoridades, sin que estas puedan supeditar su recepción a un canal, plataforma o formulario específico como condición de validez.</li>' +
    '<li>El artículo 3 del CPACA obliga a las autoridades a actuar conforme a los principios de <strong>eficacia, economía y celeridad</strong>, los cuales se ven vulnerados cuando se exige al ciudadano un trámite adicional no previsto en la ley, o cuando la plataforma dispuesta por la entidad presenta fallas técnicas que impiden la radicación.</li>' +
    '<li>El artículo 5 de la Ley 527 de 1999 dispone que <strong>no se negarán efectos jurídicos, validez ni fuerza obligatoria</strong> a una comunicación por la sola razón de constar en forma de mensaje de datos — un correo electrónico dirigido a la dirección oficial publicada por esa entidad en sus propios canales tiene, en consecuencia, plena validez como medio de radicación.</li>' +
    '<li>El Decreto Ley 019 de 2012 (Estatuto Antitrámites) prohíbe a las entidades públicas exigir requisitos, documentos o trámites adicionales a los estrictamente previstos en la ley para el ejercicio de un derecho.</li>' +
    '</ol>' +
    '<p>En consecuencia, se solicita comedidamente:</p>' +
    '<ol>' +
    '<li><strong>Confirmar la recepción</strong> de este correo y del Derecho de Petición adjunto, indicando el número de radicado asignado.</li>' +
    '<li><strong>Dar trámite de fondo</strong> a la petición dentro del término legal de quince (15) días hábiles previsto en el artículo 14 del CPACA, contados a partir de la fecha de este correo.</li>' +
    '<li>Notificar la respuesta a la dirección de correo electrónico ' + (emailCliente ? '<strong>' + emailCliente + '</strong>' : 'registrada en el documento adjunto') + ', que el peticionario señala expresamente para recibir notificaciones.</li>' +
    '</ol>' +
    '<p>De no recibirse respuesta de fondo dentro del término legal, o de considerarse improcedente el rechazo de esta radicación por el solo hecho de no haberse efectuado a través de un formulario o plataforma interna, el peticionario se reserva el derecho de acudir a los mecanismos judiciales y constitucionales pertinentes, incluida la acción de tutela por vulneración del derecho fundamental de petición.</p>' +
    '<p>Cordialmente,</p>' +
    '<p><strong>JurídicosWeb.com</strong> — Bufete Experto en Derecho de Tránsito<br>' +
    'En representación de los intereses de ' + nombres + ' ' + apellidos + ', C.C. No. ' + cedula + '<br>' +
    WHATSAPP_DESPACHO + ' · ' + EMAIL_DESPACHO + '</p>' +
    '</div>';
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
      enviarRecordatorioCliente(email, nombres, fila[idx['Cédula']]);
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

// Botón "Enviar recordatorio" en el panel — mismo correo que el envío
// automático, pero disparado a mano por el admin (ej. para reenviarlo).
function enviarRecordatorioManual(datos) {
  var hoja = obtenerOCrearHoja(SHEET_CASOS, COLUMNAS_CASOS);
  var fila = buscarFilaPorCedulaOEmail(hoja, datos.cedula, datos.email);
  if (fila === -1) return respuestaJson({ ok: false, error: 'No se encontró el caso' });
  var email = obtenerValorFila(hoja, fila, 'Email');
  var nombres = obtenerValorFila(hoja, fila, 'Nombres');
  var cedula = obtenerValorFila(hoja, fila, 'Cédula');
  if (!email) return respuestaJson({ ok: false, error: 'El caso no tiene correo registrado' });
  enviarRecordatorioCliente(email, nombres, cedula);
  escribirFila(hoja, fila, { 'Recordatorio Enviado': 'TRUE' });
  return respuestaJson({ ok: true });
}

// Correo de los 15 días — explica la tutela (garantía: solo se paga si
// resulta positiva) y trae un botón directo a WhatsApp para que el cliente
// confirme que quiere iniciarla, sin tener que escribir nada él mismo.
function enviarRecordatorioCliente(email, nombres, cedula) {
  var asunto = '⏰ Ya se cumplieron los 15 días hábiles — revisa tu respuesta';
  var msgWa = encodeURIComponent('Hola, soy ' + (nombres || '') + ' (C.C. ' + (cedula || '') + '). Ya pasaron los 15 días hábiles y no he recibido respuesta de la Secretaría de Tránsito. Quiero iniciar la Tutela (pago los $45.000 solo si resulta positiva).');
  var linkWa = 'https://wa.me/' + WHATSAPP_DESPACHO + '?text=' + msgWa;
  var cuerpoHtml = '' +
    '<div style="font-family:Arial,sans-serif;color:#1e293b;max-width:560px;">' +
    '<div style="background:#2e1065;padding:16px 20px;border-radius:10px 10px 0 0;"><p style="color:#2dd4bf;font-weight:800;font-size:15px;margin:0;">JurídicosWeb.com</p></div>' +
    '<div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px;padding:20px;">' +
    '<p>Hola ' + (nombres || '') + ',</p>' +
    '<p>Ya se cumplió el plazo legal de <strong>15 días hábiles</strong> (Art. 14 de la Ley 1437 de 2011 — CPACA) desde que radicamos tu Derecho de Petición.</p>' +
    '<p>Por favor revisa tu correo (incluida la carpeta de spam) y el SIMIT para confirmar si la secretaría ya respondió.</p>' +
    '<div style="background:#f8fafc;border-radius:10px;padding:16px;margin:18px 0;">' +
    '<p style="margin:0 0 8px;font-weight:700;color:#2e1065;">¿No te han respondido, o la respuesta fue negativa?</p>' +
    '<p style="margin:0 0 14px;font-size:14px;">Podemos iniciar de inmediato una <strong>Acción de Tutela</strong> para exigir la respuesta y proteger tu derecho. Tiene un costo de <strong>$45.000</strong> — y solo lo pagas <strong>si el resultado es positivo</strong>. Esa es nuestra garantía.</p>' +
    '<a href="' + linkWa + '" style="display:inline-block;background:#25D366;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700;font-size:14px;">💬 Quiero iniciar mi Tutela</a>' +
    '</div>' +
    '<p style="font-size:13px;color:#64748b;">Si ya te respondieron a favor, ignora este mensaje — nuestro equipo ya está al tanto y seguirá con el proceso de eliminación.</p>' +
    '<p>JurídicosWeb.com — Bufete Experto en Derecho de Tránsito</p>' +
    '</div></div>';
  try { MailApp.sendEmail({ to: email, subject: asunto, htmlBody: cuerpoHtml }); } catch (e) { /* cuota de correo agotada u otro error — no rompe el resto del chequeo */ }
}

// ───────────────────────── flujo de tutela ─────────────────────────
//
// El cliente confirma por WhatsApp (desde el botón del correo de arriba)
// que quiere iniciar la tutela. El admin, al ver ese mensaje, activa la
// tutela desde el panel: esto le envía al cliente el enlace para firmarla
// digitalmente desde el teléfono (mismo módulo firmar.html, en modo tutela).
function activarTutela(datos) {
  var hoja = obtenerOCrearHoja(SHEET_CASOS, COLUMNAS_CASOS);
  var fila = buscarFilaPorCedulaOEmail(hoja, datos.cedula, datos.email);
  if (fila === -1) return respuestaJson({ ok: false, error: 'No se encontró el caso' });

  var nombres = obtenerValorFila(hoja, fila, 'Nombres');
  var email = obtenerValorFila(hoja, fila, 'Email');
  var cedula = obtenerValorFila(hoja, fila, 'Cédula');

  escribirFila(hoja, fila, { 'Tutela Requerida': 'TRUE', 'Tutela Valor': VALOR_TUTELA });

  if (email) {
    var linkFirma = FIRMAR_BASE_URL + '?cedula=' + encodeURIComponent(cedula) + '&tipo=tutela';
    var cuerpoHtml = '' +
      '<div style="font-family:Arial,sans-serif;color:#1e293b;max-width:560px;">' +
      '<div style="background:#2e1065;padding:16px 20px;border-radius:10px 10px 0 0;"><p style="color:#2dd4bf;font-weight:800;font-size:15px;margin:0;">JurídicosWeb.com</p></div>' +
      '<div style="border:1px solid #e2e8f0;border-top:none;border-radius:0 0 10px 10px;padding:20px;">' +
      '<p>Hola ' + nombres + ',</p>' +
      '<p>Ya preparamos tu <strong>Acción de Tutela</strong> para exigir la respuesta a tu Derecho de Petición. Recuerda: el costo de $45.000 <strong>solo se cobra si el resultado es positivo</strong> — no arriesgas nada.</p>' +
      '<p>Fírmala ahora mismo desde tu celular, toma 2 minutos:</p>' +
      '<a href="' + linkFirma + '" style="display:inline-block;background:#2dd4bf;color:#2e1065;text-decoration:none;padding:13px 24px;border-radius:8px;font-weight:800;font-size:14px;">🖊️ Firmar mi Tutela</a>' +
      '<p style="font-size:13px;color:#64748b;margin-top:16px;">Cualquier duda, escríbenos por WhatsApp al +' + WHATSAPP_DESPACHO + '.</p>' +
      '<p>JurídicosWeb.com — Bufete Experto en Derecho de Tránsito</p>' +
      '</div></div>';
    try {
      MailApp.sendEmail({ to: email, subject: '⚖️ Tu Acción de Tutela está lista para firmar', htmlBody: cuerpoHtml });
    } catch (e) { /* no rompe la activación si falla el envío */ }
  }
  return respuestaJson({ ok: true });
}

// Igual que marcarFirmado() pero para la tutela — guarda el PDF firmado en
// Drive, marca el caso, y le reenvía el documento firmado al cliente.
function marcarTutelaFirmada(datos) {
  if (!datos.archivoBase64 || !datos.cedula) {
    return respuestaJson({ ok: false, error: 'Falta el archivo firmado o la cédula del caso' });
  }
  var hoja = obtenerOCrearHoja(SHEET_CASOS, COLUMNAS_CASOS);
  var fila = buscarFilaPorCedulaOEmail(hoja, datos.cedula, datos.email);
  if (fila === -1) return respuestaJson({ ok: false, error: 'No se encontró el caso' });

  var carpeta = obtenerOCrearCarpeta(CARPETA_DRIVE_FIRMAS);
  var partes = datos.archivoBase64.split(',');
  var mime = (partes[0].match(/data:(.*);base64/) || [])[1] || 'application/pdf';
  var bytes = Utilities.base64Decode(partes[1] || partes[0]);
  var nombreArchivo = datos.archivoNombre || ('Tutela_Firmada_' + datos.cedula + '.pdf');
  var archivo = carpeta.createFile(Utilities.newBlob(bytes, mime, nombreArchivo));
  archivo.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  escribirFila(hoja, fila, { 'Tutela Firmada': 'TRUE', 'Enlace PDF Tutela': archivo.getUrl() });

  var emailDestino = datos.email || obtenerValorFila(hoja, fila, 'Email');
  if (emailDestino) {
    try {
      MailApp.sendEmail({
        to: emailDestino,
        subject: '⚖️ Tu Acción de Tutela firmada — JurídicosWeb',
        body: 'Hola ' + (datos.nombres || obtenerValorFila(hoja, fila, 'Nombres')) + ',\n\n' +
          'Adjunto tu Acción de Tutela ya firmada. Nuestro equipo la radicará ante el juzgado competente.\n\n' +
          'Recuerda: el costo de $45.000 solo se cobra si el resultado es positivo.\n\n' +
          'JurídicosWeb.com — Bufete Experto en Derecho de Tránsito',
        attachments: [archivo.getBlob()],
      });
    } catch (e) { /* no rompe el guardado si falla el envío */ }
  }
  return respuestaJson({ ok: true, enlaceArchivo: archivo.getUrl() });
}

// resultado: 'positiva' | 'negativa' — si es positiva, deja el cobro de los
// $45.000 pendiente (esa es la garantía: se cobra solo cuando ya ganó).
function marcarTutelaResultado(datos) {
  var valores = { 'Resultado Tutela': datos.resultado === 'positiva' ? 'Positiva' : 'Negativa' };
  if (datos.resultado === 'positiva') valores['Tutela Pagada'] = 'FALSE';
  return actualizarPorCedula(datos, valores);
}

function marcarTutelaPagada(datos) {
  return actualizarPorCedula(datos, { 'Tutela Pagada': 'TRUE', 'Cerrado': 'TRUE' });
}

// Guarda los datos de las multas (fecha, ciudad, notificación, etc.) que el
// admin carga a mano para un caso que llegó por WhatsApp — con esto ya
// guardado, el enlace de firma (firmar.html) salta directo al documento sin
// pedirle nada al cliente, porque encuentra "Multas Reportadas" con datos.
function guardarMultasEstructuradas(datos) {
  if (!datos.multasReportadas) return respuestaJson({ ok: false, error: 'Falta la lista de multas' });
  return actualizarPorCedula(datos, { 'Multas Reportadas': datos.multasReportadas });
}

// Suma N días HÁBILES (lunes a viernes, sin festivos colombianos) a una
// fecha — usa el calendario oficial de Colombia (ver festivosColombia()).
function sumarDiasHabiles(fechaInicio, dias) {
  var fecha = new Date(fechaInicio);
  var contados = 0;
  while (contados < dias) {
    fecha.setDate(fecha.getDate() + 1);
    var dow = fecha.getDay();
    if (dow !== 0 && dow !== 6 && !esFestivoColombia(fecha)) contados++;
  }
  return fecha;
}

// ───────────────────────── festivos de Colombia (Ley 51 de 1983 / Ley Emiliani) ─
//
// Calcula los 18 festivos oficiales de un año: 6 de fecha fija, 7 de fecha
// fija pero trasladables al lunes siguiente si no caen en lunes (Ley
// Emiliani), y 5 que dependen del Domingo de Pascua (2 fijos: Jueves y
// Viernes Santo; 3 trasladables a lunes: Ascensión, Corpus Christi y Sagrado
// Corazón de Jesús).
function domingoPascua(anio) {
  var a = anio % 19;
  var b = Math.floor(anio / 100);
  var c = anio % 100;
  var d = Math.floor(b / 4);
  var e = b % 4;
  var f = Math.floor((b + 8) / 25);
  var g = Math.floor((b - f + 1) / 3);
  var h = (19 * a + b - d - g + 15) % 30;
  var i = Math.floor(c / 4);
  var k = c % 4;
  var l = (32 + 2 * e + 2 * i - h - k) % 7;
  var m = Math.floor((a + 11 * h + 22 * l) / 451);
  var mes = Math.floor((h + l - 7 * m + 114) / 31); // 3 = marzo, 4 = abril
  var dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(anio, mes - 1, dia);
}

function sumarDiasFecha(fecha, dias) {
  var f = new Date(fecha);
  f.setDate(f.getDate() + dias);
  return f;
}

// Traslada al lunes siguiente si la fecha no cae en lunes (Ley Emiliani).
function trasladarALunes(fecha) {
  var f = new Date(fecha);
  var dow = f.getDay();
  if (dow !== 1) f.setDate(f.getDate() + ((8 - dow) % 7));
  return f;
}

var _cacheFestivos = {};
function festivosColombia(anio) {
  if (_cacheFestivos[anio]) return _cacheFestivos[anio];
  var pascua = domingoPascua(anio);
  var festivos = [
    new Date(anio, 0, 1),   // Año Nuevo
    new Date(anio, 4, 1),   // Día del Trabajo
    new Date(anio, 6, 20),  // Independencia
    new Date(anio, 7, 7),   // Batalla de Boyacá
    new Date(anio, 11, 8),  // Inmaculada Concepción
    new Date(anio, 11, 25), // Navidad
    trasladarALunes(new Date(anio, 0, 6)),   // Reyes Magos
    trasladarALunes(new Date(anio, 2, 19)),  // San José
    trasladarALunes(new Date(anio, 5, 29)),  // San Pedro y San Pablo
    trasladarALunes(new Date(anio, 7, 15)),  // Asunción de la Virgen
    trasladarALunes(new Date(anio, 9, 12)),  // Día de la Raza
    trasladarALunes(new Date(anio, 10, 1)),  // Todos los Santos
    trasladarALunes(new Date(anio, 10, 11)), // Independencia de Cartagena
    sumarDiasFecha(pascua, -3), // Jueves Santo
    sumarDiasFecha(pascua, -2), // Viernes Santo
    trasladarALunes(sumarDiasFecha(pascua, 39)), // Ascensión del Señor
    trasladarALunes(sumarDiasFecha(pascua, 60)), // Corpus Christi
    trasladarALunes(sumarDiasFecha(pascua, 68)), // Sagrado Corazón de Jesús
  ];
  var claves = festivos.map(function (f) { return Utilities.formatDate(f, 'GMT-5', 'yyyy-MM-dd'); });
  _cacheFestivos[anio] = claves;
  return claves;
}

function esFestivoColombia(fecha) {
  var claves = festivosColombia(fecha.getFullYear());
  return claves.indexOf(Utilities.formatDate(fecha, 'GMT-5', 'yyyy-MM-dd')) !== -1;
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
  } else if (nombre === SHEET_CASOS) {
    asegurarColumnas(hoja, columnas);
  }
  return hoja;
}

// Si la hoja ya existía de antes (como la tuya en producción) y le agregamos
// columnas nuevas al arreglo COLUMNAS_CASOS, esto las agrega automáticamente
// al final de tu hoja real la primera vez que el script vuelve a correr —
// no necesitas tocar la hoja a mano.
function asegurarColumnas(hoja, columnas) {
  var anchoActual = hoja.getLastColumn();
  var encabezados = anchoActual > 0 ? hoja.getRange(1, 1, 1, anchoActual).getValues()[0] : [];
  var faltantes = columnas.filter(function (c) { return encabezados.indexOf(c) === -1; });
  if (!faltantes.length) return;
  var rango = hoja.getRange(1, anchoActual + 1, 1, faltantes.length);
  rango.setValues([faltantes]).setFontWeight('bold').setBackground('#0a1628').setFontColor('#ffffff');
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
