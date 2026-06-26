import "dotenv/config";
import express from "express";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";

import authRoutes        from "./routes/auth.js";
import simulacionRoutes  from "./routes/simulaciones.js";
import chatRoutes        from "./routes/chat.js";
import usuarioRoutes     from "./routes/usuarios.js";
import { errorHandler, notFound } from "./middleware/errorHandler.js";

const app  = express();
const PORT = process.env.PORT || 3001;

// ─── SEGURIDAD ────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || "http://localhost:5173",
  credentials: true,
}));

// Rate limiter general
app.use(rateLimit({
  windowMs: 60_000,
  max: parseInt(process.env.RATE_LIMIT_GENERAL || "100"),
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiadas peticiones. Intentá en un minuto." },
}));

// Rate limiter estricto solo para /api/chat (llama a la IA)
const aiLimiter = rateLimit({
  windowMs: 60_000,
  max: parseInt(process.env.RATE_LIMIT_AI || "20"),
  message: { error: "Límite de mensajes a la IA alcanzado. Esperá un momento." },
});

// ─── PARSERS ──────────────────────────────────────────────────────────────────
app.use(express.json({ limit: "50kb" }));
app.use(express.urlencoded({ extended: false }));

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/health", (_, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

// ─── RUTAS ────────────────────────────────────────────────────────────────────
app.use("/api/auth",          authRoutes);
app.use("/api/simulaciones",  simulacionRoutes);
app.use("/api/chat",          aiLimiter, chatRoutes);
app.use("/api/usuarios",      usuarioRoutes);

// ─── ERRORES ──────────────────────────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

// ─── INICIO ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║        CobranSim Backend              ║
║  Puerto : ${PORT}                        ║
║  Modo   : ${process.env.NODE_ENV || "development"}               ║
╚═══════════════════════════════════════╝
  `);
});

export default app;
