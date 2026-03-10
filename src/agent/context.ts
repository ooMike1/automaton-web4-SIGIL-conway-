/**
 * Context Window Management
 *
 * Manages the conversation history for the agent loop.
 * Handles summarization to keep within token limits.
 */

import type {
  ChatMessage,
  AgentTurn,
  AutomatonDatabase,
  InferenceClient,
} from "../types.js";

const MAX_CONTEXT_TURNS = 4;
const SUMMARY_THRESHOLD = 3;

/**
 * Strip <tool_call>...</tool_call> blocks from text produced by XML-style reasoning models.
 * These blocks in replayed history confuse the model into regenerating them.
 */
function stripXmlToolCallBlocks(text: string): string {
  return text.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Build the message array for the next inference call.
 * Includes system prompt + recent conversation history.
 */
export function buildContextMessages(
  systemPrompt: string,
  recentTurns: AgentTurn[],
  pendingInput?: { content: string; source: string },
): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
  ];

  // Add recent turns as conversation history
  for (const turn of recentTurns) {
    // The turn's input (if any) as a user message
    if (turn.input) {
      messages.push({
        role: "user",
        content: `[${turn.inputSource || "system"}] ${turn.input}`,
      });
    }

    // Detect whether this turn used XML-embedded tool calls (arcee-ai/trinity-mini style).
    // XML turns have IDs like "xml_tc_0". These models don't support role:tool messages,
    // and their reasoning output contains raw <tool_call> XML that will confuse future turns
    // if replayed verbatim. Use a compact text-only history format instead.
    const usedXmlToolCalls = turn.toolCalls.some((tc) => tc.id.startsWith("xml_tc_"));

    if (usedXmlToolCalls) {
      // For XML-based tool call models (trinity-mini style):
      // - Strip XML tool call blocks from reasoning, use as assistant message
      // - Put tool results as a user message so the model sees what happened without copying it
      const cleanThinking = stripXmlToolCallBlocks(turn.thinking || "").slice(0, 300);
      if (cleanThinking) {
        messages.push({ role: "assistant", content: cleanThinking });
      }
      if (turn.toolCalls.length > 0) {
        const toolSummary = turn.toolCalls
          .map((tc) => `${tc.name}: ${tc.error ? `ERROR: ${tc.error.slice(0, 100)}` : tc.result.slice(0, 200)}`)
          .join("\n");
        messages.push({ role: "user", content: `[Previous turn results]\n${toolSummary}` });
      }
    } else {
      // Standard format: assistant message + tool role messages
      if (turn.thinking || turn.toolCalls.length > 0) {
        const msg: ChatMessage = {
          role: "assistant",
          content: turn.thinking || "",
        };

        if (turn.toolCalls.length > 0) {
          msg.tool_calls = turn.toolCalls.map((tc) => ({
            id: tc.id,
            type: "function" as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          }));
        }
        messages.push(msg);

        for (const tc of turn.toolCalls) {
          messages.push({
            role: "tool",
            content: tc.error ? `Error: ${tc.error}` : tc.result,
            tool_call_id: tc.id,
          });
        }
      }
    }
  }

  // Add pending input if any
  if (pendingInput) {
    messages.push({
      role: "user",
      content: `[${pendingInput.source}] ${pendingInput.content}`,
    });
  }

  return messages;
}

/**
 * Trim context to fit within limits.
 * Keeps the system prompt and most recent turns.
 */
export function trimContext(
  turns: AgentTurn[],
  maxTurns: number = MAX_CONTEXT_TURNS,
): AgentTurn[] {
  if (turns.length <= maxTurns) {
    return turns;
  }

  // Keep the most recent turns
  return turns.slice(-maxTurns);
}

/**
 * Summarize old turns into a compact context entry.
 * Used when context grows too large.
 */
export async function summarizeTurns(
  turns: AgentTurn[],
  inference: InferenceClient,
): Promise<string> {
  if (turns.length === 0) return "No previous activity.";

  const turnSummaries = turns.map((t) => {
    const tools = t.toolCalls
      .map((tc) => `${tc.name}(${tc.error ? "FAILED" : "ok"})`)
      .join(", ");
    return `[${t.timestamp}] ${t.inputSource || "self"}: ${t.thinking.slice(0, 100)}${tools ? ` | tools: ${tools}` : ""}`;
  });

  // If few enough turns, just return the summaries directly
  if (turns.length <= 5) {
    return `Previous activity summary:\n${turnSummaries.join("\n")}`;
  }

  // For many turns, use inference to create a summary
  try {
    const response = await inference.chat([
      {
        role: "system",
        content:
          "Summarize the following agent activity log into a concise paragraph. Focus on: what was accomplished, what failed, current goals, and important context for the next turn.",
      },
      {
        role: "user",
        content: turnSummaries.join("\n"),
      },
    ], {
      maxTokens: 500,
      temperature: 0,
    });

    return `Previous activity summary:\n${response.message.content}`;
  } catch {
    // Fallback: just use the raw summaries
    return `Previous activity summary:\n${turnSummaries.slice(-5).join("\n")}`;
  }
}
