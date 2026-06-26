# CobranSim — Referencia de API

Base URL: `http://localhost:3001/api`

Todos los endpoints protegidos requieren header:
```
Authorization: Bearer <token>
```

---

## AUTH

### POST /auth/register
```json
{
  "nombre": "María González",
  "email": "maria@empresa.com",
  "password": "secreta123",
  "rol": "asesor"
}
```
Respuesta `201`:
```json
{ "token": "eyJ...", "user": { "id": "...", "nombre": "María González", "rol": "asesor" } }
```

### POST /auth/login
```json
{ "email": "maria@empresa.com", "password": "secreta123" }
```
Respuesta `200`: igual a register.

### GET /auth/me  🔒
Devuelve el usuario autenticado con XP, racha y nivel.

---

## SIMULACIONES  🔒

### POST /simulaciones — iniciar sesión
```json
{
  "arquetipo_cliente": "Enojado-Defensivo",
  "nombre_cliente":    "Carlos Mendoza",
  "deuda_monto":       45000,
  "deuda_producto":    "Tarjeta de Crédito",
  "dias_atraso":       45,
  "excusa_principal":  "Se quedó sin empleo temporal"
}
```
Respuesta `201`: objeto `simulacion` con `id` para usar en `/chat`.

### GET /simulaciones?page=1&limit=20&estado=finalizada
Historial del usuario con métricas incluidas.

### GET /simulaciones/:id
Detalle completo con array `mensajes`.

### PATCH /simulaciones/:id/abandonar
Cierra la simulación en curso.

---

## CHAT  🔒  (rate limit: 20 req/min)

### POST /chat — turno de conversación
```json
{
  "simulacion_id": "uuid-de-la-simulacion",
  "mensaje": "Hola Carlos, le llamo de Banco Sur..."
}
```
Respuesta `200`:
```json
{
  "mensaje_whatsapp":    "qué quiere ahora...",
  "estado_emocional":    "Enojado",
  "nivel_satisfaccion":  25,
  "simulacion_finalizada": false,
  "resultado_simulacion": "N/A",
  "feedback_interno":    "Apertura correcta pero genérica.",
  "_xp_ganada":          null,
  "_score_total":        null
}
```
Cuando `simulacion_finalizada: true`, `_xp_ganada` y `_score_total` tienen valores.

---

## USUARIOS  🔒

### GET /usuarios/me/dashboard
Datos completos para el tablero personal:
- `usuario`: perfil con XP y racha
- `stats`: simulaciones, acuerdos, score promedio del mes
- `skills`: promedios por dimensión
- `actividad`: últimos 28 días (heatmap de racha)
- `ranking`: posición en el equipo
- `historial`: últimas 10 simulaciones

### GET /usuarios/me/logros
Lista todos los logros con `desbloqueado_at` (null si bloqueado).

### GET /usuarios/ranking
Ranking completo del equipo con posición, XP y stats del mes.

### GET /usuarios/equipo  🔒 (supervisor)
Vista agregada del equipo: scores por dimensión, tasa de cierre, alertas.

### GET /usuarios/:userId/simulaciones  🔒 (supervisor)
Historial de un asesor específico.

---

## ERRORES

| Código | Significado |
|--------|-------------|
| 400 | Datos inválidos (Zod) |
| 401 | Token ausente, expirado o inválido |
| 403 | Sin permisos para este recurso |
| 404 | Recurso no encontrado |
| 409 | Conflicto (email duplicado, etc.) |
| 429 | Rate limit superado |
| 500 | Error interno |

---

## FLUJO TÍPICO DEL FRONTEND

```
1. POST /auth/login → guardar token en localStorage
2. POST /simulaciones → obtener simulacion_id
3. POST /chat (N veces) → actualizar UI con cada respuesta
4. Cuando simulacion_finalizada === true → mostrar pantalla de resultados
5. GET /usuarios/me/dashboard → actualizar tablero personal
```
