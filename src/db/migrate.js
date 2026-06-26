// Ejecutar con: npm run db:migrate
import { query } from "./pool.js";

const MIGRATION = `
-- ─── EXTENSIONES ──────────────────────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─── USUARIOS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS usuarios (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  nombre        VARCHAR(100) NOT NULL,
  email         VARCHAR(255) NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  rol           VARCHAR(20) NOT NULL DEFAULT 'asesor'
                CHECK (rol IN ('asesor','supervisor','admin')),
  nivel         VARCHAR(20) NOT NULL DEFAULT 'junior'
                CHECK (nivel IN ('junior','semi','senior')),
  nivel_num     SMALLINT NOT NULL DEFAULT 1,
  xp_total      INTEGER NOT NULL DEFAULT 0,
  racha_actual  SMALLINT NOT NULL DEFAULT 0,
  racha_record  SMALLINT NOT NULL DEFAULT 0,
  activo        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── SIMULACIONES ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS simulaciones (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  usuario_id        UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  arquetipo_cliente VARCHAR(50) NOT NULL
                    CHECK (arquetipo_cliente IN (
                      'Evasivo','Enojado-Defensivo',
                      'Angustiado-Víctima','Negociador-Difícil'
                    )),
  nombre_cliente    VARCHAR(100) NOT NULL,
  deuda_monto       NUMERIC(12,2) NOT NULL,
  deuda_producto    VARCHAR(100) NOT NULL,
  dias_atraso       INTEGER NOT NULL CHECK (dias_atraso >= 0),
  excusa_principal  TEXT,
  estado            VARCHAR(20) NOT NULL DEFAULT 'en_curso'
                    CHECK (estado IN ('en_curso','finalizada','abandonada')),
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sims_usuario  ON simulaciones(usuario_id);
CREATE INDEX IF NOT EXISTS idx_sims_estado   ON simulaciones(estado);
CREATE INDEX IF NOT EXISTS idx_sims_started  ON simulaciones(started_at DESC);

-- ─── MENSAJES ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS mensajes (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  simulacion_id    UUID NOT NULL REFERENCES simulaciones(id) ON DELETE CASCADE,
  role             VARCHAR(20) NOT NULL CHECK (role IN ('user','assistant','system')),
  contenido        TEXT NOT NULL,
  respuesta_json   JSONB,           -- JSON completo devuelto por IA (solo assistant)
  tokens_input     INTEGER,
  tokens_output    INTEGER,
  orden            INTEGER NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_msgs_sim   ON mensajes(simulacion_id, orden);

-- ─── MÉTRICAS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS metricas (
  id                     UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  simulacion_id          UUID NOT NULL UNIQUE REFERENCES simulaciones(id) ON DELETE CASCADE,
  resultado              VARCHAR(40) NOT NULL DEFAULT 'N/A'
                         CHECK (resultado IN (
                           'N/A','Acuerdo_Alcanzado',
                           'Cliente_Colgo_Chat','Negociacion_Fracasada'
                         )),
  score_empatia          SMALLINT CHECK (score_empatia BETWEEN 0 AND 100),
  score_negociacion      SMALLINT CHECK (score_negociacion BETWEEN 0 AND 100),
  score_cierre           SMALLINT CHECK (score_cierre BETWEEN 0 AND 100),
  score_total            SMALLINT CHECK (score_total BETWEEN 0 AND 100),
  estado_emocional_final VARCHAR(20),
  feedback_resumen       TEXT,
  feedback_por_turno     JSONB,     -- [{orden, feedback, score}, ...]
  xp_ganada              INTEGER NOT NULL DEFAULT 0,
  calculado_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── LOGROS ───────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS logros (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug        VARCHAR(60) NOT NULL UNIQUE,
  label       VARCHAR(100) NOT NULL,
  descripcion TEXT NOT NULL,
  xp          INTEGER NOT NULL DEFAULT 0,
  icono       VARCHAR(50)
);

CREATE TABLE IF NOT EXISTS usuario_logros (
  usuario_id    UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  logro_id      UUID NOT NULL REFERENCES logros(id) ON DELETE CASCADE,
  desbloqueado_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (usuario_id, logro_id)
);

-- ─── RACHA DIARIA ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS actividad_diaria (
  usuario_id   UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  fecha        DATE NOT NULL,
  sims         SMALLINT NOT NULL DEFAULT 0,
  acuerdos     SMALLINT NOT NULL DEFAULT 0,
  xp_dia       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (usuario_id, fecha)
);

-- ─── DESAFÍOS ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS desafios (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  slug         VARCHAR(60) NOT NULL UNIQUE,
  label        VARCHAR(100) NOT NULL,
  descripcion  TEXT NOT NULL,
  xp           INTEGER NOT NULL DEFAULT 0,
  meta_tipo    VARCHAR(40) NOT NULL, -- 'acuerdos_arquetipo' | 'sims_consecutivas' | 'score_minimo'
  meta_valor   INTEGER NOT NULL,
  activo       BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS usuario_desafios (
  usuario_id   UUID NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  desafio_id   UUID NOT NULL REFERENCES desafios(id) ON DELETE CASCADE,
  progreso     INTEGER NOT NULL DEFAULT 0,
  completado   BOOLEAN NOT NULL DEFAULT FALSE,
  inicio_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fin_at       TIMESTAMPTZ,
  PRIMARY KEY (usuario_id, desafio_id)
);

-- ─── FUNCIÓN: updated_at automático ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_usuarios_updated ON usuarios;
CREATE TRIGGER trg_usuarios_updated
  BEFORE UPDATE ON usuarios
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
`;

async function migrate() {
  console.log("🚀 Ejecutando migración...");
  try {
    await query(MIGRATION);
    console.log("✅ Migración completada.");
    process.exit(0);
  } catch (err) {
    console.error("❌ Error en migración:", err.message);
    process.exit(1);
  }
}

migrate();
