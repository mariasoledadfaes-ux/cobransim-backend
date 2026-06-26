import jwt from "jsonwebtoken";

// Verifica JWT y adjunta usuario al request
export function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token requerido" });
  }

  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, email, rol, nivel }
    next();
  } catch (err) {
    const msg = err.name === "TokenExpiredError" ? "Token expirado" : "Token inválido";
    return res.status(401).json({ error: msg });
  }
}

// Solo supervisores y admins
export function requireSupervisor(req, res, next) {
  if (!["supervisor", "admin"].includes(req.user?.rol)) {
    return res.status(403).json({ error: "Acceso restringido a supervisores" });
  }
  next();
}

// El usuario solo puede acceder a sus propios recursos,
// excepto supervisores que ven todo el equipo
export function requireOwnerOrSupervisor(paramName = "userId") {
  return (req, res, next) => {
    const targetId = req.params[paramName];
    const { id, rol } = req.user;
    if (id === targetId || ["supervisor", "admin"].includes(rol)) {
      return next();
    }
    return res.status(403).json({ error: "Sin acceso a este recurso" });
  };
}
