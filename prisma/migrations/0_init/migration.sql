-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "positions" (
    "pubkey" TEXT NOT NULL,
    "pool_address" TEXT NOT NULL,
    "pool_name" TEXT NOT NULL,
    "token_mint" TEXT NOT NULL,
    "token_symbol" TEXT NOT NULL,
    "strategy" TEXT NOT NULL,
    "shape" TEXT NOT NULL,
    "bin_step" INTEGER,
    "decided_by" TEXT,
    "deposit_sol" DOUBLE PRECISION NOT NULL,
    "paper" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'open',
    "opened_at" TIMESTAMPTZ(6) NOT NULL,
    "closed_at" TIMESTAMPTZ(6),
    "close_reason" TEXT,
    "realized_sol" DOUBLE PRECISION,
    "data" JSONB NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("pubkey")
);

-- CreateTable
CREATE TABLE "bot_state" (
    "id" INTEGER NOT NULL,
    "day" JSONB NOT NULL,
    "closed_pool_at" JSONB NOT NULL,
    "paper_balance_sol" DOUBLE PRECISION,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bot_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal" (
    "id" BIGSERIAL NOT NULL,
    "ts" TIMESTAMPTZ(6) NOT NULL,
    "type" TEXT NOT NULL,
    "pool" TEXT,
    "position" TEXT,
    "data" JSONB NOT NULL,

    CONSTRAINT "journal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cycles" (
    "n" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "status" TEXT NOT NULL,
    "steps" JSONB NOT NULL,

    CONSTRAINT "cycles_pkey" PRIMARY KEY ("n")
);

-- CreateIndex
CREATE INDEX "positions_status_idx" ON "positions"("status");

-- CreateIndex
CREATE INDEX "positions_opened_idx" ON "positions"("opened_at" DESC);

-- CreateIndex
CREATE INDEX "journal_ts_idx" ON "journal"("ts" DESC, "id" DESC);

-- CreateIndex
CREATE INDEX "journal_type_idx" ON "journal"("type");

