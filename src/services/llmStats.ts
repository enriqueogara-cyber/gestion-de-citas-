import { prisma } from "../db/client";

/**
 * Precios orientativos de OpenRouter (USD por millón de tokens), solo para
 * dar una cifra aproximada en el panel de desarrollo — NUNCA se usa para
 * facturar nada real. Si el modelo no está en la tabla, se omite el coste
 * en vez de inventar un número.
 */
const PRICE_PER_MILLION_TOKENS_USD: Record<string, { input: number; output: number }> = {
  "anthropic/claude-sonnet-4.5": { input: 3, output: 15 },
  "anthropic/claude-haiku-4.5": { input: 1, output: 5 },
  "openai/gpt-4o-mini": { input: 0.15, output: 0.6 },
};

export async function recordLlmCall(params: {
  model: string;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  toolCallCount: number;
  success: boolean;
}): Promise<void> {
  try {
    await prisma.llmCallLog.create({ data: params });
  } catch {
    // Instrumentación best-effort: si falla, no debe tumbar la conversación.
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

export interface LlmStats {
  calls: number;
  successRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  avgToolCallsPerMessage: number;
  estimatedCostUsd: number | null;
  byModel: { model: string; calls: number; avgLatencyMs: number }[];
}

/** Últimas N llamadas (por defecto una ventana razonable para no escanear toda la tabla en un MVP). */
export async function getLlmStats(limit = 500): Promise<LlmStats> {
  const rows = await prisma.llmCallLog.findMany({ orderBy: { createdAt: "desc" }, take: limit });
  if (rows.length === 0) {
    return {
      calls: 0,
      successRate: 0,
      avgLatencyMs: 0,
      p50LatencyMs: 0,
      p95LatencyMs: 0,
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      avgToolCallsPerMessage: 0,
      estimatedCostUsd: null,
      byModel: [],
    };
  }

  const latencies = rows.map((r) => r.latencyMs).sort((a, b) => a - b);
  const totalPromptTokens = rows.reduce((s, r) => s + (r.promptTokens ?? 0), 0);
  const totalCompletionTokens = rows.reduce((s, r) => s + (r.completionTokens ?? 0), 0);

  let cost = 0;
  let costKnown = true;
  for (const r of rows) {
    const price = PRICE_PER_MILLION_TOKENS_USD[r.model];
    if (!price || r.promptTokens == null || r.completionTokens == null) {
      costKnown = false;
      continue;
    }
    cost += (r.promptTokens / 1_000_000) * price.input + (r.completionTokens / 1_000_000) * price.output;
  }

  const byModelMap = new Map<string, { calls: number; totalLatency: number }>();
  for (const r of rows) {
    const entry = byModelMap.get(r.model) ?? { calls: 0, totalLatency: 0 };
    entry.calls += 1;
    entry.totalLatency += r.latencyMs;
    byModelMap.set(r.model, entry);
  }

  return {
    calls: rows.length,
    successRate: rows.filter((r) => r.success).length / rows.length,
    avgLatencyMs: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
    p50LatencyMs: percentile(latencies, 50),
    p95LatencyMs: percentile(latencies, 95),
    totalPromptTokens,
    totalCompletionTokens,
    avgToolCallsPerMessage: rows.reduce((s, r) => s + r.toolCallCount, 0) / rows.length,
    estimatedCostUsd: costKnown || cost > 0 ? Math.round(cost * 10000) / 10000 : null,
    byModel: [...byModelMap.entries()].map(([model, v]) => ({
      model,
      calls: v.calls,
      avgLatencyMs: Math.round(v.totalLatency / v.calls),
    })),
  };
}
