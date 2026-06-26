import { Router } from "express";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireAuth, requireOwnerOrSupervisor } from "../middleware/auth.js";
import { validate } from "../middleware/errorHandler.js";

const router = Router();
router.use(requireAuth);

const CreateSimSchema = z.object({
  arquetipo_cliente: z.enum([
    "Evasivo", "Enojado-Defensivo", "Angustiado-Víctima", "Negociador-Difícil",
  ]),
  nombre_cliente:   z.string().min(2).max(100),
  deuda_monto:      z.number().positive(),
  deuda_producto:   z.string().min(2).max(100),
  dias_atraso:      z.number().int().min(0),
  excusa_principal: z.string().max(500).optional(),
});

// POST /api/simulaciones — iniciar una nueva simulación
router.post("/", validate(CreateSimSchema), async (req, res, next) => {
  try {
    const { arquetipo_cliente, nombre_cliente, deuda_monto, deuda_producto,
            dias_atraso, excusa_principal } = req.body;

    // Cerrar simulaciones en_curso previas del usuario (limpieza)
    await query(
      `UPDATE simulaciones SET estado = 'abandonada', ended_at = NOW()
       WHERE usuario_id = $1 AND estado = 'en_curso'`,
      [req.user.id]
    );

    const { rows } = await query(
      `INSERT INTO simulaciones
         (usuario_id, arquetipo_cliente, nombre_cliente, deuda_monto,
          deuda_producto, dias_atraso, excusa_principal)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [req.user.id, arquetipo_cliente, nombre_cliente, deuda_monto,
       deuda_producto, dias_atraso, excusa_principal]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/simulaciones — historial del usuario autenticado
router.get("/", async (req, res, next) => {
  try {
    const { page = 1, limit = 20, estado } = req.query;
    const offset = (page - 1) * Math.min(limit, 50);

    const filters = ["s.usuario_id = $1"];
    const params = [req.user.id];

    if (estado) {
      params.push(estado);
      filters.push(`s.estado = $${params.length}`);
    }

    const where = filters.join(" AND ");

    const { rows } = await query(
      `SELECT s.*, m.resultado, m.score_total, m.score_empatia,
              m.score_negociacion, m.score_cierre
       FROM simulaciones s
       LEFT JOIN metricas m ON m.simulacion_id = s.id
       WHERE ${where}
       ORDER BY s.started_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );

    const { rows: countRows } = await query(
      `SELECT COUNT(*) FROM simulaciones WHERE ${where}`, params
    );

    res.json({
      data: rows,
      total: parseInt(countRows[0].count),
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/simulaciones/:id — detalle con mensajes
router.get("/:id", async (req, res, next) => {
  try {
    const { rows: simRows } = await query(
      `SELECT s.*, m.resultado, m.score_total, m.score_empatia,
              m.score_negociacion, m.score_cierre, m.feedback_resumen,
              m.feedback_por_turno, m.estado_emocional_final
       FROM simulaciones s
       LEFT JOIN metricas m ON m.simulacion_id = s.id
       WHERE s.id = $1`,
      [req.params.id]
    );

    if (!simRows[0]) return res.status(404).json({ error: "Simulación no encontrada" });

    const sim = simRows[0];

    // Control de acceso: solo el dueño o supervisor
    if (sim.usuario_id !== req.user.id && !["supervisor","admin"].includes(req.user.rol)) {
      return res.status(403).json({ error: "Sin acceso a esta simulación" });
    }

    const { rows: msgs } = await query(
      `SELECT id, role, contenido, respuesta_json, orden, created_at
       FROM mensajes WHERE simulacion_id = $1 ORDER BY orden`,
      [req.params.id]
    );

    res.json({ ...sim, mensajes: msgs });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/simulaciones/:id/abandonar
router.patch("/:id/abandonar", async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE simulaciones SET estado = 'abandonada', ended_at = NOW()
       WHERE id = $1 AND usuario_id = $2 AND estado = 'en_curso'
       RETURNING id, estado`,
      [req.params.id, req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Simulación no encontrada o ya finalizada" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

export default router;
