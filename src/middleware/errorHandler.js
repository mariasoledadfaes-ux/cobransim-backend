import { ZodError } from "zod";

// Valida body contra un schema Zod
export function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      const errors = result.error.errors.map((e) => ({
        field: e.path.join("."),
        message: e.message,
      }));
      return res.status(400).json({ error: "Datos inválidos", errors });
    }
    req.body = result.data; // datos saneados
    next();
  };
}

// Handler global de errores (último middleware)
export function errorHandler(err, req, res, next) {
  console.error(`[ERROR] ${req.method} ${req.path}:`, err.message);

  if (err instanceof ZodError) {
    return res.status(400).json({ error: "Datos inválidos", details: err.errors });
  }

  // Error de PG: constraint violation
  if (err.code === "23505") {
    return res.status(409).json({ error: "El recurso ya existe (duplicado)" });
  }

  // Error de PG: foreign key
  if (err.code === "23503") {
    return res.status(400).json({ error: "Referencia a recurso inexistente" });
  }

  const status = err.status || err.statusCode || 500;
  const message = status < 500 ? err.message : "Error interno del servidor";
  return res.status(status).json({ error: message });
}

// 404 catch-all
export function notFound(req, res) {
  res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.path}` });
}
