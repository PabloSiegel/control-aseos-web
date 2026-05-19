/**
 * Control de Aseos — Agrosuper
 * Backend Node.js/Express + Google Sheets API v4
 * Deploy: Render.com  |  Repo: GitHub
 */

const express      = require('express');
const cors         = require('cors');
const path         = require('path');
const nodemailer   = require('nodemailer');
const { google }   = require('googleapis');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Config ─────────────────────────────────────────────────────────────────
const SHEET_ID       = process.env.SHEET_ID       || '1Kf1mEOQ1sQUUD1N6pOlexz0mqBecIuo2aVUyllT9nrU';
const HOJA_REGISTROS = 'Registros';
const HOJA_RESUMEN   = 'Resumen';

// ── Google Auth ─────────────────────────────────────────────────────────────
function getAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error('Falta variable de entorno GOOGLE_SERVICE_ACCOUNT_JSON');
  const credentials = JSON.parse(raw);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheets() {
  const auth = getAuth();
  return google.sheets({ version: 'v4', auth });
}

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ─────────────────────────────────────────────────────────────────
function todayStr() {
  const d  = new Date();
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

function hexColor(estado) {
  return '#fce8e6'; // Solo se guardan NC → siempre rojo
}

async function ensureHeaders(sheets, spreadsheetId) {
  // Registros sheet
  try {
    const reg = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${HOJA_REGISTROS}!A1:K1`,
    });
    if (!reg.data.values || !reg.data.values[0]) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${HOJA_REGISTROS}!A1`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [['Timestamp','Fecha','Hora','Día','Subárea','Sector','Zona/Máquina','Componente','No Cumple','Acción realizada','Observación']],
        },
      });
    }
  } catch {
    // Sheet doesn't exist yet — it will be auto-created on first append
  }
}

async function colorearUltimasFilas(sheets, spreadsheetId, sheetId, n, rows, firstEstadoCol) {
  // Solo se guardan NC, siempre fondo rojo claro
  const bg = { red: 0.988, green: 0.910, blue: 0.902 };
  const requests = rows.map((_, i) => ({
    repeatCell: {
      range: {
        sheetId,
        startRowIndex: firstEstadoCol + i,
        endRowIndex:   firstEstadoCol + i + 1,
        startColumnIndex: 0,
        endColumnIndex: 11,
      },
      cell: { userEnteredFormat: { backgroundColor: bg } },
      fields: 'userEnteredFormat.backgroundColor',
    },
  }));
  if (requests.length) {
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  }
}

async function actualizarResumen(sheets, spreadsheetId, data) {
  // Solo se resumen No Cumple. Read existing Resumen
  let existing = [];
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${HOJA_RESUMEN}!A2:E`,
    });
    existing = res.data.values || [];
  } catch {
    // sheet doesn't exist yet
  }

  const mes = data.fecha.substring(0, 7); // 'yyyy-MM'
  const map = {};
  existing.forEach(r => {
    const key = `${r[0]}|${r[1]}|${r[2]}`;
    map[key] = { mes: r[0], subarea: r[1], sector: r[2]||'', nocumple: Number(r[3]||0) };
  });

  data.detalle.forEach(d => {
    if (d.estado !== 'No Cumple') return; // Solo NC
    const sector = d.sector || '';
    const key = `${mes}|${d.subarea}|${sector}`;
    if (!map[key]) map[key] = { mes, subarea: d.subarea, sector, nocumple: 0 };
    map[key].nocumple++;
  });

  const now  = new Date().toISOString();
  const rows = Object.values(map)
    .filter(r => r.nocumple > 0)
    .sort((a,b) => a.mes.localeCompare(b.mes) || a.subarea.localeCompare(b.subarea))
    .map(r => [r.mes, r.subarea, r.sector, r.nocumple, now]);

  // Clear and rewrite
  await sheets.spreadsheets.values.clear({ spreadsheetId, range: `${HOJA_RESUMEN}!A2:E` });
  if (rows.length) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${HOJA_RESUMEN}!A1`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [
          ['Mes','Subárea','Sector','No Cumple','Última actualización'],
          ...rows,
        ],
      },
    });
  }
}

// ── API Routes ──────────────────────────────────────────────────────────────

/**
 * GET /api/dashboard
 * Returns today's records → { registros: [{fecha,subarea,zona,componente,estado,cumple,nocumple}] }
 */
app.get('/api/dashboard', async (req, res) => {
  try {
    const sheets = await getSheets();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${HOJA_REGISTROS}!A2:K`,
    });
    const rows  = result.data.values || [];
    const today = todayStr();
    // Return last 3 days so frontend can detect locked subarea+fecha pairs
    const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 2);
    const cutStr = cutoff.getFullYear()+'-'+String(cutoff.getMonth()+1).padStart(2,'0')+'-'+String(cutoff.getDate()).padStart(2,'0');
    const registros = rows
      .filter(r => r[1] >= cutStr)
      .map(r => ({
        fecha     : r[1] || '',
        subarea   : r[4] || '',
        zona      : r[6] || '',
        componente: r[7] || '',
        estado    : r[8] || '',
        cumple    : r[8] === 'Cumple'    ? 1 : 0,
        nocumple  : r[8] === 'No Cumple' ? 1 : 0,
      }));
    res.json({ registros });
  } catch (err) {
    console.error('dashboard error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/registros
 * Body: { fecha, hora, dia, total, cumple, nocumple, detalle:[{subarea,zona,componente,estado,obs}] }
 */
app.post('/api/registros', async (req, res) => {
  try {
    const data   = req.body;
    const sheets = await getSheets();

    await ensureHeaders(sheets, SHEET_ID);

    const now = new Date().toISOString();

    // Solo guardar No Cumple en Registros
    const ncDetalle = data.detalle.filter(d => d.estado === 'No Cumple');
    const newRows   = ncDetalle.map(d => [
      now, data.fecha, data.hora, data.dia,
      d.subarea, d.sector||'', d.zona, d.componente, 'No Cumple', d.accion||'', d.obs || '',
    ]);

    if (newRows.length > 0) {
      // Append rows
      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${HOJA_REGISTROS}!A1`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: newRows },
      });

      // Color rows (get current row count first for sheetId)
      try {
        const meta = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
        const sheet = meta.data.sheets.find(s => s.properties.title === HOJA_REGISTROS);
        if (sheet) {
          const total = await sheets.spreadsheets.values.get({
            spreadsheetId: SHEET_ID,
            range: `${HOJA_REGISTROS}!A:A`,
          });
          const rowCount    = (total.data.values || []).length;
          const firstNewRow = rowCount - newRows.length;
          await colorearUltimasFilas(sheets, SHEET_ID, sheet.properties.sheetId, newRows.length, newRows, firstNewRow);
        }
      } catch (colorErr) {
        console.warn('colorear error (no crítico):', colorErr.message);
      }
    }

    // Actualizar Resumen (solo con NC, pero pasamos data completa para contexto)
    await actualizarResumen(sheets, SHEET_ID, data);

    res.json({ ok: true, rows: newRows.length });
  } catch (err) {
    console.error('guardar error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Email ───────────────────────────────────────────────────────────────────

function getTransporter() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });
}

const DESTINATARIOS = [
  'operaciones@fulservice.cl',
  'hsanmartin@fulservice.cl',
  'calidad@fulservice.cl',
  'analistacalidad@fulservice.cl',
];

function formatFechaLarga(fechaStr) {
  const dias   = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const meses  = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
  const [y,m,d] = fechaStr.split('-').map(Number);
  const fecha  = new Date(y, m-1, d);
  return `${dias[fecha.getDay()]} ${d} de ${meses[m-1]} de ${y}`;
}

function buildEmailHtml(fecha, hallazgos) {
  const fechaLarga = formatFechaLarga(fecha);
  const total      = hallazgos.length;

  // Agrupar por subarea+sector
  const grupos = {};
  hallazgos.forEach(h => {
    const key = `${h.subarea}|||${h.sector}`;
    if (!grupos[key]) grupos[key] = { subarea: h.subarea, sector: h.sector, items: [] };
    grupos[key].items.push(h);
  });

  const COLORES_SUBAREA = { 'Hamburguesas':'#8B0000', 'Empanizado':'#cc5500', 'Cocidos':'#1a5fa8' };
  const EMOJIS_SUBAREA  = { 'Hamburguesas':'🍔', 'Empanizado':'🍗', 'Cocidos':'🔥' };

  let tablas = '';
  Object.values(grupos).forEach(g => {
    const color = COLORES_SUBAREA[g.subarea] || '#555555';
    const emoji = EMOJIS_SUBAREA[g.subarea]  || '🏭';
    const filas = g.items.map((h, i) => `
      <tr style="background:${i%2===0?'#ffffff':'#fafafa'};">
        <td style="padding:10px 12px;font-size:13px;color:#333;border-bottom:1px solid #f0f0f0;">${h.zona}</td>
        <td style="padding:10px 12px;font-size:13px;color:#333;border-bottom:1px solid #f0f0f0;">${h.componente}</td>
        <td style="padding:10px 12px;font-size:13px;color:#1a7a1a;border-bottom:1px solid #f0f0f0;">${h.accion || '—'}</td>
        ${h.obs ? `<td style="padding:10px 12px;font-size:12px;color:#777;border-bottom:1px solid #f0f0f0;font-style:italic;">${h.obs}</td>` : '<td style="padding:10px 12px;font-size:12px;color:#ccc;border-bottom:1px solid #f0f0f0;">—</td>'}
      </tr>`).join('');

    tablas += `
      <div style="margin-bottom:20px;">
        <div style="background:${color};color:#fff;padding:8px 14px;border-radius:6px 6px 0 0;font-size:12px;font-weight:700;letter-spacing:1px;text-transform:uppercase;">
          ${emoji} ${g.subarea} — ${g.sector}
        </div>
        <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e0e0e0;border-top:none;border-radius:0 0 6px 6px;overflow:hidden;">
          <tr style="background:#f9f9f9;">
            <th style="padding:8px 12px;font-size:11px;color:#666;text-align:left;font-weight:600;border-bottom:1px solid #e8e8e8;width:20%;">Zona / Máquina</th>
            <th style="padding:8px 12px;font-size:11px;color:#666;text-align:left;font-weight:600;border-bottom:1px solid #e8e8e8;width:25%;">Componente</th>
            <th style="padding:8px 12px;font-size:11px;color:#666;text-align:left;font-weight:600;border-bottom:1px solid #e8e8e8;width:30%;">Acción realizada</th>
            <th style="padding:8px 12px;font-size:11px;color:#666;text-align:left;font-weight:600;border-bottom:1px solid #e8e8e8;width:25%;">Observación</th>
          </tr>
          ${filas}
        </table>
      </div>`;
  });

  const areasSet   = [...new Set(hallazgos.map(h => h.subarea))];
  const ahora      = new Date();
  const horaGen    = `${String(ahora.getHours()).padStart(2,'0')}:${String(ahora.getMinutes()).padStart(2,'0')} hrs.`;
  const fechaGen   = formatFechaLarga(fecha.replace(/-\d{2}$/, m => m).split('-').map((v,i)=>i===2?String(ahora.getDate()).padStart(2,'0'):v).join('-'));

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f4;padding:30px 0;">
  <tr><td align="center">
    <table width="620" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
      <tr>
        <td style="background:#8B0000;padding:28px 36px;">
          <table width="100%" cellpadding="0" cellspacing="0"><tr>
            <td>
              <p style="margin:0;color:#fff;font-size:11px;letter-spacing:2px;text-transform:uppercase;opacity:0.8;">Sistema de Control de Aseos</p>
              <h1 style="margin:6px 0 0;color:#fff;font-size:22px;font-weight:700;">Reporte de Hallazgos</h1>
            </td>
            <td align="right">
              <div style="background:rgba(255,255,255,0.15);border-radius:8px;padding:10px 16px;text-align:center;">
                <p style="margin:0;color:#fff;font-size:10px;opacity:0.8;">Fecha del reporte</p>
                <p style="margin:4px 0 0;color:#fff;font-size:14px;font-weight:700;">${fechaLarga}</p>
              </div>
            </td>
          </tr></table>
        </td>
      </tr>
      <tr><td style="padding:28px 36px 10px;">
        <p style="margin:0;font-size:15px;color:#333;line-height:1.7;">
          Buenos días,<br><br>
          Junto con saludar, se hace envío del <strong>reporte de hallazgos de No Cumplimiento</strong> correspondiente al día de ayer. A continuación se detallan los componentes que presentaron observaciones durante la jornada, junto con las acciones realizadas en cada caso.
        </p>
      </td></tr>
      <tr><td style="padding:16px 36px;">
        <table cellpadding="0" cellspacing="0"><tr>
          <td style="background:#fff5f5;border:1px solid #ffc0c0;border-radius:6px;padding:10px 20px;text-align:center;">
            <p style="margin:0;font-size:11px;color:#cc0000;text-transform:uppercase;letter-spacing:1px;">Total hallazgos</p>
            <p style="margin:4px 0 0;font-size:26px;font-weight:700;color:#8B0000;">${total}</p>
          </td>
          <td width="12"></td>
          <td style="background:#f0f7ff;border:1px solid #b0d0f0;border-radius:6px;padding:10px 20px;text-align:center;">
            <p style="margin:0;font-size:11px;color:#1a5fa8;text-transform:uppercase;letter-spacing:1px;">Áreas afectadas</p>
            <p style="margin:4px 0 0;font-size:26px;font-weight:700;color:#1a5fa8;">${areasSet.length}</p>
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:8px 36px 28px;">${tablas || '<p style="color:#888;font-size:14px;text-align:center;padding:20px 0;">✅ Sin hallazgos registrados el día de ayer.</p>'}</td></tr>
      <tr><td style="padding:0 36px;"><div style="height:1px;background:#eeeeee;"></div></td></tr>
      <tr><td style="padding:20px 36px 28px;">
        <p style="margin:0;font-size:13px;color:#888;line-height:1.6;">
          Este reporte es generado automáticamente por el <strong style="color:#555;">Sistema de Control de Aseos — Agrosuper</strong>.<br>
          Para consultas o correcciones, contacte al equipo de calidad.
        </p>
        <p style="margin:12px 0 0;font-size:12px;color:#bbb;">📅 Generado el ${fechaGen} a las ${horaGen}</p>
      </td></tr>
      <tr><td style="background:#8B0000;padding:12px 36px;">
        <p style="margin:0;font-size:11px;color:rgba(255,255,255,0.6);text-align:center;">AGROSUPER · Control de Aseos · Reporte Automático</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;
}

/**
 * GET /api/send-report?fecha=YYYY-MM-DD&to=correo (optional overrides)
 * Reads yesterday's NC from Sheets and emails the report.
 */
app.get('/api/send-report', async (req, res) => {
  try {
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) {
      return res.status(500).json({ error: 'Faltan EMAIL_USER y EMAIL_PASS en variables de entorno.' });
    }

    const sheets = await getSheets();

    // Calcular fecha de ayer
    const ayer = new Date(); ayer.setDate(ayer.getDate() - 1);
    const fecha = req.query.fecha ||
      `${ayer.getFullYear()}-${String(ayer.getMonth()+1).padStart(2,'0')}-${String(ayer.getDate()).padStart(2,'0')}`;

    // Leer registros
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${HOJA_REGISTROS}!A2:K`,
    });
    const rows = (result.data.values || []).filter(r => r[1] === fecha);

    const hallazgos = rows.map(r => ({
      subarea   : r[4] || '',
      sector    : r[5] || '',
      zona      : r[6] || '',
      componente: r[7] || '',
      accion    : r[9] || '',
      obs       : r[10] || '',
    }));

    const html    = buildEmailHtml(fecha, hallazgos);
    const fechaLarga = formatFechaLarga(fecha);
    const subject = `🧹 Reporte de Hallazgos — ${fechaLarga.charAt(0).toUpperCase() + fechaLarga.slice(1)}`;
    const to      = req.query.to ? [req.query.to] : DESTINATARIOS;

    const transporter = getTransporter();
    await transporter.sendMail({
      from   : `"Control de Aseos Agrosuper" <${process.env.EMAIL_USER}>`,
      to     : to.join(', '),
      subject,
      html,
    });

    console.log(`Reporte enviado para fecha ${fecha} → ${to.join(', ')}`);
    res.json({ ok: true, fecha, hallazgos: hallazgos.length, destinatarios: to });
  } catch (err) {
    console.error('send-report error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── SPA fallback ────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Control de Aseos corriendo en http://0.0.0.0:${PORT}`);
});
