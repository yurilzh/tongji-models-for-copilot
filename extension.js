'use strict';

/**
 * Tongji (同济大学人工智能服务平台) language model provider for Copilot Chat.
 *
 * Registers the `tongji` vendor through the `vscode.lm.registerLanguageModelChatProvider`
 * API so that the platform's models show up as a "Tongji" model group in the picker.
 */

const vscode = require('vscode');
const https = require('https');
const http = require('http');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VENDOR = 'tongji';
const SECTION = 'tongji';
const SECRET_KEY = 'tongji.apiKey';
const MODEL_CACHE_KEY = 'tongji.modelCache';
const KEY_FILE = path.join(os.homedir(), '.tongji-copilot', 'api-key');
const IDLE_TIMEOUT_MS = 180000;

/**
 * Fallback catalogue, used when `/v1/models` is unreachable (off campus, no key, ...).
 * Context lengths, capabilities and thinking levels come from the platform's model hub.
 */
const KNOWN_MODELS = [
  { id: 'DeepSeek-V4.1-Flash', name: 'DeepSeek V4.1 Flash', context: 1048576, vision: true, tools: true, thinking: true, levels: ['none', 'low', 'high', 'xhigh', 'max'], defaultLevel: 'high' },
  { id: 'MiniMax-M3.1-Flash', name: 'MiniMax M3.1 Flash', context: 524288, vision: true, tools: true, thinking: true, levels: ['low', 'medium', 'high', 'xhigh', 'max'], defaultLevel: 'high' },
  { id: 'GLM-5.3', name: 'GLM 5.3', context: 524288, vision: false, tools: true, thinking: true, levels: ['low', 'high', 'max'], defaultLevel: 'high' },
  { id: 'GLM-5.3-Flash', name: 'GLM 5.3 Flash', context: 1048576, vision: true, tools: true, thinking: true, levels: ['low', 'high', 'max'], defaultLevel: 'high' },
  { id: 'MiMo-V2.6-Pro', name: 'MiMo V2.6 Pro', context: 524288, vision: true, tools: true, thinking: true, levels: ['none', 'high'], defaultLevel: 'high' },
  { id: 'MiMo-V2.6-Flash', name: 'MiMo V2.6 Flash', context: 1048576, vision: true, tools: true, thinking: true, levels: ['none', 'high'], defaultLevel: 'high' },
  { id: 'Qwen3.8-Flash-Next', name: 'Qwen3.8 Flash Next', context: 1048576, vision: true, tools: true, thinking: true, levels: ['none', 'low', 'medium', 'xhigh'], defaultLevel: 'medium' },
  { id: 'Qwen3.8-27B', name: 'Qwen3.8 27B', context: 262144, vision: true, tools: true, thinking: true, levels: ['none', 'low', 'medium', 'xhigh'], defaultLevel: 'medium' },
  { id: 'Qwen3.8-Max', name: 'Qwen3.8 Max', context: 262144, vision: false, tools: true, thinking: true, levels: ['low', 'medium', 'xhigh'], defaultLevel: 'medium' },
  { id: 'Kimi-K3', name: 'Kimi K3', context: 131072, vision: true, tools: true, thinking: true, levels: ['low', 'high', 'max'], defaultLevel: 'high' },
];

const LEVEL_LABELS = {
  none: '关闭',
  minimal: '极低',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '很高',
  max: '最高',
};

const LEVEL_DESCRIPTIONS = {
  none: '不生成思考过程，响应最快、消耗最少',
  minimal: '最低思考强度',
  low: '较低思考强度',
  medium: '中等思考强度',
  high: '较高思考强度',
  xhigh: '高思考强度',
  max: '最高思考强度',
};

const NON_CHAT_PATTERN = /embedding|rerank|reranker|tts|asr|whisper|sensevoice|cosyvoice|paraformer|ocr|speech/i;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

let logChannel;

function log(message, error) {
  const line = `[${new Date().toISOString()}] ${message}`;
  if (error) {
    logChannel?.appendLine(`${line} :: ${error?.stack || error}`);
  } else {
    logChannel?.appendLine(line);
  }
}

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

function cfg() {
  return vscode.workspace.getConfiguration(SECTION);
}

function getBaseUrl() {
  const raw = (cfg().get('baseUrl') || 'https://agi.tongji.edu.cn/v1').trim();
  return raw.replace(/\/+$/, '');
}

function getInternalAddress() {
  const raw = cfg().get('internalAddress');
  // `undefined` means "not configured" (fall back to the built-in default), `''` means "use DNS".
  const value = raw === undefined ? '10.67.0.251' : String(raw);
  return value.trim();
}

function getMaxOutputTokens() {
  const value = Number(cfg().get('maxOutputTokens'));
  return Number.isFinite(value) && value > 0 ? value : 32768;
}

function readKeyFile() {
  try {
    const value = fs.readFileSync(KEY_FILE, 'utf8').trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

function splitUrl(baseUrl) {
  const url = new URL(baseUrl);
  return { url, origin: `${url.protocol}//${url.host}`, pathname: url.pathname.replace(/\/+$/, '') };
}

/** Try the configured internal address first, then the normal DNS resolution. */
function buildCandidates() {
  const internal = getInternalAddress();
  if (internal && net.isIP(internal)) {
    return [internal, undefined];
  }
  return [undefined];
}

function makeLookup(address) {
  return (hostname, options, callback) => {
    const family = net.isIP(address);
    if (options && options.all) {
      return callback(null, [{ address, family }]);
    }
    return callback(null, address, family);
  };
}

function openRequest(url, { method = 'GET', headers, body, address }) {
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const options = {
    protocol: url.protocol,
    host: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    method,
    headers,
    autoSelectFamily: false,
  };
  if (isHttps) {
    options.servername = url.hostname;
  }
  if (address) {
    options.lookup = makeLookup(address);
  }
  return new Promise((resolve, reject) => {
    const request = transport.request(options, (response) => resolve({ request, response }));
    request.on('error', reject);
    if (body) {
      request.write(body);
    }
    request.end();
  });
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    let text = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => (text += chunk));
    stream.on('end', () => resolve(text));
    stream.on('error', reject);
  });
}

class HttpError extends Error {
  constructor(status, body, url) {
    super(describeHttpError(status, body, url));
    this.status = status;
    this.body = body;
    this.retryable = status === 403 && /网络环境|network environment/i.test(body || '');
  }
}

class NetworkError extends Error {}

function describeHttpError(status, body, url) {
  let detail = '';
  try {
    const parsed = JSON.parse(body);
    const error = parsed.error;
    if (typeof error === 'string') {
      detail = error;
    } else if (error && typeof error.message === 'string') {
      detail = error.message;
    } else if (typeof parsed.message === 'string') {
      detail = parsed.message;
    }
  } catch {
    detail = (body || '').slice(0, 400).trim();
  }
  const suffix = detail ? `：${detail}` : '';
  switch (status) {
    case 400:
      return `请求格式有误 (HTTP 400)${suffix}`;
    case 401:
      return `API Key 无效、已停用或已删除 (HTTP 401)${suffix}`;
    case 403:
      return /网络环境/.test(detail)
        ? `当前网络环境不被平台允许，请连接校园网 / 学校 VPN，或在设置中填写 tongji.internalAddress (HTTP 403)${suffix}`
        : `鉴权失败 (HTTP 403)${suffix}`;
    case 404:
      return `模型不存在或不在当前套餐内 (HTTP 404)${suffix}`;
    case 429:
      return `额度已用完或并发超限 (HTTP 429)${suffix}`;
    default:
      return `请求失败 (HTTP ${status})${suffix || ` ${url}`}`;
  }
}

function isRetryableNetworkError(error) {
  return (
    error instanceof NetworkError ||
    ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'EAI_AGAIN'].includes(error?.code)
  );
}

/**
 * Run `consumer` against the first reachable endpoint. If the request is rejected because of the
 * network environment (or the socket fails), retry with the normal DNS resolution.
 */
async function withCandidates(url, options, consumer) {
  const candidates = buildCandidates();
  let lastError;
  for (let index = 0; index < candidates.length; index++) {
    const address = candidates[index];
    const hasNext = index < candidates.length - 1;
    let opened;
    try {
      opened = await openRequest(url, { ...options, address });
    } catch (error) {
      lastError = new NetworkError(`无法连接 ${url.host}${error?.code ? ` (${error.code})` : ''}`);
      lastError.code = error?.code;
      if (hasNext && isRetryableNetworkError(error)) {
        log(`connect failed via ${address || 'dns'}: ${error?.code}`, error);
        continue;
      }
      throw lastError;
    }

    const status = opened.response.statusCode || 0;
    if (status >= 400) {
      const body = await readAll(opened.response);
      const error = new HttpError(status, body, url.toString());
      if (error.retryable && hasNext) {
        log(`retry via dns after ${status} from ${address}`);
        lastError = error;
        continue;
      }
      throw error;
    }

    return consumer(opened.response, opened.request);
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Message / tool conversion
// ---------------------------------------------------------------------------

const ROLE_USER = 1;
const ROLE_ASSISTANT = 2;
const ROLE_SYSTEM = 3;

function roleName(role) {
  if (role === vscode.LanguageModelChatMessageRole?.Assistant || role === ROLE_ASSISTANT) {
    return 'assistant';
  }
  if (role === vscode.LanguageModelChatMessageRole?.User || role === ROLE_USER) {
    return 'user';
  }
  if (role === ROLE_SYSTEM) {
    return 'system';
  }
  return 'user';
}

function isInstance(value, ctorName) {
  const ctor = vscode[ctorName];
  return typeof ctor === 'function' && value instanceof ctor;
}

function textOfToolResultPart(part) {
  const raw = part.content ?? part.parts ?? [];
  const chunks = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      chunks.push(item);
    } else if (typeof item?.value === 'string') {
      chunks.push(item.value);
    } else if (typeof item?.text === 'string') {
      chunks.push(item.text);
    } else if (item !== undefined) {
      try {
        chunks.push(JSON.stringify(item));
      } catch {
        /* ignore unserialisable content */
      }
    }
  }
  return chunks.join('\n');
}

function imageDataUrl(part) {
  if (isInstance(part, 'LanguageModelDataPart') && /^image\//.test(part.mimeType || '')) {
    return `data:${part.mimeType};base64,${Buffer.from(part.data).toString('base64')}`;
  }
  return undefined;
}

function convertMessages(messages, model) {
  const result = [];
  for (const message of messages) {
    const role = roleName(message.role);
    let text = '';
    let reasoning = '';
    const images = [];
    const toolCalls = [];
    const toolResults = [];

    for (const part of message.content ?? []) {
      if (isInstance(part, 'LanguageModelTextPart')) {
        text += part.value;
      } else if (isInstance(part, 'LanguageModelToolCallPart')) {
        toolCalls.push({
          id: part.callId,
          type: 'function',
          function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
        });
      } else if (isInstance(part, 'LanguageModelToolResultPart')) {
        toolResults.push({ callId: part.callId, content: textOfToolResultPart(part) });
      } else if (isInstance(part, 'LanguageModelThinkingPart')) {
        const value = part.value;
        reasoning += Array.isArray(value) ? value.join('') : String(value ?? '');
      } else if (model.vision) {
        const url = imageDataUrl(part);
        if (url) {
          images.push(url);
        }
      }
    }

    if (role === 'assistant') {
      if (text || toolCalls.length > 0) {
        const converted = { role: 'assistant', content: text || '' };
        if (toolCalls.length > 0) {
          converted.tool_calls = toolCalls;
        }
        if (reasoning) {
          converted.reasoning_content = reasoning;
        }
        result.push(converted);
      }
    } else if (role === 'system') {
      if (text) {
        result.push({ role: 'system', content: text });
      }
    } else if (images.length > 0) {
      result.push({
        role: 'user',
        content: [
          ...(text ? [{ type: 'text', text }] : []),
          ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      });
    } else if (text) {
      result.push({ role: 'user', content: text });
    }

    for (const toolResult of toolResults) {
      result.push({ role: 'tool', tool_call_id: toolResult.callId, content: toolResult.content || '(empty)' });
    }
  }
  return result;
}

function convertTools(tools, model) {
  if (!model.tools || !tools || tools.length === 0) {
    return undefined;
  }
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description ?? '',
      parameters: tool.inputSchema ?? { type: 'object', properties: {} },
    },
  }));
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

class TongjiProvider {
  constructor(context) {
    this.context = context;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeLanguageModelChatInformation = this._emitter.event;
    this._models = undefined;
    this._modelsFetchedAt = 0;
  }

  refreshModels() {
    this._models = undefined;
    this._modelsFetchedAt = 0;
    this._emitter.fire();
  }

  async getApiKey() {
    const stored = await this.context.secrets.get(SECRET_KEY);
    if (stored && stored.trim()) {
      return stored.trim();
    }
    const fromSettings = (cfg().get('apiKey') || '').trim();
    if (fromSettings) {
      return fromSettings;
    }
    const fromFile = readKeyFile();
    if (fromFile) {
      return fromFile;
    }
    const fromEnv = (process.env.TONGJI_API_KEY || '').trim();
    return fromEnv || undefined;
  }

  async promptForApiKey() {
    const value = await vscode.window.showInputBox({
      title: 'Tongji API Key',
      prompt: '在 agi.tongji.edu.cn → 我的 API Key 中创建，形如 sk-xxxxxxxx',
      password: true,
      ignoreFocusOut: true,
      validateInput: (input) => (input && input.trim() ? undefined : 'API Key 不能为空'),
    });
    if (!value) {
      return false;
    }
    await this.context.secrets.store(SECRET_KEY, value.trim());
    log('api key stored');
    this.refreshModels();
    vscode.window.showInformationMessage('Tongji API Key 已保存。');
    return true;
  }

  /** Merge the live `/v1/models` list with the built-in catalogue. */
  async listModels() {
    const baseUrl = getBaseUrl();
    const now = Date.now();
    if (this._models && now - this._modelsFetchedAt < 10 * 60 * 1000) {
      return this._models;
    }

    let discovered;
    try {
      const apiKey = await this.getApiKey();
      if (apiKey) {
        const { url, pathname } = splitUrl(baseUrl);
        url.pathname = `${pathname}/models`;
        url.search = '';
        const text = await withCandidates(url, { headers: authHeaders(apiKey) }, readAll);
        const parsed = JSON.parse(text);
        const list = parsed.data ?? parsed.models ?? [];
        discovered = list.map((entry) => (typeof entry === 'string' ? entry : entry.id)).filter(Boolean);
      }
    } catch (error) {
      log('model discovery failed, using built-in catalogue', error);
    }

    const merged = mergeModels(discovered);
    this._models = merged;
    this._modelsFetchedAt = now;
    try {
      await this.context.globalState.update(MODEL_CACHE_KEY, { models: merged.map((m) => m.id), at: now });
    } catch {
      /* ignore cache write failures */
    }
    return merged;
  }

  async provideLanguageModelChatInformation() {
    const models = await this.listModels();
    const apiKey = await this.getApiKey();
    return models.map((model) => toChatInfo(model, Boolean(apiKey)));
  }

  async provideLanguageModelChatResponse(modelInfo, messages, options, progress, token) {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error('尚未配置 Tongji API Key：请运行命令 “Tongji: 设置 API Key”。');
    }

    const model = (await this.listModels()).find((entry) => entry.id === modelInfo.id) ?? {
      id: modelInfo.id,
      name: modelInfo.name,
      context: 131072,
      vision: Boolean(modelInfo.capabilities?.imageInput),
      tools: Boolean(modelInfo.capabilities?.toolCalling),
      thinking: false,
    };

    const { url, pathname } = splitUrl(getBaseUrl());
    url.pathname = `${pathname}/chat/completions`;
    url.search = '';

    const body = {
      model: model.id,
      messages: convertMessages(messages, model),
      stream: true,
      max_tokens: options?.modelOptions?.maxTokens ?? modelInfo.maxOutputTokens ?? getMaxOutputTokens(),
    };
    const reasoningEffort = resolveReasoningEffort(model, options);
    if (reasoningEffort) {
      body.reasoning_effort = reasoningEffort;
    }
    const tools = convertTools(options?.tools, model);
    if (tools) {
      body.tools = tools;
      body.tool_choice = 'auto';
    }

    log(
      `chat ${model.id} -> ${url.origin}${url.pathname} (tools=${tools ? tools.length : 0}, effort=${reasoningEffort ?? '-'})`
    );

    await withCandidates(url, { method: 'POST', headers: authHeaders(apiKey), body: JSON.stringify(body) }, (response, request) =>
      consumeStream({ response, request, progress, token })
    );
  }

  async provideTokenCount(modelInfo, text) {
    let value = '';
    if (typeof text === 'string') {
      value = text;
    } else {
      for (const part of text?.content ?? []) {
        if (isInstance(part, 'LanguageModelTextPart')) {
          value += part.value;
        } else if (isInstance(part, 'LanguageModelToolResultPart')) {
          value += textOfToolResultPart(part);
        }
      }
    }
    return Math.max(1, Math.ceil(value.length / 3.5));
  }
}

function authHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    Accept: 'text/event-stream',
  };
}

function mergeModels(discovered) {
  const byId = new Map(KNOWN_MODELS.map((model) => [model.id.toLowerCase(), model]));
  const ids = discovered && discovered.length > 0 ? discovered : KNOWN_MODELS.map((model) => model.id);
  const result = [];
  for (const id of ids) {
    if (NON_CHAT_PATTERN.test(id)) {
      continue;
    }
    const known = byId.get(id.toLowerCase());
    result.push(
      known ?? {
        id,
        name: id,
        context: 131072,
        vision: true,
        tools: true,
        thinking: false,
      }
    );
  }
  // Keep the familiar order: known models first, then anything new from the platform.
  const order = new Map(KNOWN_MODELS.map((model, index) => [model.id, index]));
  result.sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
  return result;
}

function toChatInfo(model, hasApiKey) {
  const maxOutputTokens = Math.min(getMaxOutputTokens(), Math.max(8192, Math.floor(model.context / 8)));
  const capabilityText = `${formatContext(model.context)} 上下文${model.thinking ? ' · 深度思考' : ''}${
    model.vision ? ' · 图像理解' : ''
  }${model.tools ? ' · 工具调用' : ''}`;
  const configurationSchema = model.levels?.length ? buildThinkingSchema(model) : undefined;
  return {
    id: model.id,
    name: model.name,
    family: 'tongji',
    version: '1',
    detail: hasApiKey ? capabilityText : '尚未配置 Tongji API Key（运行 “Tongji: 设置 API Key”）',
    tooltip: `同济大学人工智能服务平台 · ${model.id}`,
    statusIcon: hasApiKey ? undefined : new vscode.ThemeIcon('warning'),
    maxInputTokens: Math.max(1024, model.context - maxOutputTokens),
    maxOutputTokens,
    isBYOK: true,
    isUserSelectable: true,
    capabilities: {
      toolCalling: model.tools,
      imageInput: model.vision,
    },
    ...(configurationSchema ? { configurationSchema } : {}),
  };
}

/** Per-model "思考深度" picker (mapped to the platform's `reasoning_effort`). */
function buildThinkingSchema(model) {
  return {
    properties: {
      reasoningEffort: {
        type: 'string',
        title: '思考深度',
        enum: model.levels,
        enumItemLabels: model.levels.map((level) => LEVEL_LABELS[level] ?? level),
        enumDescriptions: model.levels.map((level) => LEVEL_DESCRIPTIONS[level] ?? ''),
        default: model.defaultLevel ?? model.levels[0],
        group: 'navigation',
      },
    },
  };
}

function resolveReasoningEffort(model, options) {
  if (!model.levels?.length) {
    return undefined;
  }
  const requested =
    options?.modelOptions?.reasoningEffort ??
    options?.modelConfiguration?.reasoningEffort ??
    options?.configuration?.reasoningEffort;
  return model.levels.includes(requested) ? requested : (model.defaultLevel ?? model.levels[0]);
}

function formatContext(tokens) {
  if (tokens >= 1048576) {
    return '1M';
  }
  return `${Math.round(tokens / 1024)}K`;
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

async function consumeStream({ response, request, progress, token }) {
  response.setEncoding('utf8');

  let buffer = '';
  let textReported = false;
  let finished = false;
  let latestUsage;
  const toolCallBuffer = new Map();

  const cancelListener = token.onCancellationRequested(() => {
    try {
      request.destroy();
    } catch {
      /* ignore */
    }
  });

  const idleTimer = () => {
    let handle;
    const arm = () => {
      clearTimeout(handle);
      handle = setTimeout(() => {
        try {
          request.destroy(new Error('Tongji 服务响应超时'));
        } catch {
          /* ignore */
        }
      }, IDLE_TIMEOUT_MS);
    };
    arm();
    return { arm, dispose: () => clearTimeout(handle) };
  };
  const watchdog = idleTimer();

  const reportText = (value) => {
    if (!value) {
      return;
    }
    textReported = true;
    progress.report(new vscode.LanguageModelTextPart(value));
  };
  const reportThinking = (value) => {
    if (value && typeof vscode.LanguageModelThinkingPart === 'function') {
      progress.report(new vscode.LanguageModelThinkingPart(value));
    }
  };

  const flushToolCalls = () => {
    if (finished || toolCallBuffer.size === 0) {
      return;
    }
    finished = true;
    for (const call of toolCallBuffer.values()) {
      let input = {};
      try {
        input = call.arguments ? JSON.parse(call.arguments) : {};
      } catch {
        input = { raw: call.arguments };
      }
      progress.report(
        new vscode.LanguageModelToolCallPart(call.id || `call_${call.index}`, call.name || 'unknown', input)
      );
    }
  };

  try {
    await new Promise((resolve, reject) => {
      response.on('data', (chunk) => {
        watchdog.arm();
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf('\n');
          if (!line || line.startsWith(':') || !line.startsWith('data:')) {
            continue;
          }
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') {
            continue;
          }
          let event;
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }
          if (event.error) {
            reject(new Error(event.error.message || '模型返回错误'));
            return;
          }
          if (event.usage) {
            latestUsage = event.usage;
          }
          const choice = event.choices?.[0];
          if (!choice) {
            continue;
          }
          const delta = choice.delta ?? choice.message ?? {};
          reportText(delta.content);
          reportThinking(delta.reasoning_content ?? delta.reasoning);
          for (const [position, toolCall] of (delta.tool_calls ?? []).entries()) {
            const index = toolCall.index ?? position;
            const current = toolCallBuffer.get(index) ?? { index, id: '', name: '', arguments: '' };
            if (toolCall.id) {
              current.id = toolCall.id;
            }
            if (toolCall.function?.name) {
              current.name += toolCall.function.name;
            }
            if (toolCall.function?.arguments) {
              current.arguments += toolCall.function.arguments;
            }
            toolCallBuffer.set(index, current);
          }
          if (choice.finish_reason) {
            flushToolCalls();
          }
        }
      });
      response.on('end', resolve);
      response.on('error', reject);
    });
  } catch (error) {
    if (token.isCancellationRequested) {
      return;
    }
    throw new Error(`Tongji 请求失败：${error?.message || error}`);
  } finally {
    watchdog.dispose();
    cancelListener.dispose();
  }

  flushToolCalls();

  if (latestUsage) {
    reportUsage(progress, latestUsage);
  }

  if (!textReported && toolCallBuffer.size === 0) {
    log('stream ended without content');
  }
}

function reportUsage(progress, usage) {
  if (typeof vscode.LanguageModelDataPart !== 'function') {
    return;
  }
  try {
    const payload = {
      prompt_tokens: usage.prompt_tokens ?? 0,
      completion_tokens: usage.completion_tokens ?? 0,
      total_tokens: usage.total_tokens ?? 0,
      prompt_tokens_details: {
        cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
      },
    };
    progress.report(
      new vscode.LanguageModelDataPart(new TextEncoder().encode(JSON.stringify(payload)), 'usage')
    );
  } catch {
    /* usage reporting is best effort */
  }
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

function activate(context) {
  logChannel = vscode.window.createOutputChannel('Tongji');
  context.subscriptions.push(logChannel);

  const provider = new TongjiProvider(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('tongji.setApiKey', () => provider.promptForApiKey()),
    vscode.commands.registerCommand('tongji.clearApiKey', async () => {
      await context.secrets.delete(SECRET_KEY);
      provider.refreshModels();
      vscode.window.showInformationMessage('Tongji API Key 已清除。');
    }),
    vscode.commands.registerCommand('tongji.refreshModels', async () => {
      provider.refreshModels();
      const models = await provider.listModels();
      vscode.window.showInformationMessage(`Tongji: 已刷新，共 ${models.length} 个对话模型。`);
    }),
    vscode.commands.registerCommand('tongji.showLog', () => logChannel.show()),
    vscode.lm.registerLanguageModelChatProvider(VENDOR, provider),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(SECTION)) {
        provider.refreshModels();
      }
    })
  );

  log(`activated (baseUrl=${getBaseUrl()}, internal=${getInternalAddress() || 'dns'})`);

  // Make the models discoverable even when Copilot Chat is still starting up.
  Promise.resolve(vscode.extensions?.getExtension('github.copilot-chat')?.activate())
    .catch(() => undefined)
    .then(() => provider.refreshModels());
}

function deactivate() {
  /* nothing to clean up */
}

module.exports = { activate, deactivate };
