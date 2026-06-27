import { Router } from "express";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { query, withTransaction } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/errorHandler.js";

const router = Router();
router.use(requireAuth);

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const CONTEXT_WINDOW = 12; // máximo de mensajes al enviar a la IA
const AI_TIMEOUT_MS  = 12_000;

const ChatSchema = z.object({
  simulacion_id: z.string().uuid(),
  mensaje:       z.string().min(1).max(1000),
});

// ── Construye el system prompt con el perfil del cliente ──────────────────────
function buildSystemPrompt(sim) {
  return `Eres un motor de simulación de interacciones de cobranza por WhatsApp. Tu objetivo es evaluar y entrenar la capacidad de negociación, empatía y cierre de acuerdos del usuario (Asesor de Cobranzas).

## PERFIL DEL CLIENTE
- Nombre: ${sim.nombre_cliente}
- Deuda: $${sim.deuda_monto} / ${sim.deuda_producto}
- Días de atraso: ${sim.dias_atraso} días
- Arquetipo: ${sim.arquetipo_cliente}
- Excusa Principal: ${sim.excusa_principal || "Sin excusa definida"}

## REGLAS DE INTERACCIÓN
1. Mensajes cortos (máx 250 caracteres / 3 líneas). Estilo WhatsApp natural. Emojis con moderación.
2. Fase Inicial: resistencia y desconfianza.
   Fase de Objeción: excusa principal + exigir soluciones.
   Fase de Cierre (solo si el asesor lo merece): acepta compromiso concreto de pago.
3. PROHIBIDO lenguaje vulgar. PROHIBIDO revelar que eres IA. NO ceder sin alternativas reales.
4. Si el asesor usa presión directa sin empatía → aumentá la resistencia.
5. Si el asesor demuestra escucha y empatía → avanzá gradualmente hacia colaborativo.

## RESPUESTA — SOLO JSON VÁLIDO, SIN BACKTICKS NI TEXTO EXTRA:
{
  "mensaje_whatsapp": "[texto que leerá el asesor, máx 250 chars]",
  "estado_emocional": "[Enojado|Defensivo|Angustiado|Neutral|Colaborativo]",
  "nivel_satisfaccion": 0,
  "simulacion_finalizada": false,
  "resultado_simulacion": "[N/A|Acuerdo_Alcanzado|Cliente_Colgo_Chat|Negociacion_Fracasada]",
  "feedback_interno": "[análisis en 1 frase de qué hizo bien o mal el asesor en este turno]"
}`;
}

// ── Calcula XP por resultado ──────────────────────────────────────────────────
function calcXP(resultado, scoreTotal) {
  const base = { Acuerdo_Alcanzado: 300, Negociacion_Fracasada: 80, Cliente_Colgo_Chat: 50, "N/A": 30 };
  const bonus = Math.floor((scoreTotal || 0) / 10) * 20;
  return (base[resultado] || 30) + bonus;
}

// POST /api/chat — mensaje del asesor → respuesta de la IA
router.post("/", validate(ChatSchema), async (req, res, next) => {
  try {
    const { simulacion_id, mensaje } = req.body;

    // 1. Verificar que la simulación existe y pertenece al usuario
    const { rows: simRows } = await query(
      `SELECT * FROM simulaciones WHERE id = $1 AND usuario_id = $2 AND estado = 'en_curso'`,
      [simulacion_id, req.user.id]
    );
    if (!simRows[0]) {
      return res.status(404).json({ error: "Simulación no encontrada o no está en curso" });
    }
    const sim = simRows[0];

    // 2. Cargar ventana de contexto (últimos N mensajes)
    const { rows: history } = await query(
      `SELECT role, contenido FROM mensajes
       WHERE simulacion_id = $1
       ORDER BY orden DESC LIMIT $2`,
      [simulacion_id, CONTEXT_WINDOW]
    );
    // Invertir para orden cronológico
    const contextMessages = history.reverse().map((m) => ({
      role: m.role === "user" ? "user" : "assistant",
      content: m.contenido,
    }));
    // Agregar el mensaje actual
    contextMessages.push({ role: "user", content: mensaje });

    // 3. Obtener el orden del próximo mensaje
    const { rows: orderRows } = await query(
      `SELECT COALESCE(MAX(orden), 0) + 1 AS next_orden
       FROM mensajes WHERE simulacion_id = $1`,
      [simulacion_id]
    );
    const nextOrden = orderRows[0].next_orden;

    // 4. Guardar mensaje del usuario (antes de llamar a la IA)
    await query(
      `INSERT INTO mensajes (simulacion_id, role, contenido, orden)
       VALUES ($1, 'user', $2, $3)`,
      [simulacion_id, mensaje, nextOrden]
    );

    // 5. Llamar a la API de Anthropic con timeout
    let aiResponse;
    try {
      const completion = await Promise.race([
        client.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 512,
          system: buildSystemPrompt(sim),
          messages: contextMessages,
        }),
        new Promise((_, rej) =>
          setTimeout(() => rej(new Error("AI_TIMEOUT")), AI_TIMEOUT_MS)
        ),
      ]);
      aiResponse = completion;
    } catch (err) {
      if (err.message === "AI_TIMEOUT") {
        // Fallback: respuesta de contingencia que no rompe la inmersión
        const fallback = {
          mensaje_whatsapp: "...",
          estado_emocional: "Neutral",
          nivel_satisfaccion: 50,
          simulacion_finalizada: false,
          resultado_simulacion: "N/A",
          feedback_interno: "[Sistema: respuesta generada por fallback — IA no disponible]",
          _fallback: true,
        };
        await query(
          `INSERT INTO mensajes (simulacion_id, role, contenido, respuesta_json, orden)
           VALUES ($1, 'assistant', $2, $3, $4)`,
          [simulacion_id, fallback.mensaje_whatsapp, JSON.stringify(fallback), nextOrden + 1]
        );
        return res.json(fallback);
      }
      throw err;
    }

    // 6. Parsear respuesta JSON de la IA
    const rawText = aiResponse.content[0].text;
    let parsed;
    try {
      parsed = JSON.parse(rawText.replace(/```json|```/g, "").trim());
    } catch {
      parsed = {
        mensaje_whatsapp: rawText.slice(0, 250),
        estado_emocional: "Neutral",
        nivel_satisfaccion: 50,
        simulacion_finalizada: false,
        resultado_simulacion: "N/A",
        feedback_interno: "(respuesta sin formato JSON)",
      };
    }

    // 7. Guardar respuesta de la IA + métricas si finalizó
    await withTransaction(async (client_tx) => {
      await client_tx.query(
        `INSERT INTO mensajes
           (simulacion_id, role, contenido, respuesta_json, tokens_input, tokens_output, orden)
         VALUES ($1, 'assistant', $2, $3, $4, $5, $6)`,
        [
          simulacion_id,
          parsed.mensaje_whatsapp,
          JSON.stringify(parsed),
          aiResponse.usage?.input_tokens,
          aiResponse.usage?.output_tokens,
          nextOrden + 1,
        ]
      );

      if (parsed.simulacion_finalizada) {
        // Marcar simulación como finalizada
        await client_tx.query(
          `UPDATE simulaciones SET estado = 'finalizada', ended_at = NOW() WHERE id = $1`,
          [simulacion_id]
        );

        // Calcular métricas agregadas desde feedback_por_turno
        const { rows: allMsgs } = await client_tx.query(
          `SELECT respuesta_json FROM mensajes
           WHERE simulacion_id = $1 AND role = 'assistant' AND respuesta_json IS NOT NULL
           ORDER BY orden`,
          [simulacion_id]
        );

        const feedbacks = allMsgs.map((m, i) => {
          const j = typeof m.respuesta_json === "string"
            ? JSON.parse(m.respuesta_json) : m.respuesta_json;
          return { orden: i + 1, feedback: j.feedback_interno, score: j.nivel_satisfaccion };
        });

        const scores = feedbacks.map((f) => f.score).filter(Boolean);
        const avgScore = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;
        const xp = calcXP(parsed.resultado_simulacion, avgScore);

        await client_tx.query(
          `INSERT INTO metricas
             (simulacion_id, resultado, score_total, estado_emocional_final,
              feedback_resumen, feedback_por_turno, xp_ganada)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            simulacion_id,
            parsed.resultado_simulacion,
            avgScore,
            parsed.estado_emocional,
            parsed.feedback_interno,
            JSON.stringify(feedbacks),
            xp,
          ]
        );

        // Actualizar XP y racha del usuario
        await client_tx.query(
          `UPDATE usuarios
           SET xp_total = xp_total + $1,
               racha_actual = CASE
                 WHEN (SELECT fecha FROM actividad_diaria
                       WHERE usuario_id = $2 AND fecha = CURRENT_DATE - 1) IS NOT NULL
                 THEN racha_actual + 1
                 ELSE 1
               END,
               racha_record = GREATEST(racha_record,
                 CASE WHEN (SELECT fecha FROM actividad_diaria
                            WHERE usuario_id = $2 AND fecha = CURRENT_DATE - 1) IS NOT NULL
                 THEN racha_actual + 1 ELSE 1 END)
           WHERE id = $2`,
          [xp, req.user.id]
        );

        // Registrar actividad del día
        await client_tx.query(
          `INSERT INTO actividad_diaria (usuario_id, fecha, sims, acuerdos, xp_dia)
           VALUES ($1, CURRENT_DATE, 1, $2, $3)
           ON CONFLICT (usuario_id, fecha) DO UPDATE
           SET sims = actividad_diaria.sims + 1,
               acuerdos = actividad_diaria.acuerdos + $2,
               xp_dia = actividad_diaria.xp_dia + $3`,
          [
            req.user.id,
            parsed.resultado_simulacion === "Acuerdo_Alcanzado" ? 1 : 0,
            xp,
          ]
        );

        parsed._xp_ganada = xp;
        parsed._score_total = avgScore;
      }
    });

    res.json(parsed);
  } catch (err) {
    next(err);
  }
});

export default router;

