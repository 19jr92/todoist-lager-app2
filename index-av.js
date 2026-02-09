import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import QRCode from 'qrcode';
import crypto from 'crypto';
import PDFDocument from 'pdfkit';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import avRoutes from "./av/avRoutes.js";

// Pfade ermitteln (für logo.png)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const {
  PORT = 3000,
  BASE_URL,
  TODOIST_TOKEN,
  PROJECT_ID,
  SIGNING_SECRET,
  ADMIN_USER,
  ADMIN_PASS,
  LOGO_PATH, // optional
} = process.env;

if (!BASE_URL || !TODOIST_TOKEN || !SIGNING_SECRET || !PROJECT_ID || !ADMIN_USER || !ADMIN_PASS) {
  console.error(
    'Bitte Env vollständig ausfüllen: BASE_URL, TODOIST_TOKEN, PROJECT_ID, SIGNING_SECRET, ADMIN_USER, ADMIN_PASS.'
  );
  process.exit(1);
}

// Standard-Pfad zum Logo: logo.png im Projektordner
const RESOLVED_LOGO_PATH =
  LOGO_PATH && LOGO_PATH.trim().length > 0
    ? LOGO_PATH
    : path.join(__dirname, 'logo.png');

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(avRoutes);

/* =========================
   Helper: mm -> Punkte
   ========================= */
const mm = (v) => v * 2.835; // 1 mm ~ 2.835pt
/* =========================
   Ausbuch-Log (lokal)
   ========================= */

// Render: persistentes Dateisystem gibt's nur eingeschränkt.
// Für den Anfang ok. Später könnten wir auf Render-Postgres umstellen.
const LOG_FILE = path.join(__dirname, 'ausbuch-log.json');

function readOutLog() {
  try {
    if (!fs.existsSync(LOG_FILE)) return {};
    const raw = fs.readFileSync(LOG_FILE, 'utf8');
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    console.error('Log lesen fehlgeschlagen:', e.message);
    return {};
  }
}

function writeOutLog(logObj) {
  try {
    fs.writeFileSync(LOG_FILE, JSON.stringify(logObj, null, 2), 'utf8');
  } catch (e) {
    console.error('Log schreiben fehlgeschlagen:', e.message);
  }
}

// taskId -> ISO timestamp
function setCompletedInLog(taskId, isoDateString) {
  const logObj = readOutLog();
  logObj[String(taskId)] = isoDateString;
  writeOutLog(logObj);
}

function getCompletedFromLog(taskId) {
  const logObj = readOutLog();
  return logObj[String(taskId)] || null;
}

/* =========================
   Basic Auth für geschützte Routen
   ========================= */

function basicAuth(req, res, next) {
  // öffentliche Routen: Health + QR-Complete
  if (
  req.path.startsWith('/health') ||
  req.path.startsWith('/scan') ||
  req.path.startsWith('/complete')
) {
  return next();
}


  const authHeader = req.headers.authorization || '';

  if (!authHeader.startsWith('Basic ')) {
    res.set('WWW-Authenticate', 'Basic realm="LagerApp"');
    return res.status(401).send('Authentifizierung erforderlich.');
  }

  const base64 = authHeader.substring(6);
  const [user, pass] = Buffer.from(base64, 'base64').toString('utf8').split(':');

  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="LagerApp"');
  return res.status(401).send('Ungültige Zugangsdaten.');
}

// Basic Auth auf alles anwenden, außer explizit freigegebene Routen
app.use(basicAuth);

/* =========================
   Todoist Client
   ========================= */

const td = axios.create({
  baseURL: 'https://api.todoist.com/rest/v2',
  headers: { Authorization: `Bearer ${TODOIST_TOKEN}` },
});

function signTaskId(taskId) {
  return crypto.createHmac('sha256', SIGNING_SECRET).update(String(taskId)).digest('hex');
}

async function createTodoistTask(content, labelNames = []) {
  const payload = { content };

  const projectIdNum = Number(PROJECT_ID);
  if (Number.isFinite(projectIdNum)) {
    payload.project_id = projectIdNum;
  } else {
    console.warn(
      'WARNUNG: PROJECT_ID ist keine gültige Zahl, Aufgabe landet im Eingang. PROJECT_ID =',
      PROJECT_ID
    );
  }

  // NEU: Labels als Namen (Strings), nicht als IDs
  if (Array.isArray(labelNames) && labelNames.length > 0) {
    payload.labels = labelNames;
  }

  const res = await td.post('/tasks', payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  return res.data;
}



async function closeTask(taskId) {
  await td.post(`/tasks/${taskId}/close`);
}
async function getTask(taskId) {
  const res = await td.get(`/tasks/${taskId}`);
  return res.data;
}


// ✅ NEU: alle offenen Aufgaben einer Kommission (Label) holen
async function listOpenTasksByLabel(labelName) {
  // /tasks liefert ohnehin nur NICHT erledigte Aufgaben.
  // Daher: nur nach Label filtern.
  const res = await td.get('/tasks', {
    params: {
      filter: `@${labelName}`
    }
  });
  return res.data || [];
}


// ✅ NEU: Sortierung nach Priorität → alphabetisch
function sortTasksByPriorityAndName(tasks) {
  return [...tasks].sort((a, b) => {
    // Todoist: priority 4 = höchste Priorität
    if (a.priority !== b.priority) {
      return b.priority - a.priority;
    }
    return a.content.localeCompare(b.content, 'de');
  });
}


/* =========================
   Healthcheck (öffentlich)
   ========================= */

app.get('/health', (_req, res) => {
  res.send('OK');
});

/* =========================
   /complete Endpoint (öffentlich)
   ========================= */

app.get('/complete/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { sig } = req.query;

    const expected = signTaskId(taskId);
    if (!sig || sig !== expected) {
      return res.status(403).send('Ungültige Signatur.');
    }
    const completedAtIso = getCompletedFromLog(taskId);
if (completedAtIso) {
  const dt = new Date(completedAtIso);
  const completedAtDE = new Intl.DateTimeFormat('de-DE', {
    dateStyle: 'short',
    timeStyle: 'medium',
  }).format(dt);

  return res.type('html').send(`
    <!doctype html>
    <html lang="de">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Bereits ausgebucht</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 2rem; text-align:center; }
        .box { max-width: 520px; margin: 0 auto; border: 1px solid #ddd; border-radius: 12px; padding: 20px; }
      </style>
    </head>
    <body>
      <div class="box">
        <h1>ℹ️ Palette bereits ausgebucht</h1>
        <p>Diese Palette wurde am <b>${completedAtDE}</b> ausgebucht.</p>
        <button onclick="window.close()">Fenster schließen</button>
      </div>
    </body>
    </html>
  `);
}


    await closeTask(taskId);
    await closeTask(taskId);

return res.type('html').send(`
  <!doctype html>
  <html lang="de">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Ausbuchung</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 2rem; text-align:center; }
      .box { max-width: 520px; margin: 0 auto; border: 1px solid #ddd; border-radius: 12px; padding: 20px; }
      h1 { margin-top: 0; }
      button { padding: 12px 16px; border-radius: 10px; border: 0; cursor: pointer; }
    </style>
  </head>
  <body>
    <div class="box">
      <h1>✅ Ware erfolgreich ausgebucht</h1>
      <button onclick="window.close()">Fenster schließen</button>
      <p style="font-size:12px;color:#666;margin-top:14px;">
        Falls das nicht geht: Tab schließen oder Zurück.
      </p>
    </div>
  </body>
  </html>
`);

  } catch (err) {
    console.error('Complete-Fehler:', err?.response?.data || err.message);
    res.status(500).send('Fehler beim Schließen der Aufgabe.');
  }
});
app.get('/scan/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { sig } = req.query;

    const expected = signTaskId(taskId);
    if (!sig || sig !== expected) {
      return res.status(403).send('Ungültige Signatur.');
    }

    // ✅ NEU: Schon ausgebucht? -> sofort Info anzeigen, nicht erneut fragen
    const completedAtIso = getCompletedFromLog(taskId);
    if (completedAtIso) {
      const dt = new Date(completedAtIso);
      const completedAtDE = new Intl.DateTimeFormat('de-DE', {
        dateStyle: 'short',
        timeStyle: 'medium',
      }).format(dt);

      return res.type('html').send(`
        <!doctype html>
        <html lang="de">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Bereits ausgebucht</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 2rem; text-align:center; }
            .box { max-width: 520px; margin: 0 auto; border: 1px solid #ddd; border-radius: 12px; padding: 20px; }
            button { padding: 12px 16px; border-radius: 10px; border: 0; cursor: pointer; }
          </style>
        </head>
        <body>
          <div class="box">
            <h1>ℹ️ Palette bereits ausgebucht</h1>
            <p>Diese Palette wurde am <b>${completedAtDE}</b> ausgebucht.</p>
            <button onclick="window.close()">Fenster schließen</button>
          </div>
        </body>
        </html>
      `);
    }

    // sonst normal fragen:
    return res.type('html').send(`
      <!doctype html>
      <html lang="de">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Ware ausbuchen?</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 2rem; }
          .box { max-width: 420px; margin: 0 auto; }
          h1 { font-size: 1.4rem; }
          button { width: 100%; padding: 1rem; margin-top: .75rem; font-size: 1.1rem; }
          .yes { font-weight: bold; }
        </style>
      </head>
      <body>
        <div class="box">
          <h1>Ware ausbuchen?</h1>
          <form method="POST" action="/scan/${taskId}?sig=${sig}">
            <button class="yes" type="submit" name="answer" value="yes">Ja</button>
            <button type="submit" name="answer" value="no">Nein</button>
          </form>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Scan-Fehler:', err?.response?.data || err.message);
    res.status(500).send('Fehler beim Laden der Scan-Seite.');
  }
});


app.post('/scan/:taskId', async (req, res) => {
  try {
    const { taskId } = req.params;
    const { sig } = req.query;
    const { answer } = req.body;

    const expected = signTaskId(taskId);
    if (!sig || sig !== expected) {
      return res.status(403).send('Ungültige Signatur.');
    }

    if (answer === 'yes') {
      let labelName = null;
try {
  const t = await getTask(taskId);
  // Todoist REST: labels sind Namen (Strings)
  if (Array.isArray(t.labels) && t.labels.length > 0) {
    labelName = t.labels[0]; // Kommission-Label (bei dir genau 1)
  }
} catch (e) {
  console.warn('Konnte Task nicht laden (Label unbekannt):', e?.response?.data || e.message);
}

// 1) Aufgabe in Todoist schließen
      try {
        await closeTask(taskId);
      } catch (e) {
        console.error('Todoist closeTask Fehler:', e?.response?.data || e.message);

        return res.status(502).type('html').send(`
          <!doctype html>
          <html lang="de">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>Fehler</title>
            <style>
              body { font-family: Arial, sans-serif; margin: 2rem; text-align:center; }
              .box { max-width: 520px; margin: 0 auto; border: 1px solid #ddd; border-radius: 12px; padding: 20px; }
            </style>
          </head>
          <body>
            <div class="box">
              <h1>⚠️ Ausbuchung fehlgeschlagen</h1>
              <p>Die Aufgabe konnte gerade nicht in Todoist erledigt werden.</p>
              <p>Bitte nochmal scannen oder später erneut versuchen.</p>
            </div>
          </body>
          </html>
        `);
      }

      // 2) ✅ Ausbuch-Datum im eigenen Log speichern
      const completedAt = new Date().toISOString();
      setCompletedInLog(taskId, completedAt);
        let remaining = [];
if (labelName) {
  try {
    remaining = await listOpenTasksByLabel(labelName);
    remaining = sortTasksByPriorityAndName(remaining);

  } catch (e) {
    console.error('Fehler beim Laden restlicher Paletten:', e?.response?.data || e.message);
  }
}

      // 3) Erfolg anzeigen
      if (!labelName) {
  return res.type('html').send(`
    <!doctype html>
    <html lang="de">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Ausbuchung</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 2rem; text-align:center; }
        .box { max-width: 720px; margin: 0 auto; border: 1px solid #ddd; border-radius: 12px; padding: 20px; }
      </style>
    </head>
    <body>
      <div class="box">
        <h1>✅ Ware erfolgreich ausgebucht</h1>
        <p>Die Aufgabe wurde erledigt.</p>
        <p><b>Hinweis:</b> Kommissions-Label konnte nicht ermittelt werden, daher keine Restliste.</p>
        <button onclick="window.close()">Fenster schließen</button>
      </div>
    </body>
    </html>
  `);
}

if (remaining.length === 0) {
  return res.type('html').send(`
    <!doctype html>
    <html lang="de">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Ausbuchung</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 2rem; text-align:center; }
        .box { max-width: 720px; margin: 0 auto; border: 1px solid #ddd; border-radius: 12px; padding: 20px; }
      </style>
    </head>
    <body>
      <div class="box">
        <h1>✅ Ware erfolgreich ausgebucht</h1>
        <p><b>Alle Paletten der Kommission wurden verladen.</b></p>
        <button onclick="window.close()">Fenster schließen</button>
      </div>
    </body>
    </html>
  `);
}

// Liste bauen (Priorität + Text)
const rows = remaining.map(t => {
  // Todoist: 4 höchste -> Anzeige als "Prio 1"
  const prioAnzeige = (5 - (t.priority || 1));
  const safeText = String(t.content || '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<tr><td style="padding:8px; border-bottom:1px solid #eee; width:90px;"><b>Prio ${prioAnzeige}</b></td>
              <td style="padding:8px; border-bottom:1px solid #eee;">${safeText}</td></tr>`;
}).join('');

return res.type('html').send(`
  <!doctype html>
  <html lang="de">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Ausbuchung</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 2rem; }
      .box { max-width: 720px; margin: 0 auto; border: 1px solid #ddd; border-radius: 12px; padding: 20px; }
      h1 { margin-top: 0; }
      table { width:100%; border-collapse: collapse; margin-top: 12px; }
      .small { color:#666; font-size: 12px; margin-top: 10px; }
      button { margin-top: 16px; padding: 12px 16px; border-radius: 10px; border: 0; cursor: pointer; }
    </style>
  </head>
  <body>
    <div class="box">
      <h1>✅ Ware erfolgreich ausgebucht</h1>
      <h2>Weitere Paletten zu dieser Kommission</h2>
      <div class="small">Sortierung: Priorität (hoch→niedrig), dann alphabetisch</div>
      <table>${rows}</table>
      <button onclick="window.close()">Fenster schließen</button>
    </div>
  </body>
  </html>
`);

    }

    // answer === 'no' oder alles andere:
    return res.type('html').send(`
      <!doctype html>
      <html lang="de">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Abgebrochen</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 2rem; text-align:center; }
          .box { max-width: 520px; margin: 0 auto; border: 1px solid #ddd; border-radius: 12px; padding: 20px; }
        </style>
      </head>
      <body>
        <div class="box">
          <h2>Abgebrochen – Palette wurde nicht ausgebucht.</h2>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error('Scan-POST Fehler:', err?.response?.data || err.message);
    res.status(500).send('Fehler beim Verarbeiten der Scan-Antwort.');
  }
});


/* =========================
   Formular (geschützt durch Basic Auth)
   ========================= */

app.get("/", (_req, res) => {
  return res.redirect("/av");
});


/* =========================
   PDF + Tasks erzeugen (geschützt)
   ========================= */
/* =========================
   Normalisierung Projekt & Zeichnung
   ========================= */

// Projekt: "XXYY1234" oder "XXYY1234K"
function normalizeProject(raw) {
  if (!raw) return '';

  // alles groß, alle Nicht-Alphanumerischen raus
  let s = raw.toUpperCase().replace(/[^A-Z0-9K]/g, '').trim();

  // Optionales K am Ende merken
  let hasK = s.endsWith('K');
  if (hasK) s = s.slice(0, -1);

  // Buchstaben + Ziffern trennen
  const letters = (s.match(/[A-Z]/g) || []).join('');
  const digits = (s.match(/\d/g) || []).join('');

  // 4 Buchstaben + 4 Ziffern rekonstruieren, soweit vorhanden
  const partLetters = (letters + 'XXXX').slice(0, 4); // notfalls auffüllen
  const partDigits = (digits + '0000').slice(0, 4);

  let result = partLetters + partDigits;
  if (hasK) result += 'K';

  return result;
}

// Freitext → Titel-Schreibweise: "tür vorne rechts" -> "Tür Vorne Rechts"
function toTitleCase(str) {
  return str
    .trim()
    .split(/\s+/)
    .map((w) =>
      w ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : ''
    )
    .join(' ');
}

// Zeichnung: BL-Codes + Freitext erkennen und aufbereiten
function normalizeDrawing(raw) {
  if (!raw) return '';

  const input = raw.trim();

  const tokens = [];
  const re = /[Bb][Ll]\s*\d+/g;
  let lastIndex = 0;
  let match;

  // BL-Codes und Freitext in der ursprünglichen Reihenfolge aufteilen
  while ((match = re.exec(input)) !== null) {
    const pre = input.slice(lastIndex, match.index).trim();
    if (pre) {
      tokens.push({ type: 'text', value: pre });
    }
    tokens.push({ type: 'bl', value: match[0] });
    lastIndex = match.index + match[0].length;
  }
  const tail = input.slice(lastIndex).trim();
  if (tail) {
    tokens.push({ type: 'text', value: tail });
  }

  if (tokens.length === 0) {
    // nur Freitext, kein "BL"
    return toTitleCase(input);
  }

  const resultParts = tokens.map((t) => {
    if (t.type === 'bl') {
      // BL-Code normalisieren
      let s = t.value.toUpperCase().replace(/\s+/g, '');
      // s z.B. "BL1", "BL07", "BL123"
      let num = s.slice(2).replace(/\D/g, '');
      if (!num) num = '0';
      // zweistellig, letzte 2 Zeichen
      num = num.padStart(2, '0').slice(-2);
      return 'BL' + num;
    } else {
      // Freitext: Title Case
      return toTitleCase(t.value);
    }
  });

  return resultParts.join(', ');
}
/* =========================
   Todoist Label-Handling
   ========================= */

const labelCache = new Map();

async function ensureProjectLabelId(labelName) {
  if (labelCache.has(labelName)) {
    return labelCache.get(labelName);
  }

  // alle Labels laden
  const res = await td.get('/labels');
  const labels = res.data || res.body || [];

  const existing = labels.find((l) => l.name === labelName);
  if (existing) {
    labelCache.set(labelName, existing.id);
    return existing.id;
  }

  // neues Label anlegen
  const createRes = await td.post('/labels', { name: labelName }, {
    headers: { 'Content-Type': 'application/json' },
  });
  const created = createRes.data;
  labelCache.set(labelName, created.id);
  return created.id;
}

app.post('/make-labels', async (req, res) => {
  try {
    const rawProject = (req.body.project || '').trim();
    const rawDrawing = (req.body.drawing || '').trim();
    let count = parseInt(req.body.count, 10);
    const packer = (req.body.packer || '').trim();

    // NEU: Projekt & Zeichnung normalisieren
    const project = normalizeProject(rawProject);
    const drawing = normalizeDrawing(rawDrawing);

    if (!project || !drawing || !Number.isFinite(count)) {
      return res.status(400).send('Bitte Projekt, Zeichnung und Anzahl korrekt angeben.');
}


    count = Math.max(1, Math.min(50, count));
    const createdAt = new Date();
    const ts = new Intl.DateTimeFormat('de-DE', {
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(createdAt);

    // Seitenformat: 100 x 150 mm (Hochformat)
    const pageW = mm(100);
    const pageH = mm(150);

    const doc = new PDFDocument({
      autoFirstPage: false,
    });

    const filename = `Labels_${rawProject}_${rawDrawing}_${createdAt
      .toISOString()
      .replace(/[:.]/g, '-')}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.pipe(res);

    const projectAndDrawing = `${project} – ${drawing}`;

    // Helper: Text in EINE Zeile passend machen
    const fitOneLine = (text, fontName, maxPt, minPt, boxWidth) => {
      doc.font(fontName);
      for (let size = maxPt; size >= minPt; size--) {
        if (doc.fontSize(size).widthOfString(text) <= boxWidth) return size;
      }
      return minPt;
    };

    for (let i = 1; i <= count; i++) {
      doc.addPage({ size: [pageW, pageH] });

      // ---------- Rahmen außen ----------
      const outerMargin = mm(2);
      const outerX = outerMargin;
      const outerY = outerMargin;
      const outerW = pageW - 2 * outerMargin;
      const outerH = pageH - 2 * outerMargin;

      doc.lineWidth(1);
      doc.rect(outerX, outerY, outerW, outerH).stroke();

      // ---------- Balkenhöhen (angepasst an PPTX) ----------
      const barHeight = mm(25);     // Projekt
      const barHeight2 = mm(25);    // Zeichnung
      const barHeight3 = mm(22);    // Paletten-Balken

      const projectY = outerY;
      const drawingY = projectY + barHeight;
      const palletBarY = drawingY + barHeight2;

      const barX = outerX;
      const barW = outerW;

      // ===== 1) Projekt-Balken =====
      doc.lineWidth(1.5);
      doc.rect(barX, projectY, barW, barHeight).stroke();

      const projFontSize = fitOneLine(project, 'Helvetica-Bold', 66, 14, barW - mm(4));
      doc.font('Helvetica-Bold').fontSize(projFontSize);
      doc.text(project, barX + mm(2), projectY + mm(4), {
        width: barW - mm(4),
        align: 'center',
      });

      // ===== 2) Zeichnungs-Balken =====
      doc.rect(barX, drawingY, barW, barHeight2).stroke();

      const drawFontSize = fitOneLine(drawing, 'Helvetica-Bold', 66, 14, barW - mm(4));
      doc.font('Helvetica-Bold').fontSize(drawFontSize);
      doc.text(drawing, barX + mm(2), drawingY + mm(4), {
        width: barW - mm(4),
        align: 'center',
      });
// ===== 3) Paletten-Balken mit "Palette" + großer 1/x =====
doc.rect(barX, palletBarY, barW, barHeight3).stroke();

// "Palette" klein, IM Balken oben links
doc.font('Helvetica-Bold').fontSize(10);
const paletteLabelY = palletBarY + mm(3);
doc.text('Palette', barX + mm(4), paletteLabelY, { lineBreak: false });

// Große 1/x mittig im Balken, mit Abstand zur oberen Linie
const fracText = `${i}/${count}`;
const fracFontSize = fitOneLine(fracText, 'Helvetica-Bold', 66, 18, barW - mm(4));
doc.font('Helvetica-Bold').fontSize(fracFontSize);

const fracLineHeight = doc.currentLineHeight();
// um ~2 mm nach unten schieben, damit es nicht an der Linie klebt
const fracTextY =
  palletBarY + (barHeight3 - fracLineHeight) / 2 + mm(2);

doc.text(fracText, barX + mm(2), fracTextY, {
  width: barW - mm(4),
  align: 'center',
});



      // ===== 5) QR-Code zentriert darunter =====
      const qrSize = mm(50);
      const qrX = outerX + (outerW - qrSize) / 2;
      // QR direkt unter dem Paletten-Balken
      const qrY = palletBarY + barHeight3 + mm(4);


      // Todoist-Aufgabe für diese Palette
      const taskTitle = `${projectAndDrawing} – Palette ${i}/${count}`;
      const task = await createTodoistTask(taskTitle, [project]);
      const taskId = task.id;

      const sig = signTaskId(taskId);
      const base = BASE_URL.replace(/\/$/, '');
      const completeUrl = `${base}/scan/${taskId}?sig=${sig}`;
      const qrPng = await QRCode.toBuffer(completeUrl, { type: 'png', margin: 0 });

      // Rahmen für QR wie in der PPTX
      doc.lineWidth(1);
      doc.rect(qrX, qrY, qrSize, qrSize).stroke();
      doc.image(qrPng, qrX, qrY, { width: qrSize, height: qrSize });

      // ===== 6) Footer: Datum/Kürzel links, Logo rechts =====
      const footerTop = qrY + qrSize + mm(4);

      const footerText = packer ? `Erstellt: ${ts} · ${packer}` : `Erstellt: ${ts}`;
      doc.font('Helvetica').fontSize(9);
      // Einfach, ohne width/align → kein Pagebreak
      doc.text(footerText, barX + mm(2), footerTop, {
        lineBreak: false,
      });

      // Logo rechts, proportional skaliert
      const logoMaxW = mm(18);
      const logoMaxH = mm(10);
      const logoX = outerX + outerW - logoMaxW - mm(2);
      const logoY = footerTop - mm(2);

      try {
        doc.image(RESOLVED_LOGO_PATH, logoX, logoY, {
          fit: [logoMaxW, logoMaxH],
          align: 'right',
          valign: 'top',
        });
      } catch (e) {
        console.warn('Logo konnte nicht geladen werden:', e.message);
      }

      // Nichts mehr nach unten zeichnen → garantiert auf einer Seite
    }

    doc.end();
  } catch (e) {
    console.error('make-labels Fehler:', e?.response?.data || e.message);
    res.status(500).send('Fehler beim Erzeugen der Labels. Details in der Server-Konsole.');
  }
});





/* =========================
   Start Server
   ========================= */
app.get("/av", (_req, res) => {
  return res.type("html").send(`
    <!doctype html>
    <html lang="de">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>AV – Ladeliste</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 2rem; }
        .box { max-width: 520px; margin: 0 auto; border: 1px solid #ddd; border-radius: 12px; padding: 20px; }
        h1 { margin-top: 0; font-size: 1.4rem; }
        label { display:block; margin-top: 12px; margin-bottom: 6px; font-weight: bold; }
        select, input { width: 100%; padding: 12px; border-radius: 10px; border: 1px solid #ccc; }
        button { width: 100%; padding: 1rem; margin-top: .75rem; font-size: 1.1rem; border-radius: 10px; border: 0; cursor: pointer; }
        .primary { font-weight: bold; }
        .row { display:flex; gap:10px; margin-top: .75rem; }
        .row button { width: 50%; }
        .muted { font-size:12px; color:#666; margin-top:14px; }
        .hide { display:none; }
        .printBtn {
  padding: 14px 16px;
  font-size: 1.05rem;
  border-radius: 12px;
  width: 100%;
}

/* Druckbereich */
#printArea {
  display: none;
}

@media print {
  /* erst alles unsichtbar machen (aber Layout bleibt existierend) */
  body * {
    visibility: hidden !important;
  }

  /* nur den Printbereich sichtbar machen */
  #printArea, #printArea * {
    visibility: visible !important;
  }

  /* Printbereich fix auf die Seite legen */
  #printArea {
    display: block !important;
    position: fixed;
    left: 0;
    top: 0;
    right: 0;
    padding: 20mm;
    background: #fff;
    font-family: Arial, sans-serif;
  }

  .printTitle {
    text-align: center;
    font-size: 24px;
    font-weight: bold;
    margin-bottom: 12mm;
  }

  .printMeta {
    font-size: 16px;
    margin-bottom: 12mm;
  }

  #printQrImg {
    width: 140mm;
    height: 140mm;
    object-fit: contain;
    display: block;
    margin: 0 auto;
  }
}


      </style>
    </head>
    <body>
      <div class="box">
        <h1>AV – Ladeliste erstellen</h1>

        <label for="labelSelect">Kommission (Label)</label>
        <select id="labelSelect">
          <option value="">– bitte wählen –</option>
        </select>

        <button class="primary" id="createBtn" type="button">Ladeliste erstellen</button>

        <div id="result" class="hide">
          <label for="listUrl">Link für Logistiker / Fahrer</label>
          <input id="listUrl" type="text" readonly />

          <div class="row">
            <button id="copyBtn" type="button">Link kopieren</button>
            <button id="waBtn" type="button">WhatsApp</button>
            
          </div>
<div style="margin-top:16px; text-align:center;">
  <div style="font-size:12px; color:#666; margin-bottom:8px;">QR-Code zum Scannen</div>

  <img id="qrImg"
       alt="QR-Code"
       style="max-width:260px; width:100%; border:1px solid #eee; border-radius:12px; padding:10px; background:#fff;">

  <div style="margin-top:12px;">
    <button class="printBtn" type="button" onclick="setTimeout(() => window.print(), 200)">Drucken</button>
  </div>
</div>

<!-- NUR FÜR DRUCK -->
<div id="printArea">
  <div class="printTitle">Ladeliste</div>
  <div class="printMeta">
    <div><b>Kommission:</b> <span id="printLabel"></span></div>
    <div><b>Datum:</b> <span id="printDate"></span></div>
  </div>
  <div style="text-align:center;">
    <img id="printQrImg" alt="QR-Code Druck" />
  </div>
</div>

          <p class="muted">Tipp: Link kopieren und an den Logistiker schicken oder per WhatsApp teilen.</p>
        </div>
      </div>

      <script>
        async function loadLabels() {
          const res = await fetch("/api/av/labels");
          const data = await res.json();
          if (data.error) {
            alert("Fehler beim Laden der Labels: " + data.error);
            return;
          }
          const select = document.getElementById("labelSelect");
          data.labels.forEach(l => {
            const opt = document.createElement("option");
            opt.value = l;
            opt.textContent = l;
            select.appendChild(opt);
          });
        }

        document.getElementById("createBtn").addEventListener("click", async () => {
          const label = document.getElementById("labelSelect").value;
          if (!label) { alert("Bitte Kommission auswählen"); return; }

          const res = await fetch("/api/av/create", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ label })
          });

          const data = await res.json();
          if (data.error) {
            alert("Fehler beim Erstellen: " + data.error);
            return;
          }

          document.getElementById("listUrl").value = data.url;
          document.getElementById("result").classList.remove("hide");
          // QR anzeigen (vom Backend)
document.getElementById("qrImg").src = data.qrDataUrl;

// Print-Felder befüllen
document.getElementById("printLabel").textContent = label;
document.getElementById("printDate").textContent = new Date().toLocaleString("de-DE");
document.getElementById("printQrImg").src = data.qrDataUrl;

        });

        document.getElementById("copyBtn").addEventListener("click", async () => {
          const url = document.getElementById("listUrl").value;
          await navigator.clipboard.writeText(url);
          alert("Link kopiert");
        });

        document.getElementById("waBtn").addEventListener("click", () => {
          const url = document.getElementById("listUrl").value;
          const wa = "https://wa.me/?text=" + encodeURIComponent(url);
          window.open(wa, "_blank");
        });

        loadLabels();
      </script>
    </body>
    </html>
  `);
});
app.get("/av/list/:id", async (req, res) => {
  try {
    const { id } = req.params;

    // Liste vom Backend holen (gleicher Server)
    const apiRes = await fetch(`${req.protocol}://${req.get("host")}/api/av/list/${id}`);
    const data = await apiRes.json();

    if (!apiRes.ok || data.error) {
      return res.type("html").send(`
        <!doctype html>
        <html lang="de">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>Ladeliste</title>
          <style>
            body { font-family: Arial, sans-serif; margin: 2rem; text-align:center; }
            .box { max-width: 520px; margin: 0 auto; border: 1px solid #ddd; border-radius: 12px; padding: 20px; }
          </style>
        </head>
        <body>
          <div class="box">
            <h1>❌ Ladeliste nicht gefunden</h1>
            <p>${data.error || "Ungültige ID oder Liste abgelaufen."}</p>
          </div>
        </body>
        </html>
      `);
    }

    const itemsHtml = (data.items || []).map(it => {
      const prio = it.priority ?? "";
      const content = (it.content || "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `
        <tr>
          <td style="text-align:center; width:60px;"><b>${prio}</b></td>
          <td>${content}</td>
        </tr>
      `;
    }).join("");

    return res.type("html").send(`
      <!doctype html>
      <html lang="de">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Ladeliste – ${data.label}</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 2rem; }
          .box { max-width: 720px; margin: 0 auto; border: 1px solid #ddd; border-radius: 12px; padding: 20px; }
          h1 { margin-top: 0; font-size: 1.4rem; }
          .meta { color:#666; font-size: 12px; margin-top: 6px; }
          table { width: 100%; border-collapse: collapse; margin-top: 14px; }
          th, td { border-bottom: 1px solid #eee; padding: 10px; vertical-align: top; }
          th { text-align:left; background: #fafafa; }
          .pill { display:inline-block; padding: 4px 10px; border: 1px solid #ddd; border-radius: 999px; font-size: 12px; }
          @media print {
            body { margin: 0; }
            .box { border: 0; border-radius: 0; }
          }
        </style>
      </head>
      <body>
        <div class="box">
          <h1>🚚 Ladeliste</h1>
          <div class="meta">
            Kommission: <span class="pill">${data.label}</span><br/>
            Erstellt: ${new Date(data.createdAt).toLocaleString("de-DE")}
            &nbsp;•&nbsp; Positionen: ${(data.items || []).length}
          </div>

          <table>
            <thead>
              <tr>
                <th style="width:70px;">Prio</th>
                <th>Palette</th>
              </tr>
            </thead>
            <tbody>
              ${itemsHtml || `<tr><td colspan="2">Keine Paletten gefunden.</td></tr>`}
            </tbody>
          </table>
        </div>
      </body>
      </html>
    `);
  } catch (err) {
    console.error("AV list error:", err?.message || err);
    res.status(500).send("Fehler beim Laden der Ladeliste.");
  }
});

app.listen(PORT, () => {
  const base = BASE_URL.replace(/\/$/, '');
  console.log(`AV-Server läuft auf Port ${PORT}`);
  console.log(`Formular: ${BASE_URL.replace(/\/$/, '')}/`);

});
