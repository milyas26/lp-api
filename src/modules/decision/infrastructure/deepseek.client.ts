import type { AgentConfig } from "../../../shared/config";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[]; reasoning_content?: string }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface ChatResponse {
  choices?: {
    message?: { content?: string | null; tool_calls?: ToolCall[]; reasoning_content?: string };
    finish_reason?: string;
  }[];
  error?: { message?: string };
}

/** DeepSeek chat completions (OpenAI-compatible) with function calling. */
export class DeepSeek {
  readonly label = "DeepSeek";

  constructor(private readonly cfg: AgentConfig["llm"]) {}

  get model(): string {
    return this.cfg.model;
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<Extract<ChatMessage, { role: "assistant" }>> {
    const reasoner = this.cfg.model.includes("reasoner");
    let res: Response;
    try {
      res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify({
          model: this.cfg.model,
          messages,
          tools,
          max_tokens: reasoner ? 8000 : 1500,
          ...(reasoner ? {} : { temperature: 0.2 }),
        }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (e) {
      throw new Error(`request gagal: ${(e as Error).message}`);
    }

    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as ChatResponse;
      const hint =
        res.status === 401
          ? " (DEEPSEEK_API_KEY ditolak)"
          : res.status === 402
            ? " (saldo DeepSeek habis)"
            : res.status === 429
              ? " (rate limit)"
              : "";
      throw new Error(`HTTP ${res.status}${hint}: ${body.error?.message ?? res.statusText}`);
    }

    const body = (await res.json()) as ChatResponse;
    const msg = body.choices?.[0]?.message;
    if (!msg) throw new Error(`balasan kosong (finish_reason=${body.choices?.[0]?.finish_reason})`);
    return {
      role: "assistant",
      content: msg.content ?? null,
      ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
      // Thinking mode needs its reasoning echoed back within the same tool-call turn.
      ...(msg.reasoning_content ? { reasoning_content: msg.reasoning_content } : {}),
    };
  }
}
