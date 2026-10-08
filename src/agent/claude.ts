import axios from "axios";
import { env } from "../config";
import { prisma } from "../db/client";
import { toolDefinitions, executeTool, describePatientState, AgentContext } from "./tools";
import { buildSystemPrompt } from "./prompts";
import { recordEvent } from "../services/auditLog";
import { recordLlmCall } from "../services/llmStats";
import { logger } from "../lib/logger";

// OpenRouter expone una API compatible con la de OpenAI (chat completions +
// function calling), y permite pagar con tarjeta normal sin pedir IBAN ni
// datos de empresa. Documentación: https://openrouter.ai/docs
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

const HISTORY_MESSAGES_LIMIT = 20; // últimos N mensajes de contexto por conversación
const MAX_TOOL_ITERATIONS = 6; // corta bucles de herramientas descontrolados
const FALLBACK_REPLY =
  "Perdona, ahora mismo no puedo consultar la agenda. Inténtalo de nuevo en unos segundos o, si es urgente, llama directamente al centro.";

type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenRouterToolCall[];
  tool_call_id?: string;
};

interface OpenRouterToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenRouterResponse {
  choices: {
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: OpenRouterToolCall[];
    };
    finish_reason: string;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// Traduce nuestras definiciones genéricas (JSON Schema) al formato de
// "tools" que espera la API de OpenRouter/OpenAI.
const openRouterTools = toolDefinitions.map((t) => ({
  type: "function" as const,
  function: {
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  },
}));

async function loadHistory(patientId: string): Promise<ChatMessage[]> {
  const rows = await prisma.conversationMessage.findMany({
    where: { patientId },
    orderBy: { createdAt: "desc" },
    take: HISTORY_MESSAGES_LIMIT,
  });
  return rows
    .reverse()
    .map((r) => ({ role: r.role as "user" | "assistant", content: r.content }));
}

async function saveMessage(patientId: string, role: "user" | "assistant", content: string) {
  await prisma.conversationMessage.create({ data: { patientId, role, content } });
}

async function callOpenRouter(messages: ChatMessage[]) {
  const started = Date.now();
  try {
    const { data } = await axios.post<OpenRouterResponse>(
      OPENROUTER_URL,
      {
        model: env.openRouterModel,
        max_tokens: 1024,
        messages,
        tools: openRouterTools,
      },
      {
        headers: {
          Authorization: `Bearer ${env.openRouterApiKey()}`,
          "Content-Type": "application/json",
          // Recomendado por OpenRouter para identificar la app en su dashboard.
          "HTTP-Referer": "http://localhost",
          "X-Title": "Clinic WhatsApp Agent (demo local)",
        },
        timeout: 30_000,
      }
    );
    const latencyMs = Date.now() - started;
    const message = data.choices[0].message;
    logger.info("openrouter_call", { model: env.openRouterModel, ms: latencyMs, tokens: data.usage });
    await recordLlmCall({
      model: env.openRouterModel,
      latencyMs,
      promptTokens: data.usage?.prompt_tokens,
      completionTokens: data.usage?.completion_tokens,
      toolCallCount: message.tool_calls?.length ?? 0,
      success: true,
    });
    return message;
  } catch (err) {
    await recordLlmCall({ model: env.openRouterModel, latencyMs: Date.now() - started, toolCallCount: 0, success: false });
    throw err;
  }
}

export interface AgentReply {
  reply: string;
  handoffReason?: string;
}

/**
 * Procesa un mensaje entrante del paciente: llama al modelo (vía
 * OpenRouter) con las herramientas de agenda, ejecuta las que pida, y
 * devuelve el texto final que hay que responder por WhatsApp.
 *
 * Nunca lanza: cualquier fallo (red, el proveedor caído, un tool que
 * revienta) se registra y se convierte en una respuesta natural para el
 * paciente (ver README, "Manejo de errores del agente") — un paciente real
 * de WhatsApp nunca debe ver un error técnico ni quedarse sin respuesta.
 */
export async function handleIncomingMessage(ctx: AgentContext, userText: string): Promise<AgentReply> {
  await saveMessage(ctx.patientId, "user", userText);
  await recordEvent("PATIENT_MESSAGE_RECEIVED", { patientId: ctx.patientId });

  try {
    const result = await runAgentLoop(ctx, userText);
    await saveMessage(ctx.patientId, "assistant", result.reply);
    return result;
  } catch (err) {
    logger.error("agent_loop_failed", { patientId: ctx.patientId, err });
    await recordEvent("AGENT_ERROR", { patientId: ctx.patientId, metadata: { message: (err as Error)?.message } });
    await saveMessage(ctx.patientId, "assistant", FALLBACK_REPLY);
    return { reply: FALLBACK_REPLY };
  }
}

async function runAgentLoop(ctx: AgentContext, userText: string): Promise<AgentReply> {
  const history = await loadHistory(ctx.patientId);
  const patientState = await describePatientState(ctx);
  const system = buildSystemPrompt(patientState);

  const messages: ChatMessage[] = [{ role: "system", content: system }, ...history];

  let finalText = "";
  let handoffReason: string | undefined;

  for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
    const message = await callOpenRouter(messages);
    const toolCalls = message.tool_calls || [];

    if (toolCalls.length === 0) {
      finalText = (message.content || "").trim();
      break;
    }

    messages.push({ role: "assistant", content: message.content, tool_calls: toolCalls });

    for (const call of toolCalls) {
      let resultText: string;
      try {
        const input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        const result = await executeTool(call.function.name, input, ctx);
        resultText = result.text;
        if (result.handoffReason) handoffReason = result.handoffReason;
      } catch (err) {
        logger.error("tool_execution_failed", { tool: call.function.name, err });
        resultText = `ERROR: no se pudo ejecutar ${call.function.name} ahora mismo. Informa al paciente con naturalidad y sugiere reintentarlo.`;
      }
      messages.push({ role: "tool", tool_call_id: call.id, content: resultText });
    }
  }

  if (!finalText) {
    finalText =
      "Perdona, he tenido un problema procesando tu solicitud. ¿Puedes reformularla o intentarlo de nuevo en un momento?";
  }

  return { reply: finalText, handoffReason };
}
