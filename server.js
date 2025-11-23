const express = require('express');
const app = express();

const PORT = process.env.PORT || 3000;

app.use(express.json());

// NEU: Startseite für "/"
app.get('/', (req, res) => {
  res.send(`
    <h1>Todoist Lager App</h1>
    <p>Die App läuft! 🎉</p>
    <p>Test-Route: <a href="/health">/health</a></p>
  `);
});

app.get('/health', (req, res) => {
  res.send('OK');
});

app.listen(PORT, () => {
  console.log('Server läuft auf Port', PORT);
});
