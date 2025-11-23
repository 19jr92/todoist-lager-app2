import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import QRCode from 'qrcode';
import crypto from 'crypto';
import PDFDocument from 'pdfkit';

const {
  PORT = 3000,
  BASE_URL,
  TODOIST_TOKEN,
  PROJECT_ID,
  SIGNING_SECRET,
} = process.env;

if (!BASE_URL || !TODOIST_TOKEN || !SIGNING_SECRET || !PROJECT_ID) {
  console.error('Bitte Env vollständig ausfüllen: BASE_URL, TODOIST_TOKEN, PROJECT_ID, SIGNING_SECRET.');
  process.exit(1);
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

/* =========================
   Todoist Client
   ========================= */

const td = axios.create({
  baseURL: 'https://api.todoist.com/rest/v2',
  headers: { Authorization: `Bearer ${TODOIST_TOKEN}` },
});

function signTaskId(taskId) {
  return crypto.createHmac('sha256', SIGNING_SECRET)
    .update(String(taskId))
    .digest('hex');
}

async function createTodoistTask(content) {
  const res = await td.post(
    '/tasks',
    {
      content,
      project_id: Number(PROJECT_ID),
    },
    { headers: { 'Content-Type': 'application/json' } }
  );
  return res.data;
}

async function closeTask(taskId) {
  await td.post(`/tasks/${taskId}/close`);
}

/* =========================
   Healthcheck für Render
   ========================= */

app.get('/health', (_req, res) => {
  res.send('OK');
});

/* =========================
   /complete Endpoint
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
   Formular
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
        <button type="submit">PDF erzeugen</button>
      </form>
      <p class="hint">Für jede Palette wird eine Todoist-Aufgabe erzeugt und ein QR eingebettet.<br>
      QR-Scan → Aufgabe wird automatisch erledigt.</p>
    </body>
    </html>
  `);
});

/* =========================
   PDF + Tasks erzeugen
   ========================= */

app.post('/make-labels', async (req, res) => {
  try {
    const rawProject = (req.body.project || '').trim();
    const rawDrawing = (req.body.drawing || '').trim();
    let count = parseInt(req.body.count, 10);

    if (!rawProject || !rawDrawing || !Number.isFinite(count)) {
      return res.status(400).send('Bitte Projekt, Zeichnungsnummer und Anzahl korrekt angeben.');
    }

    count = Math.max(1, Math.min(50, count));
    const createdAt = new Date();

    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const filename = `Labels_${rawProject}_${rawDrawing}_${createdAt
      .toISOString()
      .replace(/[:.]/g,'-')}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    doc.pipe(res);

    const projectAndDrawing = `${rawProject} – ${rawDrawing}`;

    for (let i = 1; i <= count; i++) {
      if (i > 1) doc.addPage();

      // 1) Todoist-Aufgabe
      const taskTitle = `${projectAndDrawing} – Palette ${i}/${count}`;
      const task = await createTodoistTask(taskTitle);
      const taskId = task.id;

      // 2) Complete-URL + QR
      const sig = signTaskId(taskId);
      const base = BASE_URL.replace(/\/$/, '');
      const completeUrl = `${base}/complete/${taskId}?sig=${sig}`;
      const qrPng = await QRCode.toBuffer(completeUrl, { type: 'png', margin: 0 });

      // === Layout-Parameter ===
      const pageW = doc.page.width;
      const pageH = doc.page.height;
      const margin = 36;
      const innerW = pageW - margin * 2;
      const footerReserve = 64;
      const gapTiny = 6;
      const gapSmall = 12;
      const gapMid = 18;

      const fitOneLine = (text, fontName, maxPt, minPt = 12) => {
        doc.font(fontName);
        for (let size = maxPt; size >= minPt; size--) {
          if (doc.fontSize(size).widthOfString(text) <= innerW) return size;
        }
        return minPt;
      };

      // Projekt
      const projSize = fitOneLine(rawProject, 'Helvetica-Bold', 96, 18);
      doc.font('Helvetica-Bold').fontSize(projSize);
      let y = margin;
      doc.text(rawProject, margin, y, { width: innerW, align: 'center' });
      y += doc.currentLineHeight() + gapTiny;

      // Zeichnungsnummer
      const drawSize = fitOneLine(rawDrawing, 'Helvetica-Bold', 96, 18);
      doc.font('Helvetica-Bold').fontSize(drawSize);
      doc.text(rawDrawing, margin, y, { width: innerW, align: 'center' });
      y += doc.currentLineHeight() + gapSmall;

      // Palettennummer
      const sub = `Palette ${i}/${count}`;
      const subSize = fitOneLine(sub, 'Helvetica-Bold', 64, 16);
      doc.font('Helvetica-Bold').fontSize(subSize);
      doc.text(sub, margin, y, { width: innerW, align: 'center' });
      y += doc.currentLineHeight() + gapMid;

      // QR möglichst groß
      const bottomForDateY = pageH - margin - footerReserve;
      const availH = Math.max(0, bottomForDateY - y);
      const qrSize = Math.floor(Math.min(innerW, availH));
      const qrX = margin + (innerW - qrSize) / 2;
      const qrY = y + (availH - qrSize) / 2;

      if (qrSize > 0) {
        doc.image(qrPng, qrX, qrY, { width: qrSize, height: qrSize });
      }

      // Datum/Uhrzeit
      const ts = new Intl.DateTimeFormat('de-DE', {
        dateStyle: 'short',
        timeStyle: 'medium',
      }).format(new Date());

      doc.font('Helvetica')
        .fontSize(12)
        .text(
          `Erstellt: ${ts}`,
          margin,
          pageH - margin - 24,
          { width: innerW, align: 'center', lineBreak: false }
        );
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
