/**
 * Conway Inference Client
 *
 * Wraps Conway's /v1/chat/completions endpoint (OpenAI-compatible).
 * The automaton pays for its own thinking through Conway credits.
 */

import type {
  InferenceClient,
  ChatMessage,
  InferenceOptions,
  InferenceResponse,
  InferenceToolCall,
  TokenUsage,
  InferenceToolDefinition,
} from "../types.js";

// Groq model name prefixes — if a model starts with any of these, route to Groq automatically
const GROQ_MODEL_PREFIXES = [
  "llama", "mixtral", "gemma", "deepseek-r1", "qwen", "whisper",
];

function isGroqModel(model: string): boolean {
  const lower = model.toLowerCase();
  return GROQ_MODEL_PREFIXES.some((p) => lower.startsWith(p));
}

interface InferenceClientOptions {
  apiUrl: string;
  apiKey: string;
  /** API key para proveedor cloud (Groq, Gemini, etc.). Si se pone, se usa con prefijo Bearer. */
  inferenceApiKey?: string;
  /** Groq API key — si se provee, los modelos Groq se enrutan automáticamente a api.groq.com */
  groqApiKey?: string;
  defaultModel: string;
  maxTokens: number;
  lowComputeModel?: string;
}

export function createInferenceClient(
  options: InferenceClientOptions,
): InferenceClient {
  const { apiUrl, apiKey } = options;
  let currentModel = options.defaultModel;
  let maxTokens = options.maxTokens;

  const chat = async (
    messages: ChatMessage[],
    opts?: InferenceOptions,
  ): Promise<InferenceResponse> => {
    const model = opts?.model || currentModel;
    const tools = opts?.tools;

    // Newer models (o-series, gpt-5.x, gpt-4.1) require max_completion_tokens
    const usesCompletionTokens = /^(o[1-9]|gpt-5|gpt-4\.1)/.test(model);
    const tokenLimit = opts?.maxTokens || maxTokens;

    const body: Record<string, unknown> = {
      model,
      messages: messages.map(formatMessage),
      stream: false,
    };

    if (usesCompletionTokens) {
      body.max_completion_tokens = tokenLimit;
    } else {
      body.max_tokens = tokenLimit;
    }

    if (opts?.temperature !== undefined) {
      body.temperature = opts.temperature;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    // Auto-route Groq models to api.groq.com if a Groq key is configured
    const useGroq = isGroqModel(model) && !!options.groqApiKey;
    const effectiveUrl = useGroq ? "https://api.groq.com/openai" : apiUrl;

    const isLocal = effectiveUrl.includes("localhost") || effectiveUrl.includes("127.0.0.1") || effectiveUrl.includes("192.168.");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (!isLocal) {
      if (useGroq) {
        headers["Authorization"] = `Bearer ${options.groqApiKey}`;
      } else {
        const key = options.inferenceApiKey || apiKey;
        headers["Authorization"] = options.inferenceApiKey ? `Bearer ${key}` : key;
      }
    }

    if (useGroq) {
      console.log(`[INFERENCE] Routing to Groq: ${model}`);
    }

    const resp = await fetch(`${effectiveUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(
        `Inference error: ${resp.status}: ${text}`,
      );
    }

    const data = await resp.json() as any;
    let choice = data.choices?.[0];
    let message: any;

    // Fallback: handle Ollama native format (response field at root)
    if (!choice && data.response) {
      message = {
        role: "assistant",
        content: data.response,
      };
      choice = { message, finish_reason: data.done_reason || "stop" };
    } else if (!choice && data.message) {
      message = data.message;
      choice = { message, finish_reason: data.stop_reason || "stop" };
    } else if (choice) {
      message = choice.message;
    }

    if (!message) {
      console.error("[INFERENCE DEBUG] Unexpected response structure:", JSON.stringify(data).slice(0, 500));
      throw new Error(`No completion choice returned from inference. Response: ${JSON.stringify(data).slice(0, 200)}`);
    }
    const usage: TokenUsage = {
      promptTokens: data.usage?.prompt_tokens || 0,
      completionTokens: data.usage?.completion_tokens || 0,
      totalTokens: data.usage?.total_tokens || 0,
    };

    const toolCalls: InferenceToolCall[] | undefined =
      message.tool_calls?.map((tc: any) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));

    return {
      id: data.id || "",
      model: data.model || model,
      message: {
        role: message.role,
        content: message.content || "",
        tool_calls: toolCalls,
      },
      toolCalls,
      usage,
      finishReason: choice.finish_reason || "stop",
    };
  };

  const setLowComputeMode = (enabled: boolean): void => {
    if (enabled) {
      currentModel = options.lowComputeModel || "gpt-4.1";
      maxTokens = 4096;
    } else {
      currentModel = options.defaultModel;
      maxTokens = options.maxTokens;
    }
  };

  const getDefaultModel = (): string => {
    return currentModel;
  };

  return {
    chat,
    setLowComputeMode,
    getDefaultModel,
  };
}

function formatMessage(
  msg: ChatMessage,
): Record<string, unknown> {
  const formatted: Record<string, unknown> = {
    role: msg.role,
    content: msg.content,
  };

  if (msg.name) formatted.name = msg.name;
  if (msg.tool_calls) formatted.tool_calls = msg.tool_calls;
  if (msg.tool_call_id) formatted.tool_call_id = msg.tool_call_id;

  return formatted;
}
