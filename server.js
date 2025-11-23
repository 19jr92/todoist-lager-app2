const express = require('express');
const app = express();

// Port: wichtig für Hosting später (Render setzt PORT als Umgebungsvariable)
const PORT = process.env.PORT || 3000;

// Damit wir JSON-Daten verarbeiten können
app.use(express.json());

// Einfacher Test-Endpunkt
app.get('/health', (req, res) => {
  res.send('OK');
});

// Hier kommen später deine richtigen Routen hin,
// z.B. /scan-in, /scan-out, /label/:id.pdf usw.

app.listen(PORT, () => {
  console.log('Server läuft auf Port', PORT);
});
