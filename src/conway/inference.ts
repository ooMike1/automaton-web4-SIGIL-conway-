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

// Models that must always be routed to Groq even if they contain "/" (overrides OpenRouter detection)
const GROQ_EXPLICIT_MODELS = new Set([
  "openai/gpt-oss-20b",
]);

function isGroqModel(model: string): boolean {
  const lower = model.toLowerCase();
  if (GROQ_EXPLICIT_MODELS.has(lower)) return true;
  return GROQ_MODEL_PREFIXES.some((p) => lower.startsWith(p));
}

// OpenRouter models always contain a "/" (e.g. "deepseek/deepseek-chat-v3:free")
// Explicit Groq models take precedence even if they contain "/"
function isOpenRouterModel(model: string): boolean {
  return model.includes("/") && !GROQ_EXPLICIT_MODELS.has(model.toLowerCase());
}

interface InferenceClientOptions {
  apiUrl: string;
  apiKey: string;
  /** API key para proveedor cloud (Groq, Gemini, etc.). Si se pone, se usa con prefijo Bearer. */
  inferenceApiKey?: string;
  /** Groq API key — si se provee, los modelos Groq se enrutan automáticamente a api.groq.com */
  groqApiKey?: string;
  /** OpenRouter API key — si se provee, los modelos con "/" se enrutan a openrouter.ai */
  openRouterApiKey?: string;
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
    const useGroq = isGroqModel(model) && !!options.groqApiKey && !isOpenRouterModel(model);
    // Auto-route OpenRouter models (contain "/") to openrouter.ai if a key is configured
    const useOpenRouter = isOpenRouterModel(model) && !!options.openRouterApiKey;

    const effectiveUrl = useOpenRouter
      ? "https://openrouter.ai/api"
      : useGroq
        ? "https://api.groq.com/openai"
        : apiUrl;

    const isLocal = effectiveUrl.includes("localhost") || effectiveUrl.includes("127.0.0.1") || effectiveUrl.includes("192.168.");
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (!isLocal) {
      if (useOpenRouter) {
        headers["Authorization"] = `Bearer ${options.openRouterApiKey}`;
        headers["HTTP-Referer"] = "https://conway.tech";
        headers["X-Title"] = "Agatha Automaton";
      } else if (useGroq) {
        headers["Authorization"] = `Bearer ${options.groqApiKey}`;
      } else {
        const key = options.inferenceApiKey || apiKey;
        headers["Authorization"] = options.inferenceApiKey ? `Bearer ${key}` : key;
      }
    }

    if (useOpenRouter) {
      console.log(`[INFERENCE] Routing to OpenRouter: ${model}`);
    } else if (useGroq) {
      console.log(`[INFERENCE] Routing to Groq: ${model}`);
    }

    // Retry once on 429 rate-limit, waiting the suggested time
    let resp = await fetch(`${effectiveUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (resp.status === 429) {
      const retryText = await resp.text();
      // Groq embeds "Please try again in Xs" in the error message
      const match = retryText.match(/try again in ([\d.]+)s/);
      const waitMs = match ? Math.ceil(parseFloat(match[1]) * 1000) + 2000 : 62000;
      console.log(`[INFERENCE] Rate limited. Waiting ${Math.round(waitMs / 1000)}s before retry...`);
      await new Promise((r) => setTimeout(r, waitMs));
      resp = await fetch(`${effectiveUrl}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    }

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

    let toolCalls: InferenceToolCall[] | undefined =
      message.tool_calls?.map((tc: any) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.function.name,
          arguments: tc.function.arguments,
        },
      }));

    // Reasoning models (e.g. arcee-ai/trinity-mini) return content=null and text in reasoning field
    const textContent = message.content || message.reasoning || "";

    // Some reasoning models embed tool calls as <tool_call> XML in text output.
    // Extract and promote them to real tool_calls if the API returned none.
    if ((!toolCalls || toolCalls.length === 0) && textContent) {
      const xmlToolCalls = parseXmlToolCalls(textContent);
      if (xmlToolCalls.length > 0) {
        toolCalls = xmlToolCalls;
      }
    }

    return {
      id: data.id || "",
      model: data.model || model,
      message: {
        role: message.role,
        content: textContent,
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

/**
 * Extract tool calls embedded as XML by reasoning models like arcee-ai/trinity-mini.
 * These models output tool calls inside the text rather than via the function-calling API.
 * Deduplicates by (name, arguments) to avoid executing the same call multiple times
 * when the model repeats its reasoning pattern.
 */
function parseXmlToolCalls(text: string): InferenceToolCall[] {
  const results: InferenceToolCall[] = [];
  const seen = new Set<string>();
  const pattern = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  const matches = [...text.matchAll(pattern)];
  let idx = 0;
  for (const m of matches) {
    try {
      const parsed = JSON.parse(m[1].trim());
      const fnName: string = parsed.name || parsed.function || "";
      const args = parsed.arguments ?? parsed.parameters ?? {};
      if (!fnName) continue;
      const argsStr = typeof args === "string" ? args : JSON.stringify(args);
      const key = `${fnName}:${argsStr}`;
      if (seen.has(key)) continue; // skip duplicate
      seen.add(key);
      results.push({
        id: `xml_tc_${idx++}`,
        type: "function" as const,
        function: { name: fnName, arguments: argsStr },
      });
    } catch {
      // Malformed JSON inside tag — skip
    }
  }
  return results;
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
