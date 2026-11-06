#!/usr/bin/env node
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// vs-core/node-runtime/main.ts
var readline = __toESM(require("node:readline"));
var nodePath2 = __toESM(require("node:path"));
var nodeOs = __toESM(require("node:os"));
var fs14 = __toESM(require("node:fs"));

// vs-core/base/common/uri.ts
var path = __toESM(require("node:path"));
var URI = class _URI {
  scheme;
  authority;
  path;
  query;
  fragment;
  constructor(scheme, authority, uriPath, query, fragment) {
    this.scheme = scheme;
    this.authority = authority;
    this.path = uriPath;
    this.query = query;
    this.fragment = fragment;
  }
  get fsPath() {
    return this.path;
  }
  toString() {
    if (this.scheme === "file") {
      return `file://${this.path}`;
    }
    return `${this.scheme}://${this.authority}${this.path}${this.query ? "?" + this.query : ""}${this.fragment ? "#" + this.fragment : ""}`;
  }
  with(change) {
    return new _URI(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment
    );
  }
  static file(filePath) {
    const resolved = path.resolve(filePath);
    return new _URI("file", "", resolved, "", "");
  }
  static parse(value) {
    const match = value.match(/^([a-z][a-z0-9+\-.]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i);
    if (match) {
      return new _URI(match[1], match[2] || "", match[3] || "/", (match[4] || "").slice(1), (match[5] || "").slice(1));
    }
    return _URI.file(value);
  }
  static isUri(thing) {
    return thing instanceof _URI;
  }
};

// src/vs/workbench/services/agent/common/agentModels.ts
var DEFAULT_AGENT_CONFIG = {
  provider: "openai",
  model: "glm-5.3",
  apiKey: "",
  maxSteps: 999999,
  // Effectively unlimited
  maxContextTokens: 2e5,
  maxOutputTokens: 65536,
  temperature: 0,
  topK: 0,
  // 0 = provider default (not sent); set >0 to pin top_k for reproducible benchmarks
  stepTimeout: 3e5,
  // 5 minutes - allow tools with custom timeouts to complete
  taskTimeout: 36e5
  // 1 hour
};
function createMessage(role, content, extra) {
  return {
    id: generateId(),
    role,
    content,
    timestamp: Date.now(),
    ...extra
  };
}
function createToolResultMessage(result) {
  const content = result.output || result.error || "(no output)";
  return createMessage("tool" /* Tool */, content, {
    toolCallId: result.toolCallId
  });
}
var _idCounter = 0;
function generateId() {
  return `msg_${Date.now()}_${_idCounter++}`;
}

// src/vs/workbench/services/agent/browser/llmProvider.ts
var ContextOverflowError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "ContextOverflowError";
  }
};
var CJK_REGEX = /[\u3000-\u9FFF\uAC00-\uD7AF\uFF00-\uFFEF\u2000-\u206F\u2E80-\u2FFF\u3040-\u30FF\u31C0-\u31EF\uF900-\uFAFF\uFE30-\uFE4F]/g;
function estimateTokenCount(text) {
  if (!text) return 0;
  const cjkMatches = text.match(CJK_REGEX);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const otherLen = text.length - cjkCount;
  return Math.ceil(cjkCount * 1.5) + Math.ceil(otherLen / 3) + 1;
}
var TOKENS_PER_MESSAGE_OVERHEAD = 12;
var LLMProviderFactory = class _LLMProviderFactory {
  static _providers = /* @__PURE__ */ new Map();
  static register(name, ctor) {
    _LLMProviderFactory._providers.set(name, ctor);
  }
  static create(config) {
    const ctor = _LLMProviderFactory._providers.get(config.provider);
    if (!ctor) {
      throw new Error(`Unknown LLM provider: ${config.provider}. Available: ${[..._LLMProviderFactory._providers.keys()].join(", ")}`);
    }
    return new ctor(config);
  }
};

// src/vs/workbench/services/agent/browser/llmOpenai.ts
var MAX_RETRIES = 3;
var INITIAL_RETRY_DELAY_MS = 1e3;
var RETRYABLE_STATUS_CODES = /* @__PURE__ */ new Set([429, 500, 502, 503, 504]);
var API_REQUEST_TIMEOUT_MS = 3e5;
var MIN_COMPLETION_TOKENS = 2048;
var CONTEXT_RESERVE_RATIO = 0.05;
var HEALTH_CHECK_MAX_TOKENS = 8;
var MIN_CONTEXT_RESERVE = 1024;
function minCompletionFloor(maxOutputTokens) {
  return Math.min(MIN_COMPLETION_TOKENS, maxOutputTokens);
}
function sleepWithProgress(ms, label) {
  const totalSec = Math.ceil(ms / 1e3);
  const start = Date.now();
  return new Promise((resolve12) => {
    let lastUpdate = 0;
    const timer = setInterval(() => {
      const elapsed = Math.floor((Date.now() - start) / 1e3);
      if (elapsed !== lastUpdate) {
        lastUpdate = elapsed;
        const remaining = Math.max(0, totalSec - elapsed);
        process.stdout.write(`\r  \u23F3 ${label} \u2014 waited ${elapsed}s, ${remaining}s remaining...`);
      }
    }, 250);
    setTimeout(() => {
      clearInterval(timer);
      process.stdout.write(`\r  \u2705 ${label} \u2014 done after ${totalSec}s    
`);
      resolve12();
    }, ms);
  });
}
function shouldRetry(statusCode) {
  return RETRYABLE_STATUS_CODES.has(statusCode);
}
function isReasoningEchoError(errorText) {
  return errorText.includes("reasoning_content") && errorText.includes("must be passed back");
}
var OpenAIProvider = class {
  name = "openai";
  _apiKey;
  _apiBase;
  _model;
  _supportsReasoning;
  _thinking;
  _maxOutputTokens;
  _maxContextTokens;
  /**
   * Set as soon as this model has actually answered with `reasoning_content`.
   *
   * A gateway can run a model in thinking mode without announcing it: on
   * api.enflame.cn, `deepseek-flash` is declared `supportsReasoning: false`, no
   * `thinking` param is sent, yet every answer carries reasoning_content — and
   * any request that omits it is rejected with HTTP 400 ("The
   * `reasoning_content` in the thinking mode must be passed back to the API").
   * Trusting the observed behaviour instead of the model id is what keeps a
   * session alive after a 保底-model switch dropped the chain-of-thought.
   */
  _sawReasoning = false;
  /**
   * Set when the API explicitly demanded the reasoning_content echo-back
   * (see `_doComplete`). Covers a model that has not answered yet in this
   * process — e.g. a fresh run resuming a session whose reasoning_content was
   * stripped, or a model this provider has never talked to.
   */
  _requiresReasoningEcho = false;
  constructor(config) {
    this._apiKey = config.apiKey;
    this._apiBase = config.apiBase || "https://api.openai.com/v1";
    this._model = config.model;
    this._supportsReasoning = config.supportsReasoning === true || config.thinking !== void 0;
    this._thinking = config.thinking;
    this._maxOutputTokens = config.maxOutputTokens || 65536;
    this._maxContextTokens = config.maxContextTokens || this._maxOutputTokens * 4;
  }
  async complete(messages, tools, temperature = 0, topK) {
    return this._doComplete(messages, tools, temperature, topK, true);
  }
  async _doComplete(messages, tools, temperature = 0, topK, allowRetry) {
    const body = {
      model: this._model,
      messages: this._convertMessages(messages),
      ...this._samplingParams(temperature, topK)
    };
    const clampedMaxTokens = this._clampMaxTokens(messages, tools);
    if (clampedMaxTokens < minCompletionFloor(this._maxOutputTokens)) {
      throw new ContextOverflowError(
        `Context window nearly full: estimated input leaves only ${clampedMaxTokens} tokens for completion (minimum ${minCompletionFloor(this._maxOutputTokens)}). Conversation history must be compacted.`
      );
    }
    body.max_tokens = clampedMaxTokens;
    if (this._thinking) {
      body.thinking = this._thinking;
    }
    if (tools && tools.length > 0) {
      body.tools = tools;
      body.parallel_tool_calls = true;
    }
    const abortController = new AbortController();
    const apiTimeout = setTimeout(() => abortController.abort(), API_REQUEST_TIMEOUT_MS);
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await fetch(`${this._apiBase}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this._apiKey}`
          },
          body: JSON.stringify(body),
          signal: abortController.signal
        });
        if (!response.ok) {
          const errorText = await response.text();
          if (allowRetry && response.status === 400 && this._isTemperatureError(errorText)) {
            this._skipTemperature = true;
            clearTimeout(apiTimeout);
            return this._doComplete(messages, tools, temperature, topK, false);
          }
          if (response.status === 400 && this._isContextOverflowError(errorText)) {
            const currentMaxTokens = body.max_tokens;
            if (attempt < MAX_RETRIES && currentMaxTokens > MIN_COMPLETION_TOKENS) {
              const reduced = Math.max(MIN_COMPLETION_TOKENS, Math.floor(currentMaxTokens / 4));
              body.max_tokens = reduced;
              const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
              console.warn(`[LLM Retry] Context overflow \u2014 reducing max_tokens ${currentMaxTokens} -> ${reduced} (attempt ${attempt + 1}/${MAX_RETRIES})`);
              lastError = new Error(`OpenAI API error ${response.status}: ${errorText}`);
              await sleepWithProgress(delay, "Retry backoff");
              continue;
            }
            clearTimeout(apiTimeout);
            throw new ContextOverflowError(`Model context window exceeded: ${errorText}`);
          }
          if (allowRetry && response.status === 400 && !this._requiresReasoningEcho && isReasoningEchoError(errorText)) {
            this._requiresReasoningEcho = true;
            clearTimeout(apiTimeout);
            console.warn(
              `[LLM] ${this._model} answers in thinking mode \u2014 resending the request with reasoning_content echoed back on every assistant message`
            );
            return this._doComplete(messages, tools, temperature, topK, false);
          }
          if (this._isDeepSeekRecoverableError(response.status, errorText, attempt)) {
            const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
            console.warn(`[LLM Retry] Transient API error ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES})`);
            lastError = new Error(`OpenAI API error ${response.status}: ${errorText}`);
            await sleepWithProgress(delay, "Retry backoff");
            continue;
          }
          if (shouldRetry(response.status) && attempt < MAX_RETRIES) {
            const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
            console.warn(`[LLM Retry] API error ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES})`);
            lastError = new Error(`OpenAI API error ${response.status}: ${errorText}`);
            await sleepWithProgress(delay, "Retry backoff");
            continue;
          }
          clearTimeout(apiTimeout);
          throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
        }
        clearTimeout(apiTimeout);
        const data = await response.json();
        const choice = data.choices[0];
        const msg = choice.message;
        const toolCalls = msg.tool_calls?.map((tc) => ({
          id: tc.id,
          name: tc.function.name,
          arguments: JSON.parse(tc.function.arguments)
        }));
        const usage = data.usage && typeof data.usage === "object" ? {
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
          totalTokens: data.usage.total_tokens ?? (data.usage.prompt_tokens ?? 0) + (data.usage.completion_tokens ?? 0),
          cachedTokens: data.usage.prompt_tokens_details?.cached_tokens ?? 0
        } : void 0;
        if (msg.reasoning_content) this._sawReasoning = true;
        return createMessage(
          "assistant" /* Assistant */,
          msg.content || "",
          { toolCalls, reasoningContent: msg.reasoning_content, usage }
        );
      } catch (error) {
        const err = error;
        if (err.name === "AbortError") {
          clearTimeout(apiTimeout);
          throw new Error(`OpenAI API request timed out after ${API_REQUEST_TIMEOUT_MS}ms`);
        }
        if (err.message?.includes("OpenAI API error")) {
          clearTimeout(apiTimeout);
          throw error;
        }
        if (err.message?.includes("JSON.parse") && attempt < MAX_RETRIES) {
          const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
          console.warn(`[LLM Retry] JSON parse error (attempt ${attempt + 1}/${MAX_RETRIES})`);
          lastError = error;
          await sleepWithProgress(delay, "Retry backoff");
          continue;
        }
        if (attempt < MAX_RETRIES) {
          const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
          console.warn(`[LLM Retry] Network error (attempt ${attempt + 1}/${MAX_RETRIES})`);
          lastError = error;
          await sleepWithProgress(delay, "Retry backoff");
          continue;
        }
        clearTimeout(apiTimeout);
        throw error;
      }
    }
    clearTimeout(apiTimeout);
    throw lastError || new Error("Max retries exceeded");
  }
  async *stream(messages, tools, temperature = 0, topK) {
    const body = {
      model: this._model,
      messages: this._convertMessages(messages),
      ...this._samplingParams(temperature, topK),
      stream: true
    };
    const clampedMaxTokens = this._clampMaxTokens(messages, tools);
    if (clampedMaxTokens < minCompletionFloor(this._maxOutputTokens)) {
      throw new ContextOverflowError(
        `Context window nearly full: estimated input leaves only ${clampedMaxTokens} tokens for completion (minimum ${minCompletionFloor(this._maxOutputTokens)}). Conversation history must be compacted.`
      );
    }
    body.max_tokens = clampedMaxTokens;
    if (this._thinking) {
      body.thinking = this._thinking;
    }
    if (tools && tools.length > 0) {
      body.tools = tools;
    }
    let response;
    let lastError;
    const abortController = new AbortController();
    const apiTimeout = setTimeout(() => abortController.abort(), API_REQUEST_TIMEOUT_MS);
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        response = await fetch(`${this._apiBase}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this._apiKey}`
          },
          body: JSON.stringify(body),
          signal: abortController.signal
        });
        if (!response.ok) {
          const errorText = await response.text();
          if (response.status === 400 && this._isTemperatureError(errorText) && !this._skipTemperature) {
            this._skipTemperature = true;
            const retryBody = { ...body, ...this._samplingParams(temperature, topK) };
            delete retryBody.temperature;
            clearTimeout(apiTimeout);
            response = await fetch(`${this._apiBase}/chat/completions`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${this._apiKey}`
              },
              body: JSON.stringify(retryBody)
            });
            if (!response.ok) {
              const retryErrorText = await response.text();
              throw new Error(`OpenAI API error ${response.status}: ${retryErrorText}`);
            }
            break;
          }
          if (response.status === 400 && this._isContextOverflowError(errorText)) {
            const currentMaxTokens = body.max_tokens;
            if (attempt < MAX_RETRIES && currentMaxTokens > MIN_COMPLETION_TOKENS) {
              const reduced = Math.max(MIN_COMPLETION_TOKENS, Math.floor(currentMaxTokens / 4));
              body.max_tokens = reduced;
              const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
              console.warn(`[LLM Retry] Context overflow \u2014 reducing max_tokens ${currentMaxTokens} -> ${reduced} (attempt ${attempt + 1}/${MAX_RETRIES})`);
              lastError = new Error(`OpenAI API error ${response.status}: ${errorText}`);
              await sleepWithProgress(delay, "Retry backoff");
              continue;
            }
            clearTimeout(apiTimeout);
            throw new ContextOverflowError(`Model context window exceeded: ${errorText}`);
          }
          if (this._isDeepSeekRecoverableError(response.status, errorText, attempt)) {
            const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
            console.warn(`[LLM Retry] Transient API error ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES})`);
            lastError = new Error(`OpenAI API error ${response.status}: ${errorText}`);
            await sleepWithProgress(delay, "Retry backoff");
            continue;
          }
          if (shouldRetry(response.status) && attempt < MAX_RETRIES) {
            const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
            console.warn(`[LLM Retry] API error ${response.status} (attempt ${attempt + 1}/${MAX_RETRIES})`);
            lastError = new Error(`OpenAI API error ${response.status}: ${errorText}`);
            await sleepWithProgress(delay, "Retry backoff");
            continue;
          }
          clearTimeout(apiTimeout);
          throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
        }
        break;
      } catch (error) {
        const err = error;
        if (err.name === "AbortError") {
          clearTimeout(apiTimeout);
          throw new Error(`OpenAI API request timed out after ${API_REQUEST_TIMEOUT_MS}ms`);
        }
        if (err.message?.includes("OpenAI API error")) {
          clearTimeout(apiTimeout);
          throw error;
        }
        if (attempt < MAX_RETRIES) {
          const delay = INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt);
          console.warn(`[LLM Retry] Network error (attempt ${attempt + 1}/${MAX_RETRIES})`);
          lastError = error;
          await sleepWithProgress(delay, "Retry backoff");
          continue;
        }
        clearTimeout(apiTimeout);
        throw error;
      }
    }
    clearTimeout(apiTimeout);
    if (!response || !response.ok) {
      throw lastError || new Error("Max retries exceeded");
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) {
          continue;
        }
        const payload = trimmed.slice(6);
        if (payload === "[DONE]") {
          return;
        }
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed.choices?.[0]?.delta;
          if (delta?.content) {
            yield delta.content;
          }
        } catch {
        }
      }
    }
  }
  countTokens(text) {
    return estimateTokenCount(text);
  }
  /**
   * Estimate the number of input tokens that will be sent to the API.
   * Uses the same char-based heuristic as countTokens() plus a safety margin
   * for message framing, tool schemas, and CJK text (which char-count
   * heuristics tend to underestimate).
   */
  _estimateInputTokens(messages, tools) {
    let total = 0;
    for (const msg of messages) {
      total += this.countTokens(msg.content);
      if (msg.reasoningContent) {
        total += this.countTokens(msg.reasoningContent);
      }
      total += TOKENS_PER_MESSAGE_OVERHEAD;
    }
    if (tools) {
      for (const tool of tools) {
        total += this.countTokens(JSON.stringify(tool.function));
      }
    }
    return Math.ceil(total * 1.2) + 512;
  }
  /**
   * Clamp the completion token budget so that input + max_tokens never exceeds
   * the model's total context window. Without this, a large maxOutputTokens
   * (e.g. deepseek-v4's 65536) combined with a near-full message window
   * produces "This model's maximum context length is X tokens..." API errors.
   *
   * A hard safety reserve (5% of the window, min 4096) is kept on top of the
   * estimate so a slightly-off estimate can never fill the window completely.
   */
  _clampMaxTokens(messages, tools) {
    const inputTokens = this._estimateInputTokens(messages, tools);
    const safetyReserve = Math.max(MIN_CONTEXT_RESERVE, Math.floor(this._maxContextTokens * CONTEXT_RESERVE_RATIO));
    const remaining = this._maxContextTokens - inputTokens - safetyReserve;
    return Math.max(1, Math.min(this._maxOutputTokens, remaining));
  }
  /**
   * Detect "This model's maximum context length is X tokens..." API errors.
   * These are NOT retryable as-is: the request must shrink (smaller max_tokens
   * or a compacted message window) before it can succeed.
   */
  _isContextOverflowError(text) {
    const lower = text.toLowerCase();
    return lower.includes("maximum context length") || lower.includes("reduce the length of the messages") || lower.includes("context") && lower.includes("exceed");
  }
  _skipTemperature = false;
  /**
   * Build the sampling params for the request body. `temperature` is always
   * sent (unless a previous request was rejected for it — see _skipTemperature);
   * `top_k` is only sent when explicitly configured (>0) so providers that do
   * not support it keep working with their default sampling.
   */
  _samplingParams(temperature, topK) {
    const params = {};
    if (!this._skipTemperature) {
      params.temperature = temperature;
    }
    if (topK && topK > 0) {
      params.top_k = topK;
    }
    return params;
  }
  _isTemperatureError(text) {
    const lower = text.toLowerCase();
    return lower.includes("temperature") && (lower.includes("invalid") || lower.includes("not allowed") || lower.includes("only 1 is allowed") || lower.includes("not supported"));
  }
  /**
   * Check if a DeepSeek API error is recoverable (can retry).
   * Some errors like "insufficient_quota" or "model overloaded" may be transient.
   * DeepSeek V4 Pro specific: handles TPS (tokens per second) rate limiting
   * and model overload errors gracefully.
   */
  _isDeepSeekRecoverableError(status, errorText, attempt) {
    if (shouldRetry(status)) return true;
    if (status === 400) {
      const lower = errorText.toLowerCase();
      if (lower.includes("insufficient_quota") && attempt < 2) return true;
      if (lower.includes("rate_limit") && attempt < 3) return true;
      if (lower.includes("temporarily") && attempt < 1) return true;
      if (lower.includes("tps") && lower.includes("limit") && attempt < 3) return true;
      if (lower.includes("overload") && attempt < 2) return true;
      if (lower.includes("busy") && attempt < 2) return true;
      if (lower.includes("concurrent") && attempt < 2) return true;
    }
    if (status === 503 && attempt < MAX_RETRIES) return true;
    if (status === 502 && attempt < 2) return true;
    return false;
  }
  supportsStreaming() {
    return true;
  }
  /**
   * Does this model use reasoning_content (thinking/chain-of-thought)?
   *
   * True when the model configuration enables reasoning OR the API has shown
   * that it answers in thinking mode (it produced reasoning_content, or it
   * demanded the echo-back). The agent uses this to keep one model's
   * chain-of-thought out of another model, to avoid streaming (which loses
   * reasoning_content), and to decide whether a model switch has to preserve
   * the reasoning echo-back invariant.
   */
  supportsReasoning() {
    return this._supportsReasoning || this._sawReasoning || this._requiresReasoningEcho;
  }
  /**
   * Minimal reachability probe for the 保底-model supervisor: one tiny
   * completion with its own short timeout (tens of times cheaper and faster
   * than a real turn, and unlike a `GET /models` call it exercises the exact
   * chat endpoint that timed out). Never throws.
   *
   * Evidence (api.enflame.cn gateway, measured):
   *   - max_tokens: 1   → 400 "max_tokens ... limit was reached" for the GPT-5.x
   *     family, i.e. a FALSE "unreachable". 4 is the smallest accepted value.
   *   - unknown model   → 503 model_not_found (genuinely unreachable).
   *   - reachable model → 200.
   * So: any answer from the model server counts as reachable (2xx/400/429 —
   * a rejected or throttled probe still proves the model is back), while 5xx,
   * auth failures and timeouts count as unreachable.
   */
  async healthCheck(timeoutMs = 8e3, opts) {
    if (!this._apiKey) return false;
    const abortController = new AbortController();
    const timer = setTimeout(() => abortController.abort(), timeoutMs);
    try {
      const response = await fetch(`${this._apiBase}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this._apiKey}`
        },
        body: JSON.stringify({
          model: this._model,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: HEALTH_CHECK_MAX_TOKENS,
          stream: false
        }),
        signal: abortController.signal
      });
      if (response.ok) return true;
      if (response.status === 400) return true;
      if (response.status === 429) return opts?.throttleSensitive !== true;
      return false;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
  _convertMessages(messages) {
    const historyHasThinking = messages.some(
      (m) => m.role === "assistant" /* Assistant */ && m.reasoningContent
    );
    const thinkingMode = historyHasThinking || this.supportsReasoning();
    const isValidAssistant = (m) => {
      if (m.role !== "assistant" /* Assistant */) return true;
      return !!m.content || !!m.toolCalls && m.toolCalls.length > 0;
    };
    let filtered = messages.filter(isValidAssistant);
    if (thinkingMode) {
      filtered = filtered.filter((m) => {
        if (m.role === "assistant" /* Assistant */) {
          return !!m.reasoningContent || !!m.toolCalls && m.toolCalls.length > 0;
        }
        return true;
      });
      while (filtered.length > 0 && filtered[0].role === "tool" /* Tool */) {
        filtered.shift();
      }
    }
    return filtered.map((msg) => {
      const converted = {
        role: msg.role,
        content: msg.content || null
      };
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        converted.tool_calls = msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.arguments)
          }
        }));
      }
      if (msg.toolCallId) {
        converted.tool_call_id = msg.toolCallId;
      }
      if (msg.role === "assistant" /* Assistant */ && thinkingMode) {
        converted.reasoning_content = msg.reasoningContent || "";
      }
      return converted;
    });
  }
};
LLMProviderFactory.register("openai", OpenAIProvider);

// src/vs/workbench/services/agent/browser/llmAnthropic.ts
var CACHE_TAIL_MESSAGES = 2;
var MAX_CACHE_BREAKPOINTS = 4;
function cacheControl() {
  return { type: "ephemeral" };
}
function systemBlocksForCaching(content) {
  return [{ type: "text", text: content, cache_control: cacheControl() }];
}
function markCacheBreakpoint(message) {
  const content = message.content;
  if (typeof content === "string") {
    if (!content) return false;
    message.content = [{ type: "text", text: content, cache_control: cacheControl() }];
    return true;
  }
  if (Array.isArray(content) && content.length > 0) {
    const last = content[content.length - 1];
    if (last && typeof last === "object" && !last.cache_control) {
      last.cache_control = cacheControl();
      return true;
    }
  }
  return false;
}
var AnthropicProvider = class {
  name = "anthropic";
  _apiKey;
  _apiBase;
  _model;
  /**
   * Set once the endpoint rejected a cache_control breakpoint (e.g. a gateway
   * proxy that does not implement the prompt-caching extension). Caching is an
   * optimization, never a requirement, so after the first rejection every
   * later request is sent with no breakpoints.
   */
  _cachingDisabled = false;
  _cachingDisabledReason;
  constructor(config) {
    this._apiKey = config.apiKey;
    this._apiBase = config.apiBase || "https://api.anthropic.com";
    this._model = config.model || "claude-sonnet-4-20250514";
  }
  /** True when prompt caching was rejected by this endpoint and switched off. */
  get promptCachingDisabled() {
    return this._cachingDisabled;
  }
  /** Why caching was switched off (kept for logs/diagnostics). */
  get promptCachingDisabledReason() {
    return this._cachingDisabledReason;
  }
  /** Build the request payload. `cache` toggles the prompt-caching breakpoints. */
  _buildBody(options, cache) {
    const { messages, systemMessage, tools, temperature, stream } = options;
    const body = {
      model: this._model,
      max_tokens: 4096,
      temperature,
      messages: this._convertMessages(messages, cache)
    };
    if (systemMessage) {
      body.system = cache ? systemBlocksForCaching(systemMessage.content) : systemMessage.content;
    }
    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters
      }));
    }
    if (stream) body.stream = true;
    return body;
  }
  /**
   * Send one /v1/messages request, degrading transparently to a cache-free
   * payload when the endpoint rejects the cache breakpoints.
   */
  async _request(build, useCache) {
    const send = (cache) => fetch(`${this._apiBase}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this._apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(build(cache))
    });
    const response = await send(useCache);
    if (response.ok) return response;
    const errorText = await response.text();
    if (useCache && response.status === 400 && /cache_control|cache-control/i.test(errorText)) {
      this._cachingDisabled = true;
      this._cachingDisabledReason = errorText.slice(0, 300);
      console.warn(
        `[Anthropic] endpoint rejected prompt caching (400) \u2014 retrying without cache breakpoints: ${errorText.slice(0, 200)}`
      );
      const retry = await send(false);
      if (retry.ok) return retry;
      throw new Error(`Anthropic API error ${retry.status}: ${await retry.text()}`);
    }
    throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
  }
  async complete(messages, tools, temperature = 0, _topK) {
    const systemMessage = messages.find((m) => m.role === "system" /* System */);
    const nonSystemMessages = messages.filter((m) => m.role !== "system" /* System */);
    const response = await this._request(
      (cache) => this._buildBody(
        { messages: nonSystemMessages, systemMessage, tools, temperature },
        cache
      ),
      !this._cachingDisabled
    );
    const data = await response.json();
    const usage = data.usage && typeof data.usage === "object" ? {
      promptTokens: data.usage.input_tokens ?? 0,
      completionTokens: data.usage.output_tokens ?? 0,
      totalTokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
      cachedTokens: data.usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: data.usage.cache_creation_input_tokens ?? 0
    } : void 0;
    return this._parseResponse(data.content, usage);
  }
  async *stream(messages, tools, temperature = 0, _topK) {
    const systemMessage = messages.find((m) => m.role === "system" /* System */);
    const nonSystemMessages = messages.filter((m) => m.role !== "system" /* System */);
    const response = await this._request(
      (cache) => this._buildBody(
        { messages: nonSystemMessages, systemMessage, tools, temperature, stream: true },
        cache
      ),
      !this._cachingDisabled
    );
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data: ")) {
          continue;
        }
        const payload = trimmed.slice(6);
        try {
          const event = JSON.parse(payload);
          if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            yield event.delta.text;
          }
        } catch {
        }
      }
    }
  }
  countTokens(text) {
    return estimateTokenCount(text);
  }
  _parseResponse(content, usage) {
    let textContent = "";
    const toolCalls = [];
    for (const block of content) {
      if (block.type === "text" && block.text) {
        textContent += block.text;
      } else if (block.type === "tool_use" && block.id && block.name) {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input || {}
        });
      }
    }
    return createMessage("assistant" /* Assistant */, textContent, {
      toolCalls: toolCalls.length > 0 ? toolCalls : void 0,
      usage
    });
  }
  _convertMessages(messages, cache = false) {
    const converted = messages.map((msg) => {
      if (msg.role === "tool" /* Tool */) {
        return {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: msg.toolCallId,
            content: msg.content
          }]
        };
      }
      if (msg.role === "assistant" /* Assistant */ && msg.toolCalls && msg.toolCalls.length > 0) {
        const content = [];
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.toolCalls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.name,
            input: tc.arguments
          });
        }
        return { role: "assistant", content };
      }
      return {
        role: msg.role === "user" /* User */ ? "user" : "assistant",
        content: msg.content
      };
    });
    if (cache && converted.length > 0) {
      const tail2 = Math.min(CACHE_TAIL_MESSAGES, MAX_CACHE_BREAKPOINTS - 1);
      let placed = 0;
      for (let i = converted.length - 1; i >= 0 && placed < tail2; i--) {
        if (markCacheBreakpoint(converted[i])) placed++;
      }
    }
    return converted;
  }
};
LLMProviderFactory.register("anthropic", AnthropicProvider);

// src/vs/workbench/services/agent/browser/llmOllama.ts
var OllamaProvider = class {
  name = "ollama";
  _apiBase;
  _model;
  constructor(config) {
    this._apiBase = config.apiBase || "http://localhost:11434";
    this._model = config.model || "llama3";
  }
  async complete(messages, tools, temperature = 0, topK) {
    const body = {
      model: this._model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content
      })),
      stream: false,
      options: {
        temperature,
        ...topK && topK > 0 ? { top_k: topK } : {}
      }
    };
    if (tools && tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters
        }
      }));
    }
    const response = await fetch(`${this._apiBase}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama API error ${response.status}: ${errorText}`);
    }
    const data = await response.json();
    const msg = data.message;
    const toolCalls = msg.tool_calls?.map((tc, i) => ({
      id: `ollama_tc_${Date.now()}_${i}`,
      name: tc.function.name,
      arguments: tc.function.arguments
    }));
    const usage = typeof data.prompt_eval_count === "number" || typeof data.eval_count === "number" ? {
      promptTokens: data.prompt_eval_count ?? 0,
      completionTokens: data.eval_count ?? 0,
      totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0)
    } : void 0;
    return createMessage(
      "assistant" /* Assistant */,
      msg.content || "",
      { toolCalls, usage }
    );
  }
  async *stream(messages, _tools, temperature = 0, topK) {
    const body = {
      model: this._model,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content
      })),
      stream: true,
      options: {
        temperature,
        ...topK && topK > 0 ? { top_k: topK } : {}
      }
    };
    const response = await fetch(`${this._apiBase}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama API error ${response.status}: ${errorText}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) {
          continue;
        }
        try {
          const parsed = JSON.parse(line);
          if (parsed.message?.content) {
            yield parsed.message.content;
          }
        } catch {
        }
      }
    }
  }
  countTokens(text) {
    return estimateTokenCount(text);
  }
};
LLMProviderFactory.register("ollama", OllamaProvider);

// src/vs/workbench/contrib/agent/common/agentTools.ts
var AgentTool = class {
  /**
   * Optional tool-declared execution budget (ms) for a single call.
   *
   * `AgentLoop` races every tool call against the generic `step_timeout`. A tool
   * whose whole purpose is waiting (poll) declares its own budget here, so that
   * generic timeout stays the outer bound instead of becoming a hard cap that
   * kills the tool mid-wait. Returning `undefined` keeps the default behaviour;
   * an explicit `timeout` argument always wins over this.
   */
  timeoutFor(_args, _config) {
    return void 0;
  }
  toSchema() {
    return {
      type: "function",
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters
      }
    };
  }
  success(toolCallId, output) {
    return { toolCallId, success: true, output };
  }
  failure(toolCallId, error) {
    return { toolCallId, success: false, output: "", error };
  }
};
var ToolRegistry = class {
  _tools = /* @__PURE__ */ new Map();
  _aliases = /* @__PURE__ */ new Map();
  register(tool) {
    this._tools.set(tool.name, tool);
  }
  /**
   * Register an alias name that maps to an existing tool.
   * Useful for compatibility with tool names from other agent frameworks
   * (e.g. search_content → search_text).
   */
  registerAlias(alias, targetName) {
    if (!this._tools.has(targetName)) {
      throw new Error(`Cannot alias "${alias}" to non-existent tool "${targetName}"`);
    }
    this._aliases.set(alias, targetName);
  }
  /**
   * Replace every registered tool through `fn` (aliases keep working, because
   * an alias resolves to the entry stored here).
   *
   * Used by the tool-mock layer (`agentToolMock.ts`) to interpose record /
   * replay in front of a chosen subset of tools without touching the agent
   * loop or the individual tool implementations.
   */
  decorate(fn) {
    for (const [name, tool] of this._tools) {
      const next = fn(tool);
      if (next !== tool) this._tools.set(name, next);
    }
  }
  get(name) {
    const tool = this._tools.get(name);
    if (tool) {
      return tool;
    }
    const targetName = this._aliases.get(name);
    if (targetName) {
      return this._tools.get(targetName);
    }
    return void 0;
  }
  has(name) {
    return this._tools.has(name) || this._aliases.has(name);
  }
  listNames() {
    return [...this._tools.keys()];
  }
  listSchemas() {
    const schemas = [];
    for (const tool of this._tools.values()) {
      schemas.push(tool.toSchema());
    }
    for (const [alias, targetName] of this._aliases) {
      const target = this._tools.get(targetName);
      if (target) {
        const original = target.toSchema();
        schemas.push({
          type: "function",
          function: {
            name: alias,
            description: original.function.description,
            parameters: original.function.parameters
          }
        });
      }
    }
    return schemas;
  }
  getReadOnlySchemas() {
    const readOnlyTools = ["read_file", "list_directory", "search_text", "search_files", "search_content"];
    const schemas = [];
    for (const tool of this._tools.values()) {
      if (readOnlyTools.includes(tool.name)) {
        schemas.push(tool.toSchema());
      }
    }
    for (const [alias, targetName] of this._aliases) {
      if (readOnlyTools.includes(alias)) {
        const target = this._tools.get(targetName);
        if (target) {
          const original = target.toSchema();
          schemas.push({
            type: "function",
            function: {
              name: alias,
              description: original.function.description,
              parameters: original.function.parameters
            }
          });
        }
      }
    }
    return schemas;
  }
};

// vs-core/base/common/lifecycle.ts
var DisposableStore = class {
  _toDispose = /* @__PURE__ */ new Set();
  _isDisposed = false;
  add(o) {
    if (this._isDisposed) {
      o.dispose();
      return o;
    }
    this._toDispose.add(o);
    return o;
  }
  dispose() {
    if (this._isDisposed) {
      return;
    }
    this._isDisposed = true;
    for (const d of this._toDispose) {
      d.dispose();
    }
    this._toDispose.clear();
  }
};
var Disposable = class {
  static None = Object.freeze({ dispose() {
  } });
  _store = new DisposableStore();
  _register(o) {
    return this._store.add(o);
  }
  dispose() {
    this._store.dispose();
  }
};

// vs-core/base/common/event.ts
var Event;
((Event6) => {
  Event6.None = () => Disposable.None;
})(Event || (Event = {}));
var Emitter = class {
  _listeners = [];
  _disposed = false;
  get event() {
    return (listener, thisArgs) => {
      if (this._disposed) {
        return Disposable.None;
      }
      const entry = { fn: listener, thisArg: thisArgs };
      this._listeners.push(entry);
      return {
        dispose: () => {
          const idx = this._listeners.indexOf(entry);
          if (idx >= 0) {
            this._listeners.splice(idx, 1);
          }
        }
      };
    };
  }
  fire(event) {
    if (this._disposed) {
      return;
    }
    for (const { fn, thisArg } of [...this._listeners]) {
      try {
        fn.call(thisArg, event);
      } catch (e) {
        console.error("Event listener error:", e);
      }
    }
  }
  dispose() {
    this._disposed = true;
    this._listeners.length = 0;
  }
};

// src/vs/workbench/contrib/agent/common/agentModes.ts
var AgentModeManager = class {
  _currentMode = "agent" /* Agent */;
  _onDidChangeMode = new Emitter();
  onDidChangeMode = this._onDidChangeMode.event;
  get currentMode() {
    return this._currentMode;
  }
  switchMode(mode) {
    if (this._currentMode === mode) {
      return;
    }
    this._currentMode = mode;
    this._onDidChangeMode.fire(mode);
  }
  get isReadOnly() {
    return this._currentMode === "ask" /* Ask */;
  }
  get canExecuteTools() {
    return this._currentMode === "agent" /* Agent */;
  }
  get shouldPlanFirst() {
    return this._currentMode === "plan" /* Plan */;
  }
  dispose() {
    this._onDidChangeMode.dispose();
  }
};

// vs-core/base/common/buffer.ts
var VSBuffer = class _VSBuffer {
  buffer;
  byteLength;
  constructor(buffer) {
    this.buffer = buffer;
    this.byteLength = buffer.byteLength;
  }
  toString() {
    return Buffer.from(this.buffer).toString("utf-8");
  }
  static fromString(source) {
    return new _VSBuffer(Buffer.from(source, "utf-8"));
  }
  static fromByteArray(source) {
    return new _VSBuffer(new Uint8Array(source));
  }
  static wrap(buffer) {
    return new _VSBuffer(buffer);
  }
  static concat(buffers, totalLength) {
    const result = Buffer.concat(buffers.map((b) => Buffer.from(b.buffer)), totalLength);
    return new _VSBuffer(result);
  }
  static alloc(byteLength) {
    return new _VSBuffer(new Uint8Array(byteLength));
  }
};

// src/vs/workbench/contrib/agent/common/agentCheckpoint.ts
var AgentCheckpointManager = class _AgentCheckpointManager {
  constructor(_fileService) {
    this._fileService = _fileService;
  }
  _checkpoints = /* @__PURE__ */ new Map();
  _counter = 0;
  /**
   * Create an independent checkpoint manager sharing the same file service.
   * Used by parallel agents to avoid race conditions on shared checkpoint state.
   */
  clone() {
    return new _AgentCheckpointManager(this._fileService);
  }
  async captureFile(filePath) {
    try {
      const uri = URI.file(filePath);
      const content = await this._fileService.readFile(uri);
      return content.value.toString();
    } catch {
      return void 0;
    }
  }
  createCheckpoint(description) {
    const id = `ckpt_${Date.now()}_${this._counter++}`;
    this._checkpoints.set(id, {
      id,
      timestamp: Date.now(),
      description,
      snapshots: /* @__PURE__ */ new Map()
    });
    return id;
  }
  async snapshotFile(checkpointId, filePath) {
    const checkpoint = this._checkpoints.get(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }
    const content = await this.captureFile(filePath);
    if (content !== void 0) {
      checkpoint.snapshots.set(filePath, content);
    }
  }
  async restore(checkpointId) {
    const checkpoint = this._checkpoints.get(checkpointId);
    if (!checkpoint) {
      throw new Error(`Checkpoint not found: ${checkpointId}`);
    }
    const restoredFiles = [];
    for (const [filePath, content] of checkpoint.snapshots) {
      try {
        const uri = URI.file(filePath);
        await this._fileService.writeFile(uri, VSBuffer.fromString(content));
        restoredFiles.push(filePath);
      } catch {
      }
    }
    return restoredFiles;
  }
  listCheckpoints() {
    return [...this._checkpoints.values()].map((cp) => ({
      id: cp.id,
      timestamp: cp.timestamp,
      description: cp.description,
      fileCount: cp.snapshots.size
    }));
  }
  deleteCheckpoint(checkpointId) {
    return this._checkpoints.delete(checkpointId);
  }
  clear() {
    this._checkpoints.clear();
  }
};

// vs-core/base/common/cancellation.ts
var CancellationToken;
((CancellationToken3) => {
  CancellationToken3.None = Object.freeze({
    isCancellationRequested: false,
    onCancellationRequested: Event.None
  });
  CancellationToken3.Cancelled = Object.freeze({
    isCancellationRequested: true,
    onCancellationRequested: Event.None
  });
})(CancellationToken || (CancellationToken = {}));
var CancellationTokenSource = class {
  _token;
  _emitter;
  _cancelled = false;
  get token() {
    if (!this._token) {
      this._emitter = new Emitter();
      this._token = {
        isCancellationRequested: this._cancelled,
        onCancellationRequested: this._emitter.event
      };
    }
    return this._token;
  }
  cancel() {
    if (!this._cancelled) {
      this._cancelled = true;
      if (this._emitter) {
        this._emitter.fire(void 0);
      }
      if (this._token) {
        this._token.isCancellationRequested = true;
      }
    }
  }
  dispose() {
    this._emitter?.dispose();
  }
};

// src/vs/workbench/contrib/agent/common/agentContext.ts
var WINDOW_UTILIZATION = 0.75;
var TASK_ANCHOR_PREFIX = "[Pinned original task \u2014 always in context]";
var UNANSWERED_TOOL_CALL = "[not executed] the tool call was never answered (task interrupted or cancelled)";
function sanitizeToolCallPairs(messages) {
  const out = [];
  let i = 0;
  while (i < messages.length) {
    const msg = messages[i];
    if (msg.role === "assistant" /* Assistant */ && msg.toolCalls && msg.toolCalls.length > 0) {
      out.push(msg);
      const answered = /* @__PURE__ */ new Set();
      let j = i + 1;
      while (j < messages.length && messages[j].role === "tool" /* Tool */) {
        const id = messages[j].toolCallId;
        if (id && !answered.has(id)) {
          out.push(messages[j]);
          answered.add(id);
        }
        j++;
      }
      for (const tc of msg.toolCalls) {
        if (!answered.has(tc.id)) {
          out.push(createMessage("tool" /* Tool */, UNANSWERED_TOOL_CALL, { toolCallId: tc.id }));
        }
      }
      i = j;
      continue;
    }
    if (msg.role === "tool" /* Tool */) {
      i++;
      continue;
    }
    out.push(msg);
    i++;
  }
  return out;
}
var AgentContext = class {
  constructor(_maxTokens, _maxOutputTokens, _llmProvider) {
    this._maxTokens = _maxTokens;
    this._maxOutputTokens = _maxOutputTokens;
    this._llmProvider = _llmProvider;
  }
  _messages = [];
  _systemPrompt;
  /**
   * The original task statement, pinned OUTSIDE the sliding window.
   *
   * The sliding window drops the OLDEST messages first and compaction
   * summarizes the older half away — both of them drop the statement the user
   * actually asked for, so a long run can end up optimizing a half-remembered
   * goal. The reference harness guards against exactly this by rebuilding its
   * post-overflow prompt as "original_instruction + current state"; here the
   * anchor is simply re-sent verbatim on every request instead of being
   * summarized.
   */
  _taskAnchor;
  swapTokenCounter(provider) {
    this._llmProvider = provider;
  }
  /** Estimated total tokens held in the message history (incl. system prompt). */
  get estimatedTokens() {
    return this._estimateTotalTokens();
  }
  /** Token budget available for input messages under the ACTIVE model. */
  get inputBudget() {
    return this._inputBudget;
  }
  /** True when the history no longer fits the active model's input budget. */
  get isOverBudget() {
    return this._estimateTotalTokens() > this._inputBudget * WINDOW_UTILIZATION;
  }
  /**
   * Re-target the context to another model after a runtime model switch
   * (scenario routing, /profile, or the 保底 fallback).
   *
   * The window budgets MUST follow the new model. Keeping the previous model's
   * (usually larger) window after switching to a smaller one is a silent
   * context-corruption bug: the sliding window happily keeps more history than
   * the new model accepts, so its completion budget is clamped to ~0, the
   * request fails with ContextOverflowError, and the loop force-compacts —
   * collapsing the conversation the user was relying on.
   */
  setModelBudget(maxTokens, maxOutputTokens) {
    if (maxTokens && maxTokens > 0) this._maxTokens = maxTokens;
    if (maxOutputTokens && maxOutputTokens > 0) this._maxOutputTokens = maxOutputTokens;
  }
  /**
   * Drop reasoning_content produced by a PREVIOUS model.
   *
   * Chain-of-thought is model-private. Replaying one model's thinking into a
   * different one both breaks the thinking-mode API invariant (reasoning_content
   * must be present on ALL assistant messages, or on none) and is a known way to
   * derail the new model: it latches onto the foreign plan and re-emits it
   * (observed: hy3 repeating "Hmm — let me find lit. / Let me do it." 1600+ times
   * until it burned its whole output budget and answered nothing).
   *
   * `content` and `toolCalls` are preserved, so no tool-result message becomes
   * orphaned and no assistant message turns invalid.
   */
  dropReasoningContent(predicate) {
    let dropped = 0;
    for (let i = 0; i < this._messages.length; i++) {
      const msg = this._messages[i];
      if (msg.reasoningContent === void 0) continue;
      if (predicate && !predicate(msg)) continue;
      this._messages[i] = { ...msg, reasoningContent: void 0 };
      dropped++;
    }
    return dropped;
  }
  /**
   * Token budget reserved for input messages. The model's context window is
   * shared between input (messages) and output (max_tokens), so the sliding
   * window must reserve the completion budget — otherwise a near-full message
   * window plus a large max_tokens triggers "maximum context length" API errors.
   */
  get _inputBudget() {
    return Math.max(1, this._maxTokens - this._maxOutputTokens);
  }
  get messages() {
    return this._messages;
  }
  get length() {
    return this._messages.length;
  }
  get systemPromptContent() {
    return this._systemPrompt?.content || "";
  }
  setSystemPrompt(content) {
    this._systemPrompt = createMessage("system" /* System */, content);
  }
  /**
   * Pin the original task statement so neither the sliding window nor
   * compaction can lose it. Called once per task, with the user's own words.
   */
  setTaskAnchor(content) {
    const trimmed = (content || "").trim();
    if (!trimmed) return;
    this._taskAnchor = createMessage("user" /* User */, `${TASK_ANCHOR_PREFIX}
${trimmed}`);
  }
  /** The pinned task text as the user wrote it, or undefined when nothing is pinned. */
  get taskAnchorContent() {
    if (!this._taskAnchor) return void 0;
    return this._taskAnchor.content.slice(TASK_ANCHOR_PREFIX.length + 1);
  }
  /** Forget the pinned task (used when a new conversation replaces this one). */
  clearTaskAnchor() {
    this._taskAnchor = void 0;
  }
  addMessage(message) {
    this._messages.push(message);
  }
  /**
   * Apply `sanitizeToolCallPairs` to the LIVE history and return the tool
   * results that had to be synthesized (empty when the history was already
   * valid).
   *
   * Called when a task ends (cancel/crash included), so what gets persisted is
   * a resumable conversation instead of one that 400s forever.
   */
  repairToolCallPairs() {
    const repaired = sanitizeToolCallPairs(this._messages);
    if (repaired.length === this._messages.length && repaired.every((m, i) => m === this._messages[i])) {
      return [];
    }
    const original = new Set(this._messages);
    const inserted = repaired.filter((m) => !original.has(m));
    this._messages.length = 0;
    this._messages.push(...repaired);
    return inserted;
  }
  getContextWindow() {
    const result = [];
    let tokenCount = 0;
    if (this._systemPrompt) {
      result.push(this._systemPrompt);
      tokenCount += this._estimateTokens(this._systemPrompt);
    }
    if (this._taskAnchor) {
      result.push(this._taskAnchor);
      tokenCount += this._estimateTokens(this._taskAnchor);
    }
    const contextMessages = [];
    for (let i = this._messages.length - 1; i >= 0; i--) {
      const msg = this._messages[i];
      const msgTokens = this._estimateTokens(msg);
      if (tokenCount + msgTokens > this._inputBudget * WINDOW_UTILIZATION) {
        break;
      }
      contextMessages.unshift(msg);
      tokenCount += msgTokens;
    }
    result.push(...contextMessages);
    return sanitizeToolCallPairs(result);
  }
  /**
   * Compact the conversation history when it grows too large (or always, when
   * `force` is set — used to recover from a context-overflow API error).
   * Older messages are summarized via the LLM; if summarization fails, the
   * oldest messages are truncated instead. Returns true if a compaction ran.
   */
  async compactIfNeeded(force = false) {
    const totalTokens = this._estimateTotalTokens();
    if (!force && totalTokens < this._inputBudget * WINDOW_UTILIZATION) {
      return false;
    }
    const splitPoint = Math.floor(this._messages.length / 2);
    const oldMessages = this._messages.slice(0, splitPoint);
    let recentMessages = this._messages.slice(splitPoint);
    while (recentMessages.length > 0 && recentMessages[0].role === "tool" /* Tool */) {
      recentMessages = recentMessages.slice(1);
    }
    const hasThinking = oldMessages.some(
      (m) => m.role === "assistant" /* Assistant */ && m.reasoningContent
    );
    const summaryContent = oldMessages.map((m) => {
      let prefix = `[${m.role}]`;
      if (m.role === "assistant" /* Assistant */ && m.reasoningContent) {
        prefix += `(reasoning: ${m.reasoningContent.substring(0, 100)})`;
      }
      return `${prefix}: ${m.content.substring(0, 200)}`;
    }).join("\n");
    const anchorContent = this.taskAnchorContent;
    const summaryPrompt = createMessage(
      "user" /* User */,
      `Write a HANDOFF summary of the conversation below so that work can continue without the original transcript. Preserve, in this order:
1. the original task and every explicit requirement (verbatim where wording matters),
2. decisions already made and files created or changed,
3. commands or tests already run and their results,
4. what is still unfinished or unverified, and the next concrete step.
Do not invent progress that did not happen.

` + (anchorContent ? `Pinned original task:
${anchorContent}

` : "") + `Conversation to summarize:

${summaryContent}`
    );
    const MAX_SUMMARY_RETRIES = 2;
    for (let attempt = 0; attempt <= MAX_SUMMARY_RETRIES; attempt++) {
      try {
        const summaryResponse = await this._llmProvider.complete([
          createMessage(
            "system" /* System */,
            "You are a conversation summarizer. Provide a concise summary preserving all technical details."
          ),
          summaryPrompt
        ], void 0, 0);
        this._messages.length = 0;
        const summaryMsg = hasThinking ? createMessage("assistant" /* Assistant */, `[Previous context summary]
${summaryResponse.content}`, {
          reasoningContent: summaryResponse.reasoningContent || "(compressed summary)"
        }) : createMessage("assistant" /* Assistant */, `[Previous context summary]
${summaryResponse.content}`);
        this._messages.push(summaryMsg, ...recentMessages);
        return true;
      } catch (err) {
        if (attempt < MAX_SUMMARY_RETRIES) {
          console.warn(`[Context Summarization] Attempt ${attempt + 1} failed, retrying: ${err.message}`);
          await new Promise((r) => setTimeout(r, 1e3));
          continue;
        }
        console.warn(`[Context Summarization] All retries exhausted, falling back to truncation`);
        this._messages.splice(0, splitPoint);
        while (this._messages.length > 0 && this._messages[0].role === "tool" /* Tool */) {
          this._messages.shift();
        }
        return true;
      }
    }
    return true;
  }
  clear() {
    this._messages.length = 0;
    this._systemPrompt = void 0;
    this._taskAnchor = void 0;
  }
  _estimateTokens(message) {
    let total = this._llmProvider.countTokens(message.content);
    if (message.reasoningContent) {
      total += this._llmProvider.countTokens(message.reasoningContent);
    }
    return total + TOKENS_PER_MESSAGE_OVERHEAD;
  }
  _estimateTotalTokens() {
    let total = this._systemPrompt ? this._estimateTokens(this._systemPrompt) : 0;
    if (this._taskAnchor) {
      total += this._estimateTokens(this._taskAnchor);
    }
    for (const msg of this._messages) {
      total += this._estimateTokens(msg);
    }
    return total;
  }
};

// src/vs/workbench/contrib/agent/common/agentPlanner.ts
var PLAN_GENERATION_PROMPT = `Given the user's task, create a structured implementation plan as JSON.

Output format (strict JSON, no markdown):
{
  "task": "brief task summary",
  "steps": [
    {
      "id": 1,
      "description": "what to do in this step",
      "toolName": "tool to use (read_file, write_file, edit_file, search_text, run_terminal, etc.) or null",
      "toolArgs": { "key": "value" }
    }
  ]
}

Rules:
- Break complex tasks into 3-15 concrete steps
- Each step should be a single, verifiable action
- Start with exploration (read/search), then implement, then verify
- Include a final verification step (run tests or check output)`;
var AgentPlanner = class {
  constructor(_llmProvider) {
    this._llmProvider = _llmProvider;
  }
  _currentPlan;
  _onDidUpdatePlan = new Emitter();
  onDidUpdatePlan = this._onDidUpdatePlan.event;
  swapProvider(provider) {
    this._llmProvider = provider;
  }
  get currentPlan() {
    return this._currentPlan;
  }
  async createPlan(task, codebaseContext) {
    const messages = [
      createMessage("system" /* System */, PLAN_GENERATION_PROMPT)
    ];
    if (codebaseContext) {
      messages.push(createMessage(
        "user" /* User */,
        `Codebase context:
${codebaseContext}

Task: ${task}`
      ));
    } else {
      messages.push(createMessage("user" /* User */, `Task: ${task}`));
    }
    const response = await this._llmProvider.complete(messages);
    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("No JSON found in response");
      }
      const parsed = JSON.parse(jsonMatch[0]);
      const steps = parsed.steps.map((s, i) => ({
        id: s.id || i + 1,
        description: s.description,
        status: "pending" /* Pending */,
        toolName: s.toolName || void 0,
        toolArgs: s.toolArgs || void 0
      }));
      this._currentPlan = {
        task: parsed.task || task,
        steps,
        currentStep: 0
      };
      this._onDidUpdatePlan.fire(this._currentPlan);
      return this._currentPlan;
    } catch (err) {
      this._currentPlan = {
        task,
        steps: [{
          id: 1,
          description: `Execute task directly: ${task}`,
          status: "pending" /* Pending */
        }],
        currentStep: 0
      };
      this._onDidUpdatePlan.fire(this._currentPlan);
      return this._currentPlan;
    }
  }
  advanceStep() {
    if (!this._currentPlan) {
      return void 0;
    }
    const plan = this._currentPlan;
    if (plan.currentStep > 0) {
      const prevStep = plan.steps[plan.currentStep - 1];
      if (prevStep && prevStep.status === "running" /* Running */) {
        prevStep.status = "done" /* Done */;
      }
    }
    if (plan.currentStep >= plan.steps.length) {
      return void 0;
    }
    const step = plan.steps[plan.currentStep];
    step.status = "running" /* Running */;
    plan.currentStep++;
    this._onDidUpdatePlan.fire(plan);
    return step;
  }
  markStepFailed(stepId, error) {
    if (!this._currentPlan) {
      return;
    }
    const step = this._currentPlan.steps.find((s) => s.id === stepId);
    if (step) {
      step.status = "failed" /* Failed */;
      step.result = error;
      this._onDidUpdatePlan.fire(this._currentPlan);
    }
  }
  markStepDone(stepId, result) {
    if (!this._currentPlan) {
      return;
    }
    const step = this._currentPlan.steps.find((s) => s.id === stepId);
    if (step) {
      step.status = "done" /* Done */;
      step.result = result;
      this._onDidUpdatePlan.fire(this._currentPlan);
    }
  }
  isComplete() {
    if (!this._currentPlan) {
      return true;
    }
    return this._currentPlan.currentStep >= this._currentPlan.steps.length;
  }
  reset() {
    this._currentPlan = void 0;
  }
  dispose() {
    this._onDidUpdatePlan.dispose();
  }
};

// src/vs/workbench/contrib/agent/common/agentResultRetention.ts
var RETENTION_DEFAULTS = {
  maxChars: 8e3,
  headChars: 4e3,
  tailChars: 2e3
};
var MARKER = "\n\n[... tool result middle omitted, {OMITTED} characters ...]\n\n";
function safeSlice(text, start, end) {
  let from = Math.max(0, start);
  let to = Math.min(text.length, end);
  if (from > 0 && from < text.length) {
    const code = text.charCodeAt(from);
    if (code >= 56320 && code <= 57343) from++;
  }
  if (to > 0 && to < text.length) {
    const code = text.charCodeAt(to - 1);
    if (code >= 55296 && code <= 56319) to--;
  }
  if (to <= from) return "";
  return text.slice(from, to);
}
function assertBudgets(maxChars, headChars, tailChars) {
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new Error(`result retention: maxChars (${maxChars}) must be a positive integer`);
  }
  if (!Number.isInteger(headChars) || headChars < 0) {
    throw new Error(`result retention: headChars (${headChars}) must be a non-negative integer`);
  }
  if (!Number.isInteger(tailChars) || tailChars < 0) {
    throw new Error(`result retention: tailChars (${tailChars}) must be a non-negative integer`);
  }
  if (headChars + tailChars >= maxChars) {
    throw new Error(
      `result retention: headChars (${headChars}) + tailChars (${tailChars}) must be less than maxChars (${maxChars})`
    );
  }
}
function retainResult(text, options = {}) {
  const maxChars = options.maxChars ?? RETENTION_DEFAULTS.maxChars;
  const headChars = options.headChars ?? RETENTION_DEFAULTS.headChars;
  const tailChars = options.tailChars ?? RETENTION_DEFAULTS.tailChars;
  const markerTemplate = options.marker ?? MARKER;
  assertBudgets(maxChars, headChars, tailChars);
  if (text.length <= maxChars) {
    return { text, truncated: false, omittedChars: 0, headChars: text.length, tailChars: 0 };
  }
  const head = safeSlice(text, 0, headChars);
  const tail2 = safeSlice(text, text.length - tailChars, text.length);
  const omitted = text.length - head.length - tail2.length;
  const marker = markerTemplate.split("{OMITTED}").join(String(omitted));
  return {
    text: head + marker + tail2,
    truncated: true,
    omittedChars: omitted,
    headChars: head.length,
    tailChars: tail2.length
  };
}

// src/vs/workbench/contrib/agent/common/tools/todoWrite.ts
var STATUSES = ["pending", "in_progress", "completed"];
var GLYPH = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]"
};
function canonicalizeTodos(raw, allowParallel = false) {
  if (!Array.isArray(raw)) {
    throw new Error("`todos` must be an array");
  }
  const todos = [];
  const seen = /* @__PURE__ */ new Set();
  let active = 0;
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      throw new Error("each todo must be an object with `content` and `status`");
    }
    const record = item;
    const content = typeof record.content === "string" ? record.content.trim() : "";
    if (!content) {
      throw new Error("`content` must be a non-empty string");
    }
    if (seen.has(content)) {
      throw new Error(`duplicate todo content ${JSON.stringify(content)}`);
    }
    seen.add(content);
    const status = record.status;
    if (!STATUSES.includes(status)) {
      throw new Error(`invalid status ${JSON.stringify(record.status)} (expected pending, in_progress, or completed)`);
    }
    if (status === "in_progress") active++;
    todos.push({ content, status });
  }
  if (!allowParallel && active > 1) {
    throw new Error(`at most one task may be in_progress (got ${active})`);
  }
  return todos;
}
function summarizeTodos(todos) {
  const done = todos.filter((t) => t.status === "completed").length;
  const active = todos.filter((t) => t.status === "in_progress").length;
  const parts = [`${done}/${todos.length} done`];
  if (active > 0) parts.push(`${active} in progress`);
  return parts.join(", ");
}
function formatTodoList(todos, options = {}) {
  if (todos.length === 0) return "";
  const color = options.color ?? false;
  const reset = color ? "\x1B[0m" : "";
  const dim = color ? "\x1B[2m" : "";
  const green = color ? "\x1B[32m" : "";
  const yellow = color ? "\x1B[33m" : "";
  const bold = color ? "\x1B[1m" : "";
  const lines = todos.map((todo) => {
    const glyph = GLYPH[todo.status];
    if (todo.status === "completed") return `  ${green}${glyph}${reset} ${dim}${todo.content}${reset}`;
    if (todo.status === "in_progress") return `  ${yellow}${glyph} ${bold}${todo.content}${reset}`;
    return `  ${dim}${glyph}${reset} ${todo.content}`;
  });
  return `${bold}Plan${reset} ${dim}(${summarizeTodos(todos)})${reset}
${lines.join("\n")}`;
}
var TodoList = class {
  _items = [];
  get items() {
    return this._items;
  }
  get isEmpty() {
    return this._items.length === 0;
  }
  /** Replace the whole list (last write wins, matching dsh's replay semantics). */
  replace(items) {
    this._items = [...items];
  }
  clear() {
    this._items = [];
  }
};
var TodoWriteTool = class extends AgentTool {
  constructor(_list) {
    super();
    this._list = _list;
  }
  name = "todo_write";
  // The active-status clause is the only part that varies with configuration;
  // this CLI is serial, so it asks for exactly one active item.
  description = "Record and update a task list to plan multi-step work and show progress; skip it for trivial single-step tasks. Add one todo per concrete step before you start. While work remains, keep exactly one todo `in_progress`. Mark each todo `completed` as soon as it is done.";
  parameters = {
    type: "object",
    properties: {
      todos: {
        type: "array",
        description: "The COMPLETE task list, replacing any previous list.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            content: {
              type: "string",
              description: "What the task is \u2014 a short imperative line."
            },
            status: {
              type: "string",
              enum: [...STATUSES],
              description: "pending (not started) | in_progress (now) | completed (done)."
            }
          },
          required: ["content", "status"]
        }
      }
    },
    required: ["todos"]
  };
  async execute(args, signal) {
    const toolCallId = args._toolCallId || "";
    if (signal?.aborted) {
      return this.failure(toolCallId, "Tool execution cancelled by user");
    }
    let todos;
    try {
      todos = canonicalizeTodos(args.todos);
    } catch (err) {
      return this.failure(toolCallId, `invalid todos: ${err.message}`);
    }
    this._list.replace(todos);
    if (todos.length === 0) {
      return this.success(toolCallId, "Cleared the task list.");
    }
    const remaining = todos.filter((t) => t.status !== "completed").length;
    const active = todos.find((t) => t.status === "in_progress");
    return this.success(
      toolCallId,
      `Task list updated: ${summarizeTodos(todos)}.` + (active ? ` Current: ${active.content}` : "") + (remaining === 0 ? " All steps are complete." : "")
    );
  }
};

// src/vs/workbench/contrib/agent/common/agentPrompts.ts
var AGENT_MODE_PROMPT = `You are an autonomous coding agent integrated into VS Code. You can read files, write files, edit files, search code, list directories, and run terminal commands.

## Working Directory
- Current working directory: {{CWD}}
- All relative paths are relative to this directory
- When using run_terminal, commands execute in this directory by default
- Use the 'cwd' parameter if you need to run commands in a different directory

## Thinking Protocol (MUST FOLLOW)
For EVERY user request, especially complex ones:
1. **Decompose**: Break the problem into distinct sub-tasks. List them explicitly before acting.
2. **Explore First**: Use read_file, search_text (or search_content), list_directory to understand the codebase thoroughly BEFORE making any changes. Don't guess.
3. **Plan Each Change**: Before each edit_file or write_file, explain in your reasoning:
   - What exactly you're changing and why
   - What could go wrong (side effects, edge cases)
   - How you'll verify the change
4. **Verify Relentlessly**: After every change, run tests, check for errors, read back the modified file. Don't assume success.
5. **Iterate**: If verification fails, analyze the failure deeply. Read error messages carefully. Don't just try random fixes \u2014 understand the root cause first.
6. **Don't Give Up Early**: A complex task may need 10-30+ tool calls. That's expected. Keep working until ALL subtasks are done AND verified.
7. **When Stuck**: Instead of concluding prematurely, try:
   - Reading more related files for context
   - Searching for similar patterns in the codebase
   - Breaking the problem into smaller, simpler steps
   - Explaining your current understanding and what's blocking you

## Self-Correction Loop
Before concluding any task, you MUST:
1. Verify all changes compile / pass tests (use run_terminal)
2. Re-read modified files to confirm correctness
3. If any verification fails, fix the issue and verify again
4. If you're unsure about any step, re-read the relevant files and reconsider
5. Only provide your final summary when ALL verifications pass

## Core Behavior
1. Analyze the user's request and break it into steps
2. Use tools to explore the codebase before making changes
3. Always read a file before editing it
4. After making changes, verify correctness (run tests, check for errors)
5. Provide concise explanations of what you did

## Tool Usage Rules
- Use read_file before edit_file to understand the current content
- Use search_text (or search_content) or search_files to find relevant code before making changes
- Use run_terminal for builds, tests, git operations
- Use poll for waiting on async external tasks (CI pipelines, container readiness, background jobs) with exponential backoff \u2014 NEVER just print a "waiting" message and stop
- Use edit_file with exact string matching for precise edits
- Use write_file only for new files or complete rewrites
- Use todo_write to show your plan for multi-step work (3+ distinct steps): send the COMPLETE list, keep exactly one item in_progress, and mark each item completed as soon as it is done. Skip it for trivial single-step tasks.

## Polling & Waiting Strategy (CRITICAL)
When you need to wait for an external async task to complete (CI pipeline, background job, container startup, file readiness, etc.):
- ALWAYS use the poll tool with exponential backoff \u2014 do NOT just print "waiting..." and conclude
- The poll tool will repeatedly run your check command, doubling the delay between attempts
- Set reasonable max_attempts (10-30), initial_delay (2-5s), and max_delay (30-60s)
- The check command should return exit 0 on success, OR use success_pattern to match output
- Example: poll(command="curl -s http://localhost:8080/health", success_pattern="OK", max_attempts=20)

## Mid-task User Intervention (/btw)
- The user may send '/btw <instruction>' while you are working.
- An instruction that replaces the goal, contradicts the current plan, or asks to redo work against
  the LATEST state/version SUPERSEDES the task: abandon the rest of the old plan, do not finish work
  that is now irrelevant, and start from the new instruction.
- A pure hint (extra detail, a constraint, a reminder) does NOT supersede: keep the current plan and
  apply the hint.

## Safety
- Never execute destructive commands (rm -rf, drop database, etc.) without confirmation
- Always create a checkpoint before major changes
- Prefer edit_file over write_file to minimize diff size

## Anti-Patterns (NEVER DO THESE)
- \u274C Making changes before reading relevant files
- \u274C Giving up after one failed attempt without analysis
- \u274C Saying "this should work" without running tests
- \u274C Treating a complex refactoring as a single edit
- \u274C Ignoring error messages from build/test commands
- \u274C Concluding a task without verifying the result
- \u274C Printing "waiting for..." or "let me wait..." and concluding \u2014 use the poll tool instead

## Auto-Matching Rules & Skills
- At the start of every task, check the **Preloaded Rules** section below. If any rule's description matches the user's request, automatically apply that rule's content.
- Check the **Available Skills** section below. Skills whose description, **Triggers**, or name match the task have their **full instructions preloaded** (marked "auto-activated"). You MUST follow these instructions as mandatory guidance \u2014 they are not suggestions.
- For skills listed without auto-activated content, if their description or triggers match the task, use the provided Path to read_file the full SKILL.md content and incorporate its guidance.
- Rules marked "(Always Active)" should always be followed regardless of the task.`;
var ASK_MODE_PROMPT = `You are a code exploration assistant integrated into VS Code. You can read files, search code, and list directories to answer questions about the codebase.

## Core Behavior
1. Analyze the user's question
2. Search the codebase to find relevant information
3. Read relevant files to understand the code
4. Provide clear, accurate answers with file references

## Constraints
- You are in READ-ONLY mode: you cannot edit files, write files, or run commands
- Focus on understanding and explaining, not modifying
- Reference specific file paths and line numbers in your answers`;
var PLAN_MODE_PROMPT = `You are a technical planning assistant integrated into VS Code. You help users design implementation plans for coding tasks.

## Core Behavior
1. Understand the user's goal
2. Explore the codebase to assess the current state
3. Ask clarifying questions if requirements are ambiguous
4. Generate a detailed, step-by-step implementation plan

## Plan Format
Output a structured plan with:
- Task summary
- Numbered steps, each with:
  - Description of what to do
  - Which files to create/modify
  - Key implementation details
- Risk assessment and edge cases
- Testing strategy

## Constraints
- Do not execute the plan, only design it
- The plan should be actionable by Agent mode`;
function getSystemPrompt(mode, cwd) {
  let prompt;
  switch (mode) {
    case "agent":
      prompt = AGENT_MODE_PROMPT;
      break;
    case "ask":
      prompt = ASK_MODE_PROMPT;
      break;
    case "plan":
      prompt = PLAN_MODE_PROMPT;
      break;
  }
  if (cwd) {
    prompt = prompt.replace(/\{\{CWD\}\}/g, cwd);
  }
  return prompt;
}

// src/vs/workbench/contrib/agent/common/agentTracing.ts
var fs3 = __toESM(require("node:fs"));
var os3 = __toESM(require("node:os"));
var path4 = __toESM(require("node:path"));

// src/vs/workbench/contrib/agent/common/agentHome.ts
var fs = __toESM(require("fs"));
var os = __toESM(require("os"));
var path2 = __toESM(require("path"));
var AGENT_HOME_NAME = ".agents";
var PROJECT_AGENT_HOME_NAME = AGENT_HOME_NAME;
var PREVIOUS_AGENT_HOME_NAME = ".agent";
var LEGACY_AGENT_HOME_NAME = ".codeagent";
var COPIED_ENTRIES = ["config.yaml", "config.json", "models.json", "mcp.json", ".mcp.json", "agent.md"];
var MOVED_ENTRIES = ["rules", "skills", "sessions", "tasks"];
var COMPANION_LINK_ROOTS = [".cursor", ".codebuddy"];
var COMPANION_LINK_ENTRIES = ["skills", "skills-cursor", "rules"];
function agentHomeOverride() {
  const dir = process.env.AGENT_HOME || process.env.CODE_AGENT_HOME;
  return dir ? path2.resolve(dir) : void 0;
}
function newAgentHomeDir() {
  return agentHomeOverride() || path2.join(os.homedir(), AGENT_HOME_NAME);
}
function legacyAgentHomeDirs() {
  const dirs = [
    path2.join(os.homedir(), PREVIOUS_AGENT_HOME_NAME),
    path2.join(os.homedir(), LEGACY_AGENT_HOME_NAME)
  ];
  return dirs.filter((dir, i) => dirs.indexOf(dir) === i);
}
function agentHomeDirs() {
  const override = agentHomeOverride();
  if (override) return [override];
  const dirs = [newAgentHomeDir(), ...legacyAgentHomeDirs()];
  return dirs.filter((dir, i) => dirs.indexOf(dir) === i);
}
function agentHomeDir() {
  const override = agentHomeOverride();
  if (override) return override;
  const fresh = newAgentHomeDir();
  if (fs.existsSync(fresh)) return fresh;
  const legacy = legacyAgentHomeDirs().find((dir) => fs.existsSync(dir));
  return legacy ?? fresh;
}
function agentHomeFileCandidates(relative2) {
  return agentHomeDirs().map((dir) => path2.join(dir, relative2));
}
function agentInstructionFiles(cwd = process.cwd()) {
  const files = [
    ...agentHomeDirs().map((dir) => path2.join(dir, "agent.md")),
    path2.join(cwd, PROJECT_AGENT_HOME_NAME, "agent.md"),
    path2.join(cwd, PREVIOUS_AGENT_HOME_NAME, "agent.md")
  ];
  return files.filter((file, i) => files.indexOf(file) === i);
}
function migrateLegacyAgentHome(log2) {
  if (agentHomeOverride()) return;
  const fresh = newAgentHomeDir();
  const companionRoots = COMPANION_LINK_ROOTS.map((root) => path2.join(os.homedir(), root));
  for (const legacy of legacyAgentHomeDirs()) {
    migrateAgentHome(legacy, fresh, log2);
  }
  for (const legacy of legacyAgentHomeDirs()) {
    repointCompanionLinks(legacy, fresh, companionRoots, log2);
  }
}
function migrateAgentHome(legacy, fresh, log2) {
  try {
    if (!fs.existsSync(legacy)) return 0;
    const freshExisted = fs.existsSync(fresh);
    fs.mkdirSync(fresh, { recursive: true });
    let copied = 0;
    let moved = 0;
    let flipped = 0;
    let keptLegacy = 0;
    if (!freshExisted) {
      for (const entry of COPIED_ENTRIES) {
        const from = path2.join(legacy, entry);
        if (!fs.existsSync(from) || isSymlink(from)) continue;
        const to = path2.join(fresh, entry);
        if (fs.existsSync(to)) continue;
        fs.cpSync(from, to, { recursive: true });
        copied++;
      }
    }
    for (const entry of MOVED_ENTRIES) {
      const legacyPath = path2.join(legacy, entry);
      const freshPath = path2.join(fresh, entry);
      if (isSymlink(freshPath)) {
        const target = fs.readlinkSync(freshPath);
        const resolved = path2.resolve(path2.dirname(freshPath), target);
        if (resolved.startsWith(legacy + path2.sep)) {
          if (!fs.existsSync(legacyPath)) continue;
          fs.unlinkSync(freshPath);
          flipped++;
        } else {
          continue;
        }
      }
      if (fs.existsSync(freshPath)) continue;
      if (!fs.existsSync(legacyPath) || isSymlink(legacyPath)) continue;
      try {
        fs.renameSync(legacyPath, freshPath);
        moved++;
      } catch {
        fs.cpSync(legacyPath, freshPath, { recursive: true });
        copied++;
        keptLegacy++;
        continue;
      }
      try {
        fs.symlinkSync(freshPath, legacyPath, "dir");
      } catch {
      }
    }
    const handled = copied + moved + flipped;
    if (handled > 0 || freshExisted === false) {
      log2(
        `Config home: ${fresh} now owns the configuration (${moved} moved, ${copied} copied, ${flipped} links flipped${keptLegacy > 0 ? `, ${keptLegacy} kept in ${legacy}` : ""}) \u2014 ${legacy} is now a pointer and can be deleted`
      );
    }
    return handled;
  } catch (err) {
    log2(`Config home: could not migrate ${legacy} \u2192 ${fresh}: ${err.message}`);
    return 0;
  }
}
function isSymlink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}
function repointCompanionLinks(legacy, fresh, roots, log2) {
  let repointed = 0;
  for (const root of roots) {
    for (const entry of COMPANION_LINK_ENTRIES) {
      const linkPath = path2.join(root, entry);
      if (!isSymlink(linkPath)) continue;
      try {
        const resolved = path2.resolve(path2.dirname(linkPath), fs.readlinkSync(linkPath));
        if (!resolved.startsWith(legacy + path2.sep)) continue;
        const target = path2.join(fresh, path2.relative(legacy, resolved));
        if (!fs.existsSync(target)) continue;
        fs.unlinkSync(linkPath);
        fs.symlinkSync(target, linkPath, "dir");
        repointed++;
        log2(`Config home: re-pointed ${linkPath} \u2192 ${target}`);
      } catch {
      }
    }
  }
  return repointed;
}

// src/vs/workbench/contrib/agent/common/agentConfig.ts
var fs2 = __toESM(require("node:fs"));
var path3 = __toESM(require("node:path"));
var os2 = __toESM(require("node:os"));
function stripYamlComment(value) {
  let quote = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(value[i - 1]))) {
      return value.slice(0, i);
    }
  }
  return value;
}
function parseScalarValue(raw) {
  return stripYamlComment(raw).trim().replace(/^["']|["']$/g, "");
}
function parseYaml(text) {
  const result = {};
  const lines = text.split("\n");
  let currentSection = "";
  let currentProfile = "";
  let inList = false;
  let listKey = "";
  let inRoutingScenarios = false;
  let inMcpTools = false;
  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0 && trimmed.endsWith(":")) {
      currentSection = trimmed.slice(0, -1);
      currentProfile = "";
      inList = false;
      if (currentSection === "profiles") result.profiles = result.profiles || {};
      if (currentSection === "agent") result.agent = result.agent || {};
      if (currentSection === "model_routing") result.model_routing = result.model_routing || {};
      continue;
    }
    if (indent === 0 && trimmed.includes(":")) {
      const [key, ...rest] = trimmed.split(":");
      const val = rest.join(":").trim();
      if (key.trim() === "active_profile") result.active_profile = val;
      continue;
    }
    if (currentSection === "profiles" && indent === 2 && trimmed.endsWith(":")) {
      currentProfile = trimmed.slice(0, -1).trim();
      result.profiles[currentProfile] = { provider: "", model: "", api_key: "" };
      continue;
    }
    if (currentSection === "profiles" && indent === 4 && currentProfile) {
      const [key, ...rest] = trimmed.split(":");
      const val = rest.join(":").trim();
      const k = key.trim();
      const profile = result.profiles[currentProfile];
      if (k === "provider") profile.provider = val;
      else if (k === "model") profile.model = val;
      else if (k === "api_key") profile.api_key = val.replace(/^["']|["']$/g, "");
      else if (k === "api_base") profile.api_base = val;
      else if (k === "temperature") profile.temperature = parseFloat(val);
      else if (k === "top_k") profile.top_k = parseInt(val, 10);
      else if (k === "max_input_tokens") profile.max_input_tokens = parseInt(val, 10);
      else if (k === "max_output_tokens") profile.max_output_tokens = parseInt(val, 10);
      continue;
    }
    if (currentSection === "agent" && indent === 2) {
      const [key, ...rest] = trimmed.split(":");
      const val = rest.join(":").trim();
      const k = key.trim();
      if (!result.agent) result.agent = {};
      if (k === "max_steps") result.agent.max_steps = parseInt(val, 10);
      else if (k === "max_context_tokens") result.agent.max_context_tokens = parseInt(val, 10);
      else if (k === "temperature") result.agent.temperature = parseFloat(val);
      else if (k === "top_k") result.agent.top_k = parseInt(val, 10);
      else if (k === "step_timeout") result.agent.step_timeout = parseInt(val, 10);
      else if (k === "task_timeout") result.agent.task_timeout = parseInt(val, 10);
      continue;
    }
    if (currentSection === "model_routing") {
      if (!result.model_routing) result.model_routing = {};
      if (indent === 2 && trimmed.endsWith(":")) {
        const subKey = trimmed.slice(0, -1).trim();
        inRoutingScenarios = subKey === "scenarios";
        if (inRoutingScenarios) result.model_routing.scenarios = result.model_routing.scenarios || {};
        continue;
      }
      if (indent === 2) {
        const [key, ...rest] = trimmed.split(":");
        const val = rest.join(":").trim();
        const k = key.trim();
        if (k === "enabled") result.model_routing.enabled = val === "true" || val === "1" || val === "yes";
        else if (k === "default") result.model_routing.default = val;
        else if (k === "fallback") result.model_routing.fallback = val;
        else if (k === "fallback_probe_interval_s") result.model_routing.fallback_probe_interval_s = parseFloat(val);
        continue;
      }
      if (indent === 4 && inRoutingScenarios) {
        const [key, ...rest] = trimmed.split(":");
        const val = rest.join(":").trim();
        if (result.model_routing.scenarios) {
          result.model_routing.scenarios[key.trim()] = val;
        }
        continue;
      }
    }
    if (currentSection === "mcp_servers" && indent === 2 && trimmed.endsWith(":")) {
      currentProfile = trimmed.slice(0, -1).trim();
      if (!result.mcp_servers) result.mcp_servers = {};
      result.mcp_servers[currentProfile] = {};
      continue;
    }
    if (currentSection === "mcp_servers" && indent === 4 && currentProfile) {
      const [key, ...rest] = trimmed.split(":");
      const val = rest.join(":").trim();
      const k = key.trim();
      const srv = result.mcp_servers[currentProfile];
      inMcpTools = k === "tools";
      if (k === "command") srv.command = val;
      else if (k === "url") srv.url = val;
      else if (k === "type") srv.type = val;
      else if (k === "headers") {
        if (!srv.headers) srv.headers = {};
      } else if (k === "tools") {
        if (!srv.tools) srv.tools = [];
      } else if (k === "args") {
        if (val) srv.args = val.split(/\s+/);
      }
      continue;
    }
    if (currentSection === "mcp_servers" && indent === 6 && currentProfile) {
      const srv = result.mcp_servers?.[currentProfile];
      if (srv && inMcpTools && trimmed.trimStart().startsWith("- ")) {
        if (!srv.tools) srv.tools = [];
        srv.tools.push(trimmed.trimStart().slice(2).trim());
      } else if (srv && trimmed.trimStart().startsWith("- ")) {
        const val = trimmed.trimStart().slice(2).trim();
        if (!srv.args) srv.args = [];
        srv.args.push(val);
      } else if (srv && srv.headers !== void 0) {
        const [key, ...rest] = trimmed.split(":");
        const val = rest.join(":").trim();
        srv.headers[key.trim()] = val;
      }
      continue;
    }
    if (currentSection === "mcp_servers" && indent === 6 && trimmed.trimStart().startsWith("- ")) {
      const val = trimmed.trimStart().slice(2).trim();
      const srv = result.mcp_servers?.[currentProfile];
      if (srv) {
        if (!srv.args) srv.args = [];
        srv.args.push(val);
      }
      continue;
    }
    if ((currentSection === "skills" || currentSection === "rules") && trimmed.trimStart().startsWith("- ")) {
      const val = trimmed.trimStart().slice(2).trim();
      if (!result[currentSection]) {
        result[currentSection] = [];
      }
      result[currentSection].push(val);
      continue;
    }
  }
  return result;
}
function findConfigFile() {
  const candidates = [
    path3.join(process.cwd(), "config.yaml"),
    path3.join(process.cwd(), "config.json"),
    ...agentHomeFileCandidates("config.yaml"),
    ...agentHomeFileCandidates("config.json")
  ];
  return candidates.find((p) => fs2.existsSync(p));
}
function findModelsJson() {
  const candidates = [
    path3.join(process.cwd(), "models.json"),
    ...agentHomeFileCandidates("models.json"),
    path3.join(os2.homedir(), ".codebuddy", "models.json")
    // shared compat
  ];
  return candidates.find((p) => fs2.existsSync(p));
}
function modelEntryToProfile(entry) {
  const apiBase = entry.url.replace(/\/chat\/completions\/?$/, "");
  return {
    provider: "openai",
    model: entry.id,
    api_key: entry.apiKey,
    api_base: apiBase,
    max_input_tokens: entry.maxInputTokens,
    max_output_tokens: entry.maxOutputTokens || entry.maxTokens,
    supports_reasoning: entry.supportsReasoning,
    thinking: entry.thinking
  };
}
function loadModelsJson() {
  const modelsPath = findModelsJson();
  if (!modelsPath) return void 0;
  try {
    const raw = fs2.readFileSync(modelsPath, "utf-8");
    const data = JSON.parse(raw);
    const profiles = {};
    for (const entry of data.models) {
      profiles[entry.id] = modelEntryToProfile(entry);
    }
    return profiles;
  } catch {
    return void 0;
  }
}
function resolveHomePath(p) {
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path3.join(os2.homedir(), p.slice(2));
  }
  return path3.resolve(p);
}
function profileToAgentConfig(profile, agent) {
  const budgets = normalizeTokenBudgets(
    profile.max_input_tokens || agent?.max_context_tokens || DEFAULT_AGENT_CONFIG.maxContextTokens,
    profile.max_output_tokens || DEFAULT_AGENT_CONFIG.maxOutputTokens
  );
  return {
    ...DEFAULT_AGENT_CONFIG,
    provider: profile.provider || DEFAULT_AGENT_CONFIG.provider,
    model: profile.model || DEFAULT_AGENT_CONFIG.model,
    apiKey: profile.api_key || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || "",
    apiBase: profile.api_base || void 0,
    supportsReasoning: profile.supports_reasoning,
    thinking: profile.thinking,
    maxSteps: agent?.max_steps || DEFAULT_AGENT_CONFIG.maxSteps,
    maxContextTokens: budgets.maxContextTokens,
    maxOutputTokens: budgets.maxOutputTokens,
    temperature: profile.temperature ?? agent?.temperature ?? DEFAULT_AGENT_CONFIG.temperature,
    topK: profile.top_k ?? agent?.top_k ?? DEFAULT_AGENT_CONFIG.topK,
    stepTimeout: agent?.step_timeout || DEFAULT_AGENT_CONFIG.stepTimeout,
    taskTimeout: agent?.task_timeout || DEFAULT_AGENT_CONFIG.taskTimeout
  };
}
var MIN_INPUT_BUDGET = 4096;
function defaultDirs(kind) {
  return [
    ...agentHomeDirs().map((dir) => path3.join(dir, kind)),
    path3.join(os2.homedir(), ".cursor", kind)
  ];
}
function dedupeByRealPath(dirs) {
  const seen = /* @__PURE__ */ new Set();
  const unique = [];
  for (const dir of dirs) {
    let key = dir;
    try {
      key = fs2.realpathSync(dir);
    } catch {
    }
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(dir);
  }
  return unique;
}
function normalizeTokenBudgets(maxContextTokens, maxOutputTokens) {
  const context = Math.max(1, maxContextTokens || 0);
  const output = Math.max(1, maxOutputTokens || 0);
  const maxAllowedOutput = Math.max(1, context - MIN_INPUT_BUDGET);
  return {
    maxContextTokens: context,
    maxOutputTokens: Math.min(output, maxAllowedOutput)
  };
}
function loadConfig(cliProfile) {
  let fileConfig = {};
  const configPath = findConfigFile();
  if (configPath) {
    try {
      const raw = fs2.readFileSync(configPath, "utf-8");
      fileConfig = configPath.endsWith(".json") ? JSON.parse(raw) : parseYaml(raw);
    } catch {
    }
  }
  const modelsProfiles = loadModelsJson();
  if (modelsProfiles) {
    fileConfig.profiles = { ...modelsProfiles, ...fileConfig.profiles };
  }
  let profileName = cliProfile || process.env.AGENT_PROFILE || fileConfig.active_profile || void 0;
  const profileExplicit = !!cliProfile;
  if (!profileName && fileConfig.profiles && Object.keys(fileConfig.profiles).length > 0) {
    profileName = Object.keys(fileConfig.profiles)[0];
  } else if (!profileName) {
    profileName = "default";
  }
  let profile = fileConfig.profiles?.[profileName];
  if (fileConfig.profiles && !profile && profileName !== "default") {
    const available = Object.keys(fileConfig.profiles).join(", ");
    console.warn(`Warning: profile "${profileName}" not found in config. Available: ${available}`);
    profileName = Object.keys(fileConfig.profiles)[0];
    profile = fileConfig.profiles?.[profileName];
    console.warn(`         Falling back to: "${profileName}"`);
  }
  const budgets = normalizeTokenBudgets(
    profile?.max_input_tokens || fileConfig.agent?.max_context_tokens || DEFAULT_AGENT_CONFIG.maxContextTokens,
    profile?.max_output_tokens || DEFAULT_AGENT_CONFIG.maxOutputTokens
  );
  const agentConfig = {
    ...DEFAULT_AGENT_CONFIG,
    provider: process.env.LLM_PROVIDER || profile?.provider || DEFAULT_AGENT_CONFIG.provider,
    model: process.env.LLM_MODEL || profile?.model || DEFAULT_AGENT_CONFIG.model,
    apiKey: process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || profile?.api_key || "",
    apiBase: process.env.LLM_API_BASE || profile?.api_base || void 0,
    supportsReasoning: profile?.supports_reasoning,
    thinking: profile?.thinking,
    maxSteps: fileConfig.agent?.max_steps || DEFAULT_AGENT_CONFIG.maxSteps,
    maxContextTokens: budgets.maxContextTokens,
    maxOutputTokens: budgets.maxOutputTokens,
    temperature: profile?.temperature ?? fileConfig.agent?.temperature ?? DEFAULT_AGENT_CONFIG.temperature,
    topK: profile?.top_k ?? fileConfig.agent?.top_k ?? DEFAULT_AGENT_CONFIG.topK,
    stepTimeout: fileConfig.agent?.step_timeout || DEFAULT_AGENT_CONFIG.stepTimeout,
    taskTimeout: fileConfig.agent?.task_timeout || DEFAULT_AGENT_CONFIG.taskTimeout
  };
  const skillsDirs = dedupeByRealPath((fileConfig.skills || defaultDirs("skills")).map(resolveHomePath));
  const rulesDirs = dedupeByRealPath((fileConfig.rules || defaultDirs("rules")).map(resolveHomePath));
  const mcpServers = Object.entries(fileConfig.mcp_servers || {}).map(
    ([name, srv]) => ({ name, ...srv })
  );
  const profiles = {};
  for (const [name, p] of Object.entries(fileConfig.profiles || {})) {
    profiles[name] = profileToAgentConfig(p, fileConfig.agent);
  }
  const hasRouting = fileConfig.model_routing !== void 0;
  const probeSeconds = fileConfig.model_routing?.fallback_probe_interval_s;
  const modelRouting = {
    enabled: hasRouting && fileConfig.model_routing?.enabled !== false && !profileExplicit,
    defaultModel: fileConfig.model_routing?.default,
    fallbackModel: fileConfig.model_routing?.fallback,
    probeIntervalMs: typeof probeSeconds === "number" && probeSeconds > 0 ? probeSeconds * 1e3 : void 0,
    scenarios: fileConfig.model_routing?.scenarios || {}
  };
  return {
    agentConfig,
    skillsDirs,
    rulesDirs,
    profileName,
    configFilePath: configPath,
    mcpServers,
    profiles,
    modelRouting,
    profileExplicit
  };
}
function loadConfigForProfile(profileName) {
  return loadConfig(profileName);
}
function listProfiles() {
  const modelsProfiles = loadModelsJson();
  if (modelsProfiles) {
    return Object.entries(modelsProfiles).map(([name, p]) => ({
      name,
      provider: p.provider,
      model: p.model
    }));
  }
  const configPath = findConfigFile();
  if (!configPath) return [];
  try {
    const raw = fs2.readFileSync(configPath, "utf-8");
    const config = parseYaml(raw);
    return Object.entries(config.profiles || {}).map(([name, p]) => ({
      name,
      provider: p.provider,
      model: p.model
    }));
  } catch {
    return [];
  }
}

// src/vs/workbench/contrib/agent/common/agentTracing.ts
var MAX_ID_LEN = 200;
var MAX_META_VALUE_LEN = 200;
var MAX_MESSAGE_CHARS = 2e4;
var MAX_REASONING_CHARS = 8e3;
function envStr(...names) {
  for (const name of names) {
    const v = process.env[name];
    if (v && v.trim()) return v.trim();
  }
  return void 0;
}
function envBool(...names) {
  for (const name of names) {
    const v = process.env[name];
    if (v === void 0) continue;
    const s = v.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(s)) return true;
    if (["0", "false", "no", "off"].includes(s)) return false;
  }
  return void 0;
}
function toBool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v !== "string") return void 0;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return void 0;
}
function parseTracingYaml(text) {
  let inTracing = false;
  let inTags = false;
  const section = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0 && trimmed.endsWith(":")) {
      inTracing = trimmed === "tracing:";
      inTags = false;
      continue;
    }
    if (!inTracing) continue;
    if (indent === 2 && trimmed.startsWith("- ")) {
      if (inTags) {
        section.tags = section.tags || [];
        section.tags.push(parseScalarValue(trimmed.slice(2)));
      }
      continue;
    }
    if (indent > 2 && trimmed.startsWith("- ")) {
      if (inTags) {
        section.tags = section.tags || [];
        section.tags.push(parseScalarValue(trimmed.slice(2)));
      }
      continue;
    }
    if (indent !== 2) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const rawVal = parseScalarValue(trimmed.slice(idx + 1));
    inTags = key === "tags";
    if (key === "enabled") section.enabled = toBool(rawVal);
    else if (key === "public_key") section.public_key = rawVal;
    else if (key === "secret_key") section.secret_key = rawVal;
    else if (key === "base_url") section.base_url = rawVal;
    else if (key === "host") section.host = rawVal;
    else if (key === "environment") section.environment = rawVal;
    else if (key === "release") section.release = rawVal;
    else if (key === "capture_content") section.capture_content = toBool(rawVal);
    else if (key === "user_id") section.user_id = rawVal;
    else if (key === "session_id") section.session_id = rawVal;
  }
  return Object.keys(section).length > 0 ? section : void 0;
}
function loadTracingYamlSection() {
  const candidates = [
    path4.resolve("config.yaml"),
    path4.resolve("config.json"),
    ...agentHomeFileCandidates("config.yaml"),
    ...agentHomeFileCandidates("config.json")
  ];
  for (const file of candidates) {
    try {
      if (!fs3.existsSync(file)) continue;
      const text = fs3.readFileSync(file, "utf-8");
      if (file.endsWith(".json")) {
        const parsed = JSON.parse(text);
        if (parsed?.tracing && typeof parsed.tracing === "object") return parsed.tracing;
        continue;
      }
      const section = parseTracingYaml(text);
      if (section) return section;
    } catch {
    }
  }
  return void 0;
}
function loadTracingConfig(cliOverride, release) {
  if (cliOverride === "off") {
    return { enabled: false, reason: "disabled by --tracing off" };
  }
  const yaml = loadTracingYamlSection();
  const envDisabled = envBool("LANGFUSE_TRACING_ENABLED") === false;
  if (envDisabled) {
    return { enabled: false, reason: "disabled by LANGFUSE_TRACING_ENABLED=false" };
  }
  const yamlEnabled = yaml?.enabled;
  if (yamlEnabled === false && cliOverride !== "on") {
    return { enabled: false, reason: "disabled by config.yaml tracing.enabled=false" };
  }
  const publicKey = envStr("LANGFUSE_PUBLIC_KEY") || yaml?.public_key || "";
  const secretKey = envStr("LANGFUSE_SECRET_KEY") || yaml?.secret_key || "";
  const baseUrl = envStr("LANGFUSE_BASE_URL", "LANGFUSE_HOST") || yaml?.base_url || yaml?.host || "https://cloud.langfuse.com";
  if (!publicKey || !secretKey) {
    return {
      enabled: false,
      reason: "no Langfuse API keys (set LANGFUSE_PUBLIC_KEY + LANGFUSE_SECRET_KEY, or config.yaml tracing.public_key/secret_key)"
    };
  }
  const source = envStr("LANGFUSE_PUBLIC_KEY") ? "environment (LANGFUSE_*)" : "config.yaml tracing section";
  const captureContent = envBool("LANGFUSE_CAPTURE_CONTENT") ?? yaml?.capture_content ?? true;
  const tags = (yaml?.tags || []).filter((t) => typeof t === "string" && t.trim().length > 0);
  return {
    enabled: true,
    source,
    config: {
      publicKey,
      secretKey,
      baseUrl,
      environment: envStr("LANGFUSE_TRACING_ENVIRONMENT") || yaml?.environment,
      release: envStr("LANGFUSE_RELEASE") || yaml?.release || release,
      captureContent,
      userId: envStr("LANGFUSE_USER_ID") || yaml?.user_id,
      sessionId: envStr("LANGFUSE_SESSION_ID") || yaml?.session_id,
      tags
    }
  };
}
var SECRET_PATTERNS = [
  // Langfuse / OpenAI-style keys: sk-lf-…, pk-lf-…, sk-proj-…, sk-ant-…
  [/\b(?:sk|pk|rk)-(?:lf|proj|ant|or|live|test)?-?[A-Za-z0-9_-]{12,}/g, "<redacted-key>"],
  // Authorization headers and bearer tokens
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}/gi, "Bearer <redacted>"],
  // JWT (memory hub, Dolphin MCP)
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<redacted-jwt>"],
  // key = value / "key": "value" for anything that looks like a credential
  [
    /((?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|client[_-]?secret|private[_-]?key|authorization)["']?\s*[:=]\s*["']?)([^\s"',;}{)\]]{6,})/gi,
    "$1<redacted>"
  ]
];
function redactSecrets(text) {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
function redactDeep(value, depth = 0) {
  if (depth > 12) return value;
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}
function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}
... (${text.length} chars total, truncated)` : text;
}
var NOOP_HANDLE = { update: () => {
} };
var NOOP_STEP = { ref: null, update: () => {
}, end: () => {
} };
var NoopTracing = class {
  enabled = false;
  reason;
  constructor(reason) {
    this.reason = reason;
  }
  async init() {
    return false;
  }
  async runTask(_meta, fn) {
    return fn(NOOP_HANDLE);
  }
  beginStep(_meta) {
    return NOOP_STEP;
  }
  async runGeneration(_meta, fn) {
    return fn(NOOP_HANDLE);
  }
  async runTool(_meta, fn) {
    return fn(NOOP_HANDLE);
  }
  async runSubagent(_meta, fn) {
    return fn(NOOP_HANDLE);
  }
  async flush() {
  }
  async shutdown() {
  }
};
var NOOP_TRACING = new NoopTracing();
function spanContextOf(ref) {
  return { traceId: ref.traceId, spanId: ref.spanId, traceFlags: 1, isRemote: false };
}
var LangfuseTracing = class {
  constructor(_config) {
    this._config = _config;
  }
  enabled = true;
  _sdk;
  _initPromise;
  /** Public key + base URL are enough for a safe status line (never the secret). */
  describe() {
    const env2 = this._config.environment ? ` env=${this._config.environment}` : "";
    return `Langfuse ${this._config.baseUrl}${env2} (content=${this._config.captureContent ? "full" : "metadata-only"})`;
  }
  async init() {
    if (!this._initPromise) {
      this._initPromise = this._init().catch((err) => {
        console.warn(`[TRACING] Langfuse SDK unavailable, tracing disabled: ${err.message}`);
        return false;
      });
    }
    return this._initPromise;
  }
  async _init() {
    const [otel, tracing2, sdkTrace] = await Promise.all([
      import("@langfuse/otel"),
      import("@langfuse/tracing"),
      import("@opentelemetry/sdk-trace-node")
    ]);
    const processor = new otel.LangfuseSpanProcessor({
      publicKey: this._config.publicKey,
      secretKey: this._config.secretKey,
      baseUrl: this._config.baseUrl,
      environment: this._config.environment,
      release: this._config.release,
      // Long-running CLI: batch (default) and flush explicitly on exit.
      exportMode: "batched",
      // Official masking hook — applied to every exported attribute value.
      mask: (params) => redactDeep(params.data)
    });
    const provider = new sdkTrace.NodeTracerProvider({
      spanProcessors: [processor]
    });
    provider.register();
    this._sdk = {
      tracing: tracing2,
      processor
    };
    return true;
  }
  get _ready() {
    return !!this._sdk;
  }
  /**
   * Wrap a callback in an active observation.
   *
   * When no observation is active yet this becomes the trace root (and the
   * trace-level attributes are propagated); inside an existing trace it is a
   * plain child span — which is exactly what a subagent needs, since it must
   * inherit the orchestrator's trace instead of renaming it.
   *
   * `parent`, when given, attaches the observation to a step that is not the
   * active span (see `beginStep`).
   */
  async _run(type, name, attrs, fn, traceAttrs, parent) {
    if (!this._ready) return fn(NOOP_HANDLE);
    let workFailed = false;
    let workStarted = false;
    let workError;
    const wrapped = async (obs) => {
      workStarted = true;
      try {
        return await this._invoke(obs, attrs, fn, type);
      } catch (err) {
        workFailed = true;
        workError = err;
        throw err;
      }
    };
    try {
      const options = { asType: type };
      if (parent) options.parentSpanContext = spanContextOf(parent);
      const parentActive = this._sdk.tracing.getActiveTraceId() !== void 0;
      return await (parentActive || !traceAttrs ? this._sdk.tracing.startActiveObservation(name, wrapped, options) : this._sdk.tracing.propagateAttributes(traceAttrs, () => this._sdk.tracing.startActiveObservation(name, wrapped, options)));
    } catch (err) {
      if (workFailed) throw workError;
      console.warn(`[TRACING] ${name} instrumentation failed (non-fatal): ${err.message}`);
      if (workStarted) throw err;
      return fn(NOOP_HANDLE);
    }
  }
  /**
   * Start the step observation for one ReAct iteration.
   *
   * Created as a child of whatever is active (the task span, or a subagent's
   * agent span) and ended by the caller in a `finally` — which keeps the loop's
   * `continue`/`break` control flow untouched.
   */
  beginStep(meta) {
    if (!this._ready) return NOOP_STEP;
    try {
      const obs = this._sdk.tracing.startObservation(
        meta.name || "agent-step",
        this._shape({ metadata: meta.metadata }, "span"),
        { asType: "span" }
      );
      return this._stepHandle(obs, meta);
    } catch (err) {
      console.warn(`[TRACING] step instrumentation failed (non-fatal): ${err.message}`);
      return NOOP_STEP;
    }
  }
  _stepHandle(obs, meta) {
    let ended = false;
    const ref = obs.traceId && obs.id ? { traceId: obs.traceId, spanId: obs.id } : null;
    return {
      ref,
      update: (attrs) => {
        if (ended) return;
        try {
          obs.update(this._shape(attrs, "span"));
        } catch {
        }
      },
      end: () => {
        if (ended) return;
        ended = true;
        try {
          obs.end();
        } catch {
        }
      }
    };
  }
  async _invoke(obs, attrs, fn, type) {
    const handle = {
      update: (next) => {
        try {
          obs.update(this._shape(next, type));
        } catch {
        }
      }
    };
    try {
      obs.update(this._shape(attrs, type));
    } catch {
    }
    try {
      const result = await fn(handle);
      try {
        obs.end();
      } catch {
      }
      return result;
    } catch (err) {
      try {
        obs.update({
          level: "ERROR",
          statusMessage: err.message?.slice(0, MAX_META_VALUE_LEN)
        });
      } catch {
      }
      try {
        obs.end();
      } catch {
      }
      throw err;
    }
  }
  /**
   * Turn our attribute bag into SDK attributes, honouring `captureContent`.
   *
   * `captureContent: false` keeps the trace useful for latency/cost/error
   * analysis while sending no prompt, output or tool payload at all.
   */
  _shape(attrs, type) {
    const out = {};
    const capture = this._config.captureContent;
    if (capture && attrs.input !== void 0) out.input = this._input(attrs.input);
    if (capture && attrs.output !== void 0) out.output = redactDeep(attrs.output);
    if (attrs.metadata) out.metadata = redactDeep(attrs.metadata);
    if (attrs.level) out.level = attrs.level;
    if (attrs.statusMessage) out.statusMessage = redactSecrets(attrs.statusMessage).slice(0, MAX_META_VALUE_LEN);
    if (type === "generation") {
      if (attrs.model) out.model = attrs.model;
      if (attrs.modelParameters) out.modelParameters = attrs.modelParameters;
      if (attrs.usageDetails) out.usageDetails = attrs.usageDetails;
      if (attrs.completionStartTime) out.completionStartTime = attrs.completionStartTime;
    }
    return out;
  }
  /** Redact + bound the input payload (message arrays are the common case). */
  _input(input) {
    if (Array.isArray(input)) {
      return input.map((item) => {
        if (!item || typeof item !== "object") return redactDeep(item);
        const msg = item;
        const copy = { ...msg };
        if (typeof copy.content === "string") {
          copy.content = truncate(redactSecrets(copy.content), MAX_MESSAGE_CHARS);
        }
        if (typeof copy.reasoningContent === "string") {
          copy.reasoningContent = truncate(redactSecrets(copy.reasoningContent), MAX_REASONING_CHARS);
        }
        return copy;
      });
    }
    if (typeof input === "string") return truncate(redactSecrets(input), MAX_MESSAGE_CHARS);
    return redactDeep(input);
  }
  async runTask(meta, fn) {
    if (!this._ready) return fn(NOOP_HANDLE);
    const traceAttrs = {
      traceName: clip(meta.name || "agent-task"),
      tags: [...this._config.tags, ...meta.tags || []],
      metadata: stringifyMeta({
        ...meta.metadata,
        app: "code-agent",
        ...this._config.release ? { release: this._config.release } : {}
      })
    };
    const userId = meta.userId || this._config.userId;
    const sessionId = meta.sessionId || this._config.sessionId;
    if (userId) traceAttrs.userId = clip(userId);
    if (sessionId) traceAttrs.sessionId = clip(sessionId);
    return this._run("span", meta.name || "agent-task", {
      input: meta.input,
      metadata: meta.metadata
    }, fn, traceAttrs);
  }
  async runGeneration(meta, fn, parent) {
    return this._run("generation", meta.name || "llm-call", {
      model: meta.model,
      modelParameters: meta.modelParameters,
      completionStartTime: meta.startTime,
      input: meta.input,
      metadata: meta.metadata
    }, fn, void 0, parent);
  }
  async runTool(meta, fn, parent) {
    return this._run("tool", `tool:${meta.name}`, {
      input: meta.input,
      metadata: meta.metadata
    }, fn, void 0, parent);
  }
  async runSubagent(meta, fn) {
    return this._run("agent", meta.name || "subagent", {
      input: meta.input,
      metadata: meta.metadata
    }, fn);
  }
  async flush() {
    if (!this._sdk) return;
    try {
      await this._sdk.processor.forceFlush();
    } catch {
    }
  }
  async shutdown() {
    if (!this._sdk) return;
    try {
      await this._sdk.processor.forceFlush();
    } catch {
    }
    try {
      await this._sdk.processor.shutdown();
    } catch {
    }
    this._sdk = void 0;
  }
};
function clip(v) {
  return v.length > MAX_ID_LEN ? v.slice(0, MAX_ID_LEN) : v;
}
function currentUserName() {
  const fromEnv = process.env.USER || process.env.LOGNAME || process.env.USERNAME;
  if (fromEnv) return fromEnv;
  try {
    return os3.userInfo().username || void 0;
  } catch {
    return void 0;
  }
}
function stringifyMeta(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta || {})) {
    if (v === void 0 || v === null) continue;
    const s = typeof v === "string" ? v : JSON.stringify(v);
    if (s === void 0) continue;
    out[k] = s.length > MAX_META_VALUE_LEN ? `${s.slice(0, MAX_META_VALUE_LEN - 1)}\u2026` : s;
  }
  return out;
}
function createTracing(settings) {
  return settings.enabled && settings.config ? new LangfuseTracing(settings.config) : new NoopTracing(settings.reason);
}
function initTracingFromConfig(cliOverride, release) {
  return createTracing(loadTracingConfig(cliOverride, release));
}

// src/vs/workbench/contrib/agent/common/agentBtw.ts
var CANCEL_COMMANDS = /* @__PURE__ */ new Set([
  "cancel",
  "abort",
  "stop",
  "halt",
  "kill",
  "\u53D6\u6D88",
  "\u505C\u6B62",
  "\u505C\u4E0B",
  "\u4E2D\u65AD",
  "\u7EC8\u6B62"
]);
var ADDITIVE_PREFIXES = [
  /^注意/,
  /^记得/,
  /^记住/,
  /^提醒/,
  /^补充(一下)?(：|:)?/,
  /^另外/,
  /^顺便/,
  /^还有/,
  /^(note|remember|also|fyi|tip|additionally|btw)[\s,:]/i
];
var BTW_SUPERSEDE_PATTERNS = [
  // Replace the goal.
  /(改为|改成|换成|换个|换一个|改做)/,
  // Restart / redo work (specific verbs only — a bare "重新" is ambiguous and
  // goes to the evaluator).
  /(重来|重跑|重做|重试|重新(执行|跑|做|开始|生成|发布|安装|部署|升级|构建|编译|打包|提交|推送|测试|下载|上传|计算|实现|写|改))/,
  // Discard what is already running.
  /(算了|放弃|撤回|作废|不要做了|不用做了|别做了)/,
  // Anchored to the newest state/version — a rerun is required.
  /(基于最新|最新版本|按照最新|以最新|用最新|根据最新)/,
  // Re-sequencing that invalidates the in-flight step.
  /(先(把|去|做|升级|安装|部署|发布|编译|构建|打包|改|重新))/,
  // English equivalents.
  /\b(instead|start over|scrap (that|it)|discard (that|it)|forget (about )?(the |that |previous )|ignore (the )?(previous|above)|never ?mind|change of plans?|new plan|on second thought|redo|re-?run)\b/i
];
function classifyBtwIntent(hint) {
  const trimmed = (hint || "").trim();
  if (!trimmed) return "unknown";
  if (CANCEL_COMMANDS.has(trimmed.toLowerCase())) return "cancel";
  if (BTW_SUPERSEDE_PATTERNS.some((re) => re.test(trimmed))) return "supersede";
  if (ADDITIVE_PREFIXES.some((re) => re.test(trimmed))) return "hint";
  return "unknown";
}
var CONFLICT_PROMPT = `You supervise a coding agent. It is currently working on the task below.

--- RUNNING TASK ---
{{TASK}}

The user has just sent this instruction mid-task (via the /btw command):
--- USER INSTRUCTION ---
{{HINT}}

Decide whether the instruction makes the running work OBSOLETE \u2014 the agent must
stop the current task/plan and change course (SUPERSEDE) \u2014 or whether it is an
additional hint that can be applied while the current task continues (CONTINUE).

Choose SUPERSEDE when the instruction:
- cancels, replaces, or contradicts the current goal
- asks to redo / rerun / rebuild something against the latest state or version
- changes the target files or parameters so work in progress would be wasted
- says the agent is on the wrong path

Choose CONTINUE when the instruction only adds detail, a constraint, a reminder,
or a small additive tweak that does not invalidate work already in progress.

Answer with strict JSON only, no markdown:
{"supersede": true|false, "reason": "<short reason>"}`;
function buildBtwConflictPrompt(hint, runningTask) {
  return [
    createMessage("user" /* User */, CONFLICT_PROMPT.replace("{{TASK}}", runningTask || "(unknown task)").replace("{{HINT}}", hint))
  ];
}
function parseBtwConflictVerdict(text) {
  const raw = (text || "").trim();
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const value = typeof parsed.supersede === "boolean" ? parsed.supersede : typeof parsed.verdict === "string" ? /supersede/i.test(parsed.verdict) : void 0;
      if (value !== void 0) {
        return {
          supersede: value,
          reason: typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : ""
        };
      }
    } catch {
    }
  }
  if (/\bsupersede\b/i.test(raw) && !/\bcontinue\b/i.test(raw)) {
    return { supersede: true, reason: "evaluator answered SUPERSEDE" };
  }
  return { supersede: false, reason: "" };
}
function renderBtwInjection(hint) {
  if (!hint.supersede) {
    return `[User intervention via /btw]: ${hint.text}
(This is a hint from the user to adjust your reasoning. Follow it in subsequent steps.)`;
  }
  const why = hint.reason ? ` (reason: ${hint.reason})` : "";
  return `[User intervention via /btw \u2014 THIS INSTRUCTION SUPERSEDES THE CURRENT TASK]${why}
${hint.text}
The previous task and its plan are CANCELLED. Do NOT continue the old plan and do not finish work that this instruction makes irrelevant (abandon any long-running command or waiting step that belonged to it). Treat the instruction above as the new task and start from the latest state.`;
}

// src/vs/workbench/contrib/agent/common/agent.ts
var MAX_CONSECUTIVE_TOOL_ONLY_STEPS = 100;
var MAX_VERIFICATION_ROUNDS = 2;
var FALLBACK_PROBE_INITIAL_DELAY_MS = 3e4;
var FALLBACK_PROBE_MAX_DELAY_MS = 12e4;
var FALLBACK_PROBE_TIMEOUT_MS = 1e4;
var FALLBACK_RECOVERY_SUCCESS_THRESHOLD = 2;
var FALLBACK_RECOVERY_DETAIL = `primary model answered ${FALLBACK_RECOVERY_SUCCESS_THRESHOLD} consecutive health probes`;
var MAX_REASONING_CHARS_LOGGED = 4e3;
var REASONING_EXCERPT_CHARS = 2e3;
var MAX_REASONING_CORRECTION_ROUNDS = 2;
var REASONING_LOOP_MIN_REPEATS = 20;
var REASONING_LOOP_MIN_SHARE = 0.2;
var REASONING_LOOP_MIN_CHARS = 4e3;
function countRepeatedReasoningLines(reasoning) {
  const counts = /* @__PURE__ */ new Map();
  for (const line of reasoning.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
  }
  let max = 0;
  for (const c of counts.values()) if (c > max) max = c;
  return max;
}
function isDegenerateReasoning(reasoning) {
  if (reasoning.length < REASONING_LOOP_MIN_CHARS) return false;
  const lines = reasoning.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length < REASONING_LOOP_MIN_REPEATS * 2) return false;
  const repeats = countRepeatedReasoningLines(reasoning);
  return repeats >= REASONING_LOOP_MIN_REPEATS && repeats / lines.length >= REASONING_LOOP_MIN_SHARE;
}
var COMPLEX_TASK_KEYWORDS = [
  "refactor",
  "\u91CD\u6784",
  "migrate",
  "\u8FC1\u79FB",
  "implement",
  "\u5B9E\u73B0",
  "redesign",
  "\u91CD\u65B0\u8BBE\u8BA1",
  "complex",
  "\u590D\u6742",
  "multiple files",
  "architecture",
  "\u67B6\u6784",
  "performance",
  "\u6027\u80FD",
  "debugging",
  "\u8C03\u8BD5",
  "optimize",
  "\u4F18\u5316",
  "redesign",
  "overhaul",
  "rewrite",
  "\u91CD\u5199"
];
function isApiTimeoutError(err) {
  if (!err) return false;
  const e = err;
  if (e.name === "AbortError") return true;
  const parts = [];
  if (e.message) parts.push(e.message);
  if (e.code) parts.push(String(e.code));
  const cause = e.cause;
  if (cause) {
    if (cause.message) parts.push(cause.message);
    if (cause.code) parts.push(String(cause.code));
  }
  const hay = parts.join(" ").toLowerCase();
  return /timed?\s*out|timeout|etimedout|esockettimedout|econnaborted|und_err_connect_timeout|und_err_headers_timeout|und_err_body_timeout/.test(hay);
}
function isApiRateLimitError(err) {
  if (!err) return false;
  const e = err;
  const parts = [];
  if (e.message) parts.push(e.message);
  if (e.code) parts.push(String(e.code));
  if (e.cause) {
    if (e.cause.message) parts.push(e.cause.message);
    if (e.cause.code) parts.push(String(e.cause.code));
  }
  const hay = parts.join(" ").toLowerCase();
  if (/token usage exceeds|tokens per minute|requests per minute|\btpm\b|\brpm\b|rate[\s_-]?limit|too many requests/.test(hay)) {
    return true;
  }
  const status = e.status ?? e.statusCode ?? e.cause?.status ?? e.cause?.statusCode;
  if (status === 429) return true;
  return /\b429\b/.test(hay);
}
function classifyApiFallback(err) {
  if (isApiTimeoutError(err)) return "timeout";
  if (isApiRateLimitError(err)) return "rate-limit";
  return void 0;
}
function formatModelSwitch(e) {
  const detail = e.detail ? ` (${e.detail})` : "";
  switch (e.reason) {
    case "fallback-timeout":
      return `[MODEL] \u26A0 ${e.from} unreachable \u2192 switched to \u4FDD\u5E95\u6A21\u578B ${e.to}, retrying the same request${detail}`;
    case "fallback-rate-limit":
      return `[MODEL] \u26A0 ${e.from} rate-limited \u2192 switched to \u4FDD\u5E95\u6A21\u578B ${e.to}, retrying the same request${detail}`;
    case "primary-recovered":
      return `[MODEL] \u2713 ${e.to} reachable again \u2192 switched back from \u4FDD\u5E95\u6A21\u578B ${e.from}${detail}`;
    case "profile":
      return `[MODEL] \u21AA profile switch ${e.from} \u2192 ${e.to}${detail}`;
    default:
      return `[MODEL] \u21AA routed ${e.from} \u2192 ${e.to}${detail}`;
  }
}
function formatReasoningForLog(reasoning) {
  if (reasoning.length <= MAX_REASONING_CHARS_LOGGED) return reasoning;
  const half = Math.floor(REASONING_EXCERPT_CHARS / 2);
  const head = reasoning.slice(0, REASONING_EXCERPT_CHARS - half);
  const tail2 = reasoning.slice(-half);
  const elided = reasoning.length - head.length - tail2.length;
  return `${head}
... [${elided} chars of reasoning elided] ...
${tail2}`;
}
var AgentLoop = class _AgentLoop {
  constructor(_config, _llmProvider, _toolRegistry, _modeManager, _checkpointManager, _workingDirectory = process.cwd(), memory, tracing2) {
    this._config = _config;
    this._llmProvider = _llmProvider;
    this._toolRegistry = _toolRegistry;
    this._modeManager = _modeManager;
    this._checkpointManager = _checkpointManager;
    this._workingDirectory = _workingDirectory;
    this._context = new AgentContext(_config.maxContextTokens, _config.maxOutputTokens, _llmProvider);
    this._planner = new AgentPlanner(_llmProvider);
    this._memory = memory?.enabled ? memory : void 0;
    this._tracing = tracing2 ?? NOOP_TRACING;
  }
  _isRunning = false;
  _cancellation;
  _contextHistoryForContinue = [];
  _onDidReceiveMessage = new Emitter();
  onDidReceiveMessage = this._onDidReceiveMessage.event;
  _onDidStreamToken = new Emitter();
  onDidStreamToken = this._onDidStreamToken.event;
  _onDidComplete = new Emitter();
  onDidComplete = this._onDidComplete.event;
  _onDidError = new Emitter();
  onDidError = this._onDidError.event;
  /**
   * Fired after a file-mutating tool produced a displayable diff.
   *
   * Separate from `onDidReceiveMessage` on purpose: the message stream carries
   * what the MODEL sees, and a colored diff must never enter the context. The
   * CLI host subscribes here to print the diff card for the human.
   */
  _onDidReceiveToolDiff = new Emitter();
  onDidReceiveToolDiff = this._onDidReceiveToolDiff.event;
  /**
   * Fired after `todo_write` replaced the checklist, so the host can render it.
   *
   * Separate from `onDidReceiveMessage` for the same reason as the diff event: the
   * checklist is display/planning state, and putting it in the message history
   * would make the model re-read its own plan as conversation on every request.
   */
  _onDidUpdateTodos = new Emitter();
  onDidUpdateTodos = this._onDidUpdateTodos.event;
  /**
   * The model's task checklist, owned by the agent so a `todo_write` call from any
   * step lands in the same list and clearing it on a new task is automatic.
   */
  _todoList = new TodoList();
  /** Register `todo_write` and give the loop the list it should report. */
  registerTodoTool(registry = this._toolRegistry) {
    registry.register(new TodoWriteTool(this._todoList));
  }
  _context;
  _planner;
  _useStreaming = false;
  _extraSystemPrompt = "";
  /** Shared-memory (tdai_agent_mem) recall block, rebuilt on every run(). */
  _memoryContext = "";
  _memory;
  /**
   * Langfuse observability. Defaults to a shared no-op, so every existing
   * construction site (and every test) keeps working without tracing.
   */
  _tracing;
  /** Pending /btw hints injected during agent execution — consumed each loop iteration. */
  _pendingBtwHints = [];
  /**
   * Set when an in-flight /btw instruction supersedes the running task. The
   * loop reads it twice: to abandon the remaining tool calls of the step that
   * was already planned, and — once the hint is drained — to reset itself.
   */
  _supersedeRequested = false;
  /**
   * Optional LLM-backed evaluator deciding whether an ambiguous /btw
   * instruction supersedes the running task.
   *
   * `undefined` → use the built-in LLM evaluator; `null` → keyword-only.
   */
  _btwEvaluatorOverride = void 0;
  /** Upper bound on one conflict-evaluation call, so `/btw` never hangs the REPL. */
  _btwEvaluationTimeoutMs = 2e4;
  /** AbortController for the currently executing tool, if any. Allows /btw cancel. */
  _currentToolController;
  // ---- Model fallback (保底模型) ----
  // When the active scenario/default model times out, the agent swaps to this
  // model and retries the same request. Configured via config.yaml
  // `model_routing.fallback`.
  _fallbackConfig;
  _fallbackProvider;
  _usingFallback = false;
  /** Why the current fallback happened — decides what counts as "recovered". */
  _fallbackKind;
  // ---- Model switch reporting + fallback supervision ----
  // The model that was active before the fallback swap; the probe returns to it.
  _primaryConfig;
  _primaryProvider;
  _probeTimer;
  _probeDelayMs = FALLBACK_PROBE_INITIAL_DELAY_MS;
  _probeInitialDelayMs = FALLBACK_PROBE_INITIAL_DELAY_MS;
  _probeMaxDelayMs = FALLBACK_PROBE_MAX_DELAY_MS;
  /** Set true while an LLM request is in flight on the current provider. */
  _llmRequestInFlight = false;
  /** A background probe found the primary model healthy while a request was in flight. */
  _primaryRecovered = false;
  /**
   * Consecutive healthy probes seen while on the 保底 model. A single success is
   * not enough to switch back (the primary can flap: answer once, then fail
   * again), so the agent waits for FALLBACK_RECOVERY_SUCCESS_THRESHOLD in a row.
   */
  _primaryHealthyProbes = 0;
  /** Set by a model switch whose history no longer fits the new model's window. */
  _pendingForceCompact = false;
  _onDidSwitchModel = new Emitter();
  /** Fired on every runtime model switch (routing / fallback / recovery). */
  onDidSwitchModel = this._onDidSwitchModel.event;
  /**
   * Renders a model-switch message. Overridable so the CLI can colorize it;
   * defaults to a plain single line so a switch is never invisible in any host.
   */
  _modelSwitchLogger = (e) => console.log(formatModelSwitch(e));
  // ---- Per-task execution tracing ----
  _stepRecords = [];
  _modelSwitches = [];
  /**
   * Problems observed during this task, recorded so the self-evolution evidence
   * scan can tie a defect to the runs that actually hit it. Kept separate from
   * `modelSwitches` because these are failure modes, not routing decisions.
   */
  _issueSignals = [];
  /** Record one issue signal, de-duplicated per (kind, step, detail). */
  _noteSignal(kind, detail, stepIndex) {
    const last = this._issueSignals[this._issueSignals.length - 1];
    if (last && last.kind === kind && last.stepIndex === stepIndex && last.detail === detail) {
      return;
    }
    this._issueSignals.push({ kind, detail: detail ? detail.slice(0, 200) : void 0, stepIndex });
  }
  _taskStartTime = 0;
  _taskDescription = "";
  _taskError;
  /**
   * Switch the agent onto another model (scenario routing, /profile, or an
   * explicit host action) and report it as a user-visible model switch.
   */
  swapProvider(config, provider, reason = "routing") {
    const fromModel = this._config.model;
    this._applyModelSwitch(config, provider);
    this._usingFallback = false;
    this._primaryRecovered = false;
    this._primaryHealthyProbes = 0;
    this._fallbackKind = void 0;
    this._stopRecoveryProbe();
    if (config.model !== fromModel) {
      this._reportModelSwitch({
        from: fromModel,
        to: config.model,
        reason,
        toFallback: false
      });
    }
  }
  /**
   * Install the switch renderer used by hosts that want a colorized line.
   * The agent always fires `onDidSwitchModel`; this only controls the direct
   * console output, which keeps a switch visible even without a listener.
   */
  setModelSwitchLogger(logger) {
    this._modelSwitchLogger = logger;
  }
  /**
   * Move the agent onto another model, keeping the conversation usable.
   *
   * Everything the agent needs to answer correctly lives in the context, so a
   * switch must carry the model's budgets over AND drop chain-of-thought that
   * belongs to the previous model — otherwise the sliding window keeps more
   * history than the new model accepts (silent force-compaction) and the new
   * model is fed another model's thinking (incoherent continuation, repetition
   * loops). This is the fix for "模型一切换，上下文就不对了".
   */
  _applyModelSwitch(config, provider) {
    const modelChanged = config.model !== this._config.model;
    this._config = config;
    this._llmProvider = provider;
    this._context.swapTokenCounter(provider);
    if (modelChanged) {
      this._context.setModelBudget(config.maxContextTokens, config.maxOutputTokens);
      const newModelThinks = provider.supportsReasoning?.() ?? false;
      const dropped = newModelThinks ? 0 : this._context.dropReasoningContent();
      if (this._context.isOverBudget) {
        this._pendingForceCompact = true;
        console.warn(
          `[MODEL] history (~${this._context.estimatedTokens} tokens) exceeds ${config.model}'s input budget (${this._context.inputBudget} tokens) \u2014 compacting conversation`
        );
      }
      if (dropped > 0) {
        console.warn(`[MODEL] dropped reasoning_content from ${dropped} message(s) belonging to the previous model`);
      }
    }
    this._planner.swapProvider(provider);
  }
  /** Fire the switch event and render it (host logger or plain console). */
  _reportModelSwitch(event) {
    this._modelSwitches.push({ ...event, at: Date.now() });
    this._onDidSwitchModel.fire(event);
    try {
      this._modelSwitchLogger(event);
    } catch {
    }
  }
  /**
   * Register the 保底 (guaranteed fallback) model. When the active model's API
   * call times out, the agent automatically switches to this model and retries
   * the same request instead of failing the task.
   */
  setFallback(config, provider) {
    this._fallbackConfig = config;
    this._fallbackProvider = provider;
  }
  /** Whether a 保底 (fallback) model is registered. */
  get hasFallback() {
    return !!this._fallbackConfig && !!this._fallbackProvider;
  }
  /**
   * Switch to the 保底 model after the primary/scenario model became
   * unreachable, retry the same request, and start supervising the primary
   * model so the agent returns to it as soon as it answers again.
   */
  _enterFallback(err, fromConfig, fromProvider, kind) {
    const to = this._fallbackConfig;
    this._primaryConfig = fromConfig;
    this._primaryProvider = fromProvider;
    this._applyModelSwitch(to, this._fallbackProvider);
    this._usingFallback = true;
    this._primaryHealthyProbes = 0;
    this._primaryRecovered = false;
    this._fallbackKind = kind;
    this._noteSignal("model-fallback", `${fromConfig.model} \u2192 ${to.model} (${kind}): ${err.message}`);
    this._reportModelSwitch({
      from: fromConfig.model,
      to: to.model,
      reason: kind === "rate-limit" ? "fallback-rate-limit" : "fallback-timeout",
      toFallback: true,
      detail: `${kind === "rate-limit" ? "rate limit" : "timeout"}: ${err.message}`
    });
    this._startRecoveryProbe();
  }
  /**
   * Background supervision of the primary model while running on the 保底
   * model: probe it with a cheap health check (backing off 30s → 120s) and
   * switch back the moment it responds. The timer is unref'd so a pending probe
   * never keeps the CLI process alive.
   */
  _startRecoveryProbe() {
    if (this._probeTimer) return;
    if (!this._primaryProvider || !this._primaryProvider.healthCheck) return;
    this._probeDelayMs = this._probeInitialDelayMs;
    this._scheduleProbe();
  }
  /**
   * Override the recovery-probe schedule (default 30s, backing off to 120s).
   * Exposed so a host can probe more or less aggressively, and so the
   * switch-back path is testable without waiting a minute.
   */
  setProbeSchedule(initialDelayMs, maxDelayMs = initialDelayMs) {
    this._probeInitialDelayMs = Math.max(50, initialDelayMs);
    this._probeMaxDelayMs = Math.max(this._probeInitialDelayMs, maxDelayMs);
  }
  _scheduleProbe() {
    if (!this._primaryProvider || !this._usingFallback) return;
    this._probeTimer = setTimeout(() => {
      this._probeTimer = void 0;
      void this._runProbe();
    }, this._probeDelayMs);
    this._probeTimer.unref?.();
  }
  async _runProbe() {
    const provider = this._primaryProvider;
    const config = this._primaryConfig;
    if (!this._usingFallback || !provider || !config) return;
    let reachable = false;
    try {
      reachable = await provider.healthCheck(FALLBACK_PROBE_TIMEOUT_MS, {
        throttleSensitive: this._fallbackKind === "rate-limit"
      }) === true;
    } catch {
      reachable = false;
    }
    if (!this._usingFallback || this._primaryProvider !== provider) return;
    if (reachable) {
      this._primaryHealthyProbes++;
      if (this._primaryHealthyProbes >= FALLBACK_RECOVERY_SUCCESS_THRESHOLD) {
        this._clearProbeTimer();
        if (this._llmRequestInFlight) {
          this._primaryRecovered = true;
          console.warn("[MODEL] primary model reachable again \u2014 switching back at the next step");
        } else {
          this._switchBackToPrimary(FALLBACK_RECOVERY_DETAIL);
        }
        return;
      }
      console.log(
        `[MODEL] ${config.model} answered a probe (${this._primaryHealthyProbes}/${FALLBACK_RECOVERY_SUCCESS_THRESHOLD}) \u2014 confirming recovery before switching back`
      );
      this._probeDelayMs = this._probeInitialDelayMs;
      this._scheduleProbe();
      return;
    }
    this._primaryHealthyProbes = 0;
    this._probeDelayMs = Math.min(this._probeDelayMs * 2, this._probeMaxDelayMs);
    this._scheduleProbe();
  }
  /** Return to the primary/scenario model after it recovered. */
  _switchBackToPrimary(detail) {
    const config = this._primaryConfig;
    const provider = this._primaryProvider;
    if (!config || !provider) return;
    const fromModel = this._config.model;
    this._applyModelSwitch(config, provider);
    this._usingFallback = false;
    this._fallbackKind = void 0;
    this._primaryHealthyProbes = 0;
    this._primaryRecovered = false;
    this._stopRecoveryProbe();
    this._reportModelSwitch({
      from: fromModel,
      to: config.model,
      reason: "primary-recovered",
      toFallback: false,
      detail
    });
  }
  _stopRecoveryProbe() {
    this._clearProbeTimer();
    this._primaryConfig = void 0;
    this._primaryProvider = void 0;
  }
  _clearProbeTimer() {
    if (this._probeTimer) {
      clearTimeout(this._probeTimer);
      this._probeTimer = void 0;
    }
  }
  /** The model id currently used by the agent (changes after a fallback swap). */
  get activeModel() {
    return this._config.model;
  }
  /** Whether the agent is currently running on the fallback (保底) model. */
  get usingFallback() {
    return this._usingFallback;
  }
  setStreaming(enabled) {
    this._useStreaming = enabled;
  }
  setExtraSystemPrompt(prompt) {
    this._extraSystemPrompt = prompt;
  }
  /**
   * Append an additional instruction/hint to the extra system prompt.
   * Used by in-flight /btw hints so they persist into subsequent run() calls.
   * Multiple hints accumulate; each hint is separated clearly.
   */
  appendExtraSystemPrompt(hint) {
    const separator = "\n\n---\n## User Intervention (via /btw)\n";
    if (this._extraSystemPrompt) {
      this._extraSystemPrompt += separator + hint.trim();
    } else {
      this._extraSystemPrompt = "\n## User Intervention (via /btw)\n" + hint.trim();
    }
  }
  /**
   * Override the evaluator used to decide whether an ambiguous in-flight /btw
   * instruction supersedes the running task.
   *
   * Pass a function to replace the built-in LLM evaluator (used by tests for
   * determinism), or `null` to disable evaluation entirely (keyword-only).
   */
  setBtwConflictEvaluator(evaluator, timeoutMs) {
    this._btwEvaluatorOverride = evaluator;
    if (timeoutMs && timeoutMs > 0) {
      this._btwEvaluationTimeoutMs = timeoutMs;
    }
  }
  /** The evaluator to use for ambiguous instructions, if any. */
  _resolveBtwEvaluator() {
    if (this._btwEvaluatorOverride === null) return void 0;
    if (this._btwEvaluatorOverride) return this._btwEvaluatorOverride;
    return (hint, runningTask) => this._llmBtwConflictEvaluator(hint, runningTask);
  }
  /**
   * Built-in evaluator: one short LLM call that judges whether the instruction
   * replaces the running task. Uses the agent's *active* provider (so a
   * /profile switch or 保底 fallback is respected) and never passes tools.
   */
  async _llmBtwConflictEvaluator(hint, runningTask) {
    const reply = await this._llmProvider.complete(buildBtwConflictPrompt(hint, runningTask), void 0, 0);
    return parseBtwConflictVerdict(reply?.content || "");
  }
  /**
   * Inject a /btw instruction while the agent is actively running.
   *
   * The instruction is first classified:
   *   - additive hint   → queued and delivered as a User message at the start of
   *                       the next ReAct loop iteration (the plan keeps running).
   *   - supersede       → the in-flight tool call is aborted immediately, the
   *                       remaining tool calls of the current step are skipped,
   *                       the plan is dropped, and the instruction becomes the
   *                       new task.
   *
   * Ambiguous instructions are handed to the configured evaluator (an LLM call
   * by default in the CLI host); if it cannot answer in time, the instruction
   * is treated as an additive hint — never as a destructive supersede.
   *
   * Special commands:
   *   "/btw cancel" or "/btw abort" — cancels the currently running tool immediately.
   */
  async injectBtwHint(hint) {
    const trimmed = (hint || "").trim();
    if (!trimmed) return { kind: "ignored" };
    const intent = classifyBtwIntent(trimmed);
    if (intent === "cancel") {
      if (this._currentToolController) {
        this._currentToolController.abort();
        console.log("[BTW] Cancelling current tool execution...");
        return { kind: "cancelled", toolCancelled: true };
      }
      return this._supersede(trimmed, "user requested cancellation (/btw cancel)");
    }
    if (intent === "supersede") {
      return this._supersede(trimmed, "instruction replaces the running task");
    }
    if (intent === "hint") {
      return this._queueHint(trimmed, false);
    }
    const evaluator = this._resolveBtwEvaluator();
    if (evaluator && this._isRunning) {
      let verdict;
      try {
        verdict = await this._withBtwTimeout(
          evaluator(trimmed, this._runningTaskContext()),
          this._btwEvaluationTimeoutMs
        );
      } catch (err) {
        console.warn(`[BTW] conflict evaluation failed (non-fatal): ${err.message}`);
        verdict = void 0;
      }
      if (verdict?.supersede) {
        return this._supersede(trimmed, verdict.reason || "evaluator: the running task is obsolete");
      }
    }
    return this._queueHint(trimmed, false);
  }
  /** Queue an additive hint (persisted into extraSystemPrompt, as before). */
  _queueHint(text, supersede) {
    this._pendingBtwHints.push({ text, supersede });
    this.appendExtraSystemPrompt(text);
    return { kind: supersede ? "superseded" : "hint" };
  }
  /**
   * Abort whatever is in flight and mark the running task as superseded.
   *
   * The abort usually arrives while a long tool call (build, poll, CI wait) is
   * running: without it the user's redirect would only be read after that call
   * finally returns — which is exactly the wasted work this exists to prevent.
   */
  _supersede(text, reason) {
    const toolCancelled = this.cancelCurrentTool();
    this._supersedeRequested = true;
    this._pendingBtwHints.push({ text, supersede: true, reason });
    this.appendExtraSystemPrompt(text);
    console.log(`[BTW] Task superseded (${reason})${toolCancelled ? " \u2014 in-flight tool aborted" : ""}`);
    return { kind: "superseded", toolCancelled, reason };
  }
  /**
   * A compact description of what the agent is doing right now, used as input
   * to the conflict evaluator. Deliberately short: it only needs enough context
   * to tell "same goal, extra detail" from "different goal, abort".
   */
  _runningTaskContext() {
    const parts = [];
    parts.push(`Task: ${this._taskDescription || "(unknown)"}`);
    const plan = this._planner.currentPlan;
    if (plan && plan.steps.length > 0) {
      const shown = plan.steps.slice(0, 12).map((s, i) => `${i + 1}. ${s.description}`).join("\n");
      parts.push(`Plan (step ${plan.currentStep}/${plan.steps.length}):
${shown}`);
    }
    const lastAssistant = [...this._context.messages].reverse().find((m) => m.role === "assistant" /* Assistant */ && m.content && m.content.trim());
    if (lastAssistant) {
      parts.push(`Latest progress: ${lastAssistant.content.slice(0, 400)}`);
    }
    const lastTool = [...this._stepRecords].reverse().find((s) => s.toolExecutions.length > 0);
    if (lastTool) {
      const names = lastTool.toolExecutions.map((t) => t.toolName).join(", ");
      parts.push(`Last tool calls: ${names}`);
    }
    return parts.join("\n\n").slice(0, 3e3);
  }
  /** Race a promise against a timeout (used to bound the evaluator call). */
  async _withBtwTimeout(promise, ms) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`btw conflict evaluation timed out after ${ms}ms`)), ms);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  /**
   * Drop any /btw state left over from a previous run.
   *
   * Called when a new task starts: a hint queued while the agent was idle (or a
   * `/btw cancel` with nothing to cancel) must never be replayed against the
   * next task and silently supersede it.
   */
  _resetPendingBtwState() {
    this._pendingBtwHints = [];
    this._supersedeRequested = false;
  }
  /**
   * Cancel the currently executing tool (if any).
   * Returns true if a tool was cancelled, false if no tool was running.
   */
  cancelCurrentTool() {
    if (this._currentToolController) {
      this._currentToolController.abort();
      this._currentToolController = void 0;
      return true;
    }
    return false;
  }
  get isRunning() {
    return this._isRunning;
  }
  get context() {
    return this._context;
  }
  get planner() {
    return this._planner;
  }
  get workingDirectory() {
    return this._workingDirectory;
  }
  get systemPromptContent() {
    return this._context.systemPromptContent;
  }
  get extraSystemPrompt() {
    return this._extraSystemPrompt;
  }
  /**
   * Export the current agent state for session persistence.
   */
  exportSessionState() {
    this._context.repairToolCallPairs();
    return {
      messages: [...this._context.messages],
      systemPrompt: this._context.systemPromptContent,
      extraSystemPrompt: this._extraSystemPrompt
    };
  }
  /**
   * Close the tool-call pairing invariant after a run ends.
   *
   * A run can stop anywhere: cancelled at an iteration boundary, aborted
   * inside a tool, or thrown out of the loop — in every case the assistant's
   * `tool_calls` are already in the context while their results are not. The
   * synthesized "[not executed] …" answers keep both the next request and the
   * next resume valid.
   */
  _answerDanglingToolCalls() {
    const inserted = this._context.repairToolCallPairs();
    for (const msg of inserted) {
      this._onDidReceiveMessage.fire(msg);
    }
  }
  /**
   * Restore agent state from a previously saved session.
   * This fully resets the current context and replays the saved messages.
   */
  restoreFromSession(messages, systemPrompt, extraSystemPrompt) {
    this._context.clear();
    this._extraSystemPrompt = extraSystemPrompt || "";
    const fullSystemPrompt = systemPrompt || getSystemPrompt(this._modeManager.currentMode, this._workingDirectory);
    this._context.setSystemPrompt(fullSystemPrompt + this._extraSystemPrompt);
    for (const msg of messages) {
      this._context.addMessage(msg);
    }
    this._context.repairToolCallPairs();
    const firstUser = messages.find((m) => m.role === "user" /* User */ && m.content && m.content.trim());
    if (firstUser) {
      this._context.setTaskAnchor(firstUser.content);
    }
    this._contextHistoryForContinue = [...this._context.messages];
  }
  /**
   * Export a complete task execution log for troubleshooting.
   * Includes per-step LLM interactions, tool calls, timing, and errors.
   */
  exportTaskLog(status, error) {
    const finishedAt = Date.now();
    const totalToolCalls = this._stepRecords.reduce(
      (sum, step) => sum + step.toolExecutions.length,
      0
    );
    const usedSteps = this._stepRecords.filter((s) => s.llmUsage);
    const tokenUsage = usedSteps.length > 0 ? {
      promptTokens: usedSteps.reduce((sum, s) => sum + (s.llmUsage.promptTokens || 0), 0),
      completionTokens: usedSteps.reduce((sum, s) => sum + (s.llmUsage.completionTokens || 0), 0),
      totalTokens: usedSteps.reduce((sum, s) => sum + (s.llmUsage.totalTokens || 0), 0),
      cachedTokens: usedSteps.reduce((sum, s) => sum + (s.llmUsage.cachedTokens || 0), 0),
      cacheCreationTokens: usedSteps.reduce((sum, s) => sum + (s.llmUsage.cacheCreationTokens || 0), 0)
    } : void 0;
    return {
      id: `task_${this._taskStartTime}_${Math.random().toString(36).substring(2, 8)}`,
      task: this._taskDescription,
      mode: this._modeManager.currentMode,
      workingDirectory: this._workingDirectory,
      config: {
        provider: this._config.provider,
        model: this._config.model
      },
      systemPrompt: this._context.systemPromptContent,
      extraSystemPrompt: this._extraSystemPrompt || void 0,
      modelSwitches: this._modelSwitches.length > 0 ? [...this._modelSwitches] : void 0,
      issueSignals: this._issueSignals.length > 0 ? [...this._issueSignals] : void 0,
      steps: [...this._stepRecords],
      totalSteps: this._stepRecords.length,
      totalToolCalls,
      tokenUsage,
      status,
      error,
      startedAt: this._taskStartTime,
      finishedAt,
      durationMs: finishedAt - this._taskStartTime
    };
  }
  /** The error from the last task execution, if any. */
  get lastTaskError() {
    return this._taskError;
  }
  async run(userMessage) {
    if (this._isRunning) {
      throw new Error("Agent is already running");
    }
    this._isRunning = true;
    this._cancellation = new CancellationTokenSource();
    this._stepRecords = [];
    this._modelSwitches = [];
    this._issueSignals = [];
    this._taskStartTime = Date.now();
    this._taskDescription = userMessage;
    this._taskError = void 0;
    this._llmRequestInFlight = false;
    this._resetPendingBtwState();
    if (!this._todoList.isEmpty) {
      this._todoList.clear();
      this._onDidUpdateTodos.fire(this._todoList.items);
    }
    try {
      await this._tracing.runTask(this._taskTraceMeta(userMessage), async (taskObs) => {
        await this._runTaskBody(userMessage);
        taskObs.update({
          output: this._finalAnswerForTrace(),
          level: this._taskError ? "ERROR" : "DEFAULT",
          statusMessage: this._taskError
        });
      });
    } finally {
      this._answerDanglingToolCalls();
      this._isRunning = false;
      this._cancellation?.dispose();
      this._cancellation = void 0;
    }
  }
  /** Trace-level metadata for a task: cheap dimensions, no payloads. */
  _taskTraceMeta(userMessage) {
    const mode = this._modeManager.currentMode;
    return {
      name: "agent-task",
      input: userMessage,
      tags: [mode, this._config.provider, this._config.model],
      metadata: {
        mode,
        model: this._config.model,
        provider: this._config.provider,
        working_directory: this._workingDirectory,
        streaming: this._useStreaming,
        pid: process.pid
      },
      userId: currentUserName()
    };
  }
  /** The final assistant reply, used as the trace output. */
  _finalAnswerForTrace() {
    const last = [...this._context.messages].reverse().find((m) => m.role === "assistant" /* Assistant */ && m.content && m.content.trim());
    return last?.content;
  }
  /**
   * Per-task work, wrapped by the trace root in `run()`.
   *
   * Keeps the original contract: errors are recorded in `_taskError` and fired
   * on `onDidError` instead of propagating to the caller.
   */
  async _runTaskBody(userMessage) {
    try {
      this._memoryContext = "";
      if (this._memory && this._memory.recall) {
        try {
          const recalled = await this._memory.recall(userMessage);
          if (recalled) {
            this._memoryContext = `

<shared-memory>
${recalled}
</shared-memory>`;
          }
        } catch (err) {
          console.warn(`[memory] recall failed (non-fatal): ${err.message}`);
        }
      }
      const mode = this._modeManager.currentMode;
      this._context.setSystemPrompt(
        getSystemPrompt(mode, this._workingDirectory) + this._extraSystemPrompt + this._memoryContext
      );
      const userMsg = createMessage("user" /* User */, userMessage);
      this._context.addMessage(userMsg);
      this._onDidReceiveMessage.fire(userMsg);
      this._context.setTaskAnchor(userMessage);
      const isComplex = mode === "agent" && this._isComplexTask(userMessage);
      if (isComplex) {
        const deepThinkMsg = createMessage(
          "user" /* User */,
          `[System note: Complex task detected \u2014 Deep Thinking Mode activated]
This appears to be a non-trivial task. Before making any changes:
1. Explore the relevant code thoroughly (3+ read_file/search_text calls)
2. Build a detailed mental model of the affected components
3. Consider edge cases, side effects, and interactions between files
4. Plan your changes step-by-step, verifying each independently
5. Do NOT conclude until you have run all relevant tests successfully`
        );
        this._context.addMessage(deepThinkMsg);
      }
      if (this._modeManager.shouldPlanFirst) {
        await this._runPlanMode(userMessage);
        await this._executePlanCore(this._cancellation.token);
      } else {
        await this._runAgentLoop(this._cancellation.token, !isComplex);
      }
      if (this._memory && this._memory.capture && !this._taskError) {
        const lastAssistant = [...this._context.messages].reverse().find((m) => m.role === "assistant" /* Assistant */ && m.content && m.content.trim());
        await this._memory.capture(userMessage, lastAssistant?.content || "");
      }
      this._onDidComplete.fire();
    } catch (err) {
      if (!(err instanceof Error && err.message === "Cancelled")) {
        this._taskError = err.message;
        this._onDidError.fire(err instanceof Error ? err : new Error(String(err)));
      } else {
        this._taskError = "Cancelled";
      }
    }
  }
  cancel() {
    this._cancellation?.cancel();
  }
  /**
   * Continue a previously paused agent session (e.g., after hitting step limit).
   * Restores the saved conversation context and resumes the agent loop.
   */
  async continueSession() {
    if (this._isRunning) {
      throw new Error("Agent is already running");
    }
    if (this._contextHistoryForContinue.length === 0) {
      throw new Error("No previous session to continue");
    }
    this._isRunning = true;
    this._cancellation = new CancellationTokenSource();
    this._stepRecords = [];
    this._modelSwitches = [];
    this._issueSignals = [];
    this._taskStartTime = Date.now();
    this._taskDescription = "(continue previous session)";
    this._taskError = void 0;
    this._resetPendingBtwState();
    try {
      const pinnedTask = this._context.taskAnchorContent;
      this._context.clear();
      if (pinnedTask) {
        this._context.setTaskAnchor(pinnedTask);
      }
      this._context.setSystemPrompt(
        getSystemPrompt(this._modeManager.currentMode, this._workingDirectory) + this._extraSystemPrompt
      );
      for (const msg of this._contextHistoryForContinue) {
        this._context.addMessage(msg);
      }
      const continueMsg = createMessage(
        "user" /* User */,
        "Please continue from where you left off. The previous response was cut off due to limits. Continue your work."
      );
      this._context.addMessage(continueMsg);
      this._onDidReceiveMessage.fire(continueMsg);
      await this._runAgentLoop(this._cancellation.token);
      this._onDidComplete.fire();
    } catch (err) {
      if (!(err instanceof Error && err.message === "Cancelled")) {
        this._onDidError.fire(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this._answerDanglingToolCalls();
      this._isRunning = false;
      this._cancellation?.dispose();
      this._cancellation = void 0;
    }
  }
  async executePlan(plan) {
    if (this._isRunning) {
      throw new Error("Agent is already running");
    }
    this._isRunning = true;
    this._cancellation = new CancellationTokenSource();
    this._stepRecords = [];
    this._modelSwitches = [];
    this._issueSignals = [];
    this._taskStartTime = Date.now();
    this._taskDescription = plan?.task || "(execute plan)";
    this._taskError = void 0;
    this._resetPendingBtwState();
    try {
      await this._executePlanCore(this._cancellation.token, plan);
      this._onDidComplete.fire();
    } catch (err) {
      if (!(err instanceof Error && err.message === "Cancelled")) {
        this._onDidError.fire(err instanceof Error ? err : new Error(String(err)));
      }
    } finally {
      this._answerDanglingToolCalls();
      this._isRunning = false;
      this._cancellation?.dispose();
      this._cancellation = void 0;
    }
  }
  /**
   * Core plan execution logic. Assumes _isRunning and _cancellation are already set up.
   * Used both by the public executePlan() method and by run() in Plan mode (auto-execution).
   */
  async _executePlanCore(token, plan) {
    const existingPlan = plan || this._planner.currentPlan;
    if (!existingPlan) {
      throw new Error("No plan to execute. Run Plan mode first.");
    }
    this._modeManager.switchMode("agent" /* Agent */);
    this._context.setSystemPrompt(getSystemPrompt("agent" /* Agent */, this._workingDirectory) + this._extraSystemPrompt);
    if (this._context.taskAnchorContent === void 0 && existingPlan.task) {
      this._context.setTaskAnchor(existingPlan.task);
    }
    const planSteps = existingPlan.steps.map((s, i) => `${i + 1}. ${s.description}`).join("\n");
    const userMsg = createMessage(
      "user" /* User */,
      `Execute this plan step by step:
${planSteps}`
    );
    this._context.addMessage(userMsg);
    this._onDidReceiveMessage.fire(userMsg);
    await this._runAgentLoop(token);
  }
  async _runPlanMode(task) {
    const plan = await this._planner.createPlan(task);
    const planSummary = plan.steps.map((s, i) => `${i + 1}. ${s.description}`).join("\n");
    const planMsg = createMessage(
      "assistant" /* Assistant */,
      `## Implementation Plan

${planSummary}

Executing plan automatically...`
    );
    this._context.addMessage(planMsg);
    this._onDidReceiveMessage.fire(planMsg);
  }
  async _runAgentLoop(token, skipSelfVerification = false) {
    let stepCount = 0;
    let consecutiveToolOnlySteps = 0;
    let verificationRounds = 0;
    let reasoningCorrectionRounds = 0;
    let hasExecutedTool = false;
    while (stepCount < this._config.maxSteps) {
      if (token.isCancellationRequested) {
        throw new Error("Cancelled");
      }
      const step = this._tracing.beginStep({
        name: `agent-step-${stepCount}`,
        metadata: { step_index: stepCount }
      });
      try {
        let drainedSupersede = false;
        while (this._pendingBtwHints.length > 0) {
          const hint = this._pendingBtwHints.shift();
          this._noteSignal(
            hint.supersede ? "task-superseded" : "user-intervention",
            hint.text,
            stepCount
          );
          const btwMsg = createMessage("user" /* User */, renderBtwInjection(hint));
          if (hint.supersede) {
            drainedSupersede = true;
            this._planner.reset();
            this._taskDescription = hint.text;
            this._context.setTaskAnchor(hint.text);
            verificationRounds = 0;
            consecutiveToolOnlySteps = 0;
          }
          this._context.addMessage(btwMsg);
          this._onDidReceiveMessage.fire(btwMsg);
        }
        if (drainedSupersede) {
          this._supersedeRequested = false;
        }
        if (this._usingFallback && this._primaryRecovered) {
          this._primaryRecovered = false;
          this._switchBackToPrimary(FALLBACK_RECOVERY_DETAIL);
        }
        if (consecutiveToolOnlySteps >= MAX_CONSECUTIVE_TOOL_ONLY_STEPS) {
          const warnMsg = createMessage(
            "assistant" /* Assistant */,
            `I've been calling tools without producing any analysis for ${consecutiveToolOnlySteps} consecutive steps. I may be stuck in a loop. Let me stop and summarize what I know so far. Please refine your request or check if I'm repeating myself.`
          );
          this._context.addMessage(warnMsg);
          this._onDidReceiveMessage.fire(warnMsg);
          this._noteSignal("step-limit", `${consecutiveToolOnlySteps} consecutive tool-only steps`, stepCount);
          break;
        }
        await this._context.compactIfNeeded(this._pendingForceCompact);
        this._pendingForceCompact = false;
        let messages = this._context.getContextWindow();
        let response;
        const stepStartTime = Date.now();
        let llmRequestMeta = { messageCount: 0, estimatedTokens: 0 };
        let overflowRetries = 0;
        const MAX_OVERFLOW_RETRIES = 3;
        this._llmRequestInFlight = true;
        for (; ; ) {
          messages = this._context.getContextWindow();
          const hasThinking = messages.some((m) => m.role === "assistant" /* Assistant */ && m.reasoningContent);
          const providerSupportsStreaming = this._llmProvider.supportsStreaming?.() ?? true;
          const isReasoningModel = this._llmProvider.supportsReasoning?.() ?? false;
          const tools = this._modeManager.isReadOnly ? this._toolRegistry.getReadOnlySchemas() : this._toolRegistry.listSchemas();
          llmRequestMeta = {
            messageCount: messages.length,
            estimatedTokens: messages.reduce((sum, m) => sum + this._llmProvider.countTokens(m.content) + (m.reasoningContent ? this._llmProvider.countTokens(m.reasoningContent) : 0), 0)
          };
          try {
            const canStream = this._useStreaming && (!tools || tools.length === 0) && !hasThinking && providerSupportsStreaming && !isReasoningModel;
            response = await this._tracing.runGeneration({
              name: canStream ? "llm-call-stream" : "llm-call",
              model: this._config.model,
              modelParameters: {
                temperature: this._config.temperature,
                ...this._config.topK && this._config.topK > 0 ? { top_k: this._config.topK } : {},
                stream: canStream ? 1 : 0
              },
              input: messages.map((m) => _AgentLoop._generationMessage(m)),
              startTime: new Date(stepStartTime),
              metadata: {
                attempt: overflowRetries + 1,
                message_count: messages.length,
                estimated_input_tokens: llmRequestMeta.estimatedTokens,
                tool_count: tools.length,
                using_fallback_model: this._usingFallback
              }
            }, async (gen) => {
              let out;
              if (canStream) {
                const chunks = [];
                const stream = this._llmProvider.stream(
                  messages,
                  void 0,
                  this._config.temperature,
                  this._config.topK
                );
                for await (const token2 of stream) {
                  chunks.push(token2);
                  this._onDidStreamToken.fire(token2);
                }
                out = createMessage("assistant" /* Assistant */, chunks.join(""));
              } else {
                out = await this._llmProvider.complete(
                  messages,
                  tools.length > 0 ? tools : void 0,
                  this._config.temperature,
                  this._config.topK
                );
              }
              gen.update({
                output: _AgentLoop._generationResult(out),
                usageDetails: _AgentLoop._usageDetails(out.usage),
                metadata: { finish_reason: out.toolCalls?.length ? "tool_calls" : "stop" }
              });
              return out;
            }, step.ref);
            break;
          } catch (err) {
            const fallbackKind = classifyApiFallback(err);
            if (fallbackKind && this._fallbackProvider && this._fallbackConfig && !this._usingFallback) {
              this._enterFallback(err, this._config, this._llmProvider, fallbackKind);
              if (this._pendingForceCompact) {
                this._pendingForceCompact = false;
                await this._context.compactIfNeeded(true);
              }
              continue;
            }
            if (err instanceof ContextOverflowError && overflowRetries < MAX_OVERFLOW_RETRIES) {
              overflowRetries++;
              this._noteSignal("context-overflow", `retry ${overflowRetries}/${MAX_OVERFLOW_RETRIES}: ${err.message}`, stepCount);
              console.warn(`[Context Overflow] Conversation history too large \u2014 compacting and retrying (${overflowRetries}/${MAX_OVERFLOW_RETRIES}): ${err.message}`);
              await this._context.compactIfNeeded(true);
              continue;
            }
            throw err;
          }
        }
        this._llmRequestInFlight = false;
        this._context.addMessage(response);
        this._onDidReceiveMessage.fire(response);
        const stepRecord = {
          stepIndex: stepCount,
          llmRequest: llmRequestMeta,
          llmResponse: {
            content: response.content,
            toolCalls: response.toolCalls ? response.toolCalls.map((tc) => ({ ...tc })) : void 0,
            reasoningContent: response.reasoningContent
          },
          llmUsage: response.usage,
          toolExecutions: [],
          durationMs: Date.now() - stepStartTime,
          timestamp: stepStartTime
        };
        step.update({
          output: response.toolCalls && response.toolCalls.length > 0 ? { tool_calls: response.toolCalls.map((tc) => tc.name) } : { final_answer: true }
        });
        if (!response.toolCalls || response.toolCalls.length === 0) {
          const reasoning = response.reasoningContent || "";
          if (isDegenerateReasoning(reasoning) && reasoningCorrectionRounds < MAX_REASONING_CORRECTION_ROUNDS) {
            reasoningCorrectionRounds++;
            this._noteSignal("reasoning-loop", `${reasoning.length} chars, ${countRepeatedReasoningLines(reasoning)} repeats`, stepCount);
            console.warn(
              `[Reasoning Loop] ${this._config.model} repeated the same reasoning (${reasoning.length} chars, ${countRepeatedReasoningLines(reasoning)} repeats) and produced no answer \u2014 discarding that thinking and asking it to act (${reasoningCorrectionRounds}/${MAX_REASONING_CORRECTION_ROUNDS}).`
            );
            this._context.dropReasoningContent((m) => m.id === response.id);
            const loopMsg = createMessage(
              "user" /* User */,
              `[System note] Your previous turn produced NO answer and repeated the same reasoning over and over. Stop repeating yourself. Either take the next concrete action (call a tool) or, if the work is actually finished, reply with your final summary now.`
            );
            this._context.addMessage(loopMsg);
            this._onDidReceiveMessage.fire(loopMsg);
            this._stepRecords.push(stepRecord);
            stepCount++;
            continue;
          }
          const hasAnswer = !!response.content.trim();
          const shouldVerify = !hasAnswer || !(skipSelfVerification && hasExecutedTool);
          if (shouldVerify && verificationRounds < MAX_VERIFICATION_ROUNDS) {
            verificationRounds++;
            this._noteSignal("verification-round", `round ${verificationRounds}/${MAX_VERIFICATION_ROUNDS}`, stepCount);
            const verifyMsg = createMessage(
              "user" /* User */,
              `[System verification round ${verificationRounds}/${MAX_VERIFICATION_ROUNDS}]
Before concluding, please verify: (1) Have you run tests or build to confirm correctness? (2) Are there any errors or warnings? (3) Is every subtask fully completed? (4) If you triggered any async task (CI, pipeline, deploy, container), have you used the poll tool to verify it completed? If anything is incomplete, still running, or unverified, continue working (use poll if waiting). Otherwise, provide your final summary.`
            );
            this._context.addMessage(verifyMsg);
            this._onDidReceiveMessage.fire(verifyMsg);
            this._stepRecords.push(stepRecord);
            stepCount++;
            continue;
          }
          this._contextHistoryForContinue = [...this._context.messages];
          consecutiveToolOnlySteps = 0;
          verificationRounds = 0;
          this._stepRecords.push(stepRecord);
          break;
        }
        verificationRounds = 0;
        const hasAnalysis = response.content && response.content.trim().length > 0 || response.reasoningContent && response.reasoningContent.trim().length > 0;
        if (!hasAnalysis) {
          consecutiveToolOnlySteps++;
        } else {
          consecutiveToolOnlySteps = 0;
        }
        for (const toolCall of response.toolCalls) {
          if (token.isCancellationRequested) {
            throw new Error("Cancelled");
          }
          if (this._supersedeRequested) {
            const skippedMsg = createMessage(
              "tool" /* Tool */,
              "[skipped] the user superseded this task via /btw before this tool call ran",
              { toolCallId: toolCall.id }
            );
            this._context.addMessage(skippedMsg);
            this._onDidReceiveMessage.fire(skippedMsg);
            continue;
          }
          hasExecutedTool = true;
          const toolExecStart = Date.now();
          const result = await this._tracing.runTool({
            name: toolCall.name,
            input: toolCall.arguments,
            metadata: { tool_call_id: toolCall.id, step_index: stepCount }
          }, async (toolObs) => {
            const toolResult = await this._executeTool(toolCall.id, toolCall.name, toolCall.arguments);
            toolObs.update({
              output: toolResult.success ? toolResult.output : toolResult.error || toolResult.output,
              level: toolResult.success ? "DEFAULT" : "ERROR",
              statusMessage: toolResult.success ? void 0 : toolResult.error
            });
            return toolResult;
          }, step.ref);
          const toolExecDuration = Date.now() - toolExecStart;
          const execRecord = {
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            arguments: { ...toolCall.arguments },
            result: result.output || result.error || "",
            success: result.success,
            error: result.error,
            durationMs: toolExecDuration,
            timestamp: toolExecStart
          };
          stepRecord.toolExecutions.push(execRecord);
          if (result.diff) {
            this._onDidReceiveToolDiff.fire(result.diff);
          }
          if (toolCall.name === "todo_write" && !this._todoList.isEmpty) {
            this._onDidUpdateTodos.fire(this._todoList.items);
          }
          const truncatedResult = this._truncateToolResult(result);
          const resultMsg = createToolResultMessage(truncatedResult);
          this._context.addMessage(resultMsg);
          this._onDidReceiveMessage.fire(resultMsg);
        }
        this._stepRecords.push(stepRecord);
        stepCount++;
      } finally {
        step.end();
      }
    }
    if (stepCount >= this._config.maxSteps) {
      this._contextHistoryForContinue = [...this._context.messages];
      const limitMsg = createMessage(
        "assistant" /* Assistant */,
        `Reached the step limit (${this._config.maxSteps}). Type "continue" to proceed.`
      );
      this._onDidReceiveMessage.fire(limitMsg);
    }
  }
  /**
   * Retain oversized tool results (head + tail) so they cannot overflow the
   * context window.
   *
   * Large outputs (build logs, file reads, search results) can overflow the LLM
   * context window, especially for reasoning models. A head-only cut — what this
   * used to do — keeps the LEAST useful part of the outputs that matter most: a
   * pytest assertion and its summary, a compiler diagnostic, and `npm test`'s
   * pass/fail line all live in the last lines. `retainResult` keeps the ordered
   * head AND tail with an exact omission notice in between.
   *
   * `diff` is dropped here on purpose: it is a display payload, and rendering it
   * is the host's decision (already taken before this point). Keeping it would
   * carry a pre-rendered card through the context-window path for no benefit.
   */
  _truncateToolResult(result) {
    const plain = {
      toolCallId: result.toolCallId,
      success: result.success,
      output: result.output,
      error: result.error
    };
    if (!result.output) return plain;
    const retained = retainResult(result.output);
    if (!retained.truncated) return plain;
    return { ...plain, output: retained.text };
  }
  /**
   * Shape one conversation message for a generation's `input`.
   *
   * Only the fields that make the trace readable are kept, and reasoning is
   * included (a thinking model's decisions are unexplainable without it) while
   * the tracing module bounds/redacts every string.
   */
  static _generationMessage(m) {
    const out = { role: m.role, content: m.content };
    if (m.toolCalls && m.toolCalls.length > 0) {
      out.tool_calls = m.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments }));
    }
    if (m.toolCallId) out.tool_call_id = m.toolCallId;
    if (m.reasoningContent) out.reasoning_content = m.reasoningContent;
    return out;
  }
  /** Shape the assistant reply for a generation's `output`. */
  static _generationResult(m) {
    const out = { role: m.role, content: m.content };
    if (m.toolCalls && m.toolCalls.length > 0) {
      out.tool_calls = m.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments }));
    }
    if (m.reasoningContent) out.reasoning_content = m.reasoningContent;
    return out;
  }
  /**
   * Provider-normalized token usage → Langfuse `usageDetails`.
   *
   * Setting input/output (not just total) is what lets Langfuse compute cost
   * per model and expose cache hit rates; omitted when the provider reported
   * no usage at all, so a trace never shows a fake `0` token count.
   */
  static _usageDetails(usage) {
    if (!usage) return void 0;
    const details = {
      input: usage.promptTokens,
      output: usage.completionTokens,
      total: usage.totalTokens
    };
    if (usage.cachedTokens) details.cached = usage.cachedTokens;
    if (usage.cacheCreationTokens) details.cache_creation = usage.cacheCreationTokens;
    return details;
  }
  async _executeTool(toolCallId, toolName, args) {
    const tool = this._toolRegistry.get(toolName);
    if (!tool) {
      this._noteSignal("unknown-tool", toolName);
      return {
        toolCallId,
        success: false,
        output: "",
        error: `Unknown tool: ${toolName}`
      };
    }
    const writingTools = ["write_file", "edit_file"];
    if (writingTools.includes(toolName) && args.path) {
      const checkpointId = this._checkpointManager.createCheckpoint(
        `Before ${toolName} on ${args.path}`
      );
      await this._checkpointManager.snapshotFile(checkpointId, args.path);
    }
    const controller = new AbortController();
    this._currentToolController = controller;
    try {
      if (controller.signal.aborted) {
        return {
          toolCallId,
          success: false,
          output: "",
          error: "Tool execution cancelled by user intervention (/btw)"
        };
      }
      const effectiveTimeout = args.timeout || tool.timeoutFor(args, this._config) || this._config.stepTimeout;
      const result = await Promise.race([
        tool.execute({ ...args, _toolCallId: toolCallId, _timeoutMs: effectiveTimeout }, controller.signal),
        this._timeout(effectiveTimeout, toolCallId)
      ]);
      return result;
    } catch (err) {
      if (controller.signal.aborted || err instanceof DOMException && err.name === "AbortError") {
        return {
          toolCallId,
          success: false,
          output: "",
          error: "Tool execution cancelled by user intervention (/btw)"
        };
      }
      return {
        toolCallId,
        success: false,
        output: "",
        error: `Tool execution error: ${err.message}`
      };
    } finally {
      if (this._currentToolController === controller) {
        this._currentToolController = void 0;
      }
    }
  }
  _timeout(ms, toolCallId) {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`Tool execution timed out after ${ms}ms`)), ms);
    });
  }
  /**
   * Detect complex tasks by keyword matching. When a complex task is detected,
   * the agent injects extra deep thinking instructions before starting the loop.
   */
  _isComplexTask(message) {
    const lower = message.toLowerCase();
    return COMPLEX_TASK_KEYWORDS.some((kw) => lower.includes(kw.toLowerCase()));
  }
  dispose() {
    this.cancel();
    this._stopRecoveryProbe();
    this._onDidReceiveMessage.dispose();
    this._onDidStreamToken.dispose();
    this._onDidComplete.dispose();
    this._onDidError.dispose();
    this._onDidSwitchModel.dispose();
    this._planner.dispose();
    this._modeManager.dispose();
  }
};

// src/vs/workbench/contrib/agent/common/agentParallel.ts
var ParallelAgentManager = class extends Disposable {
  constructor(_config, _llmProvider, _toolRegistry, _workingDirectory, _checkpointManager, maxConcurrent = 4, _modelRouter, _memory, _tracing = NOOP_TRACING) {
    super();
    this._config = _config;
    this._llmProvider = _llmProvider;
    this._toolRegistry = _toolRegistry;
    this._workingDirectory = _workingDirectory;
    this._checkpointManager = _checkpointManager;
    this._modelRouter = _modelRouter;
    this._memory = _memory;
    this._tracing = _tracing;
    this._maxConcurrent = maxConcurrent;
  }
  _tasks = /* @__PURE__ */ new Map();
  _results = /* @__PURE__ */ new Map();
  _maxConcurrent;
  _onDidTaskStart = this._register(new Emitter());
  onDidTaskStart = this._onDidTaskStart.event;
  _onDidTaskComplete = this._register(new Emitter());
  onDidTaskComplete = this._onDidTaskComplete.event;
  _onDidAllComplete = this._register(new Emitter());
  onDidAllComplete = this._onDidAllComplete.event;
  async runParallel(tasks) {
    return this._tracing.runTask({
      name: "agent-parallel",
      input: { tasks },
      tags: ["parallel"],
      metadata: { task_count: tasks.length, max_concurrent: this._maxConcurrent }
    }, async () => this._runParallelTasks(tasks));
  }
  async _runParallelTasks(tasks) {
    const taskEntries = tasks.map((desc) => ({
      id: generateId(),
      description: desc,
      status: "pending",
      startTime: Date.now()
    }));
    for (const task of taskEntries) {
      this._tasks.set(task.id, task);
    }
    const results = [];
    const batches = this._chunk(taskEntries, this._maxConcurrent);
    for (const batch of batches) {
      const batchPromises = batch.map((task) => this._runSingleAgent(task));
      const batchResults = await Promise.allSettled(batchPromises);
      for (let i = 0; i < batchResults.length; i++) {
        const settled = batchResults[i];
        const task = batch[i];
        if (settled.status === "fulfilled") {
          results.push(settled.value);
        } else {
          const failResult = {
            taskId: task.id,
            success: false,
            messages: [],
            error: settled.reason?.message || "Unknown error",
            durationMs: Date.now() - task.startTime,
            taskLog: void 0
          };
          results.push(failResult);
          this._onDidTaskComplete.fire(failResult);
        }
      }
    }
    this._onDidAllComplete.fire(results);
    return results;
  }
  async _runSingleAgent(task) {
    task.status = "running";
    this._onDidTaskStart.fire(task);
    const { config, llmProvider } = this._resolveModelForTask(task.description);
    const modeManager = new AgentModeManager();
    const checkpointManager = this._checkpointManager.clone();
    const agentLoop = new AgentLoop(
      config,
      llmProvider,
      this._toolRegistry,
      modeManager,
      checkpointManager,
      this._workingDirectory,
      this._memory,
      this._tracing
    );
    const fallback = this._modelRouter?.fallbackConfig();
    if (fallback && fallback.model !== config.model) {
      try {
        agentLoop.setFallback(fallback, LLMProviderFactory.create(fallback));
      } catch {
      }
    }
    const messages = [];
    agentLoop.setModelSwitchLogger((e) => console.log(formatModelSwitch(e)));
    agentLoop.onDidReceiveMessage((msg) => {
      messages.push(msg);
    });
    const startTime = Date.now();
    return this._tracing.runSubagent({
      name: `subagent: ${task.description.slice(0, 60)}`,
      input: task.description,
      tags: ["subagent"],
      metadata: {
        task_id: task.id,
        model: config.model,
        provider: config.provider,
        max_concurrent: this._maxConcurrent
      }
    }, async (agentObs) => {
      try {
        await agentLoop.run(task.description);
        task.status = "done";
        task.endTime = Date.now();
        const status = agentLoop.lastTaskError ? "failed" : "completed";
        const taskLog = agentLoop.exportTaskLog(status, agentLoop.lastTaskError);
        const result = {
          taskId: task.id,
          success: true,
          messages,
          durationMs: Date.now() - startTime,
          taskLog
        };
        agentObs.update({
          output: messages.filter((m) => m.role === "assistant" && m.content).slice(-1)[0]?.content,
          level: agentLoop.lastTaskError ? "ERROR" : "DEFAULT",
          statusMessage: agentLoop.lastTaskError
        });
        this._results.set(task.id, result);
        this._onDidTaskComplete.fire(result);
        return result;
      } catch (err) {
        task.status = "failed";
        task.endTime = Date.now();
        task.error = err.message;
        const taskLog = agentLoop.exportTaskLog("failed", err.message);
        const result = {
          taskId: task.id,
          success: false,
          messages,
          error: err.message,
          durationMs: Date.now() - startTime,
          taskLog
        };
        agentObs.update({
          output: err.message,
          level: "ERROR",
          statusMessage: err.message
        });
        this._results.set(task.id, result);
        this._onDidTaskComplete.fire(result);
        return result;
      } finally {
        agentLoop.dispose();
        modeManager.dispose();
      }
    });
  }
  /**
   * Resolve the model config + provider for a single parallel task.
   * When a model router is present and enabled, each task is routed to its
   * scenario model (vision/reasoning/fast) and gets its own provider instance.
   */
  _resolveModelForTask(description) {
    if (!this._modelRouter?.enabled) {
      return { config: this._config, llmProvider: this._llmProvider };
    }
    const config = this._modelRouter.selectConfig(description);
    if (config.model === this._config.model) {
      return { config: this._config, llmProvider: this._llmProvider };
    }
    try {
      const provider = LLMProviderFactory.create(config);
      console.log(`[ROUTE] ${this._modelRouter.detectScenario(description)} \u2192 ${config.provider}/${config.model} (${description.substring(0, 40)})`);
      return { config, llmProvider: provider };
    } catch {
      return { config: this._config, llmProvider: this._llmProvider };
    }
  }
  getTask(taskId) {
    return this._tasks.get(taskId);
  }
  getResult(taskId) {
    return this._results.get(taskId);
  }
  getAllResults() {
    return [...this._results.values()];
  }
  _chunk(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }
};

// src/vs/workbench/contrib/agent/common/tools/readFile.ts
var ReadFileTool = class extends AgentTool {
  constructor(_fileService) {
    super();
    this._fileService = _fileService;
  }
  name = "read_file";
  description = "Read the contents of a file. Returns numbered lines. Use offset and limit for large files.";
  parameters = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file to read"
      },
      offset: {
        type: "number",
        description: "Line number to start reading from (1-based). Omit to read from the beginning."
      },
      limit: {
        type: "number",
        description: "Maximum number of lines to read. Omit to read the entire file."
      }
    },
    required: ["path"]
  };
  async execute(args, signal) {
    const toolCallId = args._toolCallId || "";
    const path15 = args.path;
    const offset = args.offset || 1;
    const limit = args.limit;
    if (signal?.aborted) {
      return this.failure(toolCallId, "Tool execution cancelled by user");
    }
    try {
      const uri = URI.file(path15);
      const content = await this._fileService.readFile(uri);
      const text = content.value.toString();
      const allLines = text.split("\n");
      const startIdx = Math.max(0, offset - 1);
      const endIdx = limit ? Math.min(allLines.length, startIdx + limit) : allLines.length;
      const selectedLines = allLines.slice(startIdx, endIdx);
      const numbered = selectedLines.map((line, i) => `${String(startIdx + i + 1).padStart(6)}|${line}`).join("\n");
      const header = `File: ${path15} (${allLines.length} lines total, showing ${startIdx + 1}-${endIdx})`;
      return this.success(toolCallId, `${header}
${numbered}`);
    } catch (err) {
      return this.failure(toolCallId, `Failed to read file ${path15}: ${err.message}`);
    }
  }
};

// src/vs/workbench/contrib/agent/common/agentDiff.ts
var DIFF_CONTEXT = 3;
var MAX_LCS_CELLS = 4e6;
function splitLines(text) {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}
function lcsDiff(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((text) => ({ kind: "+", text }));
  if (m === 0) return a.map((text) => ({ kind: "-", text }));
  if ((n + 1) * (m + 1) > MAX_LCS_CELLS) {
    return [
      ...a.map((text) => ({ kind: "-", text })),
      ...b.map((text) => ({ kind: "+", text }))
    ];
  }
  const width = m + 1;
  const table = new Int32Array((n + 1) * width);
  for (let i2 = n - 1; i2 >= 0; i2--) {
    for (let j2 = m - 1; j2 >= 0; j2--) {
      table[i2 * width + j2] = a[i2] === b[j2] ? table[(i2 + 1) * width + (j2 + 1)] + 1 : Math.max(table[(i2 + 1) * width + j2], table[i2 * width + (j2 + 1)]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", text: a[i] });
      i++;
      j++;
    } else if (table[(i + 1) * width + j] >= table[i * width + (j + 1)]) {
      ops.push({ kind: "-", text: a[i] });
      i++;
    } else {
      ops.push({ kind: "+", text: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: "-", text: a[i] });
    i++;
  }
  while (j < m) {
    ops.push({ kind: "+", text: b[j] });
    j++;
  }
  return ops;
}
function diffOps(before, after) {
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  const maxSuffix = Math.min(before.length, after.length) - prefix;
  while (suffix < maxSuffix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const ops = [];
  for (let i = 0; i < prefix; i++) ops.push({ kind: " ", text: before[i] });
  ops.push(...lcsDiff(before.slice(prefix, before.length - suffix), after.slice(prefix, after.length - suffix)));
  for (let i = before.length - suffix; i < before.length; i++) ops.push({ kind: " ", text: before[i] });
  return ops;
}
function buildHunks(ops, context) {
  const lineAt = [];
  const changed = [];
  let oldNo = 0;
  let newNo = 0;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (op.kind === "-") {
      oldNo++;
      lineAt.push({ oldLine: oldNo });
      changed.push(i);
    } else if (op.kind === "+") {
      newNo++;
      lineAt.push({ newLine: newNo });
      changed.push(i);
    } else {
      oldNo++;
      newNo++;
      lineAt.push({ oldLine: oldNo, newLine: newNo });
    }
  }
  if (changed.length === 0) return [];
  const ranges = [];
  for (const index of changed) {
    const start = Math.max(0, index - context);
    const end = Math.min(ops.length - 1, index + context);
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      ranges.push({ start, end });
    }
  }
  const hunks = [];
  for (const range of ranges) {
    const lines = [];
    let oldStart = 0;
    let newStart = 0;
    let oldCount = 0;
    let newCount = 0;
    for (let i = range.start; i <= range.end; i++) {
      const op = ops[i];
      const numbering = lineAt[i];
      lines.push({ kind: op.kind, text: op.text, oldLine: numbering.oldLine, newLine: numbering.newLine });
      if (op.kind !== "+") {
        if (oldStart === 0) oldStart = numbering.oldLine ?? 0;
        oldCount++;
      }
      if (op.kind !== "-") {
        if (newStart === 0) newStart = numbering.newLine ?? 0;
        newCount++;
      }
    }
    if (oldStart === 0) {
      const previous = hunks[hunks.length - 1];
      oldStart = previous ? previous.oldStart + previous.oldCount : 0;
    }
    if (newStart === 0) {
      const previous = hunks[hunks.length - 1];
      newStart = previous ? previous.newStart + previous.newCount : 0;
    }
    hunks.push({ oldStart, oldCount, newStart, newCount, lines });
  }
  return hunks;
}
function computeFileDiff(path15, before, after, context = DIFF_CONTEXT) {
  const ops = diffOps(splitLines(before), splitLines(after));
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === "+") added++;
    else if (op.kind === "-") removed++;
  }
  return {
    path: path15,
    hunks: buildHunks(ops, context),
    added,
    removed,
    created: before === ""
  };
}
function buildToolDiff(path15, before, after) {
  const diff = computeFileDiff(path15, before, after);
  return diff.hunks.length === 0 ? void 0 : diff;
}
var ANSI = {
  reset: "\x1B[0m",
  bold: "\x1B[1m",
  dim: "\x1B[2m",
  red: "\x1B[31m",
  green: "\x1B[32m",
  cyan: "\x1B[36m",
  magenta: "\x1B[35m"
};
function ansiColorEnabled(env2 = process.env, stream) {
  if (env2.FORCE_COLOR !== void 0 && env2.FORCE_COLOR !== "" && env2.FORCE_COLOR !== "0") return true;
  if (env2.NO_COLOR !== void 0 && env2.NO_COLOR !== "") return false;
  if (env2.TERM === "dumb") return false;
  const tty = stream?.isTTY ?? process.stdout.isTTY;
  return tty === true;
}
function paint(text, color, enabled) {
  return enabled ? `${color}${text}${ANSI.reset}` : text;
}
function hunkHeader(hunk) {
  const oldRange = hunk.oldCount === 1 ? `${hunk.oldStart}` : `${hunk.oldStart},${hunk.oldCount}`;
  const newRange = hunk.newCount === 1 ? `${hunk.newStart}` : `${hunk.newStart},${hunk.newCount}`;
  return `@@ -${oldRange} +${newRange} @@`;
}
function displayPathFor(path15, cwd, sep5 = "/") {
  if (!cwd) return path15;
  const root = cwd.endsWith(sep5) ? cwd : cwd + sep5;
  return path15.startsWith(root) ? path15.slice(root.length) : path15;
}
function renderFileDiffAnsi(diff, options = {}) {
  const color = options.color ?? ansiColorEnabled();
  const maxLines = options.maxLines ?? 400;
  const shownPath = options.displayPath ?? diff.path;
  const out = [];
  out.push(paint(`\u250C\u2500 ${shownPath} `, ANSI.bold, color) + paint(`(+${diff.added} -${diff.removed})`, ANSI.magenta, color));
  let emitted = 0;
  let truncated = false;
  for (const hunk of diff.hunks) {
    if (emitted >= maxLines) {
      truncated = true;
      break;
    }
    out.push(paint("\u2502 ", ANSI.dim, color) + paint(hunkHeader(hunk), ANSI.cyan, color));
    emitted++;
    for (const line of hunk.lines) {
      if (emitted >= maxLines) {
        truncated = true;
        break;
      }
      const prefix = line.kind === "+" ? "+" : line.kind === "-" ? "-" : " ";
      const color2 = line.kind === "+" ? ANSI.green : line.kind === "-" ? ANSI.red : ANSI.dim;
      out.push(paint("\u2502 ", ANSI.dim, color) + paint(prefix + line.text, color2, color));
      emitted++;
    }
  }
  if (truncated) out.push(paint(`\u2502 ... (diff truncated at ${maxLines} lines)`, ANSI.dim, color));
  out.push(paint("\u2514\u2500", ANSI.dim, color));
  return out.join("\n");
}
function renderFileDiffPlain(diff, displayPath = diff.path, maxLines = 200) {
  const out = [`--- ${displayPath} (+${diff.added} -${diff.removed})`];
  for (const hunk of diff.hunks) {
    out.push(hunkHeader(hunk));
    for (const line of hunk.lines) out.push(line.kind + line.text);
    if (out.length >= maxLines) {
      out.push("... (diff truncated)");
      break;
    }
  }
  return out.join("\n");
}

// src/vs/workbench/contrib/agent/common/tools/writeFile.ts
var WriteFileTool = class extends AgentTool {
  constructor(_fileService) {
    super();
    this._fileService = _fileService;
  }
  name = "write_file";
  description = "Create a new file or overwrite an existing file with the provided content.";
  parameters = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file to write"
      },
      content: {
        type: "string",
        description: "The full content to write to the file"
      }
    },
    required: ["path", "content"]
  };
  async execute(args, signal) {
    const toolCallId = args._toolCallId || "";
    const path15 = args.path;
    const content = args.content;
    if (signal?.aborted) {
      return this.failure(toolCallId, "Tool execution cancelled by user");
    }
    try {
      const uri = URI.file(path15);
      let before = "";
      let existed = false;
      try {
        const existing = await this._fileService.readFile(uri);
        before = existing.value.toString();
        existed = true;
      } catch {
      }
      await this._fileService.writeFile(uri, VSBuffer.fromString(content));
      const lineCount = content.split("\n").length;
      const headline = existed ? `Successfully wrote ${lineCount} lines to ${path15}` : `Created ${path15} with ${lineCount} lines`;
      const diff = buildToolDiff(path15, before, content);
      return { ...this.success(toolCallId, headline), diff };
    } catch (err) {
      return this.failure(toolCallId, `Failed to write file ${path15}: ${err.message}`);
    }
  }
};

// src/vs/workbench/contrib/agent/common/tools/editFile.ts
var EditFileTool = class extends AgentTool {
  constructor(_fileService) {
    super();
    this._fileService = _fileService;
  }
  name = "edit_file";
  description = "Replace an exact string occurrence in a file. The old_string must uniquely identify the target. Use replace_all to replace all occurrences.";
  parameters = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the file to edit"
      },
      old_string: {
        type: "string",
        description: "The exact string to find and replace. Must be unique in the file unless replace_all is true."
      },
      new_string: {
        type: "string",
        description: "The replacement string"
      },
      replace_all: {
        type: "boolean",
        description: "If true, replace all occurrences. Default: false."
      }
    },
    required: ["path", "old_string", "new_string"]
  };
  async execute(args, signal) {
    const toolCallId = args._toolCallId || "";
    const path15 = args.path;
    const oldString = args.old_string;
    const newString = args.new_string;
    const replaceAll = args.replace_all || false;
    if (signal?.aborted) {
      return this.failure(toolCallId, "Tool execution cancelled by user");
    }
    try {
      const uri = URI.file(path15);
      const content = await this._fileService.readFile(uri);
      const text = content.value.toString();
      const occurrences = text.split(oldString).length - 1;
      if (occurrences === 0) {
        return this.failure(toolCallId, `old_string not found in ${path15}. Make sure it matches exactly including whitespace.`);
      }
      if (!replaceAll && occurrences > 1) {
        return this.failure(toolCallId, `old_string found ${occurrences} times in ${path15}. Provide more context to make it unique, or set replace_all=true.`);
      }
      let newText;
      if (replaceAll) {
        newText = text.split(oldString).join(newString);
      } else {
        const idx = text.indexOf(oldString);
        newText = text.substring(0, idx) + newString + text.substring(idx + oldString.length);
      }
      await this._fileService.writeFile(uri, VSBuffer.fromString(newText));
      const replacedCount = replaceAll ? occurrences : 1;
      const diff = buildToolDiff(path15, text, newText);
      return {
        ...this.success(toolCallId, `Replaced ${replacedCount} occurrence(s) in ${path15}`),
        diff
      };
    } catch (err) {
      return this.failure(toolCallId, `Failed to edit file ${path15}: ${err.message}`);
    }
  }
};

// src/vs/workbench/contrib/agent/common/tools/listDir.ts
var ListDirectoryTool = class extends AgentTool {
  constructor(_fileService) {
    super();
    this._fileService = _fileService;
  }
  name = "list_directory";
  description = "List the contents of a directory. Shows files and subdirectories with type indicators.";
  parameters = {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Absolute path to the directory to list"
      },
      recursive: {
        type: "boolean",
        description: "If true, list recursively up to max_depth. Default: false."
      },
      max_depth: {
        type: "number",
        description: "Maximum recursion depth. Default: 3."
      }
    },
    required: ["path"]
  };
  async execute(args, signal) {
    const toolCallId = args._toolCallId || "";
    const path15 = args.path;
    const recursive = args.recursive || false;
    const maxDepth = args.max_depth || 3;
    if (signal?.aborted) {
      return this.failure(toolCallId, "Tool execution cancelled by user");
    }
    try {
      const uri = URI.file(path15);
      const lines = [];
      await this._listRecursive(uri, "", lines, recursive ? maxDepth : 1, 0);
      if (lines.length === 0) {
        return this.success(toolCallId, `Directory ${path15} is empty`);
      }
      return this.success(toolCallId, `Directory: ${path15}
${lines.join("\n")}`);
    } catch (err) {
      return this.failure(toolCallId, `Failed to list directory ${path15}: ${err.message}`);
    }
  }
  async _listRecursive(uri, prefix, lines, maxDepth, currentDepth) {
    if (currentDepth >= maxDepth) {
      return;
    }
    const entries = await this._fileService.resolve(uri, { resolveMetadata: false });
    if (!entries.children) {
      return;
    }
    const sorted = [...entries.children].sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) {
        return -1;
      }
      if (!a.isDirectory && b.isDirectory) {
        return 1;
      }
      return a.name.localeCompare(b.name);
    });
    for (const entry of sorted) {
      const icon = entry.isDirectory ? "[dir]" : "[file]";
      lines.push(`${prefix}${icon} ${entry.name}`);
      if (entry.isDirectory) {
        await this._listRecursive(entry.resource, prefix + "  ", lines, maxDepth, currentDepth + 1);
      }
    }
  }
};

// vs-core/platform/instantiation/common/instantiation.ts
function createDecorator(serviceId) {
  const id = function(target, key, index) {
  };
  id.toString = () => serviceId;
  return id;
}
var IInstantiationService = createDecorator("instantiationService");

// vs-core/workbench/services/search/common/search.ts
var ISearchService = createDecorator("searchService");

// src/vs/workbench/contrib/agent/common/tools/searchText.ts
var SearchTextTool = class extends AgentTool {
  constructor(_searchService, _workspaceRoot) {
    super();
    this._searchService = _searchService;
    this._workspaceRoot = _workspaceRoot;
  }
  name = "search_text";
  description = "Search for a text pattern (regex supported) across files in a directory. Returns matching lines with file paths and line numbers.";
  parameters = {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "The search pattern (regex supported)"
      },
      path: {
        type: "string",
        description: "Directory to search in. Defaults to workspace root."
      },
      glob: {
        type: "string",
        description: 'Glob pattern to filter files (e.g. "*.ts", "**/*.py")'
      },
      max_results: {
        type: "number",
        description: "Maximum number of results to return. Default: 50."
      }
    },
    required: ["pattern"]
  };
  async execute(args, signal) {
    const toolCallId = args._toolCallId || "";
    const pattern = args.pattern;
    const searchPath = args.path;
    const glob = args.glob;
    const maxResults = args.max_results || 50;
    if (signal?.aborted) {
      return this.failure(toolCallId, "Tool execution cancelled by user");
    }
    try {
      new RegExp(pattern);
    } catch (regexErr) {
      return this.failure(
        toolCallId,
        `Invalid regex pattern: "${pattern}". Error: ${regexErr.message}. Tip: escape special chars like \\ . * + ? [ ] ( ) { } ^ $ | with backslash.`
      );
    }
    try {
      const folderUri = searchPath ? URI.file(searchPath) : this._workspaceRoot;
      const query = {
        type: 2 /* Text */,
        contentPattern: {
          pattern,
          isRegExp: true,
          isCaseSensitive: false,
          isWordMatch: false
        },
        folderQueries: [{ folder: folderUri }],
        maxResults
      };
      if (glob) {
        query.includePattern = { [glob]: true };
      }
      const results = await this._searchService.textSearch(query);
      const lines = [];
      for (const result of results.results) {
        const filePath = result.resource.fsPath;
        for (const match of result.results || []) {
          const lineNum = match.range?.startLineNumber || "?";
          const preview = match.preview?.text?.trim() || "";
          lines.push(`${filePath}:${lineNum}: ${preview}`);
        }
      }
      if (lines.length === 0) {
        return this.success(toolCallId, `No matches found for pattern: ${pattern}`);
      }
      const header = `Found ${lines.length} match(es) for "${pattern}"`;
      return this.success(toolCallId, `${header}
${lines.join("\n")}`);
    } catch (err) {
      return this.failure(toolCallId, `Search failed: ${err.message}`);
    }
  }
};

// src/vs/workbench/contrib/agent/common/tools/searchFiles.ts
var SearchFilesTool = class extends AgentTool {
  constructor(_searchService, _workspaceRoot) {
    super();
    this._searchService = _searchService;
    this._workspaceRoot = _workspaceRoot;
  }
  name = "search_files";
  description = "Find files matching a glob pattern. Returns a list of matching file paths.";
  parameters = {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: 'Glob pattern to match files (e.g. "**/*.ts", "src/**/test_*.py")'
      },
      path: {
        type: "string",
        description: "Directory to search in. Defaults to workspace root."
      },
      max_results: {
        type: "number",
        description: "Maximum number of results. Default: 100."
      }
    },
    required: ["pattern"]
  };
  async execute(args, signal) {
    const toolCallId = args._toolCallId || "";
    const pattern = args.pattern;
    const searchPath = args.path;
    const maxResults = args.max_results || 100;
    if (signal?.aborted) {
      return this.failure(toolCallId, "Tool execution cancelled by user");
    }
    try {
      const folderUri = searchPath ? URI.file(searchPath) : this._workspaceRoot;
      const query = {
        type: 1 /* File */,
        folderQueries: [{ folder: folderUri }],
        filePattern: pattern,
        maxResults
      };
      const results = await this._searchService.fileSearch(query);
      const paths = results.results.map((r) => r.resource.fsPath);
      if (paths.length === 0) {
        return this.success(toolCallId, `No files found matching pattern: ${pattern}`);
      }
      const header = `Found ${paths.length} file(s) matching "${pattern}"`;
      return this.success(toolCallId, `${header}
${paths.join("\n")}`);
    } catch (err) {
      return this.failure(toolCallId, `File search failed: ${err.message}`);
    }
  }
};

// src/vs/workbench/contrib/agent/common/tools/runTerminal.ts
var RunTerminalTool = class extends AgentTool {
  constructor(_terminalService, _defaultCwd) {
    super();
    this._terminalService = _terminalService;
    this._defaultCwd = _defaultCwd;
  }
  name = "run_terminal";
  description = "Execute a shell command in the integrated terminal and return its output. Use for running builds, tests, git commands, etc.";
  parameters = {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The shell command to execute"
      },
      cwd: {
        type: "string",
        description: "Working directory for the command. Defaults to workspace root."
      },
      timeout: {
        type: "number",
        description: "Timeout in milliseconds. Default: 30000 (30s)."
      }
    },
    required: ["command"]
  };
  async execute(args, signal) {
    const toolCallId = args._toolCallId || "";
    const command = args.command;
    const cwd = args.cwd || this._defaultCwd;
    const timeout = args.timeout || 3e4;
    if (signal?.aborted) {
      return this.failure(toolCallId, "Tool execution cancelled by user");
    }
    const PATH_END = String.raw`(?=$|[\s;&|)\x60'"])`;
    const dangerousPatterns = [
      new RegExp(`\\brm\\s+-rf\\s+\\/+\\*?${PATH_END}`),
      // rm -rf / (root itself only)
      /\brm\s+-rf\s+\*\b/,
      // rm -rf *
      new RegExp(`\\brm\\s+-rf\\s+~\\/?\\*?${PATH_END}`),
      // rm -rf ~ (home itself only)
      /\bdd\b[^\n]*\bof=(?!\/dev\/(?:null|zero|stdout|stderr)\b)/,
      // dd writing to a real target
      /\bmkfs\./,
      // format filesystem
      />\/dev\/sd[a-z]/,
      // overwrite block device
      new RegExp(`\\bchmod\\s+(-R\\s+)?777\\s+\\/+\\*?${PATH_END}`),
      // chmod 777 /
      /:\(\)\s*\{/,
      // fork bomb
      /\bDROP\s+(TABLE|DATABASE)\b/i
      // SQL destructive
    ];
    for (const pattern of dangerousPatterns) {
      if (pattern.test(command)) {
        return this.failure(
          toolCallId,
          `Command blocked by safety filter: potentially destructive operation detected. If this is intentional, please run it manually in your terminal.`
        );
      }
    }
    try {
      const output = await this._executeCommand(command, cwd, timeout, signal);
      return this.success(toolCallId, output);
    } catch (err) {
      if (signal?.aborted) {
        return this.failure(toolCallId, "Tool execution cancelled by user");
      }
      return this.failure(toolCallId, `Command failed: ${err.message}`);
    }
  }
  async _executeCommand(command, cwd, timeout, signal) {
    return new Promise((resolve12, reject) => {
      const chunks = [];
      let settled = false;
      const instance = this._terminalService.createTerminal({
        config: {
          name: "Agent Command",
          cwd,
          isFeatureTerminal: true
        }
      });
      const cleanup = () => {
        clearTimeout(timer);
        abortDisposable?.();
        dataDisposable.dispose();
        exitDisposable.dispose();
        instance.dispose();
      };
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          const output = chunks.join("").trim();
          resolve12(output + "\n[Command timed out after " + timeout + "ms]");
        }
      }, timeout);
      let abortDisposable;
      if (signal) {
        const onAbort = () => {
          if (!settled) {
            settled = true;
            cleanup();
            reject(new DOMException("Aborted", "AbortError"));
          }
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        abortDisposable = () => signal.removeEventListener("abort", onAbort);
      }
      const dataDisposable = instance.onData((data) => {
        chunks.push(data);
      });
      const exitDisposable = instance.onExit((exitCode) => {
        if (!settled) {
          settled = true;
          cleanup();
          const output = chunks.join("").trim();
          const exitInfo = `
[Exit code: ${exitCode?.code ?? "unknown"}]`;
          resolve12(output + exitInfo);
        }
      });
      instance.sendText(command, true);
    });
  }
};

// src/vs/workbench/contrib/agent/common/tools/poll.ts
var POLL_ATTEMPT_OVERHEAD_MS = 1e3;
var POLL_DEADLINE_MARGIN_MIN_MS = 250;
var POLL_DEADLINE_MARGIN_RATIO = 0.05;
var POLL_DEADLINE_MARGIN_MAX_MS = 3e4;
function pollDeadlineMarginMs(budgetMs) {
  return Math.min(
    Math.max(POLL_DEADLINE_MARGIN_MIN_MS, budgetMs * POLL_DEADLINE_MARGIN_RATIO),
    POLL_DEADLINE_MARGIN_MAX_MS,
    budgetMs / 2
  );
}
function pollBudgetMs(args) {
  const maxAttempts = Math.max(1, args.max_attempts || 30);
  const initialDelay = args.initial_delay || 2;
  const maxDelay = args.max_delay || 60;
  const commandTimeout = args.command_timeout || 3e4;
  let total = maxAttempts * POLL_ATTEMPT_OVERHEAD_MS;
  for (let i = 0; i < maxAttempts; i++) {
    total += commandTimeout;
    if (i < maxAttempts - 1) {
      total += Math.min(initialDelay * Math.pow(2, i), maxDelay) * 1e3;
    }
  }
  return total;
}
var PollTool = class extends AgentTool {
  constructor(_terminalService, _defaultCwd) {
    super();
    this._terminalService = _terminalService;
    this._defaultCwd = _defaultCwd;
  }
  name = "poll";
  description = `Poll a shell command at intervals with exponential backoff until a success condition is met. Use for waiting on async external tasks: CI pipelines, containers, background jobs, file readiness. The check command should exit 0 for success, or match success_pattern for text-based success. Delay grows exponentially (initial_delay \u2192 max_delay), never exceeding max_delay. Example: poll(command="curl -s http://svc/status", success_pattern="READY", max_attempts=10)`;
  parameters = {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to run for each poll attempt. Exit code 0 = success (unless success_pattern is set). Output is captured and checked against success_pattern if provided."
      },
      success_pattern: {
        type: "string",
        description: "Optional regex pattern. If set, the command is considered successful when its stdout matches this pattern (regardless of exit code). If not set, exit code 0 = success."
      },
      max_attempts: {
        type: "number",
        description: "Maximum number of poll attempts before giving up. Default: 30."
      },
      initial_delay: {
        type: "number",
        description: "Delay in seconds before the first retry. Default: 2."
      },
      max_delay: {
        type: "number",
        description: "Maximum delay in seconds between attempts. Default: 60."
      },
      cwd: {
        type: "string",
        description: "Working directory for the command. Defaults to workspace root."
      },
      command_timeout: {
        type: "number",
        description: "Per-attempt command timeout in milliseconds. Default: 30000 (30s)."
      }
    },
    required: ["command"]
  };
  /**
   * A poll is a deliberate wait: the generic step timeout (60s in the shipped
   * config) is shorter than any real CI wait, so being killed by it is a
   * guaranteed failure rather than a safety net. Declare the loop's own
   * worst case instead — never shorter than the step timeout, never longer than
   * the agent's configured task budget.
   */
  timeoutFor(args, config) {
    const outerBound = Math.max(config.stepTimeout, config.taskTimeout);
    return Math.min(Math.max(pollBudgetMs(args), config.stepTimeout), outerBound);
  }
  async execute(args, signal) {
    const toolCallId = args._toolCallId || "";
    const command = args.command;
    const successPattern = args.success_pattern;
    const maxAttempts = args.max_attempts || 30;
    const initialDelay = args.initial_delay || 2;
    const maxDelay = args.max_delay || 60;
    const cwd = args.cwd || this._defaultCwd;
    const commandTimeout = args.command_timeout || 3e4;
    const budgetMs = args._timeoutMs || 0;
    const deadline = budgetMs > 0 ? Date.now() + Math.max(0, budgetMs - pollDeadlineMarginMs(budgetMs)) : Number.POSITIVE_INFINITY;
    if (maxAttempts < 1) {
      return this.failure(toolCallId, "max_attempts must be >= 1");
    }
    if (signal?.aborted) {
      return this.failure(toolCallId, "Tool execution cancelled by user");
    }
    const allOutputs = [];
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (signal?.aborted) {
        allOutputs.push("\u23F9\uFE0F Poll cancelled by user");
        return this.failure(toolCallId, allOutputs.join("\n\n"));
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        allOutputs.push(
          `\u274C Stopped: poll budget exhausted after ${attempt} attempt(s) \u2014 the agent's task budget (${budgetMs}ms) is smaller than the requested poll budget (${pollBudgetMs(args)}ms). Re-run poll to keep waiting.`
        );
        return this.failure(toolCallId, allOutputs.join("\n\n"));
      }
      const output = await this._runCheck(command, cwd, Math.min(commandTimeout, remainingMs));
      const exitCode = output.exitCode;
      allOutputs.push(
        `[Attempt ${attempt + 1}/${maxAttempts}] (exit=${exitCode})
${output.stdout}`
      );
      if (successPattern) {
        try {
          const regex = new RegExp(successPattern);
          if (regex.test(output.stdout)) {
            allOutputs.push(`\u2705 Success: output matched pattern "${successPattern}"`);
            return this.success(toolCallId, allOutputs.join("\n\n"));
          }
        } catch (err) {
          return this.failure(
            toolCallId,
            `Invalid regex pattern "${successPattern}": ${err.message}`
          );
        }
      } else if (exitCode === 0) {
        allOutputs.push(`\u2705 Success: command exited with code 0`);
        return this.success(toolCallId, allOutputs.join("\n\n"));
      }
      if (attempt < maxAttempts - 1) {
        if (signal?.aborted) {
          allOutputs.push("\u23F9\uFE0F Poll cancelled by user");
          return this.failure(toolCallId, allOutputs.join("\n\n"));
        }
        const delay = Math.min(initialDelay * Math.pow(2, attempt), maxDelay);
        const delayMs = delay * 1e3;
        allOutputs.push(
          `\u23F3 Waiting ${delay}s before next poll (attempt ${attempt + 2}/${maxAttempts})...`
        );
        await this._sleep(Math.min(delayMs, Math.max(0, deadline - Date.now())), signal);
      }
    }
    allOutputs.push(
      `\u274C Failed: condition not met after ${maxAttempts} attempts (total wait ~${this._totalWaitTime(initialDelay, maxDelay, maxAttempts)}s)`
    );
    return this.failure(toolCallId, allOutputs.join("\n\n"));
  }
  async _runCheck(command, cwd, timeout) {
    return new Promise((resolve12) => {
      const chunks = [];
      let settled = false;
      let exitCode = null;
      const instance = this._terminalService.createTerminal({
        config: {
          name: "Agent Poll Check",
          cwd,
          isFeatureTerminal: true
        }
      });
      const cleanup = () => {
        clearTimeout(timer);
        dataDisposable.dispose();
        exitDisposable.dispose();
        instance.dispose();
      };
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          resolve12({
            stdout: chunks.join("").trim(),
            exitCode: exitCode ?? -1
          });
        }
      }, timeout);
      const dataDisposable = instance.onData((data) => {
        chunks.push(data);
      });
      const exitDisposable = instance.onExit((code) => {
        if (!settled) {
          settled = true;
          exitCode = code?.code ?? null;
          cleanup();
          clearTimeout(timer);
          resolve12({
            stdout: chunks.join("").trim(),
            exitCode: exitCode ?? null
          });
        }
      });
      instance.sendText(command, true);
    });
  }
  _sleep(ms, signal) {
    return new Promise((resolve12, reject) => {
      const timer = setTimeout(resolve12, ms);
      if (signal) {
        const onAbort = () => {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
        };
        if (signal.aborted) {
          clearTimeout(timer);
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  }
  /**
   * Calculate approximate total wait time for the failure message.
   */
  _totalWaitTime(initial, max, attempts) {
    let total = 0;
    for (let i = 0; i < attempts - 1; i++) {
      total += Math.min(initial * Math.pow(2, i), max);
    }
    return total;
  }
};

// src/vs/workbench/contrib/agent/common/agentMcp.ts
var import_node_child_process = require("node:child_process");
var fs4 = __toESM(require("node:fs"));
var os4 = __toESM(require("node:os"));
var path5 = __toESM(require("node:path"));
var DEFAULT_MCP_TOOL_TIMEOUT_MS = 3e5;
function expandHome(p) {
  if (p.startsWith("~/")) return path5.join(os4.homedir(), p.slice(2));
  return p;
}
function parseRpcBody(text, wantId) {
  const trimmed = (text || "").trim();
  if (!trimmed) return void 0;
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
    }
  }
  const payloads = [];
  for (const line of trimmed.split("\n")) {
    const l = line.trim();
    if (!l.startsWith("data:")) continue;
    const payload = l.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    try {
      payloads.push(JSON.parse(payload));
    } catch {
    }
  }
  if (payloads.length === 0) return void 0;
  if (wantId !== void 0) {
    const match = payloads.find((p) => p && p.id === wantId);
    if (match) return match;
  }
  return payloads.reverse().find((p) => p && p.id !== void 0) || payloads[0];
}
function isSessionError(msg) {
  return /session/i.test(msg) && /not found|expired|missing|invalid/i.test(msg);
}
var HttpMcpTransport = class {
  constructor(_url, _headers, _timeoutMs) {
    this._url = _url;
    this._headers = _headers;
    this._timeoutMs = _timeoutMs;
  }
  _sessionId;
  _rid = 0;
  _initialized = false;
  async _send(payload, expectResponse) {
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...this._headers
    };
    if (this._sessionId) headers["mcp-session-id"] = this._sessionId;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeoutMs);
    try {
      const res = await fetch(this._url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const sid = res.headers.get("mcp-session-id");
      if (sid) this._sessionId = sid;
      const text = await res.text();
      if (!expectResponse) return void 0;
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 400)}`);
      const json = parseRpcBody(text, payload.id);
      if (!json) throw new Error(`empty/invalid MCP response: ${text.slice(0, 400)}`);
      if (json.error) throw new Error(`MCP error ${json.error.code ?? ""}: ${json.error.message}`);
      return json.result;
    } finally {
      clearTimeout(timer);
    }
  }
  async initialize() {
    this._sessionId = void 0;
    this._initialized = false;
    await this._send({
      jsonrpc: "2.0",
      id: ++this._rid,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "code-agent", version: "1.0" }
      }
    }, true);
    try {
      await this._send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }, false);
    } catch {
    }
    this._initialized = true;
  }
  async _call(method, params) {
    if (!this._initialized) await this.initialize();
    return this._send({ jsonrpc: "2.0", id: ++this._rid, method, params }, true);
  }
  async listTools() {
    const r = await this._call("tools/list", {});
    return r && r.tools || [];
  }
  async callTool(name, args) {
    try {
      return await this._callToolOnce(name, args);
    } catch (e) {
      const msg = e.message || String(e);
      if (isSessionError(msg)) {
        await this.initialize();
        return this._callToolOnce(name, args);
      }
      throw e;
    }
  }
  async _callToolOnce(name, args) {
    const r = await this._call("tools/call", { name, arguments: args });
    const content = r && r.content || [];
    const text = content.map((c) => c && c.type === "text" ? c.text : JSON.stringify(c)).join("\n");
    if (r && r.isError) throw new Error(text || `MCP tool ${name} reported an error`);
    return text || "(empty result)";
  }
  dispose() {
  }
};
var StdioMcpTransport = class {
  constructor(_command, _args, _env) {
    this._command = _command;
    this._args = _args;
    this._env = _env;
  }
  _proc;
  _rid = 0;
  _buf = "";
  _pending = /* @__PURE__ */ new Map();
  _initialized = false;
  async initialize() {
    this.dispose();
    const proc = (0, import_node_child_process.spawn)(this._command, this._args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...this._env }
    });
    this._proc = proc;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (d) => this._onData(d));
    proc.stderr.on("data", () => {
    });
    proc.on("exit", () => {
      for (const [, p] of this._pending) p.reject(new Error("MCP stdio process exited"));
      this._pending.clear();
    });
    await this._request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "code-agent", version: "1.0" }
    });
    this._notify("notifications/initialized", {});
    this._initialized = true;
  }
  _onData(chunk) {
    this._buf += chunk;
    let nl;
    while ((nl = this._buf.indexOf("\n")) >= 0) {
      const line = this._buf.slice(0, nl).trim();
      this._buf = this._buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg && msg.id !== void 0 && this._pending.has(msg.id)) {
        const p = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`MCP error ${msg.error.code ?? ""}: ${msg.error.message}`));
        else p.resolve(msg.result);
      }
    }
  }
  _notify(method, params) {
    try {
      this._proc?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    } catch {
    }
  }
  _request(method, params) {
    return new Promise((resolve12, reject) => {
      if (!this._proc) return reject(new Error("MCP stdio process not started"));
      const id = ++this._rid;
      this._pending.set(id, { resolve: resolve12, reject });
      try {
        this._proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      } catch (e) {
        this._pending.delete(id);
        reject(e);
      }
    });
  }
  async listTools() {
    if (!this._initialized) await this.initialize();
    const r = await this._request("tools/list", {});
    return r && r.tools || [];
  }
  async callTool(name, args) {
    if (!this._initialized) await this.initialize();
    const r = await this._request("tools/call", { name, arguments: args });
    const content = r && r.content || [];
    const text = content.map((c) => c && c.type === "text" ? c.text : JSON.stringify(c)).join("\n");
    if (r && r.isError) throw new Error(text || `MCP tool ${name} reported an error`);
    return text || "(empty result)";
  }
  dispose() {
    try {
      this._proc?.kill();
    } catch {
    }
    this._proc = void 0;
    this._pending.clear();
  }
};
var McpTool = class extends AgentTool {
  constructor(_server, _transport, def) {
    super();
    this._server = _server;
    this._transport = _transport;
    this.name = def.name;
    this.description = `[MCP:${_server}] ${def.description || def.name}`;
    const schema = def.inputSchema;
    this.parameters = schema && typeof schema === "object" && schema.type ? schema : { type: "object", properties: {} };
  }
  name;
  description;
  parameters;
  async execute(args) {
    const toolCallId = args._toolCallId || "";
    const clean = {};
    for (const [k, v] of Object.entries(args)) {
      if (k.startsWith("_")) continue;
      clean[k] = v;
    }
    try {
      const out = await this._transport.callTool(this.name, clean);
      return this.success(toolCallId, out);
    } catch (e) {
      return this.failure(toolCallId, `MCP ${this._server}/${this.name} failed: ${e.message || String(e)}`);
    }
  }
};
function loadMcpServersFromJsonFile(file) {
  const candidates = file ? [file] : [...agentHomeFileCandidates("mcp.json"), ...agentHomeFileCandidates(".mcp.json")];
  for (const c of candidates) {
    const p = expandHome(c);
    try {
      if (!fs4.existsSync(p)) continue;
      const raw = JSON.parse(fs4.readFileSync(p, "utf-8"));
      const servers = raw.mcpServers || {};
      return Object.entries(servers).map(([name, s]) => ({
        name,
        type: s.type,
        url: s.url,
        headers: s.headers,
        command: s.command,
        args: s.args,
        env: s.env,
        tools: Array.isArray(s.tools) ? s.tools : void 0
      }));
    } catch (e) {
    }
  }
  return [];
}
function intersectAllow(perServer, global) {
  const a = perServer && perServer.length > 0 ? new Set(perServer) : void 0;
  const b = global && global.length > 0 ? new Set(global) : void 0;
  if (!a && !b) return void 0;
  if (a && b) return new Set([...a].filter((x) => b.has(x)));
  return a || b;
}
async function createMcpTools(specs, logger, opts = {}) {
  const tools = [];
  const transports = [];
  const seen = /* @__PURE__ */ new Set();
  const skip = new Set(opts.skipServers || []);
  const timeoutMs = opts.timeoutMs || DEFAULT_MCP_TOOL_TIMEOUT_MS;
  for (const spec of specs) {
    if (skip.has(spec.name)) continue;
    if (!spec.url && !spec.command) {
      logger(`[MCP] skip "${spec.name}": neither url nor command configured`);
      continue;
    }
    let transport;
    try {
      transport = spec.url ? new HttpMcpTransport(spec.url, spec.headers || {}, timeoutMs) : new StdioMcpTransport(spec.command, spec.args || [], spec.env || {});
      await transport.initialize();
      const defs = await transport.listTools();
      const allow = intersectAllow(spec.tools, opts.allowTools);
      let loaded = 0;
      for (const def of defs) {
        if (!def || !def.name) continue;
        if (allow && !allow.has(def.name)) continue;
        if (seen.has(def.name)) {
          logger(`[MCP] duplicate tool "${def.name}" from "${spec.name}" \u2014 keeping the first one`);
          continue;
        }
        seen.add(def.name);
        tools.push(new McpTool(spec.name, transport, def));
        loaded++;
      }
      transports.push(transport);
      const suffix = allow ? ` (allowlist of ${allow.size})` : "";
      logger(`[MCP] ${spec.name}: ${loaded}/${defs.length} tools loaded${suffix}`);
    } catch (e) {
      logger(`[MCP] ${spec.name} failed: ${e.message || String(e)}`);
      try {
        transport?.dispose();
      } catch {
      }
    }
  }
  return { tools, transports };
}
async function registerMcpTools(registry, specs, logger, opts = {}) {
  const { tools, transports } = await createMcpTools(specs, logger, opts);
  let count = 0;
  for (const tool of tools) {
    if (registry.has(tool.name)) {
      logger(`[MCP] tool "${tool.name}" already registered \u2014 skipped`);
      continue;
    }
    registry.register(tool);
    count++;
  }
  return { count, transports };
}

// src/vs/workbench/contrib/agent/common/agentModelRouter.ts
var VISION_KEYWORDS = [
  "\u56FE\u7247",
  "\u56FE\u50CF",
  "\u622A\u56FE",
  "\u770B\u56FE",
  "\u8BC6\u56FE",
  "\u7167\u7247",
  "\u753B\u9762",
  "\u89C6\u89C9",
  "screenshot",
  "image",
  "picture",
  "photo",
  "vision",
  "ocr",
  "ui\u56FE",
  "ui\u622A\u56FE"
];
var REASONING_KEYWORDS = [
  "refactor",
  "\u91CD\u6784",
  "migrate",
  "\u8FC1\u79FB",
  "implement",
  "\u5B9E\u73B0",
  "redesign",
  "\u91CD\u65B0\u8BBE\u8BA1",
  "complex",
  "\u590D\u6742",
  "multiple files",
  "architecture",
  "\u67B6\u6784",
  "performance",
  "\u6027\u80FD",
  "debugging",
  "\u8C03\u8BD5",
  "optimize",
  "\u4F18\u5316",
  "overhaul",
  "rewrite",
  "\u91CD\u5199",
  "refactoring"
];
var ModelRouter = class {
  constructor(_routing, _profiles, _fallback) {
    this._routing = _routing;
    this._profiles = _profiles;
    this._fallback = _fallback;
  }
  get enabled() {
    return this._routing.enabled;
  }
  get scenarios() {
    return this._routing.scenarios || {};
  }
  /**
   * The 保底 (guaranteed fallback) model id, resolved from
   * `model_routing.fallback` in config.yaml. Undefined when unset.
   */
  get fallbackModelId() {
    return this._routing.fallbackModel;
  }
  /**
   * Optional override for how often the background probe re-checks the primary
   * model while the agent runs on the 保底 model (ms). From
   * `model_routing.fallback_probe_interval_s`. Undefined = built-in schedule.
   */
  get probeIntervalMs() {
    return this._routing.probeIntervalMs;
  }
  /**
   * Detect the scenario of a prompt. Returns one of the built-in scenario keys:
   * 'vision' | 'reasoning' | 'fast'.
   */
  detectScenario(prompt) {
    const lower = prompt.toLowerCase();
    if (VISION_KEYWORDS.some((k) => lower.includes(k.toLowerCase()))) {
      return "vision";
    }
    if (REASONING_KEYWORDS.some((k) => lower.includes(k.toLowerCase()))) {
      return "reasoning";
    }
    return "fast";
  }
  /**
   * Resolve a model id / profile name to a full config. Matches by profile key
   * first, then by the profile's `model` value as a convenience.
   */
  resolveModel(modelId) {
    if (!modelId) return void 0;
    if (this._profiles[modelId]) return this._profiles[modelId];
    for (const p of Object.values(this._profiles)) {
      if (p.model === modelId) return p;
    }
    return void 0;
  }
  /**
   * Select the model config for a prompt. Falls back through:
   * scenario model → default model → active profile config.
   */
  selectConfig(prompt) {
    if (!this.enabled) return this._fallback;
    const scenario = this.detectScenario(prompt);
    const modelId = this._routing.scenarios?.[scenario] ?? this._routing.defaultModel;
    return this.resolveModel(modelId) ?? this._fallback;
  }
  /**
   * Resolve the 保底 (guaranteed fallback) model config used when the
   * scenario/default model times out. Returns undefined when no fallback is
   * configured, when routing is disabled, or when the fallback id cannot be
   * resolved to a known model.
   */
  fallbackConfig() {
    if (!this.enabled) return void 0;
    const id = this._routing.fallbackModel;
    if (!id) return void 0;
    return this.resolveModel(id);
  }
  /** Returns the scenario and selected model name for a prompt (used for logging). */
  describe(prompt) {
    const scenario = this.detectScenario(prompt);
    const config = this.selectConfig(prompt);
    return { scenario, model: config.model };
  }
};

// src/vs/workbench/contrib/agent/common/agentSkills.ts
var fs5 = __toESM(require("node:fs"));
var path6 = __toESM(require("node:path"));
function parseFrontmatter(text) {
  const meta = {};
  let body = text;
  if (text.startsWith("---")) {
    const endIdx = text.indexOf("---", 3);
    if (endIdx > 0) {
      const frontmatter = text.substring(3, endIdx).trim();
      body = text.substring(endIdx + 3).trim();
      let currentKey = "";
      let blockKey = "";
      let blockIndent = 0;
      for (const line of frontmatter.split("\n")) {
        const trimmed = line.trim();
        const indent = line.length - line.trimStart().length;
        if (blockKey) {
          if (trimmed === "" || indent > blockIndent) {
            if (trimmed) meta[blockKey] = ((meta[blockKey] || "") + " " + trimmed).trim();
            continue;
          }
          blockKey = "";
        }
        if (trimmed.startsWith("- ") && currentKey) {
          const itemVal = trimmed.slice(2).trim();
          if (itemVal) {
            const existing = meta[currentKey] || "";
            meta[currentKey] = existing ? existing + "\n" + itemVal : itemVal;
          }
        } else if (trimmed.includes(":") && !trimmed.startsWith("-")) {
          const colonIdx = trimmed.indexOf(":");
          currentKey = trimmed.substring(0, colonIdx).trim();
          const val = trimmed.substring(colonIdx + 1).trim();
          if (/^[|>][+-]?\d*$/.test(val)) {
            meta[currentKey] = "";
            blockKey = currentKey;
            blockIndent = indent;
          } else {
            meta[currentKey] = val;
          }
        } else if (currentKey && trimmed && !trimmed.startsWith("-")) {
          meta[currentKey] = ((meta[currentKey] || "") + " " + trimmed).trim();
        }
      }
    }
  }
  return { meta, body };
}
var SkillsLoader = class {
  _skills = [];
  _rules = [];
  loadSkillsFromDirs(dirs) {
    for (const dir of dirs) {
      if (!fs5.existsSync(dir)) continue;
      this._scanForSkills(dir);
    }
  }
  loadRulesFromDirs(dirs) {
    for (const dir of dirs) {
      if (!fs5.existsSync(dir)) continue;
      this._scanForRules(dir);
    }
  }
  /**
   * Load Claude-style instruction files (`agent.md`).
   *
   * A single Markdown file replaces a directory of `.mdc` rules for the
   * common case, and it is meant to be ALWAYS active: global instructions live
   * in `~/.agents/agent.md`, project instructions in `<project>/.agents/agent.md`
   * (see agentInstructionFiles()). Frontmatter is optional; `description`, when
   * absent, comes from the first non-empty line so the file renders like a rule.
   */
  loadAgentMdFiles(paths) {
    for (const filePath of paths) {
      if (!fs5.existsSync(filePath)) continue;
      this._loadAgentMd(filePath);
    }
  }
  get skills() {
    return this._skills;
  }
  get rules() {
    return this._rules;
  }
  getSkillByName(name) {
    return this._skills.find(
      (s) => s.name.toLowerCase() === name.toLowerCase() || s.filePath.toLowerCase().includes(name.toLowerCase())
    );
  }
  getAlwaysApplyRules() {
    return this._rules.filter((r) => r.alwaysApply);
  }
  buildSkillsPromptSection(preActivatedSkillNames) {
    if (this._skills.length === 0) return "";
    const lines = ["\n## Available Skills\n"];
    lines.push("You can leverage the following specialized skills when relevant:\n");
    for (const skill of this._skills) {
      const isPreActivated = preActivatedSkillNames?.has(skill.name);
      lines.push(`### ${skill.name}`);
      if (skill.description) {
        lines.push(skill.description);
      }
      lines.push(`Path: ${skill.filePath}`);
      if (skill.triggers.length > 0) {
        lines.push(`Triggers: ${skill.triggers.join(", ")}`);
      }
      if (skill.whenToUse) {
        lines.push(`When to use: ${skill.whenToUse}`);
      }
      if (!skill.modelInvocable) {
        lines.push("Invocation: manual only (not auto-activated)");
      }
      if (isPreActivated) {
        lines.push("");
        lines.push("> **This skill has been auto-activated based on your task.**");
        lines.push("> Follow the instructions below as mandatory guidance.");
        lines.push("");
        lines.push(skill.content);
      }
      lines.push("");
    }
    return lines.join("\n");
  }
  /**
   * Rules excluded from a host's prompt (e.g. the IDE-only AskQuestion rule in
   * the CLI). Matching is by rule IDENTITY — file name and description — never
   * by the rule body: a rule like `agent.md` may legitimately MENTION another
   * rule's topic, and a content match would then silently drop the whole file.
   */
  _filterRules(rules, excludePatterns) {
    if (!excludePatterns || excludePatterns.length === 0) return rules;
    return rules.filter((rule) => {
      const identity = `${path6.basename(rule.filePath)} ${rule.description}`.toLowerCase();
      return !excludePatterns.some((p) => identity.includes(p.toLowerCase()));
    });
  }
  buildRulesPromptSection(excludePatterns) {
    let alwaysRules = this.getAlwaysApplyRules();
    alwaysRules = this._filterRules(alwaysRules, excludePatterns);
    if (alwaysRules.length === 0) return "";
    const lines = ["\n## Active Rules\n"];
    for (const rule of alwaysRules) {
      lines.push(rule.content);
      lines.push("");
    }
    return lines.join("\n");
  }
  /**
   * Preload ALL global rules content into the system prompt at task startup.
   * Each rule includes its description so the agent can auto-match when a
   * user's prompt aligns with a rule's purpose. Unlike buildRulesPromptSection()
   * which only includes alwaysApply rules, this method loads EVERY rule so
   * the agent can dynamically activate the right one.
   */
  buildPreloadRulesPromptSection(excludePatterns) {
    let rules = [...this._rules];
    rules = this._filterRules(rules, excludePatterns);
    if (rules.length === 0) return "";
    const lines = ["\n## Preloaded Rules\n"];
    lines.push("The following rules are preloaded for auto-matching. When the user's request matches a rule's description, automatically apply that rule's instructions:\n");
    for (const rule of rules) {
      lines.push(`### Rule: ${rule.description}`);
      if (rule.alwaysApply) {
        lines.push("(Always Active)");
      }
      lines.push(rule.content);
      lines.push("");
    }
    return lines.join("\n");
  }
  getSkillContent(skillName) {
    const skill = this.getSkillByName(skillName);
    return skill?.content;
  }
  /**
   * Auto-match skills against the user's task description using keyword matching.
   *
   * Matching strategy (in priority order):
   * 1. Exact trigger keyword match in the task (strongest signal)
   * 2. Description keyword overlap with the task
   * 3. Skill name mentioned in the task
   *
   * Returns a Set of skill names that should be pre-activated.
   *
   * @param taskDescription - The user's task/query to match against
   * @param maxSkills - Maximum number of skills to auto-activate (default: 5, to avoid context bloat)
   */
  getAutoMatchedSkills(taskDescription, maxSkills = 5) {
    if (!taskDescription || this._skills.length === 0) return /* @__PURE__ */ new Set();
    const lowerTask = taskDescription.toLowerCase();
    const scored = [];
    for (const skill of this._skills) {
      let score = 0;
      for (const trigger of skill.triggers) {
        const lowerTrigger = trigger.toLowerCase();
        if (lowerTask.includes(lowerTrigger)) {
          score += 10;
        }
      }
      if (lowerTask.includes(skill.name.toLowerCase())) {
        score += 15;
      }
      if (skill.description) {
        const descWords = new Set(
          skill.description.toLowerCase().split(/[\s,，、;；:：\n\t]+/).filter((w) => w.length >= 2)
        );
        const taskWords = new Set(
          lowerTask.split(/[\s,，、;；:：\n\t]+/).filter((w) => w.length >= 2)
        );
        for (const w of descWords) {
          if (taskWords.has(w)) score += 2;
        }
        for (const dw of descWords) {
          if (dw.length >= 2) {
            for (const tw of taskWords) {
              if (tw.length >= 2 && (tw.includes(dw) || dw.includes(tw))) {
                score += 1;
                break;
              }
            }
          }
        }
      }
      if (score > 0) {
        scored.push({ name: skill.name, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const result = /* @__PURE__ */ new Set();
    for (const s of scored.slice(0, maxSkills)) {
      result.add(s.name);
    }
    return result;
  }
  /**
   * Build the "Skills of Skills" (meta-skill) prompt section.
   *
   * This ports dsh-run2skill's skill packaging logic into a prompt contract so
   * the agent itself can create, catalog, recall and publish well-formed skills:
   *
   *   - Canonical SKILL.md contract (renderCanonicalSkill / validateSkillProposal)
   *   - Dedup/recall before CREATE (recallExistingSkills → COVERED/PARTIAL/UNRELATED)
   *   - Publication location (first configured skills dir)
   *
   * The matching tool implementations live in agentSkillFactory.ts and
   * tools/skillTools.ts (skill_catalog / create_skill / update_skill).
   */
  buildMetaSkillPromptSection(skillsDirs) {
    const primaryDir = skillsDirs[0] || "~/.agents/skills";
    return `
## Skill Crafting (Meta-Skill: skills of skills)
You manage your own reusable skill library. Skills are Cursor-compatible \`SKILL.md\` files loaded from: ${skillsDirs.join(", ") || "~/.agents/skills"} (primary: ${primaryDir}).

### When to create or update a skill
- The user explicitly asks to save a workflow/constraint as a reusable skill ("\u4FDD\u5B58\u4E3Askill", "save this as a skill").
- You notice the same reusable workflow, constraint, or correction appearing across tasks.

### Canonical SKILL.md contract (MUST follow \u2014 use the create_skill / update_skill tools)
- Frontmatter fields: \`name\` (lowercase-kebab-case, e.g. \`cpp-forge\`), \`description\` (one or two sentences, what + when), optional \`whenToUse\` (situations it applies to), optional \`trigger:\` keyword list for auto-matching, \`disable-model-invocation\` and \`user-invocable\` flags.
- Body: complete, executable Markdown that MUST start with a heading (\`# ...\`). Keep it focused and under 60 KB.
- Write description/whenToUse/content in the user's working language (Simplified Chinese by default); keep code, commands and identifiers unchanged.

### Dedup before creating (CRITICAL)
1. Call \`skill_catalog\` with a query describing the new capability BEFORE \`create_skill\`.
2. If recall says \`COVERED\` \u2014 do NOT create a duplicate; prefer \`update_skill\` to extend the existing skill.
3. If recall says \`PARTIAL\` \u2014 extend the existing skill via \`update_skill\` (merge), or create only when the workflows are materially different.
4. If recall says \`UNRELATED\` and no same-name skill exists \u2014 safe to \`create_skill\`.

### Publication
- New skills are published to \`{primaryDir}/{name}/SKILL.md\`. Never overwrite an existing skill unless the user approves (or pass \`force: true\` after confirmation).
- After creating/updating a skill, tell the user the file path and that a new session (or \`/skills\`) will pick it up.`;
  }
  /**
   * Build full context prompt with all rules and skills.
   * Optionally accepts a task description for auto-matching skills.
   */
  buildFullContextPrompt(taskDescription, excludeRulePatterns, skillsDirs) {
    let prompt = "";
    const rulesSection = this.buildPreloadRulesPromptSection(excludeRulePatterns);
    if (rulesSection) prompt += rulesSection;
    let preActivatedSkills;
    if (taskDescription) {
      preActivatedSkills = this.getAutoMatchedSkills(taskDescription);
    }
    const skillsSection = this.buildSkillsPromptSection(preActivatedSkills);
    if (skillsSection) prompt += skillsSection;
    if (skillsDirs && skillsDirs.length > 0) {
      prompt += this.buildMetaSkillPromptSection(skillsDirs);
    }
    return prompt;
  }
  /**
   * Classify a directory entry, FOLLOWING SYMLINKS.
   *
   * `Dirent.isDirectory()` / `isFile()` are false for a symlink, so a skill
   * installed the documented way (`ln -s …/skills/langfuse ~/.agents/skills/langfuse`,
   * the method the Langfuse/Anthropic skill repos prescribe) used to be skipped
   * silently. A broken link must stay harmless, hence the try/catch.
   */
  _entryKind(dir, entry) {
    if (entry.isDirectory()) return "dir";
    if (entry.isFile()) return "file";
    if (!entry.isSymbolicLink()) return "other";
    try {
      const stat = fs5.statSync(path6.join(dir, entry.name));
      if (stat.isDirectory()) return "dir";
      if (stat.isFile()) return "file";
    } catch {
    }
    return "other";
  }
  _scanForSkills(dir) {
    try {
      const entries = fs5.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path6.join(dir, entry.name);
        const kind = this._entryKind(dir, entry);
        if (kind === "dir") {
          const skillFile = path6.join(fullPath, "SKILL.md");
          if (fs5.existsSync(skillFile)) {
            this._loadSkill(skillFile, entry.name);
          }
        } else if (kind === "file" && entry.name === "SKILL.md") {
          this._loadSkill(fullPath, path6.basename(dir));
        }
      }
    } catch {
    }
  }
  _loadSkill(filePath, fallbackName) {
    try {
      const raw = fs5.readFileSync(filePath, "utf-8");
      const { meta, body } = parseFrontmatter(raw);
      const triggers = meta.trigger ? meta.trigger.split("\n").map((t) => t.trim()).filter((t) => t.length > 0) : [];
      const whenToUse = meta.whenToUse?.trim() || void 0;
      const modelInvocable = meta["disable-model-invocation"] !== "true";
      const userInvocable = meta["user-invocable"] === "true";
      this._skills.push({
        name: meta.name || fallbackName,
        description: meta.description || "",
        filePath,
        content: body,
        triggers,
        ...whenToUse ? { whenToUse } : {},
        modelInvocable,
        userInvocable
      });
    } catch {
    }
  }
  _scanForRules(dir) {
    try {
      const entries = fs5.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (this._entryKind(dir, entry) === "file" && entry.name.endsWith(".mdc")) {
          this._loadRule(path6.join(dir, entry.name));
        }
      }
    } catch {
    }
  }
  _loadRule(filePath) {
    try {
      const raw = fs5.readFileSync(filePath, "utf-8");
      const { meta, body } = parseFrontmatter(raw);
      this._rules.push({
        description: meta.description || path6.basename(filePath, ".mdc"),
        filePath,
        content: body,
        alwaysApply: meta.alwaysApply === "true"
      });
    } catch {
    }
  }
  /** Load one `agent.md` instruction file as an always-apply rule. */
  _loadAgentMd(filePath) {
    try {
      const raw = fs5.readFileSync(filePath, "utf-8");
      const { meta, body } = parseFrontmatter(raw);
      const heading = body.split("\n").map((l) => l.trim()).find((l) => l.length > 0) || "";
      const fallback = heading.replace(/^#+\s*/, "").slice(0, 120) || path6.basename(filePath);
      this._rules.push({
        description: meta.description || `agent.md instructions (${fallback})`,
        filePath,
        content: body,
        // Instructions are active by default; opt out with `alwaysApply: false`.
        alwaysApply: meta.alwaysApply !== "false"
      });
    } catch {
    }
  }
};

// src/vs/workbench/contrib/agent/common/agentSkillFactory.ts
var fs6 = __toESM(require("node:fs"));
var path7 = __toESM(require("node:path"));
var os5 = __toESM(require("node:os"));
var SkillFactoryError = class extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "SkillFactoryError";
  }
};
var NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
var MARKDOWN_HEADING = /^#{1,6}\s+\S/m;
var MAX_DESCRIPTION_BYTES = 2 * 1024;
var MAX_WHEN_TO_USE_BYTES = 4 * 1024;
var MAX_CONTENT_BYTES = 60 * 1024;
var MAX_TRIGGERS = 24;
function utf8Bytes(value) {
  return Buffer.byteLength(value, "utf8");
}
function normalizeNewlines(value) {
  return value.replace(/\r\n?/g, "\n");
}
function validateSkillProposal(proposal) {
  if (!proposal.name || !NAME_PATTERN.test(proposal.name)) {
    throw new SkillFactoryError(
      "INVALID_NAME",
      `Skill name must match lowercase-kebab-case (e.g. "cpp-forge"), got: "${proposal.name}"`
    );
  }
  const description = normalizeNewlines(proposal.description || "").trim();
  if (description.length === 0) {
    throw new SkillFactoryError("INVALID_DESCRIPTION", "Skill description is required");
  }
  if (utf8Bytes(description) > MAX_DESCRIPTION_BYTES) {
    throw new SkillFactoryError("INVALID_DESCRIPTION", `Skill description exceeds ${MAX_DESCRIPTION_BYTES} UTF-8 bytes`);
  }
  if (proposal.whenToUse !== void 0 && utf8Bytes(proposal.whenToUse) > MAX_WHEN_TO_USE_BYTES) {
    throw new SkillFactoryError("INVALID_WHEN_TO_USE", `Skill whenToUse exceeds ${MAX_WHEN_TO_USE_BYTES} UTF-8 bytes`);
  }
  const content = normalizeNewlines(proposal.content || "");
  if (!MARKDOWN_HEADING.test(content)) {
    throw new SkillFactoryError("INVALID_CONTENT", "Skill content must be complete Markdown that starts with a heading");
  }
  if (utf8Bytes(content) > MAX_CONTENT_BYTES) {
    throw new SkillFactoryError("INVALID_CONTENT", `Skill content exceeds ${MAX_CONTENT_BYTES} UTF-8 bytes`);
  }
  if (proposal.triggers && proposal.triggers.length > MAX_TRIGGERS) {
    throw new SkillFactoryError("INVALID_TRIGGERS", `Skill triggers exceed ${MAX_TRIGGERS} entries`);
  }
}
function renderCanonicalSkill(input) {
  validateSkillProposal(input);
  const body = normalizeNewlines(input.content).replace(/\n+$/g, "");
  const metadata = [
    "---",
    `name: ${input.name}`,
    `description: ${JSON.stringify(normalizeNewlines(input.description).trim())}`
  ];
  if (input.whenToUse !== void 0 && input.whenToUse.trim().length > 0) {
    metadata.push(`whenToUse: ${JSON.stringify(normalizeNewlines(input.whenToUse).trim())}`);
  }
  const triggers = (input.triggers || []).map((t) => t.trim()).filter((t) => t.length > 0);
  if (triggers.length > 0) {
    metadata.push("trigger:");
    for (const trigger of triggers.slice(0, MAX_TRIGGERS)) {
      metadata.push(`  - ${trigger}`);
    }
  }
  metadata.push(`disable-model-invocation: ${String(input.modelInvocable === false)}`);
  metadata.push(`user-invocable: ${String(input.userInvocable === true)}`);
  metadata.push("---");
  return `${metadata.join("\n")}

${body}
`;
}
function parseSkillMetadata(raw) {
  const meta = {};
  let body = raw;
  if (raw.startsWith("---")) {
    const endIdx = raw.indexOf("---", 3);
    if (endIdx > 0) {
      const frontmatter = raw.substring(3, endIdx).trim();
      body = raw.substring(endIdx + 3).trim();
      let currentKey = "";
      for (const line of frontmatter.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("- ") && currentKey) {
          const itemVal = trimmed.slice(2).trim();
          if (itemVal) {
            const existing = meta[currentKey] || "";
            meta[currentKey] = existing ? existing + "\n" + itemVal : itemVal;
          }
        } else if (trimmed.includes(":") && !trimmed.startsWith("-")) {
          const colonIdx = trimmed.indexOf(":");
          currentKey = trimmed.substring(0, colonIdx).trim();
          let val = trimmed.substring(colonIdx + 1).trim();
          if (val === ">" || val === "|") val = "";
          meta[currentKey] = val;
        } else if (currentKey && trimmed && !trimmed.startsWith("-")) {
          meta[currentKey] = ((meta[currentKey] || "") + " " + trimmed).trim();
        }
      }
    }
  }
  const unquote = (value) => {
    const v = value.trim();
    if (v.length >= 2 && (v.startsWith('"') && v.endsWith('"') || v.startsWith("'") && v.endsWith("'"))) {
      try {
        return v.startsWith('"') ? JSON.parse(v) : v.slice(1, -1);
      } catch {
        return v.slice(1, -1);
      }
    }
    return v;
  };
  const triggers = (meta.trigger || "").split("\n").map((t) => t.trim()).filter((t) => t.length > 0);
  return {
    name: (meta.name || "").trim(),
    description: unquote(meta.description || ""),
    ...meta.whenToUse ? { whenToUse: unquote(meta.whenToUse) } : {},
    triggers,
    modelInvocable: meta["disable-model-invocation"] !== "true",
    userInvocable: meta["user-invocable"] === "true"
  };
}
var FILESYSTEM_PROVIDER = "filesystem";
function scanSkillCatalog(dirs) {
  const skills = [];
  const seen = /* @__PURE__ */ new Set();
  const complete = true;
  for (const dir of dirs) {
    if (!fs6.existsSync(dir)) continue;
    let entries;
    try {
      entries = fs6.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path7.join(dir, entry.name);
      let skillFile;
      let skillName = entry.name;
      if (entry.isDirectory()) {
        const candidate = path7.join(fullPath, "SKILL.md");
        if (fs6.existsSync(candidate)) skillFile = candidate;
      } else if (entry.name === "SKILL.md") {
        skillFile = fullPath;
        skillName = path7.basename(dir);
      }
      if (!skillFile) continue;
      const key = `${skillName}@${skillFile}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let raw;
      try {
        raw = fs6.readFileSync(skillFile, "utf-8");
      } catch {
        continue;
      }
      const meta = parseSkillMetadata(raw);
      const entrySummary = {
        name: meta.name || skillName,
        description: meta.description,
        ...meta.whenToUse ? { whenToUse: meta.whenToUse } : {},
        triggers: meta.triggers,
        source: "filesystem",
        provider: FILESYSTEM_PROVIDER,
        path: skillFile,
        modelInvocable: meta.modelInvocable,
        userInvocable: meta.userInvocable
      };
      skills.push(entrySummary);
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, complete };
}
var MAX_QUERY_TOKENS = 64;
var STOP_WORDS = /* @__PURE__ */ new Set([
  "a",
  "an",
  "and",
  "for",
  "in",
  "of",
  "on",
  "please",
  "the",
  "this",
  "to",
  "use"
]);
var CHINESE_STOP_WORDS = [
  "\u8FD9\u4E2A",
  "\u8FD9\u4E9B",
  "\u90A3\u4E2A",
  "\u90A3\u4E9B",
  "\u4E00\u4E2A",
  "\u4E00\u79CD",
  "\u6211\u4EEC",
  "\u4F60\u4EEC",
  "\u4F7F\u7528",
  "\u8FDB\u884C",
  "\u7528\u4E8E",
  "\u9700\u8981",
  "\u53EF\u4EE5",
  "\u8BF7"
];
function tokenizeForSkillRecall(value) {
  const normalized = value.normalize("NFKC").toLowerCase();
  const result = [];
  const seen = /* @__PURE__ */ new Set();
  const add = (token) => {
    if (token.length <= 1 || STOP_WORDS.has(token) || seen.has(token) || result.length >= MAX_QUERY_TOKENS) return;
    seen.add(token);
    result.push(token);
  };
  for (const match of normalized.matchAll(/[\p{Script=Latin}\p{Number}]+|[\p{Script=Han}]+/gu)) {
    const term = match[0];
    if (/^[\p{Script=Han}]+$/u.test(term)) {
      let meaningful = term;
      for (const stopWord of CHINESE_STOP_WORDS) meaningful = meaningful.replaceAll(stopWord, "");
      const characters = [...meaningful];
      for (let index = 0; index + 1 < characters.length; index += 1) {
        add(`${characters[index]}${characters[index + 1]}`);
      }
    } else {
      add(term);
    }
    if (result.length >= MAX_QUERY_TOKENS) break;
  }
  return result;
}
function overlapCount(value, query) {
  if (value === void 0) return 0;
  let count = 0;
  for (const token of tokenizeForSkillRecall(value)) {
    if (query.has(token)) count += 1;
  }
  return count;
}
function recallExistingSkills(snapshot, directEvidence, maxResults = 5) {
  const queryTokens = tokenizeForSkillRecall(directEvidence);
  const query = new Set(queryTokens);
  const scored = snapshot.skills.map((entry) => {
    const nameOverlap = overlapCount(entry.name, query);
    const whenToUseOverlap = overlapCount(entry.whenToUse, query);
    const descriptionOverlap = overlapCount(entry.description, query);
    return {
      entry,
      nameOverlap,
      whenToUseOverlap,
      descriptionOverlap,
      totalScore: nameOverlap * 3 + whenToUseOverlap * 2 + descriptionOverlap
    };
  }).filter((c) => c.totalScore > 0).sort((a, b) => b.totalScore - a.totalScore).slice(0, maxResults);
  const closest = scored[0];
  let classification = "UNRELATED";
  if (closest) {
    if (closest.nameOverlap > 0 && closest.totalScore >= 6) {
      classification = "COVERED";
    } else if (closest.totalScore >= 2) {
      classification = "PARTIAL";
    }
  }
  return { queryTokens, candidates: scored, classification, closest };
}
function defaultSkillsDir() {
  return path7.join(agentHomeDir(), "skills");
}
function publishSkill(skillsDir, proposal, options = {}) {
  validateSkillProposal(proposal);
  const root = (skillsDir && skillsDir.trim().length > 0 ? skillsDir : defaultSkillsDir()).replace(/^~(?=$|\/|\\)/, os5.homedir());
  const targetDir = path7.join(root, proposal.name);
  const targetPath = path7.join(targetDir, "SKILL.md");
  const existed = fs6.existsSync(targetPath);
  if (existed && !options.force) {
    return { status: "EXISTS", targetPath };
  }
  const rendered = renderCanonicalSkill(proposal);
  const tmpPath = path7.join(targetDir, `.SKILL.md.${process.pid}.${Date.now()}.tmp`);
  try {
    fs6.mkdirSync(targetDir, { recursive: true });
    fs6.writeFileSync(tmpPath, rendered, "utf-8");
    fs6.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      fs6.rmSync(tmpPath, { force: true });
    } catch {
    }
    throw new SkillFactoryError("PUBLISH_FAILED", `Failed to publish skill "${proposal.name}": ${err.message}`);
  }
  return { status: existed ? "UPDATED" : "CREATED", targetPath };
}
function readSkillDefinition(entry) {
  if (!entry.path) return void 0;
  try {
    const raw = fs6.readFileSync(entry.path, "utf-8");
    const meta = parseSkillMetadata(raw);
    let body = raw;
    if (raw.startsWith("---")) {
      const endIdx = raw.indexOf("\n---", 3);
      if (endIdx > 0) {
        body = raw.substring(endIdx + 5).trimStart();
      }
    }
    return {
      raw,
      proposal: {
        name: meta.name || entry.name,
        description: meta.description,
        ...meta.whenToUse ? { whenToUse: meta.whenToUse } : {},
        content: body,
        triggers: meta.triggers,
        modelInvocable: meta.modelInvocable,
        userInvocable: meta.userInvocable
      }
    };
  } catch {
    return void 0;
  }
}

// src/vs/workbench/contrib/agent/common/tools/skillTools.ts
function buildSkillCatalogSnapshot(skillsDirs) {
  return scanSkillCatalog(skillsDirs);
}
function formatCatalogEntry(entry, index) {
  const lines = [];
  const header = index !== void 0 ? `${index}. ` : "";
  lines.push(`${header}${entry.name} - ${entry.description}`);
  if (entry.whenToUse) lines.push(`   whenToUse: ${entry.whenToUse}`);
  if (entry.triggers.length > 0) lines.push(`   triggers: ${entry.triggers.join(", ")}`);
  if (entry.path) lines.push(`   path: ${entry.path}`);
  lines.push(`   invocation: ${entry.modelInvocable ? "model-invocable" : "manual"}${entry.userInvocable ? " / user-invocable" : ""}`);
  return lines.join("\n");
}
var SkillCatalogTool = class extends AgentTool {
  constructor(_skillsDirs) {
    super();
    this._skillsDirs = _skillsDirs;
  }
  name = "skill_catalog";
  description = "List all available skills (name, description, whenToUse, triggers, path). Pass an optional query to fuzzy-match (recall) existing skills ranked by relevance \u2014 use this BEFORE create_skill to avoid duplicates.";
  parameters = {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "Optional capability/task description used to rank existing skills by relevance (dedup/reuse check)"
      }
    },
    required: []
  };
  async execute(args, signal) {
    const toolCallId = args._toolCallId || "";
    if (signal?.aborted) {
      return this.failure(toolCallId, "Tool execution cancelled by user");
    }
    const snapshot = buildSkillCatalogSnapshot(this._skillsDirs);
    const query = args.query?.trim();
    if (!query) {
      if (snapshot.skills.length === 0) {
        return this.success(toolCallId, "No skills found. Configure skills directories in config.yaml.");
      }
      const body2 = [`Skills catalog (${snapshot.skills.length}):`, ""].concat(snapshot.skills.map((s, i) => formatCatalogEntry(s, i + 1))).join("\n");
      return this.success(toolCallId, body2);
    }
    const recall = recallExistingSkills(snapshot, query);
    if (recall.candidates.length === 0) {
      return this.success(toolCallId, `No existing skills match "${query}". Safe to CREATE a new skill.`);
    }
    const body = [
      `Recall for "${query}" \u2192 ${recall.classification} (closest: ${recall.closest?.entry.name ?? "none"}):`,
      "",
      ...recall.candidates.map((c, i) => formatCatalogEntry(c.entry, i + 1).concat(`
   match: name=${c.nameOverlap} whenToUse=${c.whenToUseOverlap} desc=${c.descriptionOverlap}`)),
      "",
      recall.classification === "COVERED" ? "Heuristic: an existing skill already covers this capability \u2014 prefer UPDATE/MERGE instead of CREATE." : recall.classification === "PARTIAL" ? "Heuristic: an existing skill partially covers this \u2014 consider UPDATE/MERGE with the new behavior." : "Heuristic: overlap is weak \u2014 a new skill may be justified."
    ].join("\n");
    return this.success(toolCallId, body);
  }
};
var CreateSkillTool = class extends AgentTool {
  constructor(_skillsDirs) {
    super();
    this._skillsDirs = _skillsDirs;
  }
  name = "create_skill";
  description = "Create a reusable skill: validates the canonical SKILL.md contract (lowercase-kebab-case name, description, whenToUse, content starting with a heading), runs a dedup recall against existing skills, and publishes {skillsDir}/{name}/SKILL.md. Use skill_catalog first to check for duplicates.";
  parameters = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: 'Skill name in lowercase-kebab-case (e.g. "cpp-forge")'
      },
      description: {
        type: "string",
        description: "One or two sentences: what the skill does and when to use it"
      },
      content: {
        type: "string",
        description: "Complete Markdown body. MUST start with a heading (# ...) and contain executable instructions"
      },
      whenToUse: {
        type: "string",
        description: "Optional: situations the skill applies to (shown to the agent for self-matching)"
      },
      triggers: {
        type: "array",
        items: { type: "string" },
        description: 'Optional trigger keywords for auto-matching (e.g. ["commit", "jira"])'
      },
      force: {
        type: "boolean",
        description: "Overwrite an existing skill with the same name. Default: false (refuses on conflict)."
      }
    },
    required: ["name", "description", "content"]
  };
  async execute(args, signal) {
    const toolCallId = args._toolCallId || "";
    if (signal?.aborted) {
      return this.failure(toolCallId, "Tool execution cancelled by user");
    }
    const proposal = {
      name: (args.name || "").trim(),
      description: (args.description || "").trim(),
      ...args.whenToUse ? { whenToUse: args.whenToUse.trim() } : {},
      content: args.content || "",
      ...Array.isArray(args.triggers) ? { triggers: args.triggers.map((t) => String(t)) } : {}
    };
    const force = args.force === true;
    try {
      renderCanonicalSkill(proposal);
    } catch (err) {
      return this.failure(toolCallId, `Invalid skill: ${err.message}`);
    }
    const snapshot = buildSkillCatalogSnapshot(this._skillsDirs);
    const recall = recallExistingSkills(snapshot, `${proposal.name} ${proposal.description} ${proposal.whenToUse ?? ""}`.trim());
    const existing = snapshot.skills.find((s) => s.name.toLowerCase() === proposal.name.toLowerCase());
    if (existing && !force) {
      return this.failure(
        toolCallId,
        `Skill "${proposal.name}" already exists at ${existing.path}. Use update_skill to modify it, or pass force: true to overwrite.`
      );
    }
    const result = publishSkill(this._skillsDirs[0], proposal, { force: force || void 0 });
    if (result.status === "UNSUPPORTED") {
      return this.failure(toolCallId, 'No skills directory configured \u2014 add "skills:" to config.yaml');
    }
    const dedupNote = recall.closest && recall.classification !== "UNRELATED" ? `
Note: recall found "${recall.closest.entry.name}" (${recall.classification}) \u2014 consider whether this new skill should instead extend it.` : "";
    return this.success(
      toolCallId,
      `Skill "${proposal.name}" ${result.status === "UPDATED" ? "updated" : "created"} at ${result.targetPath} (${renderCanonicalSkill(proposal).length} bytes).${dedupNote}`
    );
  }
};
var UpdateSkillTool = class extends AgentTool {
  constructor(_skillsDirs) {
    super();
    this._skillsDirs = _skillsDirs;
  }
  name = "update_skill";
  description = "Update an existing skill: loads the current SKILL.md, merges the provided fields, re-renders it in the canonical format and publishes it back. Fields not provided are kept unchanged.";
  parameters = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Name of the existing skill to update (lowercase-kebab-case)"
      },
      description: {
        type: "string",
        description: "Optional new description"
      },
      content: {
        type: "string",
        description: "Optional complete new Markdown body (must start with a heading)"
      },
      whenToUse: {
        type: "string",
        description: "Optional new whenToUse"
      },
      triggers: {
        type: "array",
        items: { type: "string" },
        description: "Optional new trigger keywords"
      }
    },
    required: ["name"]
  };
  async execute(args, signal) {
    const toolCallId = args._toolCallId || "";
    if (signal?.aborted) {
      return this.failure(toolCallId, "Tool execution cancelled by user");
    }
    const name = (args.name || "").trim();
    if (!name) {
      return this.failure(toolCallId, "Missing skill name");
    }
    const snapshot = buildSkillCatalogSnapshot(this._skillsDirs);
    const existing = snapshot.skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (!existing) {
      return this.failure(
        toolCallId,
        `Skill "${name}" not found. Use skill_catalog to list skills, or create_skill to create it.`
      );
    }
    const definition = readSkillDefinition(existing);
    if (!definition) {
      return this.failure(toolCallId, `Failed to read skill "${name}" at ${existing.path}`);
    }
    const merged = {
      name: existing.name,
      description: args.description?.trim() ?? definition.proposal.description,
      ...args.whenToUse !== void 0 ? { whenToUse: args.whenToUse.trim() } : definition.proposal.whenToUse ? { whenToUse: definition.proposal.whenToUse } : {},
      content: args.content ?? definition.proposal.content,
      triggers: Array.isArray(args.triggers) ? args.triggers.map((t) => String(t)) : definition.proposal.triggers,
      modelInvocable: definition.proposal.modelInvocable,
      userInvocable: definition.proposal.userInvocable
    };
    const result = publishSkill(this._skillsDirs[0], merged, { force: true });
    if (result.status === "UNSUPPORTED") {
      return this.failure(toolCallId, 'No skills directory configured \u2014 add "skills:" to config.yaml');
    }
    return this.success(
      toolCallId,
      `Skill "${name}" updated at ${result.targetPath} (${renderCanonicalSkill(merged).length} bytes). Reload the session to pick up the new content.`
    );
  }
};

// src/vs/workbench/contrib/agent/common/agentMemory.ts
var fs7 = __toESM(require("node:fs"));
var path9 = __toESM(require("node:path"));

// src/vs/workbench/contrib/agent/common/agentMemoryWorkspace.ts
var path8 = __toESM(require("node:path"));
var WORKSPACE_SCOPES = ["strict", "loose", "off"];
var DEFAULT_WORKSPACE_SCOPE = "strict";
var WORKSPACE_MARKER_OPEN = "[workspace:";
var MARKER_RE = /^\[workspace:([^\]\n\r]+)\]/m;
var MAX_ANCESTOR_QUERIES = 4;
function parseWorkspaceScope(value) {
  const v = typeof value === "string" ? value.trim().toLowerCase() : "";
  return WORKSPACE_SCOPES.includes(v) ? v : DEFAULT_WORKSPACE_SCOPE;
}
function normalizeWorkspaceDir(dir) {
  const raw = typeof dir === "string" ? dir.trim() : "";
  if (!raw) return "";
  let resolved;
  try {
    resolved = path8.resolve(raw);
  } catch {
    return "";
  }
  while (resolved.length > 1 && (resolved.endsWith("/") || resolved.endsWith("\\"))) {
    resolved = resolved.slice(0, -1);
  }
  return resolved;
}
function isAbsoluteDirLike(value) {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) return false;
  return v.startsWith("/") || /^[A-Za-z]:[\\/]/.test(v) || v.startsWith("\\\\");
}
function workspaceMarker(dir) {
  const n = normalizeWorkspaceDir(dir);
  return n ? `${WORKSPACE_MARKER_OPEN}${n}]` : "";
}
function extractWorkspaceFromText(text) {
  if (typeof text !== "string" || !text) return void 0;
  const m = MARKER_RE.exec(text);
  if (!m) return void 0;
  const dir = normalizeWorkspaceDir(m[1]);
  return dir || void 0;
}
function workspaceTagOfItem(item) {
  if (!item) return void 0;
  const taskId = typeof item.task_id === "string" ? item.task_id : "";
  if (isAbsoluteDirLike(taskId)) {
    const dir = normalizeWorkspaceDir(taskId);
    if (dir) return dir;
  }
  return extractWorkspaceFromText(typeof item.content === "string" ? item.content : void 0) ?? extractWorkspaceFromText(typeof item.background === "string" ? item.background : void 0);
}
function isSubDir(parent, child) {
  const p = normalizeWorkspaceDir(parent);
  const c = normalizeWorkspaceDir(child);
  if (!p || !c) return false;
  if (p === c) return true;
  const withSep = p.endsWith(path8.sep) ? p : p + path8.sep;
  return c.startsWith(withSep);
}
function workspaceRelation(noteTag, currentDir) {
  const a = normalizeWorkspaceDir(noteTag);
  const b = normalizeWorkspaceDir(currentDir);
  if (!a || !b) return "unrelated";
  if (a === b) return "same";
  if (isSubDir(a, b)) return "ancestor";
  if (isSubDir(b, a)) return "descendant";
  return "unrelated";
}
function isWorkspaceRelated(noteTag, currentDir) {
  return workspaceRelation(noteTag, currentDir) !== "unrelated";
}
function isWorkspaceVisible(item, currentDir, scope = DEFAULT_WORKSPACE_SCOPE) {
  if (scope === "off") return true;
  const tag = workspaceTagOfItem(item);
  if (!tag) return scope === "loose";
  return isWorkspaceRelated(tag, currentDir);
}
function filterByWorkspace(items, currentDir, scope = DEFAULT_WORKSPACE_SCOPE) {
  if (scope === "off") return items;
  return items.filter((it) => isWorkspaceVisible(it, currentDir, scope));
}
function workspaceCandidateTags(currentDir, maxAncestors = MAX_ANCESTOR_QUERIES) {
  const dir = normalizeWorkspaceDir(currentDir);
  if (!dir) return [];
  const tags = [];
  let cur = dir;
  while (tags.length < maxAncestors) {
    const parent = path8.dirname(cur);
    if (!parent || parent === cur) break;
    tags.push(cur);
    if (parent === path8.sep) break;
    cur = parent;
  }
  return tags;
}

// src/vs/workbench/contrib/agent/common/agentMemory.ts
function env(headerKey, headers) {
  if (!headers) return void 0;
  return headers[headerKey] ?? headers[headerKey.toLowerCase()];
}
function loadMcpMemoryEntry() {
  const candidates = [
    ...agentHomeFileCandidates("mcp.json"),
    ...agentHomeFileCandidates(".mcp.json")
  ];
  for (const file of candidates) {
    try {
      if (!fs7.existsSync(file)) continue;
      const raw = JSON.parse(fs7.readFileSync(file, "utf-8"));
      const entry = raw.mcpServers?.tdai_agent_mem;
      if (!entry?.url) continue;
      return {
        enabled: true,
        endpoint: entry.url,
        api_key: env("Authorization", entry.headers)?.replace(/^Bearer\s+/i, "") ?? env("x-tdai-user-key", entry.headers) ?? entry.apiKey,
        service_id: env("x-tdai-service-id", entry.headers) ?? entry.serviceId,
        user_key: env("x-tdai-user-key", entry.headers),
        username: entry.username ?? entry.user,
        team_id: entry.teamId,
        agent_id: entry.agentId,
        user_id: entry.userId,
        session_id: entry.sessionId,
        workspace_dir: entry.workspaceDir,
        workspace_scope: entry.workspaceScope
      };
    } catch {
    }
  }
  return void 0;
}
function loadYamlMemorySection() {
  const candidates = [
    path9.resolve("config.yaml"),
    path9.resolve("config.json"),
    ...agentHomeFileCandidates("config.yaml"),
    ...agentHomeFileCandidates("config.json")
  ];
  for (const file of candidates) {
    try {
      if (!fs7.existsSync(file)) continue;
      const text = fs7.readFileSync(file, "utf-8");
      const parsed = file.endsWith(".json") ? JSON.parse(text) : parseMemoryYaml(text);
      const section = parsed?.memory;
      if (section && typeof section === "object") return section;
    } catch {
    }
  }
  return void 0;
}
function parseMemoryYaml(text) {
  const result = {};
  let inMemory = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0 && trimmed.endsWith(":")) {
      inMemory = trimmed === "memory:";
      continue;
    }
    if (inMemory && indent === 2) {
      const idx = trimmed.indexOf(":");
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      let val = trimmed.slice(idx + 1).trim();
      val = val.replace(/^["']|["']$/g, "");
      if (!result.memory) result.memory = {};
      const mem = result.memory;
      if (val === "true") mem[key] = true;
      else if (val === "false") mem[key] = false;
      else if (val !== "") mem[key] = val;
    }
  }
  return result;
}
function loadMemoryConfig() {
  const yamlSection = loadYamlMemorySection();
  const mcpEntry = loadMcpMemoryEntry();
  const enabled = yamlSection?.enabled ?? mcpEntry?.enabled ?? false;
  if (!enabled) return void 0;
  const endpoint = yamlSection?.endpoint || mcpEntry?.endpoint || "";
  const apiKey = yamlSection?.api_key || mcpEntry?.api_key || "";
  const serviceId = yamlSection?.service_id || mcpEntry?.service_id || "";
  const teamId = yamlSection?.team_id || mcpEntry?.team_id || "";
  const agentId = yamlSection?.agent_id || mcpEntry?.agent_id || "";
  const userId = yamlSection?.user_id || mcpEntry?.user_id || "";
  if (!endpoint || !apiKey || !serviceId || !teamId || !agentId || !userId) {
    return void 0;
  }
  return {
    enabled: true,
    endpoint,
    apiKey,
    serviceId,
    userKey: yamlSection?.user_key || mcpEntry?.user_key || apiKey,
    username: yamlSection?.username || mcpEntry?.username || "",
    teamId,
    agentId,
    userId,
    sessionId: yamlSection?.session_id || mcpEntry?.session_id || "",
    recall: yamlSection?.recall ?? true,
    capture: yamlSection?.capture ?? true,
    workspaceDir: normalizeWorkspaceDir(yamlSection?.workspace_dir || mcpEntry?.workspace_dir || ""),
    workspaceScope: parseWorkspaceScope(yamlSection?.workspace_scope ?? mcpEntry?.workspace_scope)
  };
}
var MemoryClient = class {
  enabled = true;
  config;
  /** Explicit workspace override (host-provided); falls back to config / cwd. */
  _workspaceOverride;
  constructor(config, opts) {
    this.config = config;
    this._workspaceOverride = opts?.workspaceDir;
  }
  /**
   * Absolute directory that identifies "this workspace" for L1 tagging/scoping.
   * Resolution order: constructor override → config `workspace_dir` → process.cwd().
   */
  get workspaceDir() {
    const explicit = normalizeWorkspaceDir(this._workspaceOverride || this.config.workspaceDir);
    if (explicit) return explicit;
    try {
      return normalizeWorkspaceDir(process.cwd());
    } catch {
      return "";
    }
  }
  /** The tag written onto L1 notes; '' when scoping is disabled. */
  get workspaceTag() {
    return this.config.workspaceScope === "off" ? "" : this.workspaceDir;
  }
  get workspaceScope() {
    return this.config.workspaceScope;
  }
  get _sessionId() {
    return this.config.sessionId || void 0;
  }
  /** Stable default session: config override, else derived from the CWD. */
  _defaultSession() {
    if (this.config.sessionId) return this.config.sessionId;
    try {
      const base = path9.basename(process.cwd());
      return base ? `code-agent:${base}` : "code-agent";
    } catch {
      return "code-agent";
    }
  }
  _iso(sessionId) {
    const body = {
      team_id: this.config.teamId,
      agent_id: this.config.agentId,
      user_id: this.config.userId
    };
    const sid = sessionId !== null && sessionId !== void 0 ? sessionId : this._sessionId;
    if (sid) body.session_id = sid;
    return body;
  }
  _headers() {
    const h = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.config.apiKey}`,
      "x-tdai-service-id": this.config.serviceId
    };
    if (this.config.userKey) h["x-tdai-user-key"] = this.config.userKey;
    return h;
  }
  /** Core POST with fail-open semantics: throws only on transport-level errors. */
  async _post(pathname, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1e4);
    try {
      const res = await fetch(`${this.config.endpoint.replace(/\/+$/, "")}${pathname}`, {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await res.text();
      let envelope;
      try {
        envelope = JSON.parse(text);
      } catch {
        throw new Error(`Memory gateway returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`);
      }
      if (!res.ok || envelope.code !== 0) {
        throw new Error(`Memory API error ${envelope.code || res.status}: ${envelope.message}`);
      }
      return envelope.data ?? null;
    } finally {
      clearTimeout(timer);
    }
  }
  // ---- L0 conversation ----
  async addConversation(messages, sessionId, taskId) {
    const sid = sessionId || this._sessionId || this._defaultSession();
    const data = await this._post("/v3/conversation/add", {
      ...this._iso(sid),
      session_id: sid,
      messages,
      ...taskId ? { task_id: taskId } : {}
    });
    return data !== null;
  }
  /**
   * Raw L0 conversation search against the hub.
   *
   * NOTE: the v3 data plane answers this endpoint with `data.messages`
   * (verified live) — reading `data.items` silently returned nothing.
   *
   * `taskId` is a first-class server-side filter here too (verified: a bogus
   * tag yields 0 hits, the workspace tag yields exactly the tagged turns).
   */
  async searchConversation(query, limit = 5, taskId) {
    const data = await this._post("/v3/conversation/search", {
      ...this._iso(null),
      query,
      limit,
      ...taskId ? { task_id: taskId } : {}
    });
    return data?.messages ?? data?.items ?? [];
  }
  /**
   * Workspace-scoped L0 search — the only L0 entry point used by the tool.
   * Same strategy as `searchL1Scoped`: an over-fetched unfiltered search (which is
   * what surfaces descendant-workspace and untagged legacy turns) UNION one exact-tag
   * query per candidate tag (cwd + ancestors), merged, gated, then ranked.
   */
  async searchL0Scoped(query, limit = 5) {
    const scope = this.config.workspaceScope;
    const ws = this.workspaceDir;
    if (scope === "off" || !ws || limit <= 0) {
      return { items: await this.searchConversation(query, limit), hidden: 0 };
    }
    const primary = await this.searchConversation(query, Math.max(limit, limit * 5));
    const tagged = await Promise.all(
      workspaceCandidateTags(ws).map(async (tag) => ({
        tag,
        items: await this.searchConversation(query, limit, tag).catch(() => [])
      }))
    );
    const merged = this._mergeScoped(primary, tagged);
    const visible = filterByWorkspace(merged, ws, scope);
    visible.sort((a, b) => {
      const byScore = Number(b.score ?? 0) - Number(a.score ?? 0);
      if (byScore !== 0) return byScore;
      return String(b.timestamp ?? b.created_at ?? "").localeCompare(String(a.timestamp ?? a.created_at ?? ""));
    });
    return { items: visible.slice(0, limit), hidden: merged.length - visible.length };
  }
  async queryConversation(limit = 20) {
    const data = await this._post("/v3/conversation/query", {
      ...this._iso(null),
      limit,
      offset: 0
    });
    return data?.messages ?? data?.items ?? [];
  }
  /**
   * Merge an unfiltered over-fetch with tag-filtered queries.
   *
   * Every item returned by a tag-filtered query is stamped with the tag the hub
   * filtered on, because /v3/conversation/search does not echo `task_id` back —
   * without the stamp, a correctly-tagged L0 turn (e.g. an assistant reply that
   * carries no marker) would look untagged and be withheld in `strict` mode.
   * Tagged copies win over the unfiltered pool, and duplicates collapse by id.
   */
  _mergeScoped(primary, tagged) {
    const keyOf = (item, index) => {
      const id = typeof item.id === "string" ? item.id : "";
      return id || `anon:${index}:${String(item.content ?? "").slice(0, 48)}`;
    };
    const seen = /* @__PURE__ */ new Set();
    const merged = [];
    for (const { tag, items } of tagged) {
      for (const item of items) {
        const key = keyOf(item, merged.length);
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(workspaceTagOfItem(item) ? item : { ...item, task_id: tag });
      }
    }
    for (const item of primary) {
      const key = keyOf(item, merged.length);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
    return merged;
  }
  // ---- L1 atomic ----
  /**
   * Raw L1 search against the hub.
   *
   * `taskId` is a first-class server-side filter (verified against the v3 data
   * plane); this client stores the workspace directory there, so passing it
   * restricts the search to notes tagged with exactly that directory.
   */
  async searchAtomic(query, limit = 5, type, taskId) {
    const data = await this._post("/v3/atomic/search", {
      ...this._iso(null),
      query,
      limit,
      ...type ? { type } : {},
      ...taskId ? { task_id: taskId } : {}
    });
    return data?.items ?? [];
  }
  /**
   * Workspace-scoped L1 search: the only L1 entry point used for recall.
   *
   * Candidates = an over-fetched unfiltered search (which is what surfaces
   * descendants-of-cwd notes and untagged legacy notes) UNION one exact-tag query per
   * candidate tag (cwd + ancestors), so a workspace with few notes is still found even
   * when the global top-N is crowded by other projects. Everything is then gated by the
   * workspace rule before the caller sees it.
   */
  async searchL1Scoped(query, limit = 5, type) {
    const scope = this.config.workspaceScope;
    const ws = this.workspaceDir;
    if (scope === "off" || !ws || limit <= 0) {
      return { items: await this.searchAtomic(query, limit, type), hidden: 0 };
    }
    const overfetch = Math.max(limit, limit * 5);
    const primary = await this.searchAtomic(query, overfetch, type);
    const ancestorTags = workspaceCandidateTags(ws);
    const tagged = await Promise.all(
      ancestorTags.map(async (tag) => ({
        tag,
        items: await this.searchAtomic(query, limit, type, tag).catch(() => [])
      }))
    );
    const merged = this._mergeScoped(primary, tagged);
    const visible = filterByWorkspace(merged, ws, scope);
    visible.sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0));
    return { items: visible.slice(0, limit), hidden: merged.length - visible.length };
  }
  async updateAtomic(id, content, background, taskId) {
    const data = await this._post("/v3/atomic/update", {
      ...this._iso(null),
      id,
      content,
      ...background ? { background } : {},
      ...taskId ? { task_id: taskId } : {}
    });
    return data !== null;
  }
  // ---- L2 scenario ----
  async listScenarios(pathPrefix) {
    const data = await this._post("/v3/scenario/ls", {
      ...this._iso(null),
      ...pathPrefix ? { path_prefix: pathPrefix } : {}
    });
    return data?.entries ?? data?.items ?? [];
  }
  async readScenario(pathname) {
    const data = await this._post("/v3/scenario/read", {
      ...this._iso(null),
      path: pathname
    });
    return data?.content ?? null;
  }
  async writeScenario(pathname, content, summary) {
    const data = await this._post("/v3/scenario/write", {
      ...this._iso(null),
      path: pathname,
      content,
      ...summary ? { summary } : {}
    });
    return data !== null;
  }
  // ---- L3 core (persona) ----
  async readCore() {
    const data = await this._post("/v3/core/read", this._iso(null));
    return data?.content ?? null;
  }
  async writeCore(content) {
    const data = await this._post("/v3/core/write", {
      ...this._iso(null),
      content
    });
    return data !== null;
  }
  // ---- IMemoryIntegration (AgentLoop hooks) ----
  /**
   * Recall relevant memories for the task: L1 atomic search (workspace-scoped)
   * + L2 scenario index + L3 persona. All three run independently; a failure in
   * one never blocks the others. Returns a formatted context block or undefined.
   *
   * L2/L3 are intentionally cross-project; L0 and L1 are scoped to the workspace
   * directory (same dir, or an ancestor/descendant of it). L0 is never injected
   * automatically — it is reachable only through the `tdai_conversation_search`
   * tool, which applies the very same scope.
   */
  async recall(task) {
    const sections = [];
    try {
      const { items: atoms, hidden } = await this.searchL1Scoped(task, 5);
      if (hidden > 0) {
        console.log(`[memory] L1 workspace scope (${this.config.workspaceScope}) [${this.workspaceDir}]: hid ${hidden} memory(ies) tagged to other workspaces`);
      }
      const lines = atoms.filter((a) => typeof a.content === "string" && a.content.trim()).map((a) => {
        const type = a.type ? `[${a.type}] ` : "";
        return `- ${type}${String(a.content).trim()}`;
      });
      if (lines.length > 0) {
        sections.push(`<relevant-memories>
${lines.join("\n")}
</relevant-memories>`);
      }
    } catch (err) {
      console.warn(`[memory] L1 recall failed: ${err.message}`);
    }
    try {
      const scenarios = await this.listScenarios();
      const paths = scenarios.map((s) => s.path ?? s.filename ?? s.name).filter((p) => typeof p === "string" && p.length > 0);
      if (paths.length > 0) {
        sections.push(
          `## Shared Scenario Index (L2)
*\u4EE5\u4E0B\u573A\u666F\u6587\u4EF6\u53EF\u901A\u8FC7 tdai_read_file \u8BFB\u53D6\u8BE6\u60C5*
` + paths.map((p) => `- \`${p}\``).join("\n")
        );
      }
    } catch (err) {
      console.warn(`[memory] L2 recall failed: ${err.message}`);
    }
    try {
      const core = await this.readCore();
      if (core && core.trim()) {
        sections.push(`<user-persona>
${core.trim()}
</user-persona>`);
      }
    } catch (err) {
      console.warn(`[memory] L3 recall failed: ${err.message}`);
    }
    if (sections.length === 0) return void 0;
    return sections.join("\n\n");
  }
  /**
   * Capture the finished task exchange into L0. The memory hub's offload
   * pipeline later distills L0 → L1 → L2 → L3, so raw turns are the right
   * input here. Fail-open: never throws into the main agent flow.
   *
   * The workspace directory is stamped on the turn three times: as the hub's
   * `task_id` field (filterable server-side, but NOT echoed back by
   * /v3/conversation/search), and as a `[workspace:<dir>]` marker line inside
   * BOTH captured messages. The marker is what makes a turn attributable when
   * it is only reachable through the unfiltered search (e.g. a turn from a
   * sub-directory of this workspace); without it, a marker-less assistant reply
   * would be indistinguishable from untagged legacy data.
   */
  async capture(task, assistantContent) {
    try {
      const tag = this.workspaceTag;
      const marker = tag ? workspaceMarker(tag) : "";
      const stamp = (text) => marker ? `${marker}
${text}` : text;
      const messages = [];
      if (task && task.trim()) {
        messages.push({ role: "user", content: stamp(task.slice(0, 8e3)) });
      }
      if (assistantContent && assistantContent.trim()) {
        messages.push({ role: "assistant", content: stamp(assistantContent.slice(0, 8e3)) });
      }
      if (messages.length === 0) return;
      const ok = await this.addConversation(messages, void 0, tag || void 0);
      if (ok) {
        console.log(`[memory] L0 captured: ${messages.length} message(s) -> ${this.config.username || this.config.userId}${tag ? ` [workspace ${tag}]` : ""}`);
      }
    } catch (err) {
      console.warn(`[memory] capture failed (non-fatal): ${err.message}`);
    }
  }
};
var MemoryTool = class extends AgentTool {
  constructor(_client) {
    super();
    this._client = _client;
  }
};
var MemorySearchTool = class extends MemoryTool {
  name = "tdai_memory_search";
  description = "Search shared agent memory (L1 atomic facts: user preferences, rules, past decisions, project conventions) on the tdai_agent_mem hub. Use when you need knowledge stored by previous agent runs on any machine. L1 is scoped to the current workspace directory: only memories tagged with this directory (or one of its parents/children) are returned.";
  parameters = {
    type: "object",
    properties: {
      query: { type: "string", description: "Natural-language query describing the fact you are looking for" },
      limit: { type: "number", description: "Max results, default 5" }
    },
    required: ["query"]
  };
  async execute(args, signal) {
    const toolCallId = args._toolCallId || "";
    if (signal?.aborted) return this.failure(toolCallId, "Tool execution cancelled by user");
    try {
      const { items, hidden } = await this._client.searchL1Scoped(String(args.query || ""), args.limit || 5);
      const scopeNote = hidden > 0 ? `

(workspace scope \`${this._client.workspaceScope}\` on \`${this._client.workspaceDir}\`: ${hidden} memory(ies) tagged to other workspaces were withheld)` : "";
      if (items.length === 0) {
        return this.success(toolCallId, `(no matching memories found in this workspace)${scopeNote}`);
      }
      const out = items.map((it, i) => {
        const id = it.id ? `
id: ${it.id}` : "";
        const type = it.type ? `
type: ${it.type}` : "";
        const background = it.background ?? it.scene_name ? `
background: ${String(it.background ?? it.scene_name)}` : "";
        return `[${i + 1}]${type}${id}
${String(it.content)}${background}`;
      }).join("\n\n");
      return this.success(toolCallId, out + scopeNote);
    } catch (err) {
      return this.failure(toolCallId, `memory_search failed: ${err.message}`);
    }
  }
};
var ConversationSearchTool = class extends MemoryTool {
  name = "tdai_conversation_search";
  description = "Search raw past conversation history (L0) stored on the tdai_agent_mem hub \u2014 useful when the exact wording of a previous exchange matters. L0 is scoped to the current workspace directory: only conversations tagged with this directory (or one of its parents/children) are returned.";
  parameters = {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "number", description: "Max results, default 5" }
    },
    required: ["query"]
  };
  async execute(args, signal) {
    const toolCallId = args._toolCallId || "";
    if (signal?.aborted) return this.failure(toolCallId, "Tool execution cancelled by user");
    try {
      const { items, hidden } = await this._client.searchL0Scoped(String(args.query || ""), args.limit || 5);
      const scopeNote = hidden > 0 ? `

(workspace scope \`${this._client.workspaceScope}\` on \`${this._client.workspaceDir}\`: ${hidden} conversation(s) from other workspaces were withheld)` : "";
      if (items.length === 0) {
        return this.success(toolCallId, `(no matching conversations found in this workspace)${scopeNote}`);
      }
      const out = items.map((it, i) => {
        const role = it.role ? `${it.role}: ` : "";
        const when = it.timestamp ?? it.created_at ? `
(time: ${String(it.timestamp ?? it.created_at)})` : "";
        return `[${i + 1}]${when}
${role}${String(it.content ?? "").slice(0, 1e3)}`;
      }).join("\n\n");
      return this.success(toolCallId, out + scopeNote);
    } catch (err) {
      return this.failure(toolCallId, `conversation_search failed: ${err.message}`);
    }
  }
};
var MemoryReadTool = class extends MemoryTool {
  name = "tdai_read_file";
  description = 'Read a shared memory file from the tdai_agent_mem hub: L3 persona ("core") or an L2 scenario file by path (e.g. "work.md"). Paths come from the Shared Scenario Index.';
  parameters = {
    type: "object",
    properties: {
      path: { type: "string", description: 'File path, or "core" for the L3 persona' }
    },
    required: ["path"]
  };
  async execute(args, signal) {
    const toolCallId = args._toolCallId || "";
    if (signal?.aborted) return this.failure(toolCallId, "Tool execution cancelled by user");
    const p = String(args.path || "");
    try {
      if (p === "core") {
        const content2 = await this._client.readCore();
        return this.success(toolCallId, content2 ?? "(core persona is empty)");
      }
      const content = await this._client.readScenario(p);
      if (content === null) return this.failure(toolCallId, `Scenario file not found: ${p}`);
      return this.success(toolCallId, content);
    } catch (err) {
      return this.failure(toolCallId, `read_file failed: ${err.message}`);
    }
  }
};
var MemoryWriteTool = class extends MemoryTool {
  name = "tdai_memory_write";
  description = "Write knowledge to the tdai_agent_mem hub at a specific memory tier: l1 = atomic fact (needs an existing note id), l2 = scenario file (updates an existing path), l3 = user persona (core). L0 conversations are captured automatically after each task. L1 notes written here are tagged with the current workspace directory so they are only recalled in that workspace (or its parent/child directories).";
  parameters = {
    type: "object",
    properties: {
      layer: { type: "string", enum: ["l1", "l2", "l3"], description: "Memory tier: l1 atomic, l2 scenario, l3 persona core" },
      content: { type: "string", description: "Content to store" },
      id: { type: "string", description: "L1 atomic note id (required for layer=l1)" },
      path: { type: "string", description: "L2 scenario file path (required for layer=l2)" },
      background: { type: "string", description: "L1 background/context (optional)" },
      summary: { type: "string", description: "L2 file summary (optional)" }
    },
    required: ["layer", "content"]
  };
  async execute(args, signal) {
    const toolCallId = args._toolCallId || "";
    if (signal?.aborted) return this.failure(toolCallId, "Tool execution cancelled by user");
    const layer = String(args.layer || "").toLowerCase();
    const content = String(args.content || "");
    try {
      if (layer === "l3") {
        const ok = await this._client.writeCore(content);
        return ok ? this.success(toolCallId, "L3 persona core updated.") : this.failure(toolCallId, "write failed");
      }
      if (layer === "l2") {
        const p = String(args.path || "");
        if (!p) return this.failure(toolCallId, 'layer=l2 requires "path" (an existing scenario file)');
        const ok = await this._client.writeScenario(p, content, args.summary ? String(args.summary) : void 0);
        return ok ? this.success(toolCallId, `L2 scenario updated: ${p}`) : this.failure(toolCallId, "write failed (file must already exist)");
      }
      if (layer === "l1") {
        const id = String(args.id || "");
        if (!id) return this.failure(toolCallId, 'layer=l1 requires "id" of an existing atomic note');
        const tag = this._client.workspaceTag;
        const marker = tag ? workspaceMarker(tag) : "";
        const bg = args.background ? String(args.background) : "";
        const background = marker ? `${bg ? `${bg}
` : ""}${marker}` : bg || void 0;
        const ok = await this._client.updateAtomic(id, content, background, tag || void 0);
        return ok ? this.success(toolCallId, `L1 atomic note updated: ${id}${tag ? ` (workspace ${tag})` : ""}`) : this.failure(toolCallId, "update failed (note must already exist)");
      }
      return this.failure(toolCallId, `Unknown layer: ${layer} (use l1 | l2 | l3)`);
    } catch (err) {
      return this.failure(toolCallId, `memory_write failed: ${err.message}`);
    }
  }
};

// src/vs/workbench/contrib/agent/common/agentSelfImprove.ts
var fs8 = __toESM(require("node:fs"));
var path10 = __toESM(require("node:path"));
var import_node_child_process2 = require("node:child_process");
var DEFAULT_SELF_UPDATE_CONFIG = {
  enabled: true,
  allowRelease: false,
  allowPush: false,
  evidenceDays: 14,
  evidenceTasks: 200,
  remote: "origin",
  releaseScripts: ["typecheck", "test", "pack"],
  installCommand: ""
};
function parseSelfUpdateYaml(text) {
  const out = {};
  let inSection = false;
  let inScripts = false;
  let seen = false;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0 && trimmed.endsWith(":")) {
      inSection = trimmed === "self_update:";
      inScripts = false;
      continue;
    }
    if (!inSection) continue;
    if (trimmed.startsWith("- ")) {
      if (inScripts) {
        const value2 = parseScalarValue(trimmed.slice(2));
        if (value2) {
          out.releaseScripts = out.releaseScripts || [];
          out.releaseScripts.push(value2);
          seen = true;
        }
      }
      continue;
    }
    if (indent !== 2) continue;
    const idx = trimmed.indexOf(":");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = parseScalarValue(trimmed.slice(idx + 1));
    inScripts = key === "release_scripts";
    seen = true;
    const bool = (v) => ["1", "true", "yes", "on"].includes(v.toLowerCase()) ? true : ["0", "false", "no", "off"].includes(v.toLowerCase()) ? false : void 0;
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : void 0;
    };
    if (key === "enabled") out.enabled = bool(value);
    else if (key === "allow_release") out.allowRelease = bool(value);
    else if (key === "allow_push") out.allowPush = bool(value);
    else if (key === "evidence_days") out.evidenceDays = num(value);
    else if (key === "evidence_tasks") out.evidenceTasks = num(value);
    else if (key === "remote") out.remote = value;
    else if (key === "install_command") out.installCommand = value;
  }
  return seen ? out : void 0;
}
function loadSelfUpdateConfig() {
  const candidates = [
    path10.resolve("config.yaml"),
    path10.resolve("config.json"),
    ...agentHomeFileCandidates("config.yaml"),
    ...agentHomeFileCandidates("config.json")
  ];
  for (const file of candidates) {
    try {
      if (!fs8.existsSync(file)) continue;
      const text = fs8.readFileSync(file, "utf-8");
      let parsed;
      if (file.endsWith(".json")) {
        const json = JSON.parse(text);
        parsed = json?.self_update;
      } else {
        parsed = parseSelfUpdateYaml(text);
      }
      if (parsed) {
        const merged = { ...DEFAULT_SELF_UPDATE_CONFIG, ...parsed };
        if (!merged.allowRelease) merged.allowPush = false;
        return merged;
      }
    } catch {
    }
  }
  return { ...DEFAULT_SELF_UPDATE_CONFIG };
}
var MAX_SIGNATURE_CHARS = 160;
var MAX_EXAMPLE_CHARS = 240;
function looksLikePath(value) {
  return value.startsWith("/") || value.includes("/") || /^[A-Za-z]:[\\/]/.test(value);
}
function normalizeFailureSignature(text) {
  return text.replace(/\b[0-9a-f]{8,}\b/gi, "<id>").replace(/(\d+(?:\.\d+)?)\s*(ms|msec|s|sec|secs|m|min|mins|h|hr|hrs|kb|mb|gb|tb|%)\b/gi, "<n>$2").replace(/'(?:[^'\\]|\\.){0,300}'/g, (m) => looksLikePath(m.slice(1, -1)) ? "<path>" : "<str>").replace(/"(?:[^"\\]|\\.){0,300}"/g, (m) => looksLikePath(m.slice(1, -1)) ? "<path>" : "<str>").replace(/\/(?:[\w.@-]+\/)+[\w.@-]+/g, "<path>").replace(/\b\d+(?:\.\d+)?\b/g, "<n>").replace(/\s+/g, " ").trim().slice(0, MAX_SIGNATURE_CHARS);
}
function readTaskLogs(dir, maxTasks) {
  let files = [];
  try {
    files = fs8.readdirSync(dir).filter((f) => f.startsWith("task_") && f.endsWith(".json"));
  } catch {
    return { logs: [], filesOnDisk: 0, truncated: false };
  }
  files.sort().reverse();
  const truncated = files.length > maxTasks;
  const logs = [];
  for (const file of files.slice(0, maxTasks)) {
    try {
      logs.push(JSON.parse(fs8.readFileSync(path10.join(dir, file), "utf-8")));
    } catch {
    }
  }
  return { logs, filesOnDisk: files.length, truncated };
}
function countFiles(dir, pred) {
  try {
    return fs8.readdirSync(dir).filter(pred).length;
  } catch {
    return 0;
  }
}
function collectRunEvidence(opts = {}) {
  const now = opts.now ?? Date.now();
  const days = opts.days ?? DEFAULT_SELF_UPDATE_CONFIG.evidenceDays;
  const maxTasks = opts.maxTasks ?? DEFAULT_SELF_UPDATE_CONFIG.evidenceTasks;
  const maxGroups = opts.maxGroups ?? 25;
  const tasksDir2 = opts.tasksDir ?? path10.join(agentHomeDir(), "tasks");
  const sessionsDir2 = opts.sessionsDir ?? path10.join(agentHomeDir(), "sessions");
  const { logs, filesOnDisk, truncated } = readTaskLogs(tasksDir2, maxTasks);
  const cutoff = now - days * 24 * 60 * 60 * 1e3;
  const inWindow = logs.filter((l) => (l.startedAt ?? 0) >= cutoff);
  const statusCounts = {};
  const toolCalls = /* @__PURE__ */ new Map();
  const toolFailureGroups = /* @__PURE__ */ new Map();
  const taskFailureGroups = /* @__PURE__ */ new Map();
  const issueGroups = /* @__PURE__ */ new Map();
  const summaries = [];
  let totalSteps = 0;
  let totalToolCalls = 0;
  let totalTokens = 0;
  let firstAt;
  let lastAt;
  const noteIssue = (kind, taskId, detail) => {
    const existing = issueGroups.get(kind) ?? { kind, count: 0, taskIds: [], example: detail };
    existing.count++;
    if (!existing.taskIds.includes(taskId)) existing.taskIds.push(taskId);
    if (!existing.example && detail) existing.example = detail;
    issueGroups.set(kind, existing);
  };
  const noteFailure = (group, taskId) => {
    const key = `${group.scope}|${group.tool ?? ""}|${group.signature}`;
    const map = group.scope === "tool" ? toolFailureGroups : taskFailureGroups;
    const existing = map.get(key) ?? group;
    existing.count++;
    if (!existing.taskIds.includes(taskId)) existing.taskIds.push(taskId);
    map.set(key, existing);
  };
  for (const log2 of inWindow) {
    const taskId = log2.id;
    statusCounts[log2.status] = (statusCounts[log2.status] ?? 0) + 1;
    totalSteps += log2.totalSteps ?? 0;
    totalToolCalls += log2.totalToolCalls ?? 0;
    const tokens = log2.tokenUsage?.totalTokens ?? 0;
    totalTokens += tokens;
    if (log2.startedAt) {
      firstAt = firstAt === void 0 ? log2.startedAt : Math.min(firstAt, log2.startedAt);
      lastAt = lastAt === void 0 ? log2.startedAt : Math.max(lastAt, log2.startedAt);
    }
    summaries.push({
      taskId,
      task: (log2.task ?? "").slice(0, 160),
      status: log2.status,
      steps: log2.totalSteps ?? 0,
      toolCalls: log2.totalToolCalls ?? 0,
      durationMs: log2.durationMs ?? 0,
      tokens
    });
    if (log2.status === "failed" && log2.error) {
      noteFailure({
        scope: "task",
        signature: normalizeFailureSignature(String(log2.error)),
        count: 0,
        example: String(log2.error).slice(0, MAX_EXAMPLE_CHARS),
        taskIds: []
      }, taskId);
    }
    for (const signal of log2.issueSignals ?? []) {
      noteIssue(signal.kind, taskId, signal.detail);
    }
    for (const sw of log2.modelSwitches ?? []) {
      noteIssue(`model-switch:${sw.reason}`, taskId, `${sw.from} \u2192 ${sw.to}`);
    }
    for (const step of log2.steps ?? []) {
      for (const exec of step.toolExecutions ?? []) {
        const stat = toolCalls.get(exec.toolName) ?? { calls: 0, failures: 0, maxMs: 0 };
        stat.calls++;
        stat.maxMs = Math.max(stat.maxMs, exec.durationMs ?? 0);
        if (!exec.success) {
          stat.failures++;
          const raw = exec.error || exec.result || "tool failed";
          noteFailure({
            scope: "tool",
            tool: exec.toolName,
            signature: normalizeFailureSignature(String(raw)),
            count: 0,
            example: String(raw).slice(0, MAX_EXAMPLE_CHARS),
            taskIds: []
          }, taskId);
          const unknown = /unknown tool:\s*(\S+)/i.exec(String(raw));
          if (unknown) noteIssue("unknown-tool", taskId, unknown[1]);
        }
        toolCalls.set(exec.toolName, stat);
      }
    }
  }
  const toolStats = [...toolCalls.entries()].map(([tool, s]) => ({
    tool,
    calls: s.calls,
    failures: s.failures,
    failureRate: s.calls > 0 ? Number((s.failures / s.calls).toFixed(3)) : 0,
    maxMs: s.maxMs
  })).sort((a, b) => b.failures - a.failures || b.calls - a.calls);
  const byCount = (a, b) => b.count - a.count;
  const failureGroups = [...toolFailureGroups.values(), ...taskFailureGroups.values()].sort((a, b) => b.count - a.count).slice(0, maxGroups);
  const issueList = [...issueGroups.values()].sort(byCount).slice(0, maxGroups);
  const notes = [];
  notes.push("Session transcripts are NOT read (bounded by design): only per-task execution logs.");
  if (truncated) notes.push(`Scanned the newest ${maxTasks} of ${filesOnDisk} task logs (cap reached).`);
  if (filesOnDisk === 0) notes.push(`No task logs under ${tasksDir2} \u2014 evidence is empty, not "healthy".`);
  if (logs.length > 0 && inWindow.length < logs.length) {
    notes.push(`${logs.length - inWindow.length} scanned log(s) fall outside the ${days}-day window.`);
  }
  return {
    generatedAt: now,
    windowDays: days,
    tasksDir: tasksDir2,
    filesOnDisk,
    scannedTasks: logs.length,
    tasksInWindow: inWindow.length,
    firstAt,
    lastAt,
    statusCounts,
    totalSteps,
    totalToolCalls,
    totalTokens,
    toolStats,
    failureGroups,
    issueGroups: issueList,
    costlyTasks: [...summaries].sort((a, b) => b.tokens - a.tokens || b.durationMs - a.durationMs).slice(0, 10),
    failingTasks: summaries.filter((s) => s.status !== "completed").sort((a, b) => b.durationMs - a.durationMs).slice(0, 10),
    sessionsInWindow: countFiles(sessionsDir2, (f) => f.startsWith("session_") && f.endsWith(".json")),
    notes
  };
}
function formatEvidenceReport(e) {
  const lines = [];
  const ts = (v) => v ? new Date(v).toISOString().slice(0, 16).replace("T", " ") : "?";
  lines.push(`RUN EVIDENCE \u2014 last ${e.windowDays} days (${e.tasksInWindow}/${e.filesOnDisk} task logs)`);
  lines.push(`  window: ${ts(e.firstAt)} .. ${ts(e.lastAt)}`);
  lines.push(`  tasks: ${e.tasksInWindow} | steps: ${e.totalSteps} | tool calls: ${e.totalToolCalls} | tokens: ${e.totalTokens}`);
  lines.push(`  status: ${Object.entries(e.statusCounts).map(([k, v]) => `${k} ${v}`).join(" | ") || "(none)"}`);
  if (e.issueGroups.length > 0) {
    lines.push("");
    lines.push("RUN SIGNALS (from task logs)");
    for (const g of e.issueGroups) {
      lines.push(`  ${g.count}x ${g.kind}${g.example ? ` \u2014 ${g.example.slice(0, 120)}` : ""} (tasks: ${g.taskIds.slice(0, 5).join(", ")})`);
    }
  }
  if (e.failureGroups.length > 0) {
    lines.push("");
    lines.push("FAILURES (grouped by normalized error \u2014 the raw count is the repeat rate)");
    for (const g of e.failureGroups) {
      const where = g.scope === "tool" ? `tool ${g.tool}` : "task";
      lines.push(`  ${g.count}x [${where}] ${g.signature}`);
      lines.push(`        e.g. ${g.example.replace(/\s+/g, " ").slice(0, 160)}`);
      lines.push(`        tasks: ${g.taskIds.slice(0, 6).join(", ")}`);
    }
  }
  if (e.toolStats.length > 0) {
    lines.push("");
    lines.push("TOOL USE (by failures, then calls)");
    for (const t of e.toolStats.slice(0, 20)) {
      lines.push(`  ${t.tool.padEnd(18)} ${String(t.calls).padStart(5)} calls  ${String(t.failures).padStart(3)} failed  (${(t.failureRate * 100).toFixed(1)}%)  max ${(t.maxMs / 1e3).toFixed(1)}s`);
    }
  }
  if (e.costlyTasks.length > 0) {
    lines.push("");
    lines.push("COSTLIEST TASKS");
    for (const t of e.costlyTasks) {
      lines.push(`  ${t.taskId} ${String(t.tokens).padStart(7)} tok ${String(Math.round(t.durationMs / 1e3)).padStart(5)}s steps=${t.steps} tools=${t.toolCalls} [${t.status}] ${t.task.slice(0, 70)}`);
    }
  }
  if (e.failingTasks.length > 0) {
    lines.push("");
    lines.push("NON-COMPLETED TASKS");
    for (const t of e.failingTasks) {
      lines.push(`  ${t.taskId} [${t.status}] steps=${t.steps} ${t.task.slice(0, 90)}`);
    }
  }
  lines.push("");
  lines.push("NOTES");
  for (const n of e.notes) lines.push(`  - ${n}`);
  lines.push("");
  lines.push("Facts only \u2014 deciding which finding is a real defect (and whether it is worth changing) is the reviewer's job.");
  return lines.join("\n");
}
function buildSelfEvolvePromptSection(config) {
  if (!config.enabled) return "";
  const lines = [];
  lines.push("");
  lines.push("## Self-evolution (find your own defects, then release the fix)");
  lines.push("");
  lines.push("You can inspect your own run history and release a fix for a defect you find there.");
  lines.push("Never skip a step \u2014 a change without the evidence below is not a fix, it is a guess.");
  lines.push("");
  lines.push("1. **Evidence first.** Call `agent_self_scan` before proposing anything. It returns facts");
  lines.push("   (tool histograms, failure signatures grouped by normalized error, run signals).");
  lines.push("   Repeated signatures and high failure rates are candidates; a single failure is not.");
  lines.push("");
  lines.push("2. **Judge against the user's task, not against elegance.** Evidence says a thing is true,");
  lines.push("   it does not say the thing is wrong. A tool that failed once because the user passed a bad");
  lines.push("   path is not a defect. If the evidence supports two readings, say both and ask.");
  lines.push("");
  lines.push("3. **Read only what the signature points at.** Find the code path behind the group");
  lines.push("   (grep the tool name / error text), and prefer the smallest change that removes the");
  lines.push('   failure mode. Do not "improve" neighbouring code.');
  lines.push("");
  lines.push("4. **Write the failing case down first.** Add or extend a test that fails before your change");
  lines.push("   and passes after it. No test, no release.");
  lines.push("");
  lines.push("5. **Say the plan out loud before editing**, including what you decided NOT to change and why.");
  lines.push("   If the plan turns out to be impossible, stop and explain the alternative \u2014 never silently swap it.");
  lines.push("");
  if (config.allowRelease) {
    lines.push("6. **Release through the gate.** Call `agent_release` with a conventional commit message");
    lines.push("   (it bumps the version, runs typecheck + tests, packs, smokes the built CLI, then commits" + (config.allowPush ? " and pushes)." : "; pushing needs allow_push in config."));
    lines.push("   It aborts at the first failure and leaves nothing half-published. Report its step-by-step");
    lines.push("   output verbatim; never claim a release you did not see the pipeline confirm.");
  } else {
    lines.push("6. **Stop before releasing.** `self_update.allow_release` is off, so you may prepare and");
    lines.push("   verify the fix but must hand the release to the user (version bump, tests, pack, commit).");
  }
  lines.push("");
  lines.push("Full method: docs/self-evolve.md");
  return lines.join("\n");
}
var DEFAULT_COMMAND_TIMEOUT_MS = 30 * 60 * 1e3;
var OUTPUT_TAIL_CHARS = 4e3;
var defaultCommandRunner = (cmd, args, opts) => new Promise((resolve12) => {
  const child = (0, import_node_child_process2.spawn)(cmd, args, { cwd: opts.cwd, shell: opts.shell ?? false });
  let stdout = "";
  let stderr = "";
  let done = false;
  const finish = (code) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    resolve12({ code, stdout, stderr });
  };
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
    }
    stderr += `
[timeout after ${opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS}ms]`;
    finish(124);
  }, opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS);
  child.stdout?.on("data", (d) => {
    stdout += d.toString();
  });
  child.stderr?.on("data", (d) => {
    stderr += d.toString();
  });
  child.on("error", (err) => {
    stderr += String(err.message);
    finish(127);
  });
  child.on("close", (code) => finish(code ?? 1));
  if (child.stdin) {
    if (opts.stdin !== void 0) child.stdin.write(opts.stdin);
    child.stdin.end();
  }
});
function bumpVersion(version, kind) {
  if (kind === "none") return version;
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) throw new Error(`Cannot bump version: "${version}" is not semver`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}
function tail(text) {
  const combined = text.trim();
  return combined.length > OUTPUT_TAIL_CHARS ? `\u2026
${combined.slice(-OUTPUT_TAIL_CHARS)}` : combined;
}
async function runReleasePipeline(opts) {
  const repoDir = opts.repoDir ?? process.cwd();
  const run = opts.run ?? defaultCommandRunner;
  const dryRun = opts.dryRun ?? false;
  const remote = opts.remote ?? "origin";
  const scripts = opts.scripts ?? DEFAULT_SELF_UPDATE_CONFIG.releaseScripts;
  const wantPush = opts.push ?? false;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const pkgPath = path10.join(repoDir, "package.json");
  const steps = [];
  const notes = [];
  let versionFrom = "";
  let versionTo = "";
  let committed = false;
  let commitHash;
  let pushed = false;
  let abortedAt;
  let abortReason;
  const record = (step) => {
    steps.push(step);
    return step;
  };
  if (dryRun) {
    notes.push("dry-run validates preflight only (repo state, semver, branch): the version bump, the release scripts and the commit are skipped because each of them writes to the tree/index.");
  }
  const abort = (name, reason) => {
    abortedAt = name;
    abortReason = reason;
    return report(false);
  };
  const report = (ok) => ({
    ok,
    dryRun,
    repoDir,
    versionFrom,
    versionTo,
    committed,
    commitHash,
    pushed,
    steps,
    abortedAt,
    abortReason,
    notes
  });
  let currentVersion = "";
  try {
    const pkg = JSON.parse(fs8.readFileSync(pkgPath, "utf-8"));
    currentVersion = String(pkg.version ?? "");
  } catch (err) {
    record({ name: "read-package.json", cmd: pkgPath, code: 1, ok: false, ms: 0, outputTail: err.message });
    return abort("read-package.json", `cannot read ${pkgPath}`);
  }
  versionFrom = currentVersion;
  if (!/^\d+\.\d+\.\d+/.test(currentVersion)) {
    return abort("read-package.json", `package.json version "${currentVersion}" is not semver`);
  }
  record({ name: "read-package.json", code: 0, ok: true, ms: 0 });
  const git = async (args) => run("git", args, { cwd: repoDir, timeoutMs: 6e4 });
  let t0 = Date.now();
  const gitDir = await git(["rev-parse", "--git-dir"]);
  record({ name: "git-repository", cmd: "git rev-parse --git-dir", code: gitDir.code, ok: gitDir.code === 0, ms: Date.now() - t0, outputTail: gitDir.code === 0 ? void 0 : tail(gitDir.stderr || gitDir.stdout) });
  if (gitDir.code !== 0) return abort("git-repository", `${repoDir} is not a git repository`);
  const inProgress = [".git/MERGE_HEAD", ".git/rebase-merge", ".git/rebase-apply", ".git/CHERRY_PICK_HEAD"].filter((p) => fs8.existsSync(path10.join(repoDir, p)));
  t0 = Date.now();
  const unmerged = await git(["diff", "--name-only", "--diff-filter=U"]);
  const conflicting = unmerged.stdout.trim().split("\n").filter(Boolean);
  const stateOk = inProgress.length === 0 && conflicting.length === 0;
  record({
    name: "git-state",
    cmd: "git diff --name-only --diff-filter=U",
    code: stateOk ? 0 : 1,
    ok: stateOk,
    ms: Date.now() - t0,
    outputTail: stateOk ? void 0 : `in-progress: ${inProgress.join(", ")}; unmerged: ${conflicting.slice(0, 10).join(", ")}`
  });
  if (!stateOk) return abort("git-state", "a merge/rebase/cherry-pick is in progress or files are unmerged");
  t0 = Date.now();
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const branchName = branch.stdout.trim();
  const detached = branchName === "HEAD" || branchName === "";
  const branchOk = !(wantPush && detached);
  record({
    name: "git-branch",
    cmd: "git rev-parse --abbrev-ref HEAD",
    code: branchOk ? 0 : 1,
    ok: branchOk,
    ms: Date.now() - t0,
    outputTail: branchOk ? void 0 : "HEAD is detached \u2014 nothing to push"
  });
  if (!branchOk) return abort("git-branch", "cannot push from a detached HEAD");
  try {
    versionTo = bumpVersion(currentVersion, opts.bump ?? "patch");
  } catch (err) {
    return abort("bump-version", err.message);
  }
  t0 = Date.now();
  if (dryRun) {
    record({ name: "bump-version", code: 0, ok: true, ms: 0, skipped: true, outputTail: `dry-run: would write ${currentVersion} \u2192 ${versionTo}` });
  } else {
    const raw = fs8.readFileSync(pkgPath, "utf-8");
    const updated = raw.replace(/("version"\s*:\s*")([^"]*)(")/, `$1${versionTo}$3`);
    fs8.writeFileSync(pkgPath, updated, "utf-8");
    const written = /"version"\s*:\s*"([^"]+)"/.exec(updated)?.[1];
    const ok = written === versionTo;
    record({ name: "bump-version", code: ok ? 0 : 1, ok, ms: Date.now() - t0, outputTail: ok ? `${currentVersion} \u2192 ${versionTo}` : `wrote "${written}"` });
    if (!ok) return abort("bump-version", "package.json version was not updated");
  }
  if (!dryRun) {
    for (const script of scripts) {
      t0 = Date.now();
      const res = await run("npm", ["run", script], { cwd: repoDir, timeoutMs });
      const ok = res.code === 0;
      record({ name: `npm run ${script}`, cmd: `npm run ${script}`, code: res.code, ok, ms: Date.now() - t0, outputTail: ok ? void 0 : tail(res.stdout + "\n" + res.stderr) });
      if (!ok) {
        restoreVersion(pkgPath, versionFrom);
        notes.push(`package.json version restored to ${versionFrom} (no commit was made).`);
        return abort(`npm run ${script}`, `${script} failed (exit ${res.code}); aborting before commit`);
      }
    }
    if (opts.installCommand) {
      t0 = Date.now();
      const res = await run(opts.installCommand, [], { cwd: repoDir, timeoutMs, shell: true });
      const ok = res.code === 0;
      record({ name: "install", cmd: opts.installCommand, code: res.code, ok, ms: Date.now() - t0, outputTail: ok ? void 0 : tail(res.stdout + "\n" + res.stderr) });
      if (!ok) {
        restoreVersion(pkgPath, versionFrom);
        notes.push(`package.json version restored to ${versionFrom} (no commit was made).`);
        return abort("install", `install command failed (exit ${res.code})`);
      }
    }
    const cliPath = path10.join(repoDir, "build", "agent-cli.js");
    if (fs8.existsSync(cliPath)) {
      t0 = Date.now();
      const res = await run(process.execPath, [cliPath, "--version"], { cwd: repoDir, timeoutMs: 6e4 });
      const seen = (res.stdout + res.stderr).trim();
      const ok = res.code === 0 && seen.includes(versionTo);
      record({
        name: "smoke built CLI",
        cmd: `node build/agent-cli.js --version`,
        code: ok ? 0 : 1,
        ok,
        ms: Date.now() - t0,
        outputTail: ok ? seen.split("\n")[0] : `expected version ${versionTo}, got "${seen.slice(0, 120)}"`
      });
      if (!ok) {
        restoreVersion(pkgPath, versionFrom);
        notes.push(`package.json version restored to ${versionFrom} (no commit was made).`);
        return abort("smoke built CLI", `build/agent-cli.js does not report ${versionTo}`);
      }
    } else {
      record({ name: "smoke built CLI", code: 0, ok: true, ms: 0, skipped: true, outputTail: "no build/agent-cli.js (pack step not in release_scripts)" });
    }
  } else {
    record({ name: "verification", code: 0, ok: true, ms: 0, skipped: true, outputTail: `dry-run: would run ${scripts.map((s) => `npm run ${s}`).join(", ")}` });
  }
  if (dryRun) {
    record({ name: "git add -A", code: 0, ok: true, ms: 0, skipped: true, outputTail: "dry-run: would stage all changes" });
    record({ name: "git commit", code: 0, ok: true, ms: 0, skipped: true, outputTail: "dry-run: would commit" });
    record({
      name: "git push",
      code: 0,
      ok: true,
      ms: 0,
      skipped: true,
      outputTail: wantPush ? `dry-run: would push to ${remote}` : "push not requested (allow_push is off)"
    });
    return report(true);
  }
  const message = opts.trailer === false ? opts.commitMessage : `${opts.commitMessage.trimEnd()}

Verified-by: code-agent self-update ${versionFrom} -> ${versionTo}
` + steps.filter((s) => !s.skipped && s.cmd).map((s) => `  ${s.name} (${(s.ms / 1e3).toFixed(1)}s)`).join("\n");
  t0 = Date.now();
  const add = await git(["add", "-A"]);
  record({ name: "git add -A", cmd: "git add -A", code: add.code, ok: add.code === 0, ms: Date.now() - t0, outputTail: add.code === 0 ? void 0 : tail(add.stderr) });
  if (add.code !== 0) {
    restoreVersion(pkgPath, versionFrom);
    return abort("git add -A", "staging failed");
  }
  const staged = await git(["diff", "--cached", "--name-only"]);
  if (staged.stdout.trim() === "") {
    record({ name: "git commit", code: 0, ok: true, ms: 0, skipped: true, outputTail: "nothing staged \u2014 skipped" });
    notes.push("Nothing was staged, so no commit was created.");
    return report(true);
  }
  t0 = Date.now();
  const commit = await run("git", ["commit", "-F", "-"], { cwd: repoDir, timeoutMs: 12e4, stdin: message });
  record({ name: "git commit", cmd: "git commit -F -", code: commit.code, ok: commit.code === 0, ms: Date.now() - t0, outputTail: commit.code === 0 ? void 0 : tail(commit.stderr || commit.stdout) });
  if (commit.code !== 0) {
    notes.push(`Commit failed; package.json still holds ${versionTo} \u2014 the change is staged, fix and re-run.`);
    return abort("git commit", "commit failed");
  }
  committed = true;
  const rev = await git(["rev-parse", "HEAD"]);
  commitHash = rev.stdout.trim() || void 0;
  if (!wantPush) {
    record({ name: "git push", code: 0, ok: true, ms: 0, skipped: true, outputTail: "push not requested (allow_push is off)" });
    return report(true);
  }
  t0 = Date.now();
  const push = await git(["push", remote, "HEAD"]);
  const pushOk = push.code === 0;
  record({ name: "git push", cmd: `git push ${remote} HEAD`, code: push.code, ok: pushOk, ms: Date.now() - t0, outputTail: pushOk ? void 0 : tail(push.stderr || push.stdout) });
  if (!pushOk) {
    notes.push("The commit exists locally; only the push failed. Re-run to push (no force push is ever attempted).");
    return abort("git push", `push to ${remote} failed`);
  }
  pushed = true;
  return report(true);
}
function restoreVersion(pkgPath, version) {
  try {
    const raw = fs8.readFileSync(pkgPath, "utf-8");
    fs8.writeFileSync(pkgPath, raw.replace(/("version"\s*:\s*")([^"]*)(")/, `$1${version}$3`), "utf-8");
  } catch {
  }
}
function formatReleaseReport(r) {
  const lines = [];
  lines.push(`${r.ok ? "RELEASE OK" : "RELEASE ABORTED"}${r.dryRun ? " (dry run)" : ""} \u2014 ${r.repoDir}`);
  lines.push(`  version: ${r.versionFrom} \u2192 ${r.versionTo}`);
  for (const s of r.steps) {
    const mark = s.skipped ? "\u2013" : s.ok ? "\u2713" : "\u2717";
    lines.push(`  ${mark} ${s.name} (${(s.ms / 1e3).toFixed(1)}s)${s.outputTail ? ` \u2014 ${s.outputTail.replace(/\s+/g, " ").slice(0, 200)}` : ""}`);
  }
  lines.push(`  committed: ${r.committed}${r.commitHash ? ` (${r.commitHash.slice(0, 10)})` : ""} | pushed: ${r.pushed}`);
  if (r.abortedAt) lines.push(`  aborted at: ${r.abortedAt} \u2014 ${r.abortReason}`);
  for (const n of r.notes) lines.push(`  note: ${n}`);
  return lines.join("\n");
}

// src/vs/workbench/contrib/agent/common/tools/selfImproveTools.ts
var SelfScanTool = class extends AgentTool {
  constructor(_config) {
    super();
    this._config = _config;
  }
  name = "agent_self_scan";
  description = "Read your own run history and return FACTS about how recent tasks went: tool call/failure histograms, failures grouped by normalized error (so a defect that happened 40 times is one line, not 40), run signals (user /btw corrections, model fallbacks, context overflows, reasoning loops, step-limit hits, unknown tools), and the slowest / most expensive tasks. Use it before proposing any change to your own code: it says what is true, not what is wrong. Session transcripts are never read.";
  parameters = {
    type: "object",
    properties: {
      days: {
        type: "number",
        description: "Look-back window in days (default from `self_update.evidence_days`)."
      },
      max_tasks: {
        type: "number",
        description: "Hard cap on task logs scanned, newest first (default from config)."
      }
    },
    required: []
  };
  async execute(args) {
    const toolCallId = String(args._toolCallId ?? "");
    try {
      const evidence = collectRunEvidence({
        days: Number(args.days) > 0 ? Number(args.days) : void 0,
        maxTasks: Number(args.max_tasks) > 0 ? Number(args.max_tasks) : void 0
      });
      return this.success(toolCallId, formatEvidenceReport(evidence));
    } catch (err) {
      return this.failure(toolCallId, `Could not collect run evidence: ${err.message}`);
    }
  }
};
var AgentReleaseTool = class extends AgentTool {
  constructor(_config) {
    super();
    this._config = _config;
  }
  name = "agent_release";
  description = "Release a change to your own code through a checked gate: version bump \u2192 `npm run` scripts (typecheck, tests, pack) \u2192 smoke the built CLI \u2192 git commit \u2192 optional push. It ABORTS at the first failure and leaves nothing half-published: no commit on red tests, no --force, no --amend, no --no-verify, and package.json is restored if it aborts before committing. Use `dry_run` first when unsure. Pass a conventional commit message; the pipeline appends a machine-verified trailer listing every step it actually ran.";
  parameters = {
    type: "object",
    properties: {
      message: {
        type: "string",
        description: 'Commit message (conventional style, e.g. "fix: ..."; a body is welcome).'
      },
      bump: {
        type: "string",
        enum: ["patch", "minor", "major", "none"],
        description: "Semver field to increment. Default: patch."
      },
      push: {
        type: "boolean",
        description: "Push after committing. Only honoured when `self_update.allow_push` is true."
      },
      dry_run: {
        type: "boolean",
        description: "Preflight only: validate the tree, run nothing that writes, commit nothing."
      },
      repo_dir: {
        type: "string",
        description: "Repository to release. Default: the process working directory."
      }
    },
    required: ["message"]
  };
  async execute(args, signal) {
    const toolCallId = String(args._toolCallId ?? "");
    if (signal?.aborted) {
      return this.failure(toolCallId, "Release cancelled");
    }
    const message = String(args.message ?? "").trim();
    if (!message) {
      return this.failure(toolCallId, "A commit message is required.");
    }
    const requestedPush = args.push === true;
    const allowPush = requestedPush && this._config.allowPush;
    const report = await runReleasePipeline({
      repoDir: typeof args.repo_dir === "string" && args.repo_dir ? args.repo_dir : void 0,
      bump: ["patch", "minor", "major", "none"].includes(args.bump) ? args.bump : "patch",
      commitMessage: message,
      push: allowPush,
      remote: this._config.remote,
      dryRun: args.dry_run === true,
      scripts: this._config.releaseScripts,
      installCommand: this._config.installCommand || void 0
    });
    const text = formatReleaseReport(report) + (requestedPush && !allowPush ? "\n  note: push was requested but `self_update.allow_push` is false \u2014 committed locally only." : "");
    return report.ok ? this.success(toolCallId, text) : this.failure(toolCallId, text);
  }
};

// src/vs/workbench/contrib/agent/common/agentSessions.ts
var fs10 = __toESM(require("node:fs"));
var path12 = __toESM(require("node:path"));

// src/vs/workbench/contrib/agent/common/agentStorage.ts
var fs9 = __toESM(require("node:fs"));
var os6 = __toESM(require("node:os"));
var path11 = __toESM(require("node:path"));
var ENV_STATE_DIR = "AGENT_STATE_DIR";
var ENV_SESSIONS_DIR = "AGENT_SESSIONS_DIR";
var ENV_TASKS_DIR = "AGENT_TASKS_DIR";
var ENV_SAVE_SESSIONS = "AGENT_SAVE_SESSIONS";
function expandStoragePath(input) {
  const home = os6.homedir();
  let out = input.trim();
  if (!out) return out;
  if (out === "~") out = home;
  else if (out.startsWith("~/")) out = path11.join(home, out.slice(2));
  out = out.replace(/^\$\{HOME\}/, home);
  return path11.resolve(out);
}
function truthy(raw) {
  if (raw === void 0) return void 0;
  const value = raw.trim().toLowerCase();
  if (!value) return void 0;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return void 0;
}
function parseStorageYaml(text) {
  const out = {};
  let inSection = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (indent === 0) {
      inSection = trimmed === "storage:";
      continue;
    }
    if (!inSection) continue;
    const sep5 = trimmed.indexOf(":");
    if (sep5 < 0) continue;
    const key = trimmed.slice(0, sep5).trim();
    const value = stripYamlComment(trimmed.slice(sep5 + 1)).trim().replace(/^["']|["']$/g, "");
    if (!value) continue;
    if (key === "state_dir") out.stateDir = value;
    else if (key === "sessions_dir") out.sessionsDir = value;
    else if (key === "tasks_dir") out.tasksDir = value;
    else if (key === "save_sessions") out.saveSessions = truthy(value);
  }
  return out;
}
function storageFromJson(file, text) {
  try {
    const parsed = JSON.parse(text);
    const raw = parsed?.storage;
    if (!raw || typeof raw !== "object") return {};
    const section = { stateDir: raw.state_dir, sessionsDir: raw.sessions_dir, tasksDir: raw.tasks_dir, saveSessions: truthy(raw.save_sessions) };
    return section;
  } catch {
    return {};
  }
}
function loadStorageYamlSection(dirs) {
  const cwd = dirs?.cwd ?? process.cwd();
  const files = [
    path11.join(cwd, "config.yaml"),
    path11.join(cwd, "config.json"),
    ...dirs?.home ? [path11.join(dirs.home, "config.yaml"), path11.join(dirs.home, "config.json")] : agentHomeFileCandidates("config.yaml").concat(agentHomeFileCandidates("config.json"))
  ];
  for (const file of files) {
    try {
      if (!fs9.existsSync(file)) continue;
      const text = fs9.readFileSync(file, "utf-8");
      const section = file.endsWith(".json") ? storageFromJson(file, text) : parseStorageYaml(text);
      if (section.stateDir || section.sessionsDir || section.tasksDir || section.saveSessions !== void 0) {
        return section;
      }
    } catch {
    }
  }
  return {};
}
function firstDefined(...values) {
  for (let i = 0; i < values.length; i++) {
    if (values[i] !== void 0) return { value: values[i], index: i };
  }
  return { value: void 0, index: -1 };
}
var SOURCE_LABELS = ["cli flag", "env var", "config.yaml", "default"];
function resolveStorageSettings(overrides = {}, env2 = process.env, yaml = loadStorageYamlSection(), home = agentHomeDir()) {
  const stateRaw = firstDefined(overrides.stateDir, env2[ENV_STATE_DIR], yaml.stateDir);
  const baseDir = stateRaw.value ? expandStoragePath(stateRaw.value) : home;
  const sessionsRaw = firstDefined(overrides.sessionsDir, env2[ENV_SESSIONS_DIR], yaml.sessionsDir);
  const tasksRaw = firstDefined(overrides.tasksDir, env2[ENV_TASKS_DIR], yaml.tasksDir);
  const saveRaw = firstDefined(
    overrides.saveSessions,
    truthy(env2[ENV_SAVE_SESSIONS]),
    yaml.saveSessions
  );
  return {
    stateDir: baseDir,
    sessionsDir: sessionsRaw.value ? expandStoragePath(sessionsRaw.value) : path11.join(baseDir, "sessions"),
    tasksDir: tasksRaw.value ? expandStoragePath(tasksRaw.value) : path11.join(baseDir, "tasks"),
    saveSessions: saveRaw.value !== false,
    source: saveRaw.index === 0 || stateRaw.index === 0 || sessionsRaw.index === 0 || tasksRaw.index === 0 ? SOURCE_LABELS[0] : stateRaw.index === 1 || sessionsRaw.index === 1 || tasksRaw.index === 1 || saveRaw.index === 1 ? SOURCE_LABELS[1] : stateRaw.index === 2 || sessionsRaw.index === 2 || tasksRaw.index === 2 || saveRaw.index === 2 ? SOURCE_LABELS[2] : SOURCE_LABELS[3]
  };
}
var _active;
function configureStorage(overrides = {}) {
  _active = resolveStorageSettings(overrides);
  return _active;
}
function storageSettings() {
  return _active ??= resolveStorageSettings();
}
function sessionsDir() {
  return storageSettings().sessionsDir;
}
function tasksDir() {
  return storageSettings().tasksDir;
}
function storageNotice(settings = storageSettings(), home = agentHomeDir()) {
  const defaultSessions = path11.join(home, "sessions");
  const defaultTasks = path11.join(home, "tasks");
  const parts = [];
  if (settings.sessionsDir !== defaultSessions) parts.push(`sessions \u2192 ${settings.sessionsDir}`);
  if (settings.tasksDir !== defaultTasks) parts.push(`tasks \u2192 ${settings.tasksDir}`);
  if (!settings.saveSessions) parts.push("session saving OFF");
  if (parts.length === 0) return void 0;
  return `${parts.join(" | ")} (${settings.source})`;
}

// src/vs/workbench/contrib/agent/common/agentSessions.ts
var INDEX_FILE = "_index.json";
var CWD_INDEX_FILE = "_cwd_index.json";
var CWD_INDEX_VERSION = 1;
function scanJsonField(buffer, key, wantString) {
  const at = buffer.indexOf(key);
  if (at < 0) return null;
  let p = at + key.length;
  while (p < buffer.length) {
    const c = buffer[p];
    if (c === 58 || c === 32 || c === 9 || c === 10 || c === 13) p++;
    else break;
  }
  if (wantString) {
    if (buffer[p] !== 34) return null;
    const start2 = ++p;
    while (p < buffer.length && buffer[p] !== 34) {
      p += buffer[p] === 92 ? 2 : 1;
    }
    if (p >= buffer.length) return null;
    const raw = buffer.slice(start2, p).toString("utf8");
    return raw.includes("\\") ? null : raw;
  }
  const start = p;
  while (p < buffer.length && buffer[p] >= 48 && buffer[p] <= 57) p++;
  if (p === start) return null;
  return Number(buffer.slice(start, p).toString());
}
var WORKING_DIR_KEY = Buffer.from('"workingDirectory"');
var UPDATED_AT_KEY = Buffer.from('"updatedAt"');
function scanSessionFile(file) {
  let buffer;
  try {
    buffer = fs10.readFileSync(file);
  } catch {
    return void 0;
  }
  const dir = scanJsonField(buffer, WORKING_DIR_KEY, true);
  const updatedAt = scanJsonField(buffer, UPDATED_AT_KEY, false);
  if (typeof updatedAt !== "number") return void 0;
  return {
    dir: typeof dir === "string" && dir.length > 0 ? AgentSessionManager._normDir(dir) : "",
    updatedAt
  };
}
var AgentSessionManager = class _AgentSessionManager {
  constructor(_workingDirectory = process.cwd(), _dirOverride) {
    this._workingDirectory = _workingDirectory;
    this._dirOverride = _dirOverride;
  }
  _index = {};
  _indexLoaded = false;
  /**
   * In-memory copy of the cwd sidecar. Without it every tab completion and every
   * `/sessions` read the sidecar from disk; with it, repeated queries during one
   * session are free.
   */
  _cwdEntries;
  /**
   * Directory this manager reads/writes.
   *
   * Resolved per call (not at import time) so `--sessions-dir` / `--state-dir`
   * / `AGENT_SESSIONS_DIR` redirect the store without the CLI having to thread a
   * path through every caller.
   */
  get _dir() {
    return this._dirOverride ?? sessionsDir();
  }
  /**
   * Ensure sessions directory exists and load index.
   */
  _ensureDir() {
    if (!fs10.existsSync(this._dir)) {
      fs10.mkdirSync(this._dir, { recursive: true });
    }
  }
  _loadIndex() {
    if (this._indexLoaded) return;
    this._ensureDir();
    const indexPath = path12.join(this._dir, INDEX_FILE);
    if (fs10.existsSync(indexPath)) {
      try {
        this._index = JSON.parse(fs10.readFileSync(indexPath, "utf-8"));
      } catch {
        this._index = {};
      }
    }
    this._indexLoaded = true;
  }
  _saveIndex() {
    this._ensureDir();
    const indexPath = path12.join(this._dir, INDEX_FILE);
    fs10.writeFileSync(indexPath, JSON.stringify(this._index, null, 2), "utf-8");
  }
  /**
   * Save the current agent state as a session.
   */
  saveSession(id, name, mode, messages, systemPrompt, extraSystemPrompt, plan) {
    this._loadIndex();
    const now = Date.now();
    const session = {
      id,
      name,
      mode,
      messages,
      systemPrompt,
      extraSystemPrompt,
      workingDirectory: this._workingDirectory,
      plan,
      createdAt: this._index[id]?.createdAt || now,
      updatedAt: now,
      messageCount: messages.length,
      summary: this._extractSummary(messages)
    };
    this._ensureDir();
    const sessionPath = path12.join(this._dir, `${id}.json`);
    fs10.writeFileSync(sessionPath, JSON.stringify(session, null, 2), "utf-8");
    this._index[id] = {
      name: session.name,
      mode: session.mode,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      messageCount: session.messageCount,
      summary: session.summary
    };
    this._saveIndex();
    this._touchCwdIndex(id, session.workingDirectory, session.updatedAt);
    return session;
  }
  /**
   * Load a session by ID.
   */
  loadSession(id) {
    this._loadIndex();
    const sessionPath = path12.join(this._dir, `${id}.json`);
    if (!fs10.existsSync(sessionPath)) {
      return void 0;
    }
    try {
      const data = JSON.parse(fs10.readFileSync(sessionPath, "utf-8"));
      return data;
    } catch {
      return void 0;
    }
  }
  /**
   * Get the most recent session (by updatedAt) across the WHOLE store.
   *
   * This is directory-blind: it is right for `/sessions` (which lists everything)
   * and for an explicit `--session <id>` lookup, but it is the WRONG default for a
   * bare `--resume`. On the author's machine the store held 2163 sessions across
   * 1550 distinct working directories, so "the most recent session" was usually a
   * different project. Use {@link getLatestSessionForCwd} for `--resume`.
   */
  getLatestSession() {
    this._loadIndex();
    let latestId;
    let latestTime = -1;
    for (const [id, entry] of Object.entries(this._cwdIndex())) {
      if (entry.updatedAt > latestTime) {
        latestTime = entry.updatedAt;
        latestId = id;
      }
    }
    if (latestId === void 0) {
      const ids = Object.keys(this._index);
      if (ids.length === 0) return void 0;
      let fallbackId = ids[0];
      let fallbackTime = this._index[fallbackId]?.updatedAt || 0;
      for (const id of ids) {
        const t = this._index[id]?.updatedAt || 0;
        if (t > fallbackTime) {
          fallbackTime = t;
          fallbackId = id;
        }
      }
      latestId = fallbackId;
    }
    return this.loadSession(latestId);
  }
  /**
   * Every session on disk as `{ id, dir, updatedAt }`, served from the sidecar.
   *
   * The sidecar is the difference between "usable" and "unusable" here: a raw file
   * scan parses every session JSON (~110 KB each) to learn one string per session,
   * which cost 570 ms per lookup and 2.9 s per directory listing on a 2163-session
   * store. After the one-time build, every query below is an in-memory filter.
   */
  _cwdIndex() {
    if (this._cwdEntries) return this._cwdEntries;
    this._loadIndex();
    const indexPath = path12.join(this._dir, CWD_INDEX_FILE);
    let entries;
    if (fs10.existsSync(indexPath)) {
      try {
        const parsed = JSON.parse(fs10.readFileSync(indexPath, "utf-8"));
        if (parsed.version === CWD_INDEX_VERSION && parsed.entries && typeof parsed.entries === "object") {
          entries = parsed.entries;
        }
      } catch {
      }
    }
    if (entries === void 0 || this._cwdIndexIsStale(entries)) {
      entries = this._rebuildCwdIndex();
    }
    this._cwdEntries = entries;
    return entries;
  }
  /**
   * Cheap staleness check: does any session file exist without a sidecar row?
   *
   * Uses `readdirSync` only (no file reads). An interrupted run leaves a session
   * file behind with no row, which is exactly what this catches — so the very next
   * `--resume` sees the session it wrote.
   */
  _cwdIndexIsStale(entries) {
    let names;
    try {
      names = fs10.readdirSync(this._dir);
    } catch {
      return false;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name === INDEX_FILE || name === CWD_INDEX_FILE) continue;
      if (!(name.slice(0, -".json".length) in entries)) return true;
    }
    return false;
  }
  /**
   * Build the sidecar from every session file. Runs at most once on a store that
   * predates the sidecar (or after an interrupted run), then stays current via
   * `saveSession` / `deleteSession`.
   *
   * Uses the targeted byte scan rather than `JSON.parse` — see `scanJsonField` for
   * the measurement that motivated it (532 ms vs 2820 ms on a 592 MB store).
   */
  _rebuildCwdIndex() {
    const entries = {};
    let names;
    try {
      names = fs10.readdirSync(this._dir);
    } catch {
      return entries;
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name === INDEX_FILE || name === CWD_INDEX_FILE) continue;
      const id = name.slice(0, -".json".length);
      const scanned = scanSessionFile(path12.join(this._dir, name));
      if (!scanned) continue;
      entries[id] = { dir: scanned.dir, updatedAt: scanned.updatedAt };
    }
    this._writeCwdIndex(entries);
    return entries;
  }
  /** Persist the sidecar (best effort: a failure only costs a later rebuild). */
  _writeCwdIndex(entries) {
    try {
      this._ensureDir();
      const payload = { version: CWD_INDEX_VERSION, entries };
      fs10.writeFileSync(path12.join(this._dir, CWD_INDEX_FILE), JSON.stringify(payload), "utf-8");
    } catch {
    }
  }
  /** Record / refresh one session's sidecar row (called on save). */
  _touchCwdIndex(id, workingDirectory, updatedAt) {
    const entries = this._cwdIndex();
    entries[id] = { dir: this._normDirOf(workingDirectory), updatedAt };
    this._writeCwdIndex(entries);
  }
  /** Drop one session's sidecar row (called on delete). */
  _dropFromCwdIndex(id) {
    const entries = this._cwdIndex();
    if (!(id in entries)) return;
    delete entries[id];
    this._writeCwdIndex(entries);
  }
  /** Resolve + normalize one working directory, or `''` when it is unusable. */
  _normDirOf(workingDirectory) {
    if (typeof workingDirectory !== "string" || workingDirectory.length === 0) return "";
    return _AgentSessionManager._normDir(workingDirectory);
  }
  /**
   * Normalized form used to compare working directories.
   *
   * `path.resolve` collapses `..`, relative spellings and duplicate separators;
   * the trailing-separator trim makes `/repo/` and `/repo` the same place.
   */
  static _normDir(dir) {
    let out = path12.resolve(dir);
    while (out.length > 1 && (out.endsWith(path12.sep) || out.endsWith("/"))) {
      out = out.slice(0, -1);
    }
    return out;
  }
  /**
   * The most recent session whose recorded working directory is `workingDirectory`.
   *
   * The correct default for a bare `--resume`: a session belongs to the project it
   * was created in, so resuming stays inside the current directory instead of
   * jumping into whichever project the user touched last.
   *
   * O(n) over a small in-memory map, so it is cheap enough for the tab completer.
   *
   * @param workingDirectory - directory to match (defaults to the manager's).
   * @returns the session, or undefined when this directory has none — NEVER a
   *   session from another directory.
   */
  getLatestSessionForCwd(workingDirectory = this._workingDirectory) {
    const want = _AgentSessionManager._normDir(workingDirectory);
    const entries = this._cwdIndex();
    let latestId;
    let latestUpdated = -1;
    for (const [id, entry] of Object.entries(entries)) {
      if (entry.dir !== want) continue;
      if (entry.updatedAt > latestUpdated) {
        latestUpdated = entry.updatedAt;
        latestId = id;
      }
    }
    return latestId === void 0 ? void 0 : this.loadSession(latestId);
  }
  /** Parse one session file defensively (a corrupt file is skipped, never fatal). */
  _readSessionFile(file) {
    try {
      return JSON.parse(fs10.readFileSync(file, "utf-8"));
    } catch {
      return void 0;
    }
  }
  /**
   * Like {@link listSessions} but scoped to one working directory.
   *
   * Used by `/sessions` and the tab completer so the default listing answers "what
   * did I do in THIS project" instead of mixing every project together.
   */
  listSessionsForCwd(workingDirectory = this._workingDirectory) {
    const want = _AgentSessionManager._normDir(workingDirectory);
    const entries = this._cwdIndex();
    this._loadIndex();
    const forCwd = Object.entries(entries).filter(([, entry]) => entry.dir === want).map(([id, entry]) => ({ id, entry }));
    const sessions = forCwd.map(({ id, entry }) => {
      const meta = this._index[id];
      if (meta) {
        return {
          id,
          name: meta.name || id,
          mode: meta.mode,
          createdAt: meta.createdAt,
          updatedAt: meta.updatedAt || entry.updatedAt,
          messageCount: meta.messageCount,
          summary: meta.summary
        };
      }
      const session = this._readSessionFile(path12.join(this._dir, `${id}.json`));
      return {
        id,
        name: session?.name || id,
        mode: session?.mode ?? "agent",
        createdAt: session?.createdAt || entry.updatedAt,
        updatedAt: session?.updatedAt || entry.updatedAt,
        messageCount: session?.messageCount ?? 0,
        summary: session?.summary
      };
    });
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return sessions;
  }
  /**
   * List all sessions with metadata (sorted by updatedAt descending).
   */
  listSessions() {
    this._loadIndex();
    const entries = Object.entries(this._index).map(([id, info]) => ({
      id,
      name: info.name,
      mode: info.mode,
      createdAt: info.createdAt,
      updatedAt: info.updatedAt,
      messageCount: info.messageCount,
      summary: info.summary
    }));
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    return entries;
  }
  /**
   * Delete a session by ID.
   */
  deleteSession(id) {
    this._loadIndex();
    const sessionPath = path12.join(this._dir, `${id}.json`);
    let deleted = false;
    if (fs10.existsSync(sessionPath)) {
      fs10.unlinkSync(sessionPath);
      deleted = true;
    }
    delete this._index[id];
    this._saveIndex();
    this._dropFromCwdIndex(id);
    return deleted;
  }
  /**
   * Generate a new unique session ID.
   */
  generateId() {
    const ts = Date.now();
    const rand = Math.random().toString(36).substring(2, 8);
    return `session_${ts}_${rand}`;
  }
  /**
   * Get the total count of stored sessions.
   */
  get count() {
    this._loadIndex();
    return Object.keys(this._index).length;
  }
  /**
   * Extract a short summary from conversation messages.
   */
  _extractSummary(messages) {
    const firstUser = messages.find((m) => m.role === "user" /* User */);
    if (firstUser && firstUser.content) {
      return firstUser.content.substring(0, 200);
    }
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" /* Assistant */ && m.content && !m.toolCalls?.length) {
        return m.content.substring(0, 200);
      }
    }
    return "(empty session)";
  }
};

// src/vs/workbench/contrib/agent/common/agentTaskLog.ts
var fs11 = __toESM(require("node:fs"));
var path13 = __toESM(require("node:path"));
var TASK_INDEX_FILE = "_index.json";
var TaskLogManager = class {
  constructor(_dirOverride) {
    this._dirOverride = _dirOverride;
  }
  _index = {};
  _indexLoaded = false;
  /**
   * Directory this manager reads/writes.
   *
   * Resolved per call (not at import time) so `--tasks-dir` / `--state-dir` /
   * `AGENT_TASKS_DIR` redirect the store without threading a path everywhere.
   */
  get _dir() {
    return this._dirOverride ?? tasksDir();
  }
  _ensureDir() {
    if (!fs11.existsSync(this._dir)) {
      fs11.mkdirSync(this._dir, { recursive: true });
    }
  }
  _loadIndex() {
    if (this._indexLoaded) return;
    this._ensureDir();
    const indexPath = path13.join(this._dir, TASK_INDEX_FILE);
    if (fs11.existsSync(indexPath)) {
      try {
        this._index = JSON.parse(fs11.readFileSync(indexPath, "utf-8"));
      } catch {
        this._index = {};
      }
    }
    this._indexLoaded = true;
  }
  _saveIndex() {
    this._ensureDir();
    const indexPath = path13.join(this._dir, TASK_INDEX_FILE);
    fs11.writeFileSync(indexPath, JSON.stringify(this._index, null, 2), "utf-8");
  }
  /**
   * Save a task execution log to disk.
   */
  saveTaskLog(log2) {
    this._loadIndex();
    this._ensureDir();
    const logPath = path13.join(this._dir, `${log2.id}.json`);
    fs11.writeFileSync(logPath, JSON.stringify(log2, null, 2), "utf-8");
    this._index[log2.id] = {
      id: log2.id,
      task: log2.task.substring(0, 200),
      mode: log2.mode,
      status: log2.status,
      totalSteps: log2.totalSteps,
      totalToolCalls: log2.totalToolCalls,
      durationMs: log2.durationMs,
      startedAt: log2.startedAt,
      finishedAt: log2.finishedAt,
      summary: this._buildSummary(log2)
    };
    this._saveIndex();
  }
  /**
   * Load a task log by ID.
   */
  loadTaskLog(id) {
    this._loadIndex();
    const logPath = path13.join(this._dir, `${id}.json`);
    if (!fs11.existsSync(logPath)) {
      return void 0;
    }
    try {
      return JSON.parse(fs11.readFileSync(logPath, "utf-8"));
    } catch {
      return void 0;
    }
  }
  /**
   * List all task logs (sorted by startedAt descending — newest first).
   */
  listTaskLogs() {
    this._loadIndex();
    const entries = Object.values(this._index);
    entries.sort((a, b) => b.startedAt - a.startedAt);
    return entries;
  }
  /**
   * Delete a task log by ID.
   */
  deleteTaskLog(id) {
    this._loadIndex();
    const logPath = path13.join(this._dir, `${id}.json`);
    let deleted = false;
    if (fs11.existsSync(logPath)) {
      fs11.unlinkSync(logPath);
      deleted = true;
    }
    delete this._index[id];
    this._saveIndex();
    return deleted;
  }
  /**
   * Generate a unique task log ID.
   */
  generateId() {
    const ts = Date.now();
    const rand = Math.random().toString(36).substring(2, 8);
    return `task_${ts}_${rand}`;
  }
  /**
   * Get the most recent task log.
   */
  getLatestTaskLog() {
    this._loadIndex();
    const entries = this.listTaskLogs();
    if (entries.length === 0) return void 0;
    return this.loadTaskLog(entries[0].id);
  }
  /**
   * Get total task log count.
   */
  get count() {
    this._loadIndex();
    return Object.keys(this._index).length;
  }
  /**
   * Build a human-readable summary from the task log.
   */
  _buildSummary(log2) {
    const parts = [];
    parts.push(log2.task.substring(0, 120));
    for (const step of log2.steps) {
      const content = step.llmResponse.content;
      if (content && content.length > 0) {
        parts.push(content.substring(0, 150));
        break;
      }
    }
    return parts.join(" | ").substring(0, 300);
  }
  /**
   * Format a task log for human-readable console output.
   */
  formatTaskLog(log2) {
    const lines = [];
    const statusIcon = log2.status === "completed" ? "\u2713" : log2.status === "failed" ? "\u2717" : "\u2298";
    lines.push(`Task: ${log2.task}`);
    lines.push(`Status: ${statusIcon} ${log2.status}`);
    lines.push(`Mode: ${log2.mode} | Model: ${log2.config.provider}/${log2.config.model}`);
    lines.push(`Steps: ${log2.totalSteps} | Tool calls: ${log2.totalToolCalls}`);
    if (log2.tokenUsage) {
      const u = log2.tokenUsage;
      const cached = u.cachedTokens ? ` | cache read: ${u.cachedTokens}${u.cacheCreationTokens ? ` + write: ${u.cacheCreationTokens}` : ""}` : "";
      lines.push(`Tokens: ${u.promptTokens} in / ${u.completionTokens} out / ${u.totalTokens} total${cached}`);
    }
    lines.push(`Duration: ${(log2.durationMs / 1e3).toFixed(1)}s`);
    lines.push(`Started: ${new Date(log2.startedAt).toLocaleString()}`);
    lines.push(`Finished: ${new Date(log2.finishedAt).toLocaleString()}`);
    if (log2.error) {
      lines.push(`Error: ${log2.error}`);
    }
    lines.push("");
    for (const step of log2.steps) {
      lines.push(`\u2500\u2500 Step ${step.stepIndex + 1} (${step.durationMs}ms) \u2500\u2500`);
      if (step.llmResponse.reasoningContent) {
        lines.push(`  [Reasoning] ${step.llmResponse.reasoningContent.substring(0, 200)}`);
      }
      if (step.llmResponse.content) {
        const content = step.llmResponse.content.substring(0, 300);
        lines.push(`  [Response] ${content}`);
      }
      if (step.llmResponse.toolCalls && step.llmResponse.toolCalls.length > 0) {
        for (const tc of step.llmResponse.toolCalls) {
          const argsStr = JSON.stringify(tc.arguments).substring(0, 100);
          lines.push(`  [Tool Call] ${tc.name}(${argsStr})`);
        }
      }
      for (const exec of step.toolExecutions) {
        const icon = exec.success ? "\u2713" : "\u2717";
        const output = exec.result.length > 200 ? exec.result.substring(0, 200) + `... (${exec.result.length} chars)` : exec.result;
        lines.push(`  ${icon} ${exec.toolName} (${exec.durationMs}ms): ${output}`);
        if (exec.error) {
          lines.push(`    Error: ${exec.error}`);
        }
      }
      lines.push("");
    }
    return lines.join("\n");
  }
};

// src/vs/workbench/contrib/agent/common/agentToolMock.ts
var fs12 = __toESM(require("node:fs"));
var os7 = __toESM(require("node:os"));
var path14 = __toESM(require("node:path"));
var READ_ONLY_MOCK_TOOLS = [
  "read_file",
  "list_directory",
  "search_text",
  "search_files",
  "search_content"
];
var WS_TOKEN = "{{WS}}";
var HOME_TOKEN = "{{HOME}}";
function substitute(text, pairs) {
  let out = text;
  for (const [from, to] of pairs) {
    if (!from) continue;
    out = out.split(from).join(to);
  }
  return out;
}
function tokenPairs(workspace) {
  const home = os7.homedir();
  const pairs = [];
  if (workspace) pairs.push([path14.resolve(workspace), WS_TOKEN]);
  if (home) pairs.push([home, HOME_TOKEN]);
  return pairs.sort((a, b) => b[0].length - a[0].length);
}
function normalizeValue(value, pairs) {
  if (typeof value === "string") return substitute(value, pairs);
  if (Array.isArray(value)) return value.map((v) => normalizeValue(v, pairs));
  if (value && typeof value === "object") {
    const source = value;
    const out = {};
    for (const key of Object.keys(source).sort()) out[key] = normalizeValue(source[key], pairs);
    return out;
  }
  return value;
}
function parseToolMockTools(spec) {
  if (!spec) return READ_ONLY_MOCK_TOOLS;
  const value = spec.trim();
  if (!value) return READ_ONLY_MOCK_TOOLS;
  if (value === "all" || value === "*") return void 0;
  if (value === "read" || value === "read-only" || value === "readonly") return READ_ONLY_MOCK_TOOLS;
  const names = value.split(",").map((s) => s.trim()).filter(Boolean);
  return names.length > 0 ? names : READ_ONLY_MOCK_TOOLS;
}
function normalizeMode(raw) {
  const value = (raw || "").trim().toLowerCase();
  if (!value || value === "off" || value === "0" || value === "false" || value === "no") return "off";
  if (value === "record" || value === "rec" || value === "on" || value === "1") return "record";
  if (value === "replay" || value === "play") return "replay";
  return "off";
}
function resolveToolMockOptions(cli = {}, env2 = process.env, defaultDir = process.cwd()) {
  const mode = normalizeMode(cli.mode ?? env2.AGENT_TOOL_MOCK);
  if (mode === "off") {
    return { mode: "off", file: "", tools: READ_ONLY_MOCK_TOOLS, strict: false, workspace: process.cwd() };
  }
  const fileRaw = cli.file || env2.AGENT_TOOL_MOCK_FILE || "";
  const file = fileRaw ? path14.resolve(fileRaw.replace(/^~(?=\/|$)/, os7.homedir())) : path14.join(defaultDir, "tool-mocks", "default.json");
  const strict = cli.strict !== void 0 ? cli.strict : ["1", "true", "yes", "on"].includes((env2.AGENT_TOOL_MOCK_STRICT || "").trim().toLowerCase());
  return {
    mode,
    file,
    tools: parseToolMockTools(cli.tools ?? env2.AGENT_TOOL_MOCK_TOOLS),
    strict,
    workspace: process.cwd()
  };
}
var ToolMockStore = class {
  constructor(options) {
    this.options = options;
    this._tokens = tokenPairs(options.workspace || process.cwd());
    this._fixture = this._load();
  }
  _fixture;
  _counters = /* @__PURE__ */ new Map();
  _tokens;
  get file() {
    return this.options.file;
  }
  get mode() {
    return this.options.mode;
  }
  get entryCount() {
    return Object.values(this._fixture.entries).reduce((sum, list) => sum + list.length, 0);
  }
  _load() {
    const empty = {
      version: 1,
      createdAt: (/* @__PURE__ */ new Date()).toISOString(),
      workspace: WS_TOKEN,
      entries: {}
    };
    if (!this.options.file || !fs12.existsSync(this.options.file)) return empty;
    try {
      const parsed = JSON.parse(fs12.readFileSync(this.options.file, "utf-8"));
      if (!parsed || typeof parsed !== "object" || typeof parsed.entries !== "object" || parsed.entries === null) {
        return empty;
      }
      return {
        version: parsed.version ?? 1,
        createdAt: parsed.createdAt ?? (/* @__PURE__ */ new Date()).toISOString(),
        workspace: parsed.workspace ?? WS_TOKEN,
        entries: parsed.entries
      };
    } catch {
      return empty;
    }
  }
  _save() {
    if (!this.options.file) return;
    try {
      fs12.mkdirSync(path14.dirname(this.options.file), { recursive: true });
      fs12.writeFileSync(this.options.file, JSON.stringify(this._fixture, null, 2), "utf-8");
    } catch {
    }
  }
  /** Deterministic key for a call: tool name + tokenized, sorted arguments. */
  keyFor(toolName, args) {
    const clean = {};
    for (const key of Object.keys(args).sort()) {
      if (key.startsWith("_")) continue;
      clean[key] = normalizeValue(args[key], this._tokens);
    }
    return `${toolName}\0${JSON.stringify(clean)}`;
  }
  /** Next occurrence index for a key (0-based, shared across the process). */
  _nextIndex(key) {
    const index = this._counters.get(key) ?? 0;
    this._counters.set(key, index + 1);
    return index;
  }
  /** Tokenize/de-tokenize helpers used for stored outputs. */
  detokenize(text) {
    return substitute(text, this._tokens.map(([real, token]) => [token, real]));
  }
  _tokenize(text) {
    return substitute(text, this._tokens);
  }
  /**
   * Execute (record) or look up (replay) one tool call.
   *
   * `toolCallId` always comes from the CURRENT call so the agent's tool-call
   * pairing stays intact regardless of what was recorded.
   */
  async invoke(tool, args, signal) {
    const toolCallId = args._toolCallId || "";
    if (this.options.mode === "off") return tool.execute(args, signal);
    const key = this.keyFor(tool.name, args);
    const index = this._nextIndex(key);
    if (this.options.mode === "replay") {
      const entry = this._fixture.entries[key]?.[index];
      if (entry) {
        return {
          toolCallId,
          success: entry.success,
          output: this.detokenize(entry.output ?? ""),
          error: entry.error === void 0 ? void 0 : this.detokenize(entry.error)
        };
      }
      if (this.options.strict) {
        return {
          toolCallId,
          success: false,
          output: "",
          error: `tool mock: no recorded result for ${tool.name} (call #${index + 1}) in ${this.options.file}`
        };
      }
      const live2 = await tool.execute(args, signal);
      this._record(key, index, live2);
      return live2;
    }
    const live = await tool.execute(args, signal);
    this._record(key, index, live);
    return live;
  }
  _record(key, index, result) {
    const list = this._fixture.entries[key] ?? (this._fixture.entries[key] = []);
    list[index] = {
      success: result.success,
      output: this._tokenize(result.output ?? ""),
      error: result.error === void 0 ? void 0 : this._tokenize(result.error),
      recordedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    this._fixture.createdAt = this._fixture.createdAt || (/* @__PURE__ */ new Date()).toISOString();
    this._save();
  }
};
var MockedAgentTool = class extends AgentTool {
  constructor(_inner, _store) {
    super();
    this._inner = _inner;
    this._store = _store;
  }
  get name() {
    return this._inner.name;
  }
  get description() {
    return this._inner.description;
  }
  get parameters() {
    return this._inner.parameters;
  }
  timeoutFor(args, config) {
    return this._inner.timeoutFor(args, config);
  }
  execute(args, signal) {
    return this._store.invoke(this._inner, args, signal);
  }
};
function installToolMock(registry, store, log2) {
  if (store.mode === "off") return 0;
  const wanted = store.options.tools;
  let wrapped = 0;
  registry.decorate((tool) => {
    if (wanted && !wanted.includes(tool.name)) return tool;
    wrapped++;
    return new MockedAgentTool(tool, store);
  });
  log2?.(`${store.mode} \u2192 ${store.file} | ${wrapped} tool(s)${wanted ? `: ${wanted.filter((n) => registry.has(n)).join(", ")}` : " (all)"}`);
  return wrapped;
}

// src/vs/workbench/contrib/agent/common/agentReplInput.ts
var IMMEDIATE_COMMANDS = /* @__PURE__ */ new Map([
  ["/mode", "applies to subsequent tasks; the running task keeps the tool set it started with"],
  ["/stream", "takes effect on the next step"],
  ["/auto-save", "takes effect for the next auto-save"],
  ["/tasks", "lists saved task logs"],
  ["/task", "shows one saved task log"],
  ["/delete-task", "deletes one saved task log"],
  ["/sessions", "lists saved sessions"],
  ["/delete-session", "deletes one saved session"],
  ["/skills", "lists loaded skills"],
  ["/profiles", "lists configured profiles"],
  ["/help", "prints the command list"],
  ["/save", "snapshots the conversation so far"],
  ["/btw", "injects a hint or cancels the current tool"],
  ["/cancel", "cancels the current tool (alias for /btw cancel)"]
]);
var CONTINUE_IDLE_REASON = "resumes a run that stopped at the step limit";
var REFUSED_COMMANDS = /* @__PURE__ */ new Map([
  ["/profile", "switching the provider mid-run would leave the running loop on a disposed provider \u2014 finish the task or /btw cancel first"],
  ["/resume", "restoring a session replaces the message history the running task is still writing to"],
  ["/new", "starting a new session replaces the message history the running task is still writing to"],
  ["/parallel", "parallel mode starts additional agents \u2014 run it when idle"],
  ["/skill", "activating a skill rewrites the system prompt of the running task"],
  ["/use-skill", "activating a skill rewrites the system prompt of the running task"],
  ["/continue", "the agent is already running; /continue resumes a run that stopped at the step limit"]
]);
var EXIT_COMMANDS = /* @__PURE__ */ new Set(["exit", "quit", "q", "/exit", "/quit"]);
function splitCommand(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("/")) return { rest: trimmed };
  const space = trimmed.indexOf(" ");
  if (space < 0) return { command: trimmed.toLowerCase(), rest: "" };
  return { command: trimmed.slice(0, space).toLowerCase(), rest: trimmed.slice(space + 1).trim() };
}
function decideRunningLine(line, options = {}) {
  const trimmed = line.trim();
  if (!trimmed) return { route: "buffer", reason: "blank line ignored" };
  if (EXIT_COMMANDS.has(trimmed.toLowerCase())) {
    return { route: "immediate", command: trimmed.toLowerCase(), reason: "exits the REPL (cancels the running task)" };
  }
  const { command, rest } = splitCommand(trimmed);
  if (command === "/btw") {
    return { route: "btw", command, reason: rest ? `hint: ${rest}` : "usage error" };
  }
  if (command === "/continue") {
    return options.agentRunning === false ? { route: "immediate", command, reason: CONTINUE_IDLE_REASON } : { route: "refuse", command, reason: REFUSED_COMMANDS.get(command) };
  }
  if (command && REFUSED_COMMANDS.has(command)) {
    return { route: "refuse", command, reason: REFUSED_COMMANDS.get(command) };
  }
  if (command && IMMEDIATE_COMMANDS.has(command)) {
    return { route: "immediate", command, reason: IMMEDIATE_COMMANDS.get(command) };
  }
  if (command) {
    return { route: "refuse", command, reason: `unknown command "${command}" \u2014 type /help for the list` };
  }
  return { route: "buffer", reason: "queued as the next task" };
}
function refusalMessage(decision, whileRunning = true) {
  const name = decision.command ?? "that";
  const reason = decision.reason ?? "not allowed";
  if (!whileRunning) return `${name}: ${reason}.`;
  return `${name} is unavailable while a task is running: ${reason}. Use /btw cancel to stop the current tool, or /btw <hint> to steer it.`;
}

// vs-core/node-runtime/nodeFileService.ts
var fs13 = __toESM(require("node:fs"));
var nodePath = __toESM(require("node:path"));
var NodeFileService = class {
  _serviceBrand;
  async readFile(resource) {
    const content = fs13.readFileSync(resource.fsPath, "utf-8");
    return { resource, value: VSBuffer.fromString(content) };
  }
  async writeFile(resource, content) {
    const dir = nodePath.dirname(resource.fsPath);
    if (!fs13.existsSync(dir)) {
      fs13.mkdirSync(dir, { recursive: true });
    }
    fs13.writeFileSync(resource.fsPath, content.toString(), "utf-8");
    return this._stat(resource);
  }
  async resolve(resource, options) {
    const stat = this._stat(resource);
    if (stat.isDirectory) {
      const entries = fs13.readdirSync(resource.fsPath, { withFileTypes: true });
      stat.children = entries.map((e) => {
        const childUri = URI.file(nodePath.join(resource.fsPath, e.name));
        return {
          resource: childUri,
          name: e.name,
          isFile: e.isFile(),
          isDirectory: e.isDirectory(),
          isSymbolicLink: e.isSymbolicLink()
        };
      });
    }
    return stat;
  }
  async exists(resource) {
    return fs13.existsSync(resource.fsPath);
  }
  async del(resource) {
    fs13.rmSync(resource.fsPath, { recursive: true, force: true });
  }
  async createFolder(resource) {
    fs13.mkdirSync(resource.fsPath, { recursive: true });
    return this._stat(resource);
  }
  _stat(resource) {
    try {
      const s = fs13.statSync(resource.fsPath);
      return {
        resource,
        name: nodePath.basename(resource.fsPath),
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        isSymbolicLink: s.isSymbolicLink(),
        size: s.size,
        mtime: s.mtimeMs
      };
    } catch {
      return {
        resource,
        name: nodePath.basename(resource.fsPath),
        isFile: false,
        isDirectory: false,
        isSymbolicLink: false
      };
    }
  }
};

// vs-core/node-runtime/nodeSearchService.ts
var import_node_child_process3 = require("node:child_process");
var NodeSearchService = class {
  _serviceBrand;
  async textSearch(query) {
    const folder = query.folderQueries[0]?.folder.fsPath || ".";
    const pattern = query.contentPattern.pattern;
    const maxResults = query.maxResults || 50;
    try {
      let cmd = `rg --no-heading -n "${pattern.replace(/"/g, '\\"')}" "${folder}" --max-count ${maxResults}`;
      if (query.includePattern) {
        for (const glob of Object.keys(query.includePattern)) {
          cmd += ` --glob "${glob}"`;
        }
      }
      const output = (0, import_node_child_process3.execSync)(cmd, { encoding: "utf-8", timeout: 15e3 }).trim();
      const results = [];
      const fileMap = /* @__PURE__ */ new Map();
      for (const line of output.split("\n")) {
        if (!line) continue;
        const match = line.match(/^(.+?):(\d+):(.*)$/);
        if (!match) continue;
        const [, filePath, lineNum, text] = match;
        if (!fileMap.has(filePath)) {
          fileMap.set(filePath, { resource: URI.file(filePath), results: [] });
        }
        fileMap.get(filePath).results.push({
          range: { startLineNumber: parseInt(lineNum, 10) },
          preview: { text: text.trim() }
        });
      }
      return { results: [...fileMap.values()] };
    } catch {
      return { results: [] };
    }
  }
  async fileSearch(query) {
    const folder = query.folderQueries[0]?.folder.fsPath || ".";
    const pattern = query.filePattern || "*";
    const maxResults = query.maxResults || 100;
    try {
      const cmd = `find "${folder}" -name "${pattern}" -type f 2>/dev/null | head -${maxResults}`;
      const output = (0, import_node_child_process3.execSync)(cmd, { encoding: "utf-8", timeout: 1e4 }).trim();
      const results = output.split("\n").filter(Boolean).map((p) => ({ resource: URI.file(p) }));
      return { results };
    } catch {
      return { results: [] };
    }
  }
};

// vs-core/node-runtime/nodeTerminalService.ts
var import_node_child_process4 = require("node:child_process");
var NodeTerminalService = class {
  _serviceBrand;
  _defaultCwd;
  constructor(cwd) {
    this._defaultCwd = cwd;
  }
  createTerminal(options) {
    const cwd = options?.config?.cwd || this._defaultCwd;
    const onDataEmitter = new Emitter();
    const onExitEmitter = new Emitter();
    let proc = null;
    return {
      onData: onDataEmitter.event,
      onExit: onExitEmitter.event,
      sendText(text, addNewLine) {
        const cmd = addNewLine !== false ? text : text;
        proc = (0, import_node_child_process4.spawn)("sh", ["-c", cmd], {
          cwd,
          stdio: ["pipe", "pipe", "pipe"]
        });
        proc.stdout?.on("data", (data) => {
          onDataEmitter.fire(data.toString());
        });
        proc.stderr?.on("data", (data) => {
          onDataEmitter.fire(data.toString());
        });
        proc.on("exit", (code) => {
          onExitEmitter.fire({ code: code ?? void 0 });
        });
        proc.on("error", (err) => {
          onDataEmitter.fire(`Error: ${err.message}
`);
          onExitEmitter.fire({ code: 1 });
        });
      },
      dispose() {
        proc?.kill();
        onDataEmitter.dispose();
        onExitEmitter.dispose();
      }
    };
  }
};

// vs-core/node-runtime/main.ts
var C = {
  reset: "\x1B[0m",
  bold: "\x1B[1m",
  dim: "\x1B[2m",
  red: "\x1B[31m",
  green: "\x1B[32m",
  yellow: "\x1B[33m",
  blue: "\x1B[34m",
  cyan: "\x1B[36m",
  gray: "\x1B[90m",
  magenta: "\x1B[35m"
};
var EXIT_WORDS = /* @__PURE__ */ new Set(["exit", "quit", "q", "/exit", "/quit"]);
var REPL_COMMAND_HELP = [
  "/mode <agent|plan|ask>   Switch mode (applies to subsequent tasks)",
  "/profile <name>          Switch config profile   (idle only)",
  "/profiles                List configured profiles",
  "/stream                  Toggle token streaming",
  "/skill <name>            Activate a skill for this session   (idle only)",
  "/skills                  List loaded skills",
  "/save [name]             Save the current session",
  "/sessions                List sessions for THIS directory",
  "/sessions all            List sessions from every directory",
  "/resume [id]             Resume a session (no id: latest here)  (idle only)",
  "/new                     Start a new session   (idle only)",
  "/delete-session <id>     Delete a saved session",
  "/auto-save               Toggle session auto-save",
  "/tasks                   List saved task logs",
  "/task <id>               Show one task log",
  "/delete-task <id>        Delete a task log",
  "/continue                Resume a run that hit the step limit",
  "/btw <hint>              Steer the running task (or start one when idle)",
  "/btw cancel | /cancel    Abort the currently running tool",
  '/parallel "a" "b"        Run tasks concurrently   (idle only)',
  "/help                    Show this list",
  "exit | quit | Ctrl+C     Save the session and leave"
];
function log(color, prefix, msg) {
  console.log(`${color}${C.bold}[${prefix}]${C.reset} ${msg}`);
}
function expandHomePath(p) {
  if (p.startsWith("~/")) return nodePath2.join(nodeOs.homedir(), p.slice(2));
  return nodePath2.resolve(p);
}
function installBatchLog(file) {
  if (!file) return () => {
  };
  const outPath = expandHomePath(file);
  const stream = fs14.createWriteStream(outPath, { flags: "a" });
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk, enc, cb) => {
    stream.write(typeof chunk === "string" ? chunk : Buffer.from(chunk));
    return origOut(chunk, enc, cb);
  };
  process.stderr.write = (chunk, enc, cb) => {
    stream.write(typeof chunk === "string" ? chunk : Buffer.from(chunk));
    return origErr(chunk, enc, cb);
  };
  return () => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
    try {
      stream.end();
    } catch {
    }
  };
}
function acquireLock(file) {
  const lockPath = expandHomePath(file);
  try {
    fs14.mkdirSync(nodePath2.dirname(lockPath), { recursive: true });
  } catch {
  }
  const tryCreate = () => {
    try {
      const fd = fs14.openSync(lockPath, "wx");
      fs14.writeSync(fd, String(process.pid));
      fs14.closeSync(fd);
      return process.pid;
    } catch (e) {
      if (e && e.code === "EEXIST") return void 0;
      return process.pid;
    }
  };
  if (tryCreate()) {
    return () => {
      try {
        fs14.unlinkSync(lockPath);
      } catch {
      }
    };
  }
  let stale = false;
  try {
    const pid = parseInt(fs14.readFileSync(lockPath, "utf-8").trim(), 10);
    if (!pid || pid <= 0) {
      stale = true;
    } else {
      try {
        process.kill(pid, 0);
      } catch {
        stale = true;
      }
    }
  } catch {
    stale = true;
  }
  if (stale) {
    try {
      fs14.unlinkSync(lockPath);
    } catch {
    }
    if (tryCreate()) {
      return () => {
        try {
          fs14.unlinkSync(lockPath);
        } catch {
        }
      };
    }
  }
  return void 0;
}
function writeJsonFile(file, data) {
  try {
    const p = expandHomePath(file);
    fs14.mkdirSync(nodePath2.dirname(p), { recursive: true });
    fs14.writeFileSync(p, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error(`${C.yellow}[BATCH]${C.reset} failed to write result file ${file}: ${e.message}`);
  }
}
function mergeMcpSpecs(primary, secondary) {
  const out = [...primary];
  const seen = new Set(primary.map((s) => s.name));
  for (const s of secondary) {
    if (!seen.has(s.name)) {
      out.push(s);
      seen.add(s.name);
    }
  }
  return out;
}
function resolveMcpSpecs(resolved, opts) {
  const mode = (opts.mcp || "").trim().toLowerCase();
  const fromConfig = (resolved.mcpServers || []).map((s) => ({
    name: s.name,
    type: s.type,
    url: s.url,
    headers: s.headers,
    command: s.command,
    args: s.args,
    env: s.env,
    tools: s.tools
  }));
  if (mode === "off" || mode === "false" || mode === "none") return [];
  if (!mode) return fromConfig;
  const merged = mergeMcpSpecs(fromConfig, loadMcpServersFromJsonFile());
  if (mode === "on" || mode === "true" || mode === "all") return merged;
  const want = new Set(mode.split(",").map((x) => x.trim()).filter(Boolean));
  return merged.filter((s) => want.has(s.name));
}
function mcpAllowTools(opts) {
  const raw = (opts.mcpTools || "").trim();
  if (!raw) return void 0;
  return raw.split(",").map((x) => x.trim()).filter(Boolean);
}
function createCompleter(sessionManager, _skillsLoader, taskLogManager) {
  const knownCommands = [
    "/resume",
    "/mode",
    "/profile",
    "/skill",
    "/use-skill",
    "/save",
    "/sessions",
    "/new",
    "/auto-save",
    "/btw",
    "/stream",
    "/profiles",
    "/skills",
    "/parallel",
    "/continue",
    "/delete-session",
    "/help",
    "/cancel",
    "/tasks",
    "/task",
    "/delete-task"
  ];
  return (line) => {
    if (!line.startsWith("/")) {
      return [[], line];
    }
    const trimmed = line.trim();
    const resumeMatch = trimmed.match(/^\/resume(\s+(\S*))?$/);
    if (resumeMatch) {
      const partial = (resumeMatch[2] || "").toLowerCase();
      const sessions = sessionManager.listSessions();
      const matches = sessions.filter(
        (s) => s.id.toLowerCase().startsWith(partial) || s.name.toLowerCase().includes(partial)
      );
      if (matches.length > 0) {
        const completions = matches.map((s) => `/resume ${s.id}`);
        return [completions, line];
      }
      const latest = sessionManager.getLatestSessionForCwd(process.cwd());
      if (latest && !partial) {
        return [[`/resume ${latest.id}`], line];
      }
      return [[], line];
    }
    const sessionMatch = trimmed.match(/^\/session(\s+(\S*))?$/);
    if (sessionMatch) {
      const partial = (sessionMatch[2] || "").toLowerCase();
      const sessions = sessionManager.listSessions();
      const matches = sessions.filter(
        (s) => s.id.toLowerCase().startsWith(partial) || s.name.toLowerCase().includes(partial)
      );
      if (matches.length > 0) {
        return [matches.map((s) => `/session ${s.id}`), line];
      }
      return [[], line];
    }
    const deleteMatch = trimmed.match(/^\/delete-session(\s+(\S*))?$/);
    if (deleteMatch) {
      const partial = (deleteMatch[2] || "").toLowerCase();
      const sessions = sessionManager.listSessions();
      const matches = sessions.filter(
        (s) => s.id.toLowerCase().startsWith(partial) || s.name.toLowerCase().includes(partial)
      );
      if (matches.length > 0) {
        return [matches.map((s) => `/delete-session ${s.id}`), line];
      }
      return [[], line];
    }
    const taskMatch = trimmed.match(/^\/task(\s+(\S*))?$/);
    if (taskMatch && taskLogManager) {
      const partial = (taskMatch[2] || "").toLowerCase();
      const logs = taskLogManager.listTaskLogs();
      const matches = logs.filter((t) => t.id.toLowerCase().startsWith(partial));
      if (matches.length > 0) {
        return [matches.map((t) => `/task ${t.id}`), line];
      }
      return [[], line];
    }
    const deleteTaskMatch = trimmed.match(/^\/delete-task(\s+(\S*))?$/);
    if (deleteTaskMatch && taskLogManager) {
      const partial = (deleteTaskMatch[2] || "").toLowerCase();
      const logs = taskLogManager.listTaskLogs();
      const matches = logs.filter((t) => t.id.toLowerCase().startsWith(partial));
      if (matches.length > 0) {
        return [matches.map((t) => `/delete-task ${t.id}`), line];
      }
      return [[], line];
    }
    const modeMatch = trimmed.match(/^\/mode(\s+(\S*))?$/);
    if (modeMatch) {
      const partial = (modeMatch[2] || "").toLowerCase();
      const modes = ["agent", "plan", "ask"];
      const matches = modes.filter((m) => m.startsWith(partial));
      if (matches.length > 0) {
        return [matches.map((m) => `/mode ${m}`), line];
      }
      return [modes.map((m) => `/mode ${m}`), line];
    }
    const profileMatch = trimmed.match(/^\/profile(\s+(\S*))?$/);
    if (profileMatch) {
      const partial = (profileMatch[2] || "").toLowerCase();
      try {
        const profiles = listProfiles();
        const matches = profiles.filter(
          (p) => p.name.toLowerCase().startsWith(partial)
        );
        if (matches.length > 0) {
          return [matches.map((p) => `/profile ${p.name}`), line];
        }
        if (profiles.length > 0 && !partial) {
          return [profiles.map((p) => `/profile ${p.name}`), line];
        }
      } catch {
      }
      return [[], line];
    }
    const skillMatch = trimmed.match(/^\/skill(\s+(\S*))?$/);
    if (skillMatch) {
      const partial = (skillMatch[2] || "").toLowerCase();
      const skills = _skillsLoader.skills;
      const matches = skills.filter(
        (s) => s.name.toLowerCase().startsWith(partial)
      );
      if (matches.length > 0) {
        return [matches.map((s) => `/skill ${s.name}`), line];
      }
      if (skills.length > 0 && !partial) {
        return [skills.map((s) => `/skill ${s.name}`), line];
      }
      return [[], line];
    }
    const useSkillMatch = trimmed.match(/^\/use-skill(\s+(\S*))?$/);
    if (useSkillMatch) {
      const partial = (useSkillMatch[2] || "").toLowerCase();
      const skills = _skillsLoader.skills;
      const matches = skills.filter(
        (s) => s.name.toLowerCase().startsWith(partial)
      );
      if (matches.length > 0) {
        return [matches.map((s) => `/use-skill ${s.name}`), line];
      }
      if (skills.length > 0 && !partial) {
        return [skills.map((s) => `/use-skill ${s.name}`), line];
      }
      return [[], line];
    }
    const partialCmd = trimmed.split(/\s+/, 1)[0];
    const cmdMatches = knownCommands.filter(
      (cmd) => cmd.startsWith(partialCmd) && cmd !== partialCmd
    );
    if (cmdMatches.length > 0) {
      return [cmdMatches, line];
    }
    return [[], line];
  };
}
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    mode: "agent" /* Agent */,
    streaming: false,
    parallel: false,
    tasks: [],
    showProfiles: false,
    showSkills: false,
    resumeLatest: false,
    listSessions: false,
    listTaskLogs: false
  };
  let i = 0;
  while (i < args.length) {
    switch (args[i]) {
      case "--mode":
        i++;
        if (args[i] === "plan") opts.mode = "plan" /* Plan */;
        else if (args[i] === "ask") opts.mode = "ask" /* Ask */;
        else opts.mode = "agent" /* Agent */;
        break;
      case "--stream":
        opts.streaming = true;
        break;
      case "--parallel":
        opts.parallel = true;
        break;
      case "--profile":
        i++;
        opts.profile = args[i];
        break;
      case "--temperature":
        i++;
        opts.temperature = parseFloat(args[i]);
        break;
      case "--top-k":
        i++;
        opts.topK = parseInt(args[i], 10);
        break;
      case "--memory":
        i++;
        opts.memory = args[i] === "on" ? "on" : "off";
        break;
      case "--tracing":
        i++;
        opts.tracing = args[i] === "on" ? "on" : "off";
        break;
      case "--self-scan": {
        const next = args[i + 1];
        if (next !== void 0 && /^\d+$/.test(next)) {
          opts.selfScan = parseInt(next, 10);
          i++;
        } else opts.selfScan = 0;
        break;
      }
      case "--profiles":
        opts.showProfiles = true;
        break;
      case "--skills":
        opts.showSkills = true;
        break;
      case "--use-skill":
        i++;
        opts.useSkill = args[i];
        break;
      case "--session":
        i++;
        opts.sessionId = args[i];
        break;
      case "--resume":
        opts.resumeLatest = true;
        break;
      case "--sessions":
        opts.listSessions = true;
        break;
      case "--delete-session":
        i++;
        opts.deleteSessionId = args[i];
        break;
      case "--tasks":
        opts.listTaskLogs = true;
        break;
      case "--task":
        i++;
        opts.taskLogId = args[i];
        break;
      case "--delete-task":
        i++;
        opts.deleteTaskLogId = args[i];
        break;
      case "--batch":
        opts.batch = true;
        break;
      case "--batch-log":
        i++;
        opts.batchLog = args[i];
        break;
      case "--batch-result":
        i++;
        opts.batchResult = args[i];
        break;
      case "--batch-timeout":
        i++;
        opts.batchTimeout = parseInt(args[i], 10) || 0;
        break;
      case "--lock":
        i++;
        opts.lockFile = args[i];
        break;
      case "--cwd":
        i++;
        opts.cwd = args[i];
        break;
      case "--state-dir":
        i++;
        opts.stateDir = args[i];
        break;
      case "--sessions-dir":
        i++;
        opts.sessionsDir = args[i];
        break;
      case "--tasks-dir":
        i++;
        opts.tasksDir = args[i];
        break;
      case "--no-session-save":
        opts.noSessionSave = true;
        break;
      case "--tool-mock":
        i++;
        opts.toolMock = args[i] || "record";
        break;
      case "--tool-mock-file":
        i++;
        opts.toolMockFile = args[i];
        break;
      case "--tool-mock-tools":
        i++;
        opts.toolMockTools = args[i];
        break;
      case "--tool-mock-strict":
        opts.toolMockStrict = true;
        break;
      case "--step-timeout":
        i++;
        opts.stepTimeout = parseInt(args[i], 10) || 0;
        break;
      case "--mcp":
        i++;
        opts.mcp = args[i] || "on";
        break;
      case "--mcp-tools":
        i++;
        opts.mcpTools = args[i];
        break;
      case "--help":
        printHelp();
        process.exit(0);
      case "--version":
      case "-v":
        printVersion();
        process.exit(0);
      default:
        opts.tasks.push(args[i]);
    }
    i++;
  }
  return opts;
}
var AGENT_VERSION = "0.3.56";
function printVersion() {
  console.log(`code-agent v${AGENT_VERSION}`);
  console.log(`path: ${__filename}`);
  console.log(`node: ${process.version} (${process.platform}-${process.arch})`);
}
function printHelp() {
  console.log(`
${C.bold}CodeAgent - VS Code Agent Mode CLI${C.reset}

Usage:
  agent-cli [options] "task description"

Options:
  --mode <agent|plan|ask>     Set agent mode (default: agent)
  --stream                    Enable streaming output
  --parallel "t1" "t2"        Run multiple tasks in parallel
  --profile <name>            Use a specific config profile
  --profiles                  List available config profiles
  --skills                    List loaded skills
  --use-skill <name>          Activate a specific skill for this session
  --session <id>              Resume a specific session by ID
  --resume                    Resume the most recent session in the
                              CURRENT DIRECTORY (pass --session <id> to pick
                              one from another directory)
  --sessions                  List saved sessions
  --delete-session <id>       Delete a session
  --tasks                     List saved task logs
  --task <id>                 View a specific task log
  --delete-task <id>          Delete a task log
  --temperature <float>       Override sampling temperature (default from config)
  --top-k <int>               Override top-k sampling; 0 = provider default
  --memory <on|off>           Force shared agent memory on/off for this run
  --tracing <on|off>          Force Langfuse tracing on/off (LANGFUSE_* keys)
  --self-scan [days]          Print self-evolution evidence from your own run
                              history (tool failures, run signals) and exit
  --batch                     Headless: run the task(s), then exit (no REPL)
  --batch-log <file>          Also append all run output to <file>
  --batch-result <file>       Write a JSON result summary to <file>
  --batch-timeout <seconds>   Overall wall-clock limit for the run (0 = unlimited)
  --lock <file>               Skip the run if another process holds the lock
  --cwd <dir>                 Change working directory before running
  --step-timeout <ms>         Override the per-tool-call timeout
  --state-dir <dir>           Write sessions AND task logs under <dir>
                              (keeps benchmark runs out of ~/.agents)
  --sessions-dir <dir>        Override the sessions directory only
  --tasks-dir <dir>           Override the task-log directory only
  --no-session-save           Never write session files (task logs unaffected)
  --tool-mock <off|record|replay>  Record/replay tool results for repeatable
                              regression runs (default: off)
  --tool-mock-file <json>     Fixture to record into / replay from
                              (default: <state-dir>/tool-mocks/default.json)
  --tool-mock-tools <read|all|csv>  Tools the mock covers (default: read-only)
  --tool-mock-strict          A replay miss fails instead of executing live
  --mcp <off|on|a,b>          Load MCP servers (on = config.yaml + mcp.json)
  --mcp-tools <a,b,c>         Only expose these MCP tools (global allowlist)
  --help                      Show this help
  --version, -v               Show version

Batch / Cron:
  code-agent --batch --use-skill <skill> --cwd <dir> "do the whole workflow"
    Runs one-shot, no TTY required, and exits 0 on success / 1 on failure
    (124 on --batch-timeout). Combine with --batch-log/--batch-result to keep a
    durable record, and --lock to prevent overlapping scheduled runs.

MCP tools:
  Skills such as dolphin-mcp / caps-llvm-nda-daily call external MCP tools.
  Pass --mcp on to load servers from config.yaml mcp_servers and
  ~/.agents/mcp.json. Without --mcp only config.yaml mcp_servers load.
  Restrict the exposed tool set with --mcp-tools (recommended: some gateways
  advertise 180+ tools). A per-server "tools: [...]" entry is honoured too.

Session Management:
  Sessions persist your agent conversation context across restarts.
  - Auto-save: after each run, the session is saved automatically.
  - REPL commands: /save, /sessions, /resume, /new, /auto-save
  - Tab-completion: press Tab to auto-complete /resume, /mode, /profile, /skill, etc.
  - Storage: ~/.agents/sessions/ (redirect with --state-dir / --sessions-dir,
    or switch off with --no-session-save; env AGENT_STATE_DIR / AGENT_SESSIONS_DIR
    / AGENT_SAVE_SESSIONS, or config.yaml storage: block)

Task Logs (for troubleshooting):
  - Auto-save: after each task, a detailed execution log is saved automatically.
  - Includes: LLM requests/responses, tool calls with arguments and results, timings.
  - REPL commands: /tasks, /task <id>, /delete-task <id>
  - Storage: ~/.agents/tasks/ (redirect with --state-dir / --tasks-dir, env
    AGENT_STATE_DIR / AGENT_TASKS_DIR, or config.yaml storage: block)

Deterministic tool layer (regression benchmarks):
  --tool-mock record --tool-mock-file /tmp/bm/001.json "task"   # record once
  --tool-mock replay --tool-mock-file /tmp/bm/001.json "task"   # same results
  Only read-only tools are mocked by default (read_file, list_directory,
  search_text, search_files, search_content); write/edit/terminal keep running
  for real so the workspace verifications still hold. Workspace and home paths
  are tokenized in the fixture, so it replays in a fresh temp workspace.

Intervention:
  /btw <hint>    While the agent is running, inject a hint into its reasoning
                 for subsequent turns. While idle, treat it as a direct prompt
                 and respond immediately. Useful for course-correcting or adding
                 context mid-session.
                 An instruction that CONFLICTS with (or replaces) the running
                 task \u2014 e.g. "\u53D6\u6D88\u521A\u624D\u7684\u4EFB\u52A1\uFF0C\u6539\u4E3A\u57FA\u4E8E\u6700\u65B0\u7248\u672C\u91CD\u65B0\u6267\u884C" \u2014 is detected
                 automatically: the in-flight tool call is aborted, the running
                 plan is dropped, and the agent pivots to the new instruction.
  /btw cancel    Cancel the currently running tool (e.g., a long build or
                 poll). The agent will continue with the next step.

While a task is running (no need to wait for it to finish):
  Immediate   /mode /stream /tasks /task /sessions /skills /save /help /cancel,
              /profiles /delete-task /delete-session, and exit / quit.
              These only touch REPL state or signal the agent, so they run
              concurrently with the agent.
  Queued      A plain prompt is put in the queue and run right after the current
              task (two prompts cannot share one context window).
  Refused     /profile /resume /new /parallel /skill \u2014 rejected with a reason,
              because running them mid-task would leave the loop on a disposed
              provider or rewrite the history it is still writing. /btw cancel
              first, then run them.

Modes:
  agent   Full autonomy: read, write, edit files, run commands
  plan    Generate implementation plan without executing
  ask     Read-only: explore codebase and answer questions

Config (searched in order):
  1. CLI flags / env vars (OPENAI_API_KEY, LLM_MODEL, etc.)
  2. ./config.yaml
  3. ~/.agents/config.yaml
`);
}
var tracing = NOOP_TRACING;
var tracingFlush;
var _selfUpdateConfig;
function selfUpdateConfig() {
  return _selfUpdateConfig ??= loadSelfUpdateConfig();
}
async function flushTracing() {
  const flush = tracingFlush;
  tracingFlush = void 0;
  if (flush) await flush();
}
async function setupTracing(release, cliOverride) {
  tracing = initTracingFromConfig(cliOverride, release);
  if (!tracing.enabled) {
    if (cliOverride !== "off") {
      console.log(`${C.dim}[TRACING] off \u2014 ${tracing.reason}${C.reset}`);
    }
    return;
  }
  const ok = await tracing.init();
  if (!ok) {
    console.log(`${C.yellow}[TRACING]${C.reset} Langfuse SDK failed to load \u2014 tracing disabled for this run`);
    tracing = NOOP_TRACING;
    return;
  }
  console.log(`${C.green}[TRACING]${C.reset} Langfuse tracing enabled: ${tracing.describe?.() ?? ""}`);
  tracingFlush = () => tracing.shutdown();
  process.once("beforeExit", () => {
    void flushTracing();
  });
  process.once("SIGINT", () => {
    void flushTracing().finally(() => process.exit(130));
  });
  process.once("SIGTERM", () => {
    void flushTracing().finally(() => process.exit(143));
  });
}
async function createServices(resolved, memoryOverride, opts) {
  const config = resolved.agentConfig;
  if (!config.apiKey) {
    console.error(`${C.red}No API key found. Set OPENAI_API_KEY, or configure apiKey in ~/.agents/models.json or config.yaml.${C.reset}`);
    process.exit(1);
  }
  const llmProvider = LLMProviderFactory.create(config);
  const fileService = new NodeFileService();
  const searchService = new NodeSearchService();
  const terminalService = new NodeTerminalService(process.cwd());
  const toolRegistry = new ToolRegistry();
  const workspaceRoot = URI.file(process.cwd());
  toolRegistry.register(new ReadFileTool(fileService));
  toolRegistry.register(new WriteFileTool(fileService));
  toolRegistry.register(new EditFileTool(fileService));
  toolRegistry.register(new ListDirectoryTool(fileService));
  toolRegistry.register(new SearchTextTool(searchService, workspaceRoot));
  toolRegistry.register(new SearchFilesTool(searchService, workspaceRoot));
  toolRegistry.registerAlias("search_content", "search_text");
  toolRegistry.register(new RunTerminalTool(terminalService, process.cwd()));
  toolRegistry.register(new PollTool(terminalService, process.cwd()));
  const skillDirs = resolved.skillsDirs && resolved.skillsDirs.length > 0 ? resolved.skillsDirs : [defaultSkillsDir()];
  toolRegistry.register(new SkillCatalogTool(skillDirs));
  toolRegistry.register(new CreateSkillTool(skillDirs));
  toolRegistry.register(new UpdateSkillTool(skillDirs));
  const selfUpdate = selfUpdateConfig();
  if (selfUpdate.enabled) {
    toolRegistry.register(new SelfScanTool(selfUpdate));
    const releaseNote = selfUpdate.allowRelease ? `release ON${selfUpdate.allowPush ? " + push" : " (no push)"}` : "release OFF (self_update.allow_release)";
    console.log(`${C.green}[SELF]${C.reset} self-evolution: evidence scan ON, ${releaseNote}`);
    if (selfUpdate.allowRelease) {
      toolRegistry.register(new AgentReleaseTool(selfUpdate));
    }
  }
  const memoryConfig = memoryOverride === "off" ? void 0 : loadMemoryConfig();
  let memoryClient;
  if (memoryConfig) {
    memoryClient = new MemoryClient(memoryConfig, { workspaceDir: process.cwd() });
    toolRegistry.register(new MemorySearchTool(memoryClient));
    toolRegistry.register(new ConversationSearchTool(memoryClient));
    toolRegistry.register(new MemoryReadTool(memoryClient));
    toolRegistry.register(new MemoryWriteTool(memoryClient));
    const who = memoryConfig.username || memoryConfig.userId;
    console.log(`${C.green}[MEMORY]${C.reset} Shared memory enabled (tdai_agent_mem): user=${who || "?"} endpoint=${memoryConfig.endpoint} service=${memoryConfig.serviceId}`);
    console.log(`${C.dim}  Tools: tdai_memory_search / tdai_conversation_search / tdai_read_file / tdai_memory_write${C.reset}`);
    console.log(`${C.dim}  L1 workspace scope: ${memoryClient.workspaceScope} @ ${memoryClient.workspaceDir || "(unknown)"}${C.reset}`);
    if (memoryConfig.recall) console.log(`${C.dim}  Auto-recall: on | Auto-capture L0: ${memoryConfig.capture ? "on" : "off"}${C.reset}`);
  }
  const checkpointManager = new AgentCheckpointManager(fileService);
  let mcpTransports = [];
  if (opts) {
    const specs = resolveMcpSpecs(resolved, opts);
    if (specs.length > 0) {
      try {
        const { count, transports } = await registerMcpTools(
          toolRegistry,
          specs,
          (msg) => console.log(`${C.cyan}${msg}${C.reset}`),
          { allowTools: mcpAllowTools(opts), skipServers: ["tdai_agent_mem"] }
        );
        mcpTransports = transports;
        console.log(`${C.green}[MCP]${C.reset} ${count} tool(s) registered from ${specs.length} server(s)`);
      } catch (e) {
        console.log(`${C.yellow}[MCP]${C.reset} failed to load MCP servers: ${e.message}`);
      }
    }
  }
  const mockOptions = resolveToolMockOptions(
    {
      mode: opts?.toolMock,
      file: opts?.toolMockFile,
      tools: opts?.toolMockTools,
      strict: opts?.toolMockStrict
    },
    process.env,
    storageSettings().stateDir
  );
  if (mockOptions.mode !== "off") {
    try {
      const store = new ToolMockStore(mockOptions);
      const wrapped = installToolMock(toolRegistry, store, (msg) => console.log(`${C.magenta}[MOCK]${C.reset} ${msg}`));
      if (wrapped === 0) {
        console.log(`${C.yellow}[MOCK]${C.reset} no tool matched "${mockOptions.tools?.join(",") ?? "all"}" \u2014 mock inactive`);
      } else if (mockOptions.mode === "replay") {
        const hint = store.entryCount === 0 ? " (fixture is EMPTY \u2014 every call will execute live and be recorded; run once with --tool-mock record first)" : ` (${store.entryCount} recorded result(s))`;
        console.log(`${C.dim}[MOCK] replay${mockOptions.strict ? " strict" : ""}${hint}${C.reset}`);
      }
    } catch (e) {
      console.log(`${C.yellow}[MOCK]${C.reset} failed to initialise the tool mock: ${e.message}`);
    }
  }
  return { config, llmProvider, toolRegistry, checkpointManager, memoryClient, mcpTransports };
}
function attachAgentListeners(agentLoop, opts) {
  if (opts.streaming) {
    agentLoop.onDidStreamToken((token) => {
      process.stdout.write(token);
    });
  }
  agentLoop.onDidReceiveMessage((msg) => {
    if (msg.role === "assistant" /* Assistant */) {
      if (msg.reasoningContent) {
        log(C.dim, "THINKING", formatReasoningForLog(msg.reasoningContent));
      }
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          const argsStr = JSON.stringify(tc.arguments).substring(0, 120);
          log(C.cyan, "TOOL", `${tc.name}(${argsStr}...)`);
        }
      }
      if (msg.content && !opts.streaming) {
        log(C.green, "AGENT", msg.content);
      }
    } else if (msg.role === "tool" /* Tool */) {
      const truncated = msg.content.length > 500 ? msg.content.substring(0, 500) + `
... (${msg.content.length} chars)` : msg.content;
      log(C.yellow, "RESULT", truncated);
    } else if (msg.role === "user" /* User */) {
      log(C.blue, "USER", msg.content);
    }
  });
  agentLoop.setModelSwitchLogger((e) => {
    const color = e.reason === "primary-recovered" ? C.green : e.toFallback ? C.yellow : C.magenta;
    console.log(`${color}${C.bold}${formatModelSwitch(e)}${C.reset}`);
  });
  agentLoop.onDidError((err) => log(C.red, "ERROR", err.message));
  const colorDiff = ansiColorEnabled();
  agentLoop.onDidUpdateTodos((todos) => {
    if (todos.length === 0) {
      process.stdout.write(`
${C.dim}Plan cleared.${C.reset}
`);
      return;
    }
    const rendered = formatTodoList(todos, { color: colorDiff });
    if (rendered) process.stdout.write(`
${rendered}
`);
  });
  agentLoop.onDidReceiveToolDiff((toolDiff) => {
    const displayPath = displayPathFor(toolDiff.path, process.cwd(), nodePath2.sep);
    const card = colorDiff ? renderFileDiffAnsi(toolDiff, { color: true, displayPath }) : renderFileDiffPlain(toolDiff, displayPath);
    if (!card) return;
    process.stdout.write(`
${card}
`);
  });
  agentLoop.onDidComplete(() => console.log(`
${C.dim}--- Task completed ---${C.reset}
`));
}
async function runParallelMode(tasks, resolved, memoryOverride, opts) {
  const { config, llmProvider, toolRegistry, checkpointManager, memoryClient } = await createServices(resolved, memoryOverride, opts);
  console.log(`
${C.bold}${C.magenta}=== Parallel Agent Mode ===${C.reset}`);
  console.log(`${C.dim}Running ${tasks.length} tasks concurrently (max 4)${C.reset}
`);
  const modelRouter = new ModelRouter(resolved.modelRouting, resolved.profiles, config);
  const taskLogManager = new TaskLogManager();
  const manager = new ParallelAgentManager(config, llmProvider, toolRegistry, process.cwd(), checkpointManager, 4, modelRouter, memoryClient, tracing);
  manager.onDidTaskStart((task) => {
    log(C.cyan, `TASK ${task.id.slice(-6)}`, `Started: ${task.description.substring(0, 80)}`);
  });
  manager.onDidTaskComplete((result) => {
    const status = result.success ? `${C.green}OK` : `${C.red}FAIL`;
    log(status, `TASK ${result.taskId.slice(-6)}`, `${result.success ? "Completed" : "Failed"} in ${result.durationMs}ms`);
    if (result.error) {
      log(C.red, "ERROR", result.error);
    }
  });
  const results = await manager.runParallel(tasks);
  console.log(`
${C.bold}=== Results ===${C.reset}`);
  for (const result of results) {
    const task = manager.getTask(result.taskId);
    const status = result.success ? `${C.green}OK${C.reset}` : `${C.red}FAIL${C.reset}`;
    console.log(`  ${status} [${result.durationMs}ms] ${task?.description.substring(0, 60) || result.taskId}`);
    const agentMessages = result.messages.filter((m) => m.role === "assistant" /* Assistant */ && m.content);
    if (agentMessages.length > 0) {
      const lastMsg = agentMessages[agentMessages.length - 1];
      console.log(`    ${C.dim}${lastMsg.content.substring(0, 100)}${C.reset}`);
    }
    if (result.taskLog) {
      taskLogManager.saveTaskLog(result.taskLog);
      console.log(`    ${C.dim}[Task log: ${result.taskLog.id}]${C.reset}`);
    }
  }
  manager.dispose();
}
function wireModelFallback(agentLoop, modelRouter) {
  if (modelRouter.probeIntervalMs) {
    agentLoop.setProbeSchedule(modelRouter.probeIntervalMs);
  }
  const fb = modelRouter.fallbackConfig();
  if (!fb) return;
  try {
    agentLoop.setFallback(fb, LLMProviderFactory.create(fb));
    console.log(`${C.dim}Model fallback: ON | \u4FDD\u5E95\u6A21\u578B: ${fb.model} (auto-switch on API access timeout or rate limit; background probe switches back on recovery)${C.reset}`);
  } catch (err) {
    console.log(`${C.yellow}Model fallback: failed to init provider for "${fb.model}": ${err.message}${C.reset}`);
  }
}
async function runBatchMode(opts, resolved, skillsLoader) {
  const teardownLog = installBatchLog(opts.batchLog);
  const releaseLock = opts.lockFile ? acquireLock(opts.lockFile) : void 0;
  if (opts.lockFile && !releaseLock) {
    console.log(`${C.yellow}[BATCH]${C.reset} lock "${opts.lockFile}" is held by another run \u2014 skipping (exit 0)`);
    teardownLog();
    process.exit(0);
  }
  const task = opts.tasks.join(" ").trim();
  if (!task) {
    console.error(`${C.red}[BATCH]${C.reset} no task provided; usage: code-agent --batch "task"`);
    releaseLock?.();
    teardownLog();
    process.exit(2);
  }
  const modeLabel = opts.mode === "plan" /* Plan */ ? "plan" : opts.mode === "ask" /* Ask */ ? "ask" : "agent";
  const startedAt = Date.now();
  console.log(`${C.green}[BATCH]${C.reset} start pid=${process.pid} mode=${modeLabel} cwd=${process.cwd()}`);
  console.log(`${C.dim}${task.length > 400 ? task.slice(0, 400) + "\u2026" : task}${C.reset}`);
  const { config, llmProvider, toolRegistry, checkpointManager, memoryClient } = await createServices(resolved, opts.memory, opts);
  if (opts.stepTimeout && opts.stepTimeout > 0) config.stepTimeout = opts.stepTimeout;
  const modeManager = new AgentModeManager();
  modeManager.switchMode(opts.mode);
  const agentLoop = new AgentLoop(config, llmProvider, toolRegistry, modeManager, checkpointManager, process.cwd(), memoryClient, tracing);
  agentLoop.registerTodoTool();
  agentLoop.setExtraSystemPrompt(buildSkillsContext(skillsLoader, opts.useSkill, task));
  wireModelFallback(agentLoop, new ModelRouter(resolved.modelRouting, resolved.profiles, config));
  attachAgentListeners(agentLoop, opts);
  let timedOut = false;
  const timer = opts.batchTimeout && opts.batchTimeout > 0 ? setTimeout(() => {
    timedOut = true;
    console.log(`
${C.red}[BATCH]${C.reset} batch-timeout of ${opts.batchTimeout}s reached \u2014 cancelling task`);
    agentLoop.cancel();
  }, opts.batchTimeout * 1e3) : void 0;
  const onSignal = (sig) => {
    console.log(`
${C.yellow}[BATCH]${C.reset} received ${sig} \u2014 cancelling task`);
    agentLoop.cancel();
  };
  process.on("SIGINT", () => onSignal("SIGINT"));
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  let thrown;
  try {
    await agentLoop.run(task);
  } catch (e) {
    thrown = e.message || String(e);
  }
  if (timer) clearTimeout(timer);
  const status = timedOut ? "cancelled" : thrown || agentLoop.lastTaskError ? "failed" : "completed";
  const success = status === "completed";
  let taskLogId = "";
  try {
    const taskLog = agentLoop.exportTaskLog(status, thrown || agentLoop.lastTaskError);
    taskLogId = taskLog.id;
    new TaskLogManager().saveTaskLog(taskLog);
  } catch (e) {
    console.log(`${C.yellow}[BATCH]${C.reset} failed to save task log: ${e.message}`);
  }
  const lastAssistant = [...agentLoop.context.messages].reverse().find((m) => m.role === "assistant" /* Assistant */ && m.content && m.content.trim())?.content || "";
  const durationMs = Date.now() - startedAt;
  const result = {
    status,
    task,
    mode: modeLabel,
    pid: process.pid,
    cwd: process.cwd(),
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: (/* @__PURE__ */ new Date()).toISOString(),
    durationMs,
    durationSec: Math.round(durationMs / 1e3),
    taskLogId,
    error: thrown || agentLoop.lastTaskError || void 0,
    lastAssistant: lastAssistant.slice(0, 8e3)
  };
  if (opts.batchResult) writeJsonFile(opts.batchResult, result);
  const tag = success ? `${C.green}SUCCESS` : `${C.red}${status.toUpperCase()}`;
  console.log(`
${C.bold}[BATCH]${C.reset} ${tag}${C.reset} in ${result.durationSec}s (task log: ${taskLogId || "n/a"})`);
  agentLoop.dispose();
  releaseLock?.();
  teardownLog();
  await flushTracing();
  process.exit(success ? 0 : timedOut ? 124 : 1);
}
async function main() {
  const opts = parseArgs();
  if (opts.cwd) {
    try {
      process.chdir(expandHomePath(opts.cwd));
    } catch (e) {
      console.error(`${C.red}[BATCH]${C.reset} cannot chdir to ${opts.cwd}: ${e.message}`);
      process.exit(2);
    }
  }
  const storage = configureStorage({
    stateDir: opts.stateDir,
    sessionsDir: opts.sessionsDir,
    tasksDir: opts.tasksDir,
    saveSessions: opts.noSessionSave ? false : void 0
  });
  const storageInfo = storageNotice(storage);
  if (storageInfo) {
    console.log(`${C.dim}[STORAGE] ${storageInfo}${C.reset}`);
  }
  const sessionManager = new AgentSessionManager(process.cwd());
  const taskLogManager = new TaskLogManager();
  if (opts.showProfiles) {
    const profiles = listProfiles();
    if (profiles.length === 0) {
      console.log(`${C.dim}No models.json or config.yaml found. Create ~/.agents/models.json or ~/.agents/config.yaml${C.reset}`);
    } else {
      console.log(`
${C.bold}Available profiles:${C.reset}`);
      for (const p of profiles) {
        console.log(`  ${C.cyan}${p.name}${C.reset}  ${C.dim}${p.provider}/${p.model}${C.reset}`);
      }
    }
    return;
  }
  if (opts.listSessions) {
    const sessions = sessionManager.listSessions();
    if (sessions.length === 0) {
      console.log(`${C.dim}No saved sessions.${C.reset}`);
    } else {
      const here = sessionManager.listSessionsForCwd(process.cwd()).length;
      console.log(`
${C.bold}Saved sessions (${sessions.length} total, ${here} in this directory):${C.reset}
`);
      for (const s of sessions) {
        const date = new Date(s.updatedAt).toLocaleString();
        const modeLabel2 = s.mode === "plan" /* Plan */ ? "Plan" : s.mode === "ask" /* Ask */ ? "Ask" : "Agent";
        console.log(`  ${C.cyan}${s.id}${C.reset}`);
        console.log(`    ${C.bold}Name:${C.reset} ${s.name || "(unnamed)"}  ${C.bold}Mode:${C.reset} ${modeLabel2}  ${C.bold}Msgs:${C.reset} ${s.messageCount}`);
        console.log(`    ${C.bold}Updated:${C.reset} ${date}`);
        if (s.summary) {
          console.log(`    ${C.dim}${s.summary.substring(0, 120)}${C.reset}`);
        }
        console.log("");
      }
      console.log(`${C.dim}--resume picks the most recent session in the current directory; use --session <id> for any other.${C.reset}
`);
    }
    return;
  }
  if (opts.deleteSessionId) {
    const deleted = sessionManager.deleteSession(opts.deleteSessionId);
    if (deleted) {
      console.log(`${C.green}Session "${opts.deleteSessionId}" deleted.${C.reset}`);
    } else {
      console.log(`${C.yellow}Session "${opts.deleteSessionId}" not found.${C.reset}`);
    }
    return;
  }
  if (opts.listTaskLogs) {
    const taskLogs = taskLogManager.listTaskLogs();
    if (taskLogs.length === 0) {
      console.log(`${C.dim}No saved task logs.${C.reset}`);
    } else {
      console.log(`
${C.bold}Task logs (${taskLogs.length}):${C.reset}
`);
      for (const t of taskLogs) {
        const date = new Date(t.startedAt).toLocaleString();
        const dur = (t.durationMs / 1e3).toFixed(1);
        const statusIcon = t.status === "completed" ? `${C.green}\u2713` : t.status === "failed" ? `${C.red}\u2717` : `${C.yellow}\u2298`;
        console.log(`  ${C.cyan}${t.id}${C.reset} ${statusIcon}${C.reset}`);
        console.log(`    ${C.bold}Task:${C.reset} ${t.task.substring(0, 120)}`);
        console.log(`    ${C.bold}Mode:${C.reset} ${t.mode}  ${C.bold}Steps:${C.reset} ${t.totalSteps}  ${C.bold}Tools:${C.reset} ${t.totalToolCalls}  ${C.bold}Duration:${C.reset} ${dur}s`);
        console.log(`    ${C.bold}Started:${C.reset} ${date}`);
        console.log(`    ${C.dim}${t.summary.substring(0, 150)}${C.reset}`);
        console.log("");
      }
    }
    return;
  }
  if (opts.taskLogId) {
    const log2 = taskLogManager.loadTaskLog(opts.taskLogId);
    if (!log2) {
      console.log(`${C.yellow}Task log "${opts.taskLogId}" not found.${C.reset}`);
    } else {
      console.log(`
${C.bold}=== Task Log: ${log2.id} ===${C.reset}
`);
      console.log(taskLogManager.formatTaskLog(log2));
    }
    return;
  }
  if (opts.deleteTaskLogId) {
    const deleted = taskLogManager.deleteTaskLog(opts.deleteTaskLogId);
    if (deleted) {
      console.log(`${C.green}Task log "${opts.deleteTaskLogId}" deleted.${C.reset}`);
    } else {
      console.log(`${C.yellow}Task log "${opts.deleteTaskLogId}" not found.${C.reset}`);
    }
    return;
  }
  migrateLegacyAgentHome((message) => console.log(`${C.dim}${message}${C.reset}`));
  console.log(`${C.dim}Config home: ${agentHomeDir()}${C.reset}`);
  let resolved = loadConfig(opts.profile);
  if (opts.temperature !== void 0) resolved.agentConfig.temperature = opts.temperature;
  if (opts.topK !== void 0) resolved.agentConfig.topK = opts.topK;
  const skillsLoader = new SkillsLoader();
  skillsLoader.loadSkillsFromDirs(resolved.skillsDirs);
  skillsLoader.loadRulesFromDirs(resolved.rulesDirs);
  skillsLoader.loadAgentMdFiles(agentInstructionFiles(process.cwd()));
  setResolvedSkillDirs(resolved.skillsDirs);
  if (opts.showSkills) {
    if (skillsLoader.skills.length === 0) {
      console.log(`${C.dim}No skills found. Configure skills directories in config.yaml.${C.reset}`);
    } else {
      console.log(`
${C.bold}Loaded skills (${skillsLoader.skills.length}):${C.reset}`);
      for (const s of skillsLoader.skills) {
        console.log(`  ${C.cyan}${s.name}${C.reset}  ${C.dim}${s.description.substring(0, 80)}${C.reset}`);
        if (s.whenToUse) {
          console.log(`      whenToUse: ${C.dim}${s.whenToUse.substring(0, 100)}${C.reset}`);
        }
      }
    }
    if (skillsLoader.rules.length > 0) {
      console.log(`
${C.bold}Loaded rules (${skillsLoader.rules.length}):${C.reset}`);
      for (const r of skillsLoader.rules) {
        const tag = r.alwaysApply ? `${C.green}always` : `${C.yellow}manual`;
        console.log(`  ${tag}${C.reset}  ${C.dim}${r.description}${C.reset}`);
      }
    }
    console.log(`
${C.dim}Skill management tools (meta-skill): skill_catalog / create_skill / update_skill${C.reset}`);
    return;
  }
  const modeLabel = opts.mode === "plan" /* Plan */ ? "Plan" : opts.mode === "ask" /* Ask */ ? "Ask" : "Agent";
  console.log(`
${C.bold}${C.green}===========================================${C.reset}`);
  console.log(`${C.bold}  CodeAgent v${AGENT_VERSION} - ${modeLabel} Mode${C.reset}`);
  console.log(`${C.bold}${C.green}===========================================${C.reset}`);
  const cfg = resolved.agentConfig;
  console.log(`${C.dim}Profile: ${resolved.profileName} | Provider: ${cfg.provider} | Model: ${cfg.model}${C.reset}`);
  if (resolved.modelRouting.enabled) {
    const routingDefault = resolved.modelRouting.defaultModel || cfg.model;
    const scenarioEntries = Object.entries(resolved.modelRouting.scenarios || {}).map(([s, m]) => `${s}\u2192${m}`).join(", ");
    console.log(`${C.dim}Model routing: ON | startup: ${cfg.model} | default: ${routingDefault}${scenarioEntries ? ` | ${scenarioEntries}` : ""}${C.reset}`);
    if (resolved.modelRouting.fallbackModel) {
      console.log(`${C.dim}Model fallback: ${resolved.modelRouting.fallbackModel} (\u4FDD\u5E95\u6A21\u578B, auto-switch on API access timeout or rate limit)${C.reset}`);
    }
  } else if (resolved.profileExplicit) {
    console.log(`${C.dim}Model routing: OFF (profile "${resolved.profileName}" pinned via --profile \u2014 no runtime model switching)${C.reset}`);
  }
  console.log(`${C.dim}API Base: ${cfg.apiBase || "default"} | Mode: ${modeLabel}${opts.streaming ? " | Streaming" : ""}${C.reset}`);
  console.log(`${C.dim}Sampling: temperature=${cfg.temperature} top_k=${cfg.topK || "(provider default)"} | Memory: ${opts.memory ?? "auto"}${C.reset}`);
  console.log(`${C.dim}Config: ${resolved.configFilePath || "none (using defaults)"} | CWD: ${process.cwd()}${C.reset}`);
  const skillCount = skillsLoader.skills.length;
  const ruleCount = skillsLoader.rules.length;
  const mcpCount = resolved.mcpServers.length;
  const parts = [];
  if (skillCount > 0) parts.push(`Skills: ${skillCount}`);
  if (ruleCount > 0) parts.push(`Rules: ${ruleCount}`);
  if (mcpCount > 0) parts.push(`MCP Servers: ${mcpCount}`);
  if (parts.length > 0) {
    console.log(`${C.dim}${parts.join(" | ")}${C.reset}`);
  }
  console.log("");
  if (opts.selfScan !== void 0) {
    const cfg2 = selfUpdateConfig();
    const evidence = collectRunEvidence({ days: opts.selfScan > 0 ? opts.selfScan : cfg2.evidenceDays });
    console.log(formatEvidenceReport(evidence));
    return;
  }
  await setupTracing(AGENT_VERSION, opts.tracing);
  if (opts.parallel && opts.tasks.length > 1) {
    await runParallelMode(opts.tasks, resolved, opts.memory, opts);
    return;
  }
  if (opts.batch) {
    await runBatchMode(opts, resolved, skillsLoader);
    return;
  }
  const { config, llmProvider, toolRegistry, checkpointManager, memoryClient } = await createServices(resolved, opts.memory, opts);
  const modeManager = new AgentModeManager();
  modeManager.switchMode(opts.mode);
  const agentLoop = new AgentLoop(config, llmProvider, toolRegistry, modeManager, checkpointManager, process.cwd(), memoryClient, tracing);
  agentLoop.registerTodoTool();
  if (opts.streaming) {
    agentLoop.setStreaming(true);
  }
  let modelRouter = new ModelRouter(resolved.modelRouting, resolved.profiles, config);
  let currentModel = config.model;
  wireModelFallback(agentLoop, modelRouter);
  const applyModelRouting = (task) => {
    if (!modelRouter.enabled) return;
    const selected = modelRouter.selectConfig(task);
    if (selected.model === agentLoop.activeModel) return;
    const previousModel = agentLoop.activeModel;
    try {
      const newProvider = LLMProviderFactory.create(selected);
      agentLoop.swapProvider(selected, newProvider, "routing");
      currentModel = selected.model;
      log(C.dim, "ROUTE", `scenario ${modelRouter.detectScenario(task)} \u2192 ${selected.model}`);
    } catch (err) {
      log(C.red, "ROUTE", `Failed to switch model from ${previousModel} to ${selected.model}: ${err.message}`);
    }
  };
  const taskDescription = opts.tasks.length > 0 ? opts.tasks.join(" ") : void 0;
  const extraPrompt = buildSkillsContext(skillsLoader, opts.useSkill, taskDescription);
  if (extraPrompt) {
    agentLoop.setExtraSystemPrompt(extraPrompt);
  }
  attachAgentListeners(agentLoop, opts);
  let currentSessionId;
  let currentSessionName = "";
  let autoSaveEnabled = storage.saveSessions;
  const sessionToResume = opts.sessionId ? sessionManager.loadSession(opts.sessionId) : opts.resumeLatest ? sessionManager.getLatestSessionForCwd(process.cwd()) : void 0;
  if (sessionToResume) {
    const restoreMode = sessionToResume.mode;
    modeManager.switchMode(restoreMode);
    const rebuiltExtra = buildSkillsContext(skillsLoader, opts.useSkill, void 0);
    agentLoop.restoreFromSession(
      sessionToResume.messages,
      sessionToResume.systemPrompt || "",
      rebuiltExtra || ""
    );
    currentSessionId = sessionToResume.id;
    currentSessionName = sessionToResume.name;
    const date = new Date(sessionToResume.updatedAt).toLocaleString();
    console.log(`${C.magenta}[SESSION]${C.reset} Resumed session "${currentSessionName || currentSessionId}" (${sessionToResume.messageCount} msgs, last updated ${date})`);
    console.log(`${C.dim}  Summary: ${sessionToResume.summary || "(no summary)"}${C.reset}
`);
  } else if (opts.sessionId) {
    console.error(`${C.yellow}[SESSION]${C.reset} Session "${opts.sessionId}" not found in ${storage.sessionsDir}`);
    process.exit(1);
  } else if (opts.resumeLatest) {
    const forCwd = sessionManager.listSessionsForCwd(process.cwd()).length;
    const total = sessionManager.count;
    console.error(`${C.yellow}[SESSION]${C.reset} No saved session for this directory: ${process.cwd()}`);
    if (total > 0) {
      console.error(`${C.dim}  ${total} session(s) exist for other directories (this one has ${forCwd}).${C.reset}`);
      console.error(`${C.dim}  Use --sessions to list them, or --session <id> to resume one explicitly.${C.reset}`);
    } else {
      console.error(`${C.dim}  No sessions have been saved yet.${C.reset}`);
    }
    process.exit(1);
  } else if (sessionManager.count > 0) {
    const latest = sessionManager.getLatestSessionForCwd(process.cwd());
    if (latest) {
      const date = new Date(latest.updatedAt).toLocaleString();
      console.log(`${C.dim}Tip: Resume this directory's last session with --resume (${latest.name || latest.id}, ${latest.messageCount} msgs, ${date})${C.reset}
`);
    }
  }
  const autoSaveSession = (name) => {
    if (!autoSaveEnabled) return;
    const state = agentLoop.exportSessionState();
    if (state.messages.length === 0) return;
    const id = currentSessionId || sessionManager.generateId();
    const sessionName = name || currentSessionName || `Session ${(/* @__PURE__ */ new Date()).toLocaleString()}`;
    const saved = sessionManager.saveSession(
      id,
      sessionName,
      modeManager.currentMode,
      state.messages,
      state.systemPrompt,
      state.extraSystemPrompt,
      agentLoop.planner.currentPlan
    );
    currentSessionId = saved.id;
    currentSessionName = saved.name;
  };
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: createCompleter(sessionManager, skillsLoader, taskLogManager)
  });
  console.log(`${C.dim}Commands: /mode, /profile, /profiles, /stream, /skill, /skills, /parallel, /btw, /help, exit${C.reset}`);
  console.log(`${C.dim}Session:  /save, /sessions [/all], /resume [id], /new, /auto-save, /delete-session${C.reset}`);
  console.log(`${C.dim}Tasks:   /tasks, /task <id>, /delete-task <id>${C.reset}`);
  console.log(`${C.dim}Tip: /btw <hint> works any time (even while running). Conflicting instructions (e.g. "\u57FA\u4E8E\u6700\u65B0\u7248\u672C\u91CD\u65B0\u6267\u884C") auto-cancel the running tool/plan and pivot; /btw cancel aborts the current tool${C.reset}`);
  console.log(`${C.dim}Tip: control commands (/mode, /tasks, /sessions, /save, /help, exit) run IMMEDIATELY even while a task runs \u2014 no need to wait${C.reset}`);
  console.log(`${C.dim}Tip: press Tab to auto-complete commands like /resume, /mode, /profile, /skill${C.reset}
`);
  let agentIsRunning = false;
  const bufferedLines = [];
  let processingLock = false;
  const currentModeLabel = () => {
    switch (modeManager.currentMode) {
      case "plan" /* Plan */:
        return "Plan";
      case "ask" /* Ask */:
        return "Ask";
      default:
        return "Agent";
    }
  };
  const displayPrompt = () => {
    if (agentIsRunning) {
      process.stdout.write(`${C.bold}${C.yellow}[running - /btw to intervene]${C.reset} `);
    } else {
      process.stdout.write(`${C.bold}${C.blue}${currentModeLabel()}> ${C.reset}`);
    }
  };
  const processTask = async (task) => {
    try {
      const taskExtra = buildSkillsContext(skillsLoader, void 0, task);
      agentLoop.setExtraSystemPrompt(taskExtra);
      applyModelRouting(task);
      await agentLoop.run(task);
      autoSaveSession(task.substring(0, 80));
      const status = agentLoop.lastTaskError ? "failed" : "completed";
      const taskLog = agentLoop.exportTaskLog(status, agentLoop.lastTaskError);
      taskLogManager.saveTaskLog(taskLog);
    } catch (err) {
      log(C.red, "ERROR", err.message);
    }
  };
  const drainBufferedLines = async () => {
    while (bufferedLines.length > 0) {
      const next = bufferedLines.shift();
      const decision = decideRunningLine(next, { agentRunning: agentIsRunning });
      if (decision.route === "immediate" || decision.route === "refuse") {
        if (EXIT_WORDS.has(next.toLowerCase())) {
          void gracefulExit();
          return;
        }
        if (decision.route === "refuse") {
          log(C.yellow, "REFUSED", refusalMessage(decision, false));
        } else if (await handleCommand(next)) {
          if (agentIsRunning) {
            log(C.dim, "QUEUED", `${decision.command} \u2014 ${decision.reason ?? "executed from the queue"}`);
          }
        } else {
          log(C.yellow, "REPL", `no handler for ${decision.command} \u2014 nothing was done`);
        }
        continue;
      }
      if (decision.route === "btw") {
        const hint = next.slice(4).trim();
        if (hint && hint !== "cancel" && hint !== "abort") {
          log(C.magenta, "BTW", `Buffered hint as prompt: "${hint.substring(0, 80)}${hint.length > 80 ? "..." : ""}"`);
          await runAgentTask(hint);
        }
        continue;
      }
      console.log(`
${C.dim}--- Processing queued: "${next.substring(0, 80)}${next.length > 80 ? "..." : ""}" ---${C.reset}`);
      await runAgentTask(next);
    }
  };
  const gracefulExit = async () => {
    try {
      if (agentIsRunning) {
        agentLoop.cancel();
        agentIsRunning = false;
      }
      autoSaveSession();
      if (currentSessionId) {
        console.log(`
${C.dim}Session saved: ${currentSessionId}${C.reset}`);
      }
      console.log(`${C.dim}Goodbye!${C.reset}`);
    } catch (e) {
      console.error("Error during graceful exit:", e);
    }
    rl.close();
    agentLoop.dispose();
    await flushTracing();
    setTimeout(() => process.exit(0), 100);
  };
  const handleCommand = async (trimmed) => {
    if (trimmed.startsWith("/save")) {
      const name = trimmed.slice(5).trim() || currentSessionName || "";
      autoSaveSession(name);
      console.log(`${C.green}Session saved: ${currentSessionId}${C.reset}${name ? ` (${name})` : ""}`);
      return true;
    }
    if (trimmed === "/sessions" || trimmed === "/sessions all") {
      const all = trimmed.endsWith(" all");
      const sessions = all ? sessionManager.listSessions() : sessionManager.listSessionsForCwd(process.cwd());
      const scope = all ? "all directories" : `this directory: ${process.cwd()}`;
      if (sessions.length === 0) {
        const total = sessionManager.count;
        console.log(`${C.dim}No saved sessions for ${scope}.${C.reset}`);
        if (!all && total > 0) {
          console.log(`${C.dim}${total} session(s) exist for other directories \u2014 /sessions all to list them.${C.reset}`);
        }
      } else {
        console.log(`
${C.bold}Saved sessions (${sessions.length} \u2014 ${scope}):${C.reset}
`);
        for (const s of sessions) {
          const date = new Date(s.updatedAt).toLocaleString();
          const modeLabel2 = s.mode === "plan" /* Plan */ ? "Plan" : s.mode === "ask" /* Ask */ ? "Ask" : "Agent";
          const isCurrent = s.id === currentSessionId ? ` ${C.green}(current)` : "";
          console.log(`  ${C.cyan}${s.id}${C.reset}${isCurrent}`);
          console.log(`    ${C.bold}Name:${C.reset} ${s.name || "(unnamed)"}  ${C.bold}Mode:${C.reset} ${modeLabel2}  ${C.bold}Msgs:${C.reset} ${s.messageCount}`);
          console.log(`    ${C.bold}Updated:${C.reset} ${date}`);
          if (s.summary) {
            console.log(`    ${C.dim}${s.summary.substring(0, 120)}${C.reset}`);
          }
          console.log("");
        }
      }
      return true;
    }
    if (trimmed.startsWith("/resume")) {
      const targetId = trimmed.slice(7).trim();
      const session = targetId ? sessionManager.loadSession(targetId) : sessionManager.getLatestSessionForCwd(process.cwd());
      if (!session) {
        if (targetId) {
          log(C.yellow, "SESSION", `Session "${targetId}" not found`);
        } else {
          log(C.yellow, "SESSION", `No saved session for this directory (${process.cwd()}). Use /sessions to list them all.`);
        }
        return true;
      }
      autoSaveSession();
      modeManager.switchMode(session.mode);
      const rebuiltExtra = buildSkillsContext(skillsLoader, void 0, void 0);
      agentLoop.restoreFromSession(
        session.messages,
        session.systemPrompt || "",
        rebuiltExtra || ""
      );
      currentSessionId = session.id;
      currentSessionName = session.name;
      const date = new Date(session.updatedAt).toLocaleString();
      console.log(`${C.magenta}[SESSION]${C.reset} Resumed "${session.name || session.id}" (${session.messageCount} msgs, ${date})`);
      return true;
    }
    if (trimmed === "/new") {
      autoSaveSession();
      agentLoop.restoreFromSession([], "", extraPrompt || "");
      currentSessionId = void 0;
      currentSessionName = "";
      console.log(`${C.magenta}[SESSION]${C.reset} Started new session`);
      return true;
    }
    if (trimmed === "/auto-save") {
      autoSaveEnabled = !autoSaveEnabled;
      console.log(`${C.magenta}[SESSION]${C.reset} Auto-save ${autoSaveEnabled ? "enabled" : "disabled"}`);
      return true;
    }
    if (trimmed === "/tasks") {
      const taskLogs = taskLogManager.listTaskLogs();
      if (taskLogs.length === 0) {
        console.log(`${C.dim}No saved task logs.${C.reset}`);
      } else {
        console.log(`
${C.bold}Task logs (${taskLogs.length}):${C.reset}
`);
        for (const t of taskLogs) {
          const date = new Date(t.startedAt).toLocaleString();
          const dur = (t.durationMs / 1e3).toFixed(1);
          const statusIcon = t.status === "completed" ? `${C.green}\u2713` : t.status === "failed" ? `${C.red}\u2717` : `${C.yellow}\u2298`;
          console.log(`  ${C.cyan}${t.id}${C.reset} ${statusIcon}${C.reset}  ${C.dim}${dur}s${C.reset}`);
          console.log(`    ${t.task.substring(0, 100)}`);
          console.log(`    ${C.dim}${new Date(t.startedAt).toLocaleString()} | ${t.mode} | ${t.totalSteps} steps | ${t.totalToolCalls} tools${C.reset}`);
          console.log("");
        }
      }
      return true;
    }
    if (trimmed.startsWith("/task ") || trimmed === "/task") {
      const targetId = trimmed.slice(6).trim();
      if (!targetId) {
        log(C.yellow, "TASK", "Usage: /task <id>   (use /tasks to list ids)");
        return true;
      }
      const entry = taskLogManager.loadTaskLog(targetId);
      if (!entry) {
        console.log(`${C.yellow}Task log "${targetId}" not found${C.reset}`);
      } else {
        console.log(`
${C.bold}=== Task Log: ${entry.id} ===${C.reset}
`);
        console.log(taskLogManager.formatTaskLog(entry));
      }
      return true;
    }
    if (trimmed.startsWith("/delete-task ")) {
      const targetId = trimmed.slice(13).trim();
      if (taskLogManager.deleteTaskLog(targetId)) {
        console.log(`${C.green}Task log "${targetId}" deleted${C.reset}`);
      } else {
        console.log(`${C.yellow}Task log "${targetId}" not found${C.reset}`);
      }
      return true;
    }
    if (trimmed === "/delete-task") {
      log(C.yellow, "TASK", "Usage: /delete-task <id>   (use /tasks to list ids)");
      return true;
    }
    if (trimmed.startsWith("/delete-session")) {
      const targetId = trimmed.slice(15).trim();
      if (!targetId) {
        log(C.yellow, "SESSION", "Usage: /delete-session <id>   (use /sessions to list ids)");
        return true;
      }
      const deleted = sessionManager.deleteSession(targetId);
      if (deleted) {
        if (currentSessionId === targetId) {
          currentSessionId = void 0;
          currentSessionName = "";
        }
        console.log(`${C.green}Session "${targetId}" deleted${C.reset}`);
      } else {
        console.log(`${C.yellow}Session "${targetId}" not found${C.reset}`);
      }
      return true;
    }
    if (trimmed === "/help") {
      console.log(`
${C.bold}Commands${C.reset}`);
      for (const line of REPL_COMMAND_HELP) console.log(`  ${line}`);
      console.log(`
${C.dim}Tip: /btw <hint> works even while a task runs; control commands like${C.reset}`);
      console.log(`${C.dim}/mode, /tasks, /sessions, /save and exit run immediately without waiting.${C.reset}
`);
      return true;
    }
    if (trimmed.startsWith("/mode ") || trimmed === "/mode") {
      const newMode = trimmed.slice(6).trim();
      if (!newMode) {
        log(C.magenta, "MODE", `Current mode: ${currentModeLabel()}. Usage: /mode <agent|plan|ask>`);
        return true;
      }
      if (newMode === "plan") modeManager.switchMode("plan" /* Plan */);
      else if (newMode === "ask") modeManager.switchMode("ask" /* Ask */);
      else modeManager.switchMode("agent" /* Agent */);
      log(C.magenta, "MODE", `Switched to ${newMode}`);
      return true;
    }
    if (trimmed === "/stream") {
      agentLoop.setStreaming(!opts.streaming);
      opts.streaming = !opts.streaming;
      log(C.magenta, "STREAM", `Streaming ${opts.streaming ? "enabled" : "disabled"}`);
      return true;
    }
    if (trimmed === "/profiles") {
      const profiles = listProfiles();
      for (const p of profiles) {
        const active = p.name === resolved.profileName ? ` ${C.green}(active)` : "";
        console.log(`  ${C.cyan}${p.name}${C.reset}  ${C.dim}${p.provider}/${p.model}${active}${C.reset}`);
      }
      return true;
    }
    if (trimmed.startsWith("/profile ")) {
      const newProfileName = trimmed.slice(9).trim();
      const previousProfile = resolved.profileName;
      const previousModel = currentModel;
      try {
        const newResolved = loadConfigForProfile(newProfileName);
        if (!newResolved.agentConfig.apiKey) {
          log(C.red, "ERROR", `Profile "${newProfileName}" has no API key configured`);
          return true;
        }
        const newProvider = LLMProviderFactory.create(newResolved.agentConfig);
        agentLoop.swapProvider(newResolved.agentConfig, newProvider, "profile");
        resolved = newResolved;
        setResolvedSkillDirs(newResolved.skillsDirs);
        modelRouter = new ModelRouter(newResolved.modelRouting, newResolved.profiles, newResolved.agentConfig);
        currentModel = newResolved.agentConfig.model;
        wireModelFallback(agentLoop, modelRouter);
        const nc = newResolved.agentConfig;
        log(C.magenta, "PROFILE", `Switched ${previousProfile} (${previousModel}) \u2192 ${newProfileName} (${nc.provider}/${nc.model})`);
      } catch (err) {
        log(C.red, "ERROR", `Failed to switch profile: ${err.message}`);
      }
      return true;
    }
    if (trimmed === "/skills") {
      if (skillsLoader.skills.length === 0) {
        console.log(`${C.dim}No skills loaded. Configure skills directories in config.yaml.${C.reset}`);
      } else {
        console.log(`
${C.bold}Loaded skills (${skillsLoader.skills.length}):${C.reset}`);
        for (const s of skillsLoader.skills) {
          console.log(`  ${C.cyan}${s.name}${C.reset}  ${C.dim}${s.description.substring(0, 80)}${C.reset}`);
          if (s.whenToUse) {
            console.log(`      whenToUse: ${C.dim}${s.whenToUse.substring(0, 100)}${C.reset}`);
          }
        }
      }
      console.log(`${C.dim}Skill tools: skill_catalog / create_skill / update_skill (ask the agent to manage skills)${C.reset}`);
      return true;
    }
    if (trimmed.startsWith("/skill ")) {
      const skillName = trimmed.slice(7).trim();
      const newExtra = buildSkillsContext(skillsLoader, skillName, void 0);
      agentLoop.setExtraSystemPrompt(newExtra);
      log(C.magenta, "SKILL", skillName ? `Activated skill: ${skillName}` : "Cleared active skill");
      return true;
    }
    if (trimmed.startsWith("/use-skill ")) {
      const skillName = trimmed.slice(11).trim();
      const newExtra = buildSkillsContext(skillsLoader, skillName, void 0);
      agentLoop.setExtraSystemPrompt(newExtra);
      const known = skillsLoader.skills.some((s) => s.name === skillName);
      log(C.magenta, "SKILL", known ? `Activated skill: ${skillName}` : `Activated skill: ${skillName} ${C.yellow}(not in the loaded skill list \u2014 /skills to check)${C.reset}`);
      return true;
    }
    if (trimmed.startsWith("/parallel ")) {
      const tasks = trimmed.slice(10).match(/"[^"]+"/g)?.map((t) => t.replace(/"/g, "")) || [];
      if (tasks.length >= 2) {
        await runParallelMode(tasks, resolved, opts.memory);
      } else {
        log(C.red, "ERROR", 'Provide at least 2 tasks in quotes: /parallel "task1" "task2"');
      }
      return true;
    }
    if (trimmed === "/continue" || trimmed === "continue") {
      try {
        agentIsRunning = true;
        try {
          await agentLoop.continueSession();
        } finally {
          agentIsRunning = false;
        }
        autoSaveSession();
        const status = agentLoop.lastTaskError ? "failed" : "completed";
        const taskLog = agentLoop.exportTaskLog(status, agentLoop.lastTaskError);
        taskLogManager.saveTaskLog(taskLog);
      } catch (err) {
        log(C.red, "ERROR", err.message);
      }
      return true;
    }
    if (trimmed.startsWith("/btw ")) {
      const hint = trimmed.slice(5).trim();
      if (hint) {
        if (hint === "cancel" || hint === "abort") {
          log(C.yellow, "BTW", "No agent currently running. Use /btw cancel while agent is running to abort a tool.");
        } else {
          log(C.magenta, "BTW", `Direct prompt: "${hint.substring(0, 100)}${hint.length > 100 ? "..." : ""}"`);
          await runAgentTask(hint);
          await drainBufferedLines();
        }
      } else {
        log(C.yellow, "BTW", "Usage: /btw <your hint>  or  /btw cancel  (to abort current tool)");
      }
      return true;
    }
    if (trimmed === "/cancel") {
      log(C.yellow, "CANCEL", "No task currently running.");
      return true;
    }
    return false;
  };
  const runAgentTask = async (task) => {
    agentIsRunning = true;
    try {
      await processTask(task);
    } finally {
      agentIsRunning = false;
    }
  };
  const handleBtw = async (hint) => {
    if (!hint) {
      log(C.yellow, "BTW", "Usage: /btw <your hint>  or  /btw cancel  (to abort current tool)");
      return;
    }
    if (hint === "cancel" || hint === "abort") {
      if (agentLoop.cancelCurrentTool()) {
        log(C.magenta, "BTW", "Cancelling current tool execution...");
        return;
      }
      const outcome2 = await agentLoop.injectBtwHint(hint);
      log(C.yellow, "BTW", outcome2.kind === "superseded" ? "No tool running \u2014 asking the agent to stop the current task" : "No tool currently running to cancel");
      return;
    }
    const outcome = await agentLoop.injectBtwHint(hint);
    if (outcome.kind === "superseded") {
      log(C.magenta, "BTW", `Task superseded \u2014 ${outcome.toolCancelled ? "aborted the running tool and " : ""}pivoting to: "${hint.substring(0, 80)}${hint.length > 80 ? "..." : ""}"`);
      if (outcome.reason) log(C.dim, "BTW", `reason: ${outcome.reason}`);
    } else if (outcome.kind === "cancelled") {
      log(C.magenta, "BTW", "Cancelling current tool execution...");
    } else {
      log(C.magenta, "BTW", `Hint injected: "${hint.substring(0, 100)}${hint.length > 100 ? "..." : ""}"`);
    }
  };
  rl.on("line", async (input) => {
    const trimmed = input.trim();
    if (agentIsRunning) {
      const decision = decideRunningLine(trimmed, { agentRunning: true });
      switch (decision.route) {
        case "btw":
          await handleBtw(trimmed.slice(4).trim());
          break;
        case "immediate":
          if (EXIT_WORDS.has(trimmed.toLowerCase())) {
            void gracefulExit();
            return;
          }
          log(C.dim, "NOW", `${decision.command} \u2014 ${decision.reason ?? "running immediately"}`);
          if (!await handleCommand(trimmed)) {
            log(C.yellow, "REPL", `no handler for ${decision.command} \u2014 nothing was done`);
          }
          break;
        case "refuse":
          log(C.yellow, "REFUSED", refusalMessage(decision));
          break;
        default:
          if (trimmed) {
            bufferedLines.push(trimmed);
            log(C.dim, "QUEUED", `"${trimmed.substring(0, 60)}${trimmed.length > 60 ? "..." : ""}" \u2014 will process after current task`);
          }
          break;
      }
      displayPrompt();
      return;
    }
    if (processingLock) {
      bufferedLines.push(trimmed);
      return;
    }
    if (!trimmed) {
      displayPrompt();
      return;
    }
    if (EXIT_WORDS.has(trimmed.toLowerCase())) {
      void gracefulExit();
      return;
    }
    processingLock = true;
    try {
      await drainBufferedLines();
      if (agentIsRunning) return;
      if (await handleCommand(trimmed)) {
        await drainBufferedLines();
        return;
      }
      await runAgentTask(trimmed);
      await drainBufferedLines();
    } finally {
      processingLock = false;
      displayPrompt();
    }
  });
  rl.on("SIGINT", () => {
    void gracefulExit();
  });
  displayPrompt();
  if (opts.tasks.length > 0) {
    const task = opts.tasks.join(" ");
    rl.write(task + "\n");
  }
}
var CLI_EXCLUDED_RULE_PATTERNS = ["askquestion", "durable-request", "durable request"];
function buildSkillsContext(loader, activeSkill, taskDescription) {
  let prompt = "";
  prompt += loader.buildPreloadRulesPromptSection(CLI_EXCLUDED_RULE_PATTERNS);
  let preActivatedSkills;
  if (taskDescription) {
    preActivatedSkills = loader.getAutoMatchedSkills(taskDescription);
  }
  if (activeSkill) {
    if (!preActivatedSkills) preActivatedSkills = /* @__PURE__ */ new Set();
    preActivatedSkills.add(activeSkill);
  }
  prompt += loader.buildSkillsPromptSection(preActivatedSkills);
  const skillDirs = getResolvedSkillDirs();
  prompt += loader.buildMetaSkillPromptSection(skillDirs);
  prompt += buildSelfEvolvePromptSection(selfUpdateConfig());
  if (activeSkill) {
    const content = loader.getSkillContent(activeSkill);
    if (content && preActivatedSkills?.has(activeSkill)) {
    } else if (content) {
      prompt += `
## Active Skill: ${activeSkill}

${content}
`;
    }
  }
  return prompt;
}
var _resolvedSkillDirs = [];
function getResolvedSkillDirs() {
  return _resolvedSkillDirs;
}
function setResolvedSkillDirs(dirs) {
  _resolvedSkillDirs = dirs && dirs.length > 0 ? dirs : [defaultSkillsDir()];
}
main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
//# sourceMappingURL=agent-cli.js.map
