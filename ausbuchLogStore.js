import { pool } from "./db.js";

/**
 * Gibt completed_at zurück (ISO-String), oder null wenn nicht ausgebucht.
 */
export async function getCompletedAt(taskId) {
  const res = await pool.query(
    "select completed_at from ausbuch_log where task_id = $1",
    [taskId]
  );
  if (res.rowCount === 0) return null;
  return res.rows[0].completed_at; // kommt als Date oder String je nach pg config
}

/**
 * Speichert completed_at für taskId. Wenn bereits vorhanden, wird überschrieben.
 */
export async function setCompleted(taskId, completedAt) {
  await pool.query(
    `insert into ausbuch_log (task_id, completed_at)
     values ($1, $2)
     on conflict (task_id)
     do update set completed_at = excluded.completed_at`,
    [taskId, completedAt]
  );
}
