const TOKEN_PLAN_ASR_URL =
  "https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
const TOKEN_PLAN_ASR_MODEL = "qwen-audio-3.0-asr-flash";
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 90_000;

const AUDIO_FORMATS = new Map([
  ["audio/aac", "aac"],
  ["audio/flac", "flac"],
  ["audio/m4a", "m4a"],
  ["audio/mp4", "mp4"],
  ["audio/mpeg", "mp3"],
  ["audio/mp3", "mp3"],
  ["audio/ogg", "ogg"],
  ["audio/opus", "opus"],
  ["audio/wav", "wav"],
  ["audio/wave", "wav"],
  ["audio/x-wav", "wav"],
  ["audio/webm", "webm"],
]);

function errorMessage(payload, fallback) {
  if (!payload || typeof payload !== "object") return fallback;
  return payload.message
    || payload.error?.message
    || payload.output?.message
    || payload.code
    || fallback;
}

function toAudioBuffer(audio) {
  if (Buffer.isBuffer(audio)) return audio;
  if (audio instanceof ArrayBuffer) return Buffer.from(audio);
  if (ArrayBuffer.isView(audio)) {
    return Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  }
  throw new Error("录音数据格式无效");
}

export function audioFormatForMimeType(mimeType) {
  const normalized = String(mimeType || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  const format = AUDIO_FORMATS.get(normalized);
  if (!format) throw new Error(`暂不支持该录音格式：${normalized || "未知格式"}`);
  return { mimeType: normalized, format };
}

export function createTokenPlanAsrBody({ audio, mimeType, sampleRate }) {
  const buffer = toAudioBuffer(audio);
  if (buffer.byteLength === 0) throw new Error("没有录到声音，请重试");
  if (buffer.byteLength > MAX_AUDIO_BYTES) throw new Error("录音过长，请控制在两分钟以内");

  const resolved = audioFormatForMimeType(mimeType);
  const rate = Number(sampleRate);
  const parameters = { format: resolved.format };
  if (Number.isInteger(rate) && rate >= 8_000 && rate <= 192_000) {
    parameters.sample_rate = rate;
  }

  return {
    model: TOKEN_PLAN_ASR_MODEL,
    input: {
      messages: [{
        role: "user",
        content: [{
          type: "input_audio",
          input_audio: {
            data: `data:${resolved.mimeType};base64,${buffer.toString("base64")}`,
          },
        }],
      }],
    },
    parameters,
  };
}

export function transcriptFromTokenPlanResponse(payload) {
  const candidates = [
    payload?.output?.text,
    payload?.output?.output?.sentence?.text,
    payload?.output?.choices?.[0]?.message?.content?.find?.((item) => item?.text)?.text,
  ];
  const transcript = candidates.find((value) => typeof value === "string" && value.trim());
  if (!transcript) throw new Error("千问 ASR 没有返回可用的识别文字");
  return transcript.trim();
}

export async function recognizeWithTokenPlan({
  audio,
  mimeType,
  sampleRate,
  apiKey,
  fetchImpl = fetch,
  signal,
}) {
  const key = String(apiKey || "").trim();
  if (!key) throw new Error("未配置 PINVOU_TOKEN_PLAN_API_KEY，无法使用语音识别");
  if (!key.startsWith("sk-sp-")) {
    throw new Error("PINVOU_TOKEN_PLAN_API_KEY 不是 Token Plan 的 sk-sp- 密钥");
  }

  const body = createTokenPlanAsrBody({ audio, mimeType, sampleRate });
  const timeoutSignal = signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(TOKEN_PLAN_ASR_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "X-DashScope-SSE": "disable",
      },
      body: JSON.stringify(body),
      signal: timeoutSignal,
    });
  } catch (error) {
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new Error("千问 ASR 请求超时，请检查网络后重试");
    }
    throw new Error(`无法连接千问 ASR：${error?.message || error}`);
  }

  const raw = await response.text();
  let payload;
  try {
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`千问 ASR 返回了无法解析的响应（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    throw new Error(`千问 ASR 请求失败：${errorMessage(payload, `HTTP ${response.status}`)}`);
  }

  return {
    text: transcriptFromTokenPlanResponse(payload),
    requestId: payload.request_id || payload.requestId,
    model: TOKEN_PLAN_ASR_MODEL,
  };
}

export const tokenPlanAsrConstants = Object.freeze({
  endpoint: TOKEN_PLAN_ASR_URL,
  model: TOKEN_PLAN_ASR_MODEL,
  maximumAudioBytes: MAX_AUDIO_BYTES,
});
