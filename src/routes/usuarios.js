import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth, requireSupervisor } from "../middleware/auth.js";

const router = Router();
router.use(requireAuth);

// GET /api/usuarios/me/dashboard — tablero personal del asesor
router.get("/me/dashboard", async (req, res, next) => {
  try {
    const uid = req.user.id;

    const [userRes, simStats, skillsRes, actividadRes, rankRes] = await Promise.all([
      // Datos del usuario
      query(
        `SELECT nombre, email, rol, nivel, nivel_num, xp_total, racha_actual, racha_record
         FROM usuarios WHERE id = $1`,
        [uid]
      ),
      // Stats de simulaciones del mes
      query(
        `SELECT
           COUNT(*) FILTER (WHERE s.estado = 'finalizada') AS total,
           COUNT(*) FILTER (WHERE m.resultado = 'Acuerdo_Alcanzado') AS acuerdos,
           ROUND(AVG(m.score_total)) AS score_promedio,
           ROUND(AVG(
             EXTRACT(EPOCH FROM (s.ended_at - s.started_at)) / 60
           )) AS duracion_promedio_min
         FROM simulaciones s
         LEFT JOIN metricas m ON m.simulacion_id = s.id
         WHERE s.usuario_id = $1
           AND s.started_at >= DATE_TRUNC('month', NOW())`,
        [uid]
      ),
      // Skills promedio por dimensión
      query(
        `SELECT
           ROUND(AVG(score_empatia))     AS empatia,
           ROUND(AVG(score_negociacion)) AS negociacion,
           ROUND(AVG(score_cierre))      AS cierre,
           ROUND(AVG(score_total))       AS total
         FROM metricas m
         JOIN simulaciones s ON s.id = m.simulacion_id
         WHERE s.usuario_id = $1`,
        [uid]
      ),
      // Actividad últimos 28 días para el heatmap de racha
      query(
        `SELECT fecha, sims, acuerdos, xp_dia
         FROM actividad_diaria
         WHERE usuario_id = $1
           AND fecha >= CURRENT_DATE - 27
         ORDER BY fecha`,
        [uid]
      ),
      // Posición en el ranking del equipo
      query(
        `SELECT posicion FROM (
           SELECT id, RANK() OVER (ORDER BY xp_total DESC) AS posicion
           FROM usuarios WHERE activo = TRUE
         ) r WHERE id = $1`,
        [uid]
      ),
    ]);

    // Historial reciente con métricas
    const { rows: historial } = await query(
      `SELECT s.id, s.arquetipo_cliente, s.nombre_cliente, s.started_at, s.ended_at,
              m.resultado, m.score_total, m.xp_ganada
       FROM simulaciones s
       LEFT JOIN metricas m ON m.simulacion_id = s.id
       WHERE s.usuario_id = $1 AND s.estado = 'finalizada'
       ORDER BY s.started_at DESC LIMIT 10`,
      [uid]
    );

    res.json({
      usuario:   userRes.rows[0],
      stats:     simStats.rows[0],
      skills:    skillsRes.rows[0],
      actividad: actividadRes.rows,
      ranking:   rankRes.rows[0]?.posicion || null,
      historial,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/usuarios/me/logros
router.get("/me/logros", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT l.*, ul.desbloqueado_at
       FROM logros l
       LEFT JOIN usuario_logros ul ON ul.logro_id = l.id AND ul.usuario_id = $1
       ORDER BY ul.desbloqueado_at DESC NULLS LAST`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/usuarios/ranking
router.get("/ranking", async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.nombre, u.nivel, u.nivel_num, u.xp_total, u.racha_actual,
              RANK() OVER (ORDER BY u.xp_total DESC) AS posicion,
              ROUND(AVG(m.score_total)) AS score_promedio,
              COUNT(s.id) FILTER (WHERE s.estado='finalizada') AS sims_total,
              COUNT(s.id) FILTER (WHERE m.resultado='Acuerdo_Alcanzado') AS acuerdos
       FROM usuarios u
       LEFT JOIN simulaciones s ON s.usuario_id = u.id
         AND s.started_at >= DATE_TRUNC('month', NOW())
       LEFT JOIN metricas m ON m.simulacion_id = s.id
       WHERE u.activo = TRUE
       GROUP BY u.id, u.nombre, u.nivel, u.nivel_num, u.xp_total, u.racha_actual
       ORDER BY u.xp_total DESC
       LIMIT 50`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// ─── RUTAS DE SUPERVISOR ──────────────────────────────────────────────────────

// GET /api/usuarios/equipo — visión del equipo para supervisor
router.get("/equipo", requireSupervisor, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT u.id, u.nombre, u.email, u.nivel, u.xp_total, u.racha_actual,
              ROUND(AVG(m.score_total))       AS score_promedio,
              ROUND(AVG(m.score_empatia))     AS score_empatia,
              ROUND(AVG(m.score_negociacion)) AS score_negociacion,
              ROUND(AVG(m.score_cierre))      AS score_cierre,
              COUNT(s.id) FILTER (WHERE s.estado='finalizada') AS sims_mes,
              COUNT(s.id) FILTER (WHERE m.resultado='Acuerdo_Alcanzado') AS acuerdos_mes,
              CASE
                WHEN COUNT(s.id) FILTER (WHERE s.estado='finalizada') > 0
                THEN ROUND(
                  COUNT(s.id) FILTER (WHERE m.resultado='Acuerdo_Alcanzado') * 100.0 /
                  NULLIF(COUNT(s.id) FILTER (WHERE s.estado='finalizada'), 0)
                )
                ELSE 0
              END AS tasa_cierre
       FROM usuarios u
       LEFT JOIN simulaciones s ON s.usuario_id = u.id
         AND s.started_at >= DATE_TRUNC('month', NOW())
       LEFT JOIN metricas m ON m.simulacion_id = s.id
       WHERE u.activo = TRUE AND u.rol = 'asesor'
       GROUP BY u.id, u.nombre, u.email, u.nivel, u.xp_total, u.racha_actual
       ORDER BY score_promedio DESC NULLS LAST`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

// GET /api/usuarios/:userId/simulaciones — historial de un asesor (supervisor)
router.get("/:userId/simulaciones", requireSupervisor, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT s.id, s.arquetipo_cliente, s.nombre_cliente, s.deuda_monto,
              s.dias_atraso, s.estado, s.started_at, s.ended_at,
              m.resultado, m.score_total, m.feedback_resumen, m.xp_ganada
       FROM simulaciones s
       LEFT JOIN metricas m ON m.simulacion_id = s.id
       WHERE s.usuario_id = $1
       ORDER BY s.started_at DESC LIMIT 30`,
      [req.params.userId]
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

export default router;
