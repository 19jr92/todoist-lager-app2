// src/av/avRoutes.js
import express from "express";
import { avLists } from "./store.js";
import QRCode from "qrcode";

const router = express.Router();

const TODOIST_TOKEN = process.env.TODOIST_TOKEN;
const TODOIST_PROJECT_ID = process.env.PROJECT_ID;


async function todoistGet(path) {
  const res = await fetch(`https://api.todoist.com/api/v1${path}`, {
    headers: { Authorization: `Bearer ${TODOIST_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Todoist error ${res.status}`);
  return res.json();
}

function sortTasks(tasks) {
  return tasks.sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.content.localeCompare(b.content, "de");
  });
}

// Labels fürs Dropdown
router.get("/api/av/labels", async (req, res) => {
  try {
    // 1) Alle Tasks aus dem Paletten-Projekt holen
    const tasks = await todoistGet(`/tasks?project_id=${TODOIST_PROJECT_ID}`);

    // 2) Labels, die dort wirklich vorkommen, einsammeln
    const used = new Set();
    for (const t of tasks) {
      if (Array.isArray(t.labels)) {
        for (const name of t.labels) used.add(name);
      }
    }

    // 3) Sortiert zurückgeben
    const labels = [...used].sort((a, b) => a.localeCompare(b, "de"));

    res.json({ labels });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


// Liste erzeugen (Snapshot)
router.post("/api/av/create", async (req, res) => {
  try {
    const { label } = req.body;
    if (!label) return res.status(400).json({ error: "label fehlt" });

    const tasks = await todoistGet(`/tasks?project_id=${TODOIST_PROJECT_ID}`);
    const filtered = tasks.filter(t => Array.isArray(t.labels) && t.labels.includes(label));
    const sorted = sortTasks(filtered);

    const id = crypto.randomUUID();
    avLists.set(id, {
      id,
      createdAt: new Date().toISOString(),
      label,
      items: sorted.map(t => ({
        content: t.content,
        priority: t.priority,
        url: t.url,
      })),
    });

    const baseUrl = `${req.protocol}://${req.get("host")}`;
const url = `${baseUrl}/av/list/${id}`;

const qrDataUrl = await QRCode.toDataURL(url, {
  margin: 1,
  width: 300
});

res.json({
  id,
  url,
  qrDataUrl,
  count: sorted.length
});

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Liste abrufen (für Fahrer-Ansicht)
router.get("/api/av/list/:id", (req, res) => {
  const list = avLists.get(req.params.id);
  if (!list) return res.status(404).json({ error: "Liste nicht gefunden" });
  res.json(list);
});

export default router;
