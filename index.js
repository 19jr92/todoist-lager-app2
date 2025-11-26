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

    const projectAndDrawing = `${rawProject} – ${rawDrawing}`;

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

      const projFontSize = fitOneLine(rawProject, 'Helvetica-Bold', 66, 14, barW - mm(4));
      doc.font('Helvetica-Bold').fontSize(projFontSize);
      doc.text(rawProject, barX + mm(2), projectY + mm(4), {
        width: barW - mm(4),
        align: 'center',
      });

      // ===== 2) Zeichnungs-Balken =====
      doc.rect(barX, drawingY, barW, barHeight2).stroke();

      const drawFontSize = fitOneLine(rawDrawing, 'Helvetica-Bold', 66, 14, barW - mm(4));
      doc.font('Helvetica-Bold').fontSize(drawFontSize);
      doc.text(rawDrawing, barX + mm(2), drawingY + mm(4), {
        width: barW - mm(4),
        align: 'center',
      });

      // ===== 3) Paletten-Balken mit großer 1/x =====
      doc.rect(barX, palletBarY, barW, barHeight3).stroke();

      const fracText = `${i}/${count}`;
      const fracFontSize = fitOneLine(fracText, 'Helvetica-Bold', 66, 18, barW - mm(4));
      doc.font('Helvetica-Bold').fontSize(fracFontSize);
      // vertikal zentriert im 3. Balken
      const fracTextY = palletBarY + (barHeight3 - doc.currentLineHeight()) / 2;
      doc.text(fracText, barX + mm(2), fracTextY, {
        width: barW - mm(4),
        align: 'center',
      });

      // ===== 4) "Palette" klein, ÜBER dem Paletten-Balken links =====
      const paletteLabelY = palletBarY - mm(4); // etwas über der Linie vor "1/x"
      doc.font('Helvetica-Bold').fontSize(10);
      doc.text('Palette', barX + mm(4), paletteLabelY);


      // ===== 5) QR-Code zentriert darunter =====
      const qrSize = mm(50);
      const qrX = outerX + (outerW - qrSize) / 2;
      // QR direkt unter dem Paletten-Balken
      const qrY = palletBarY + barHeight3 + mm(4);


      // Todoist-Aufgabe für diese Palette
      const taskTitle = `${projectAndDrawing} – Palette ${i}/${count}`;
      const task = await createTodoistTask(taskTitle);
      const taskId = task.id;

      const sig = signTaskId(taskId);
      const base = BASE_URL.replace(/\/$/, '');
      const completeUrl = `${base}/complete/${taskId}?sig=${sig}`;
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

app.listen(PORT, () => {
  const base = BASE_URL.replace(/\/$/, '');
  console.log(`Server läuft auf Port ${PORT}`);
  console.log(`Formular: ${base}`);
});
