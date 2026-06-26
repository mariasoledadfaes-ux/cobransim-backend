import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { query } from "../db/pool.js";
import { validate } from "../middleware/errorHandler.js";

const router = Router();

const RegisterSchema = z.object({
  nombre:   z.string().min(2).max(100),
  email:    z.string().email(),
  password: z.string().min(8).max(100),
  empresa:  z.string().min(2).max(200).optional(),
  rol:      z.enum(["asesor", "supervisor"]).default("asesor"),
});

const LoginSchema = z.object({
  email:    z.string().email(),
  password: z.string().min(1),
});

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, rol: user.rol, nivel: user.nivel },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
}

// POST /api/auth/register
router.post("/register", validate(RegisterSchema), async (req, res, next) => {
  try {
    const { nombre, email, password, rol } = req.body;

    const exists = await query("SELECT id FROM usuarios WHERE email = $1", [email]);
    if (exists.rows.length) {
      return res.status(409).json({ error: "El email ya está registrado" });
    }

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await query(
      `INSERT INTO usuarios (nombre, email, password_hash, rol)
       VALUES ($1, $2, $3, $4)
       RETURNING id, nombre, email, rol, nivel, xp_total, created_at`,
      [nombre, email, hash, rol]
    );

    const user = rows[0];
    const token = signToken(user);

    res.status(201).json({ token, user });
  } catch (err) {
    next(err);
  }
});

// POST /api/auth/login
router.post("/login", validate(LoginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body;

    const { rows } = await query(
      `SELECT id, nombre, email, password_hash, rol, nivel, xp_total, activo
       FROM usuarios WHERE email = $1`,
      [email]
    );

    const user = rows[0];
    if (!user || !user.activo) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Credenciales inválidas" });
    }

    const token = signToken(user);
    const { password_hash, ...safeUser } = user;

    res.json({ token, user: safeUser });
  } catch (err) {
    next(err);
  }
});

// GET /api/auth/me
import { requireAuth } from "../middleware/auth.js";
router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, nombre, email, rol, nivel, nivel_num, xp_total,
              racha_actual, racha_record, created_at
       FROM usuarios WHERE id = $1`,
      [req.user.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Usuario no encontrado" });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

export default router;
