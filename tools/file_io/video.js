import { exec } from "child_process";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import util from "util";
import { resolveSecurePath } from "../../config.js";
import { validateArgs } from "../_shared/utils.js";

const execPromise = util.promisify(exec);

const CONTAINER = "python_runner";
const DEVELOP_MOUNT = "/develop";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = path.resolve(__dirname, "..", "..");

const SUPPORTED_EXTS = new Set([".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v"]);
const WHISPER_MODELS = new Set(["tiny", "base", "small", "medium", "large-v3"]);

// ============================================
// 工具定義
// ============================================
export const definitions = [
  {
    name: "read_video",
    description:
      "讀取影片（MP4/MOV/MKV/WebM/AVI/M4V），抽出語音字幕 + 關鍵幀（每 N 秒一張）回傳給 Claude。" +
      "用 Docker python_runner 跑 ffmpeg + faster-whisper。" +
      "Token 估算：10 分鐘 1080p 影片，base 模型 + 每 15 秒 1 張 768px 關鍵幀 ≈ 50k–70k token。" +
      "可只抽字幕（set extract_keyframes=false）或只抽關鍵幀（set extract_transcript=false）。",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "影片路徑（相對 basePath 或絕對路徑）" },
        extract_transcript: { type: "boolean", description: "是否抽字幕（預設 true）" },
        extract_keyframes: { type: "boolean", description: "是否抽關鍵幀（預設 true）" },
        whisper_model: {
          type: "string",
          enum: ["tiny", "base", "small", "medium", "large-v3"],
          description: "Whisper 模型大小（預設 base）。tiny 最快但精度低，large-v3 最慢最準",
        },
        language: { type: "string", description: "字幕語言代碼（如 zh/en/ja），不填則自動偵測" },
        keyframe_interval: { type: "number", description: "每 N 秒抽 1 張關鍵幀（預設 15）" },
        max_frames: { type: "number", description: "關鍵幀數上限（預設 40）" },
        frame_max_width: { type: "number", description: "關鍵幀最大寬度 px（預設 768）" },
        start: { type: "number", description: "起始秒數（選填，跳過開頭）" },
        end: { type: "number", description: "結束秒數（選填，截斷結尾）" },
      },
      required: ["path"],
    },
  },
];

// ============================================
// Handle
// ============================================
export async function handle(name, args) {
  const def = definitions.find(d => d.name === name);
  if (def) args = validateArgs(def.inputSchema, args);

  if (name === "read_video") return readVideo(args);
  throw new Error(`未知工具: ${name}`);
}

// ============================================
// 主流程
// ============================================
async function readVideo(args) {
  const {
    path: videoPath,
    extract_transcript = true,
    extract_keyframes = true,
    whisper_model = "base",
    language,
    keyframe_interval = 15,
    max_frames = 40,
    frame_max_width = 768,
    start,
    end,
  } = args;

  if (!extract_transcript && !extract_keyframes) {
    return errText("extract_transcript 與 extract_keyframes 至少要開啟一個");
  }
  if (!WHISPER_MODELS.has(whisper_model)) {
    return errText(`whisper_model 必須是 ${[...WHISPER_MODELS].join(", ")}`);
  }

  const securePath = resolveSecurePath(videoPath);
  const ext = path.extname(securePath).toLowerCase();
  if (!SUPPORTED_EXTS.has(ext)) {
    return errText(`不支援的影片格式 ${ext}（支援 ${[...SUPPORTED_EXTS].join(", ")}）`);
  }
  await fs.access(securePath);

  try {
    await execPromise(`docker inspect --format="{{.State.Running}}" ${CONTAINER}`);
  } catch {
    return errText(`容器 ${CONTAINER} 未啟動。執行：cd D:\\MCP_Server\\python && docker compose up -d`);
  }

  const jobId = `video_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const hostTmpDir = path.join(MCP_ROOT, ".tmp", jobId);
  const containerTmpDir = `${DEVELOP_MOUNT}/.tmp/${jobId}`;
  await fs.mkdir(hostTmpDir, { recursive: true });

  const hostVideoCopy = path.join(hostTmpDir, `src${ext}`);
  await fs.copyFile(securePath, hostVideoCopy);
  const containerVideoPath = `${containerTmpDir}/src${ext}`;

  const content = [];

  try {
    const duration = await getDuration(containerVideoPath);
    const effStart = start && start > 0 ? start : 0;
    const effEnd = end && end < duration ? end : duration;
    const effDuration = effEnd - effStart;

    const stat = await fs.stat(securePath);
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
    content.push({
      type: "text",
      text: `🎬 ${videoPath} (${formatSec(duration)}, ${sizeMB} MB)${start || end ? `, 範圍 ${formatSec(effStart)} – ${formatSec(effEnd)}` : ""}`,
    });

    if (extract_transcript) {
      const transcript = await extractTranscript({
        containerVideoPath,
        containerTmpDir,
        whisper_model,
        language,
        start: effStart,
        duration: effDuration,
      });
      content.push({
        type: "text",
        text: `📝 字幕（${whisper_model} 模型${transcript.language ? `, 偵測語言 ${transcript.language}` : ""}）：\n\n${transcript.text || "(無語音內容)"}`,
      });
    }

    if (extract_keyframes) {
      const frames = await extractKeyframes({
        containerVideoPath,
        containerTmpDir,
        hostTmpDir,
        keyframe_interval,
        max_frames,
        frame_max_width,
        start: effStart,
        duration: effDuration,
      });
      content.push({
        type: "text",
        text: `🖼️ 關鍵幀（每 ${keyframe_interval} 秒 1 張，共 ${frames.length} 張）：`,
      });
      for (const f of frames) {
        content.push({ type: "text", text: `⏱️ ${formatSec(f.timestamp)}` });
        content.push({ type: "image", data: f.data, mimeType: "image/jpeg" });
      }
    }

    return { content };
  } catch (err) {
    return errText(`處理失敗：${err.message}`);
  } finally {
    await fs.rm(hostTmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ============================================
// 子流程
// ============================================
async function getDuration(containerVideoPath) {
  const cmd = `docker exec ${CONTAINER} ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${containerVideoPath}"`;
  const { stdout } = await execPromise(cmd, { timeout: 30000 });
  return parseFloat(stdout.trim());
}

async function extractTranscript({ containerVideoPath, containerTmpDir, whisper_model, language, start, duration }) {
  const audioPath = `${containerTmpDir}/audio.wav`;
  const ssArgs = start > 0 ? `-ss ${start} ` : "";
  const tArgs = duration > 0 ? `-t ${duration} ` : "";
  const ffmpegCmd = `docker exec ${CONTAINER} ffmpeg -y -loglevel error ${ssArgs}-i "${containerVideoPath}" ${tArgs}-vn -ac 1 -ar 16000 -f wav "${audioPath}"`;
  await execPromise(ffmpegCmd, { timeout: 300000, maxBuffer: 20 * 1024 * 1024 });

  const langArg = language ? `, language="${language}"` : "";
  const pyCode = `import json
from faster_whisper import WhisperModel
model = WhisperModel("${whisper_model}", device="cpu", compute_type="int8")
segments, info = model.transcribe("${audioPath}", beam_size=1${langArg})
lines = []
for seg in segments:
    lines.append(f"[{seg.start:.1f}s] {seg.text.strip()}")
print(json.dumps({"language": info.language, "text": "\\n".join(lines)}, ensure_ascii=False))
`;
  const pyScriptHost = path.join(MCP_ROOT, ".tmp", `whisper_${Date.now()}.py`);
  await fs.writeFile(pyScriptHost, pyCode, "utf-8");
  const pyScriptContainer = `${DEVELOP_MOUNT}/.tmp/${path.basename(pyScriptHost)}`;

  try {
    const { stdout } = await execPromise(
      `docker exec ${CONTAINER} python3 "${pyScriptContainer}"`,
      { timeout: 600000, maxBuffer: 50 * 1024 * 1024 }
    );
    const lastLine = stdout.trim().split("\n").pop();
    return JSON.parse(lastLine);
  } finally {
    await fs.unlink(pyScriptHost).catch(() => {});
  }
}

async function extractKeyframes({ containerVideoPath, containerTmpDir, hostTmpDir, keyframe_interval, max_frames, frame_max_width, start, duration }) {
  const fps = 1 / Math.max(1, keyframe_interval);
  const ssArgs = start > 0 ? `-ss ${start} ` : "";
  const tArgs = duration > 0 ? `-t ${duration} ` : "";
  const ffmpegCmd = `docker exec ${CONTAINER} ffmpeg -y -loglevel error ${ssArgs}-i "${containerVideoPath}" ${tArgs}-vf "fps=${fps},scale=${frame_max_width}:-2" -frames:v ${max_frames} -q:v 5 "${containerTmpDir}/frame_%03d.jpg"`;
  await execPromise(ffmpegCmd, { timeout: 300000, maxBuffer: 20 * 1024 * 1024 });

  const files = (await fs.readdir(hostTmpDir))
    .filter(f => f.startsWith("frame_") && f.endsWith(".jpg"))
    .sort();

  const frames = [];
  for (let i = 0; i < files.length; i++) {
    const buf = await fs.readFile(path.join(hostTmpDir, files[i]));
    frames.push({
      timestamp: start + i * keyframe_interval,
      data: buf.toString("base64"),
    });
  }
  return frames;
}

// ============================================
// Helpers
// ============================================
function errText(msg) {
  return { isError: true, content: [{ type: "text", text: msg }] };
}

function formatSec(sec) {
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}:${String(m % 60).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
  }
  return `${m}:${String(r).padStart(2, "0")}`;
}
