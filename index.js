import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import QRCode from 'qrcode';
import crypto from 'crypto';
import PDFDocument from 'pdfkit';
import path from 'path';
import { fileURLToPath } from 'url';

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

/* =========================
   Helper: mm -> Punkte
   ========================= */
const mm = (v) => v * 2.835; // 1 mm ~ 2.835pt

/* =========================
   Basic Auth für geschützte Routen
   ========================= */

function basicAuth(req, res, next) {
  // öffentliche Routen: Health + QR-Complete
  if (req.path.startsWith('/health') || req.path.startsWith('/complete')) {
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

async function createTodoistTask(content) {
  const payload = { content };

  const projectIdNum = Number(PROJECT_ID);
  if (Number.isFinite(projectIdNum)) {
    payload.project_id = projectIdNum;
  } else {
    console.warn('WARNUNG: PROJECT_ID ist keine gültige Zahl, Aufgabe landet im Eingang. PROJECT_ID =', PROJECT_ID);
  }

  const res = await td.post('/tasks', payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  return res.data;
}

async function closeTask(taskId) {
  await td.post(`/tasks/${taskId}/close`);
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

    await closeTask(taskId);
    return res.redirect(`https://todoist.com/showTask?id=${taskId}`);
  } catch (err) {
    console.error('Complete-Fehler:', err?.response?.data || err.message);
    res.status(500).send('Fehler beim Schließen der Aufgabe.');
  }
});

/* =========================
   Formular (geschützt durch Basic Auth)
   ========================= */

app.get('/', (_req, res) => {
  res.type('html').send(`
    <!doctype html>
    <html lang="de">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Paletten-Labels erzeugen</title>
      <style>
        body { font-family: Arial, sans-serif; margin: 2rem; }
        label { display:block; margin-top:.8rem; }
        input[type="text"], input[type="number"] {
          padding:.5rem; width: 320px; max-width: 90%;
        }
        button { margin-top:1rem; padding:.6rem 1.2rem; font-size:1rem; }
        .hint { margin-top:1.5rem; color:#444; font-size:.9rem; }
      </style>
    </head>
    <body>
      <h1>Paletten-Labels erzeugen</h1>
      <form method="POST" action="/make-labels" target="_blank">
        <label>Projekt:
          <input required name="project" type="text" placeholder="z. B. BEFR0124" />
        </label>
        <label>Zeichnungsnummer:
          <input required name="drawing" type="text" placeholder="z. B. BL22" />
        </label>
        <label>Anzahl Paletten:
          <input required name="count" type="number" min="1" max="50" value="1" />
        </label>
        <label>Gepackt von (Kürzel, optional):
          <input name="packer" type="text" placeholder="mm" maxlength="8" />
        </label>
        <button type="submit">PDF erzeugen</button>
      </form>
      <p class="hint">
        Für jede Palette wird eine Todoist-Aufgabe erzeugt und ein QR eingebettet.<br>
        QR-Scan → Aufgabe wird automatisch erledigt.
      </p>
    </body>
    </html>
  `);
});

/* =========================
   PDF + Tasks erzeugen (geschützt)
   ========================= */

app.post('/make-labels', async (req, res) => {
  try {
    const rawProject = (req.body.project || '').trim();
    const rawDrawing = (req.body.drawing || '').trim();
    let count = parseInt(req.body.count, 10);
    const packer = (req.body.packer || '').trim(); // Kürzel optional

    if (!rawProject || !rawDrawing || !Number.isFinite(count)) {
      return res.status(400).send('Bitte Projekt, Zeichnungsnummer und Anzahl korrekt angeben.');
    }

    count = Math.max(1, Math.min(50, count));
    const createdAt = new Date();
    const ts = new Intl.DateTimeFormat('de-DE', {
      dateStyle: 'short',
      timeStyle: 'medium',
    }).format(createdAt);

    // Seitenformat: 100 x 150 mm
    const pageW = mm(100);
    const pageH = mm(150);
    const margin = mm(4);
    const usableWidth = pageW - 2 * margin;

    const doc = new PDFDocument({
      autoFirstPage: false,
    });

    const filename = `Labels_${rawProject}_${rawDrawing}_${createdAt
      .toISOString()
      .replace(/[:.]/g, '-')}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.pipe(res);

    const projectAndDrawing = `${rawProject} – ${rawDrawing}`;

    // Helper für eine Zeile
    const fitOneLine = (text, fontName, maxPt, minPt = 10) => {
      doc.font(fontName);
      for (let size = maxPt; size >= minPt; size--) {
        if (doc.fontSize(size).widthOfString(text) <= usableWidth) return size;
      }
      return minPt;
    };

    for (let i = 1; i <= count; i++) {
      doc.addPage({ size: [pageW, pageH] });

      // Koordinaten wie im Muster-PDF
      // Projekt-Box
      const projectBoxHeight = mm(28);
      const projectBoxY = pageH - margin - projectBoxHeight - mm(20);
      const projectBoxX = margin;

      doc.lineWidth(2);
      doc.rect(projectBoxX, projectBoxY, usableWidth, projectBoxHeight).stroke();

      // Projektname
      const projSize = fitOneLine(rawProject, 'Helvetica-Bold', 18, 12);
      doc.font('Helvetica-Bold').fontSize(projSize);
      doc.text(rawProject, projectBoxX, projectBoxY + projectBoxHeight - mm(9), {
        width: usableWidth,
        align: 'center',
      });

      // Zeichnungsnummer
      const drawSize = fitOneLine(rawDrawing, 'Helvetica-Bold', 16, 10);
      doc.font('Helvetica-Bold').fontSize(drawSize);
      doc.text(rawDrawing, projectBoxX, projectBoxY + mm(7), {
        width: usableWidth,
        align: 'center',
      });

      // Palette-Zeile: "Palette" klein, Bruch groß
      const paletteY = projectBoxY - mm(12);
      const textPalette = 'Palette';
      const textFrac = `${i}/${count}`;

      doc.font('Helvetica-Bold').fontSize(10);
      const paletteW = doc.widthOfString(textPalette);
      doc.font('Helvetica-Bold').fontSize(26);
      const fracW = doc.widthOfString(textFrac);

      const totalW = paletteW + mm(3) + fracW;
      const startX = (pageW - totalW) / 2;

      // "Palette" (klein)
      doc.font('Helvetica-Bold').fontSize(10);
      doc.text(textPalette, startX, paletteY + mm(5));

      // "1/3" (groß)
      doc.font('Helvetica-Bold').fontSize(26);
      doc.text(textFrac, startX + paletteW + mm(3), paletteY);

      // QR-Bereich
      const qrSize = mm(60);
      const qrX = (pageW - qrSize) / 2;
      const qrY = paletteY - mm(10) - qrSize;

      // QR-Code: URL zum Complete-Endpoint
      const taskTitle = `${projectAndDrawing} – Palette ${i}/${count}`;
      const task = await createTodoistTask(taskTitle);
      const taskId = task.id;

      const sig = signTaskId(taskId);
      const base = BASE_URL.replace(/\/$/, '');
      const completeUrl = `${base}/complete/${taskId}?sig=${sig}`;
      const qrPng = await QRCode.toBuffer(completeUrl, { type: 'png', margin: 0 });

      doc.image(qrPng, qrX, qrY, { width: qrSize, height: qrSize });

      // Footer links: Datum + Kürzel (falls vorhanden)
      const footerText = packer ? `Erstellt: ${ts} · ${packer}` : `Erstellt: ${ts}`;
      doc.font('Helvetica').fontSize(10);
      doc.text(footerText, margin, margin + mm(2), {
        width: usableWidth - mm(24), // etwas Platz fürs Logo rechts
        align: 'left',
      });

      // Footer rechts: Logo (falls vorhanden)
      const logoW = mm(20);
      const logoH = mm(10);
      const logoX = pageW - margin - logoW;
      const logoY = margin + mm(0.5);

      try {
        doc.image(RESOLVED_LOGO_PATH, logoX, logoY, { width: logoW, height: logoH });
      } catch (e) {
        console.warn('Logo konnte nicht geladen werden:', e.message);
        // Falls Logo fehlt, nicht abstürzen
      }
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

app.listen(PORT, () => {
  const base = BASE_URL.replace(/\/$/, '');
  console.log(`Server läuft auf Port ${PORT}`);
  console.log(`Formular: ${base}`);
});
