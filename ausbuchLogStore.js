import { pool } from "./db.js";

/**
 * Gibt completed_at zurück oder null, wenn nicht ausgebucht.
 * Der Wert kommt als Date-Objekt von pg.
 */
export async function getCompletedAt(taskId) {
  const res = await pool.query(
    "select completed_at from ausbuch_log where task_id = $1",
    [taskId]
  );
  if (res.rowCount === 0) return null;
  return res.rows[0].completed_at;
}

/**
 * Setzt completed_at serverseitig in der DB (now()).
 * Keine Übergabe von Zeit aus Node → keine Zeitzonenfehler.
 */
export async function setCompleted(taskId) {
  await pool.query(
    `insert into ausbuch_log (task_id, completed_at)
     values ($1, now())
     on conflict (task_id)
     do update set completed_at = excluded.completed_at`,
    [taskId]
  );
}
