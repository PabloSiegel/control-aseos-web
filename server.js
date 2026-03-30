/**
 * Control de Aseos — Agrosuper
 * Backend Node.js/Express + Google Sheets API v4
 * Deploy: Render.com  |  Repo: GitHub
 */

const express    = require('express');
const cors       = require('cors');
const path       = require('path');
const { google } = require('googleapis');

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
      range: `${HOJA_REGISTROS}!A1:J1`,
    });
    if (!reg.data.values || !reg.data.values[0]) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${HOJA_REGISTROS}!A1`,
        valueInputOption: 'RAW',
        requestBody: {
          values: [['Timestamp','Fecha','Hora','Día','Subárea','Sector','Zona/Máquina','Componente','No Cumple','Observación']],
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
        endColumnIndex: 10,
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
      range: `${HOJA_REGISTROS}!A2:J`,
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
      d.subarea, d.sector||'', d.zona, d.componente, 'No Cumple', d.obs || '',
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

// ── SPA fallback ────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ───────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Control de Aseos corriendo en http://0.0.0.0:${PORT}`);
});
