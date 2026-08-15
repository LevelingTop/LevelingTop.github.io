/**
 * MP3 打点分割工具 - 主页面
 * 设计风格：工业感暗色工具台
 * 核心色：深蓝灰底 + 青绿波形 + 琥珀标记点 + 白色播放头
 * 字体：JetBrains Mono（时间码）+ Inter（UI）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Download,
  FileAudio,
  Keyboard,
  Loader2,
  MapPin,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Trash2,
  Upload,
  Volume2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Marker {
  id: string;
  time: number; // seconds
  label: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(sec: number): string {
  if (!isFinite(sec) || isNaN(sec)) return "0:00.000";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return `${m}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function parseTime(str: string): number | null {
  const match = str.match(/^(\d+):(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  const m = parseInt(match[1]);
  const s = parseInt(match[2]);
  const ms = parseInt((match[3] || "0").padEnd(3, "0"));
  return m * 60 + s + ms / 1000;
}

function nanoid(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * 裁掉 AudioBuffer 开头的编码器 padding 静音。
 * - 只在前 maxTrimSec 内查找首个非静音样本，避免误裁真实的渐入/留白
 * - 阈值 threshold（线性振幅）≈ -46dB，足以区分编码器 padding 和真实音频
 * - 若开头不是静音则原样返回
 */
function trimLeadingSilence(
  buffer: AudioBuffer,
  ctx: BaseAudioContext,
  threshold = 0.005,
  maxTrimSec = 0.5,
): { buffer: AudioBuffer; trimmedSec: number } {
  const sr = buffer.sampleRate;
  const numChannels = buffer.numberOfChannels;
  const scanEnd = Math.min(Math.floor(maxTrimSec * sr), buffer.length);

  const channels: Float32Array[] = [];
  for (let ch = 0; ch < numChannels; ch++) channels.push(buffer.getChannelData(ch));

  let firstNonSilent = 0;
  outer: for (let i = 0; i < scanEnd; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      if (Math.abs(channels[ch][i]) > threshold) {
        firstNonSilent = i;
        break outer;
      }
    }
  }

  if (firstNonSilent === 0) return { buffer, trimmedSec: 0 };

  const newLength = buffer.length - firstNonSilent;
  const newBuffer = ctx.createBuffer(numChannels, newLength, sr);
  for (let ch = 0; ch < numChannels; ch++) {
    newBuffer.copyToChannel(channels[ch].subarray(firstNonSilent), ch);
  }
  return { buffer: newBuffer, trimmedSec: firstNonSilent / sr };
}

// ─── Main Component ───────────────────────────────────────────────────────────

type ActiveSource = {
  node: AudioBufferSourceNode;
  /** 手动 stop 的标记（避免被随后到达的 onended 误判为自然结束） */
  manuallyStopped: boolean;
  /** 该段播放的目标结束位置（buffer 内秒数）。null = 播到 buffer 末尾 */
  endAt: number | null;
};

export default function Home() {
  // Audio state — 统一使用 Web Audio API 播放，避免 <audio> 元素的 MP3 编码器延迟问题
  const audioCtxRef = useRef<AudioContext | null>(null);
  const gainNodeRef = useRef<GainNode | null>(null);
  const audioBufferRef = useRef<AudioBuffer | null>(null);
  // 当前正在发声的 source（最多一个）。所有创建出来的 source 也加入 activeSourcesRef 兜底清理
  const currentSourceRef = useRef<ActiveSource | null>(null);
  const activeSourcesRef = useRef<Set<ActiveSource>>(new Set());
  // 用于把 ctx.currentTime 映射回 buffer 内的播放位置
  const playStartCtxTimeRef = useRef(0);
  const playStartOffsetRef = useRef(0);
  const pausedAtRef = useRef(0);

  const [hasAudio, setHasAudio] = useState(false);
  const [fileName, setFileName] = useState<string>("");
  const [duration, setDuration] = useState<number>(0);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(0.8);
  const [isLoadingFile, setIsLoadingFile] = useState(false);

  // Waveform
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [waveData, setWaveData] = useState<Float32Array | null>(null);
  const [zoom, setZoom] = useState(1);
  const [scrollPx, setScrollPx] = useState(0);
  const isDraggingRef = useRef(false);
  const lastXRef = useRef(0);
  const rafRef = useRef<number>(0);

  // Markers
  const [markers, setMarkers] = useState<Marker[]>([]);
  const [selectedMarkerId, setSelectedMarkerId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingValue, setEditingValue] = useState<string>("");

  // 当前播放头落在哪个片段（marker[i].time <= currentTime < marker[i+1].time 的那个 i）。
  // 0 → 第一个 marker 之前的"开头片段"返回 null（列表里也没列）。
  const currentSegmentMarkerId = useMemo(() => {
    if (markers.length === 0) return null;
    const sorted = [...markers].sort((a, b) => a.time - b.time);
    let result: string | null = null;
    for (const m of sorted) {
      if (m.time <= currentTime + 1e-3) result = m.id;
      else break;
    }
    return result;
  }, [markers, currentTime]);

  // Preview segment
  const previewEndRef = useRef<number | null>(null);

  // Export
  const importJsonInputRef = useRef<HTMLInputElement>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);

  // ─── File Loading ────────────────────────────────────────────────────────

  // 停止所有还在 active 的 source（不更新 pausedAt）。
  // 即使有遗漏/竞态，这里也会兜底把所有跟踪到的 source 全部 stop+disconnect，
  // 从而保证"任意时刻最多只有一个 source 在发声"的约束。
  const stopSource = useCallback(() => {
    activeSourcesRef.current.forEach((src) => {
      src.manuallyStopped = true;
      try { src.node.stop(); } catch { /* already stopped */ }
      try { src.node.disconnect(); } catch { /* noop */ }
    });
    activeSourcesRef.current.clear();
    currentSourceRef.current = null;
  }, []);

  const loadFile = useCallback(async (file: File) => {
    if (!file.type.includes("audio") && !file.name.endsWith(".mp3")) {
      toast.error("请上传 MP3 或其他音频文件");
      return;
    }
    setIsLoadingFile(true);
    stopSource();
    previewEndRef.current = null;
    setMarkers([]);
    setScrollPx(0);
    setZoom(1);
    setCurrentTime(0);
    setIsPlaying(false);
    pausedAtRef.current = 0;

    try {
      setFileName(file.name);

      // Decode audio
      const arrayBuffer = await file.arrayBuffer();
      // 复用旧 ctx；若已被关闭（如 StrictMode 下双 mount cleanup 过），则重建
      let ctx = audioCtxRef.current;
      if (!ctx || ctx.state === "closed") {
        ctx = new AudioContext();
        audioCtxRef.current = ctx;
        const gain = ctx.createGain();
        gain.gain.value = volume;
        gain.connect(ctx.destination);
        gainNodeRef.current = gain;
      }
      const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
      // 裁掉解码出的开头 padding 静音，使时间基准 = 真实音频起点
      const { buffer, trimmedSec } = trimLeadingSilence(decoded, ctx);
      if (trimmedSec > 0) {
        console.log(`[loadFile] trimmed leading silence: ${(trimmedSec * 1000).toFixed(1)} ms`);
      }
      audioBufferRef.current = buffer;
      setDuration(buffer.duration);
      setHasAudio(true);

      // Downsample waveform
      const channelData = buffer.getChannelData(0);
      const samples = 4000;
      const blockSize = Math.floor(channelData.length / samples);
      const data = new Float32Array(samples);
      for (let i = 0; i < samples; i++) {
        let max = 0;
        for (let j = 0; j < blockSize; j++) {
          const v = Math.abs(channelData[i * blockSize + j]);
          if (v > max) max = v;
        }
        data[i] = max;
      }
      setWaveData(data);
      toast.success(`已加载：${file.name}`);
    } catch (e) {
      toast.error("音频加载失败，请检查文件格式");
      console.error(e);
    } finally {
      setIsLoadingFile(false);
    }
  }, [stopSource, volume]);

  // ─── Volume / Cleanup ────────────────────────────────────────────────────

  useEffect(() => {
    if (gainNodeRef.current) gainNodeRef.current.gain.value = volume;
  }, [volume]);

  useEffect(() => {
    return () => {
      stopSource();
      audioCtxRef.current?.close().catch(() => {});
    };
  }, [stopSource]);

  // ─── Playback Controls ───────────────────────────────────────────────────

  // 内部启动播放：从 buffer 的 fromTime 处开始；若 untilTime 给定则到点自动停止
  const startPlayback = useCallback((fromTime: number, untilTime?: number) => {
    const ctx = audioCtxRef.current;
    const buffer = audioBufferRef.current;
    const gain = gainNodeRef.current;
    if (!ctx || !buffer || !gain) return;

    if (ctx.state === "suspended") ctx.resume().catch(() => {});

    // 先停掉所有可能还在播的旧 source（即使有竞态也能彻底清理）
    stopSource();

    const start = Math.max(0, Math.min(fromTime, buffer.duration));
    const reachEnd = untilTime === undefined || untilTime >= buffer.duration;
    const end = reachEnd ? buffer.duration : Math.max(start, untilTime);
    const dur = end - start;
    if (dur <= 0) return;

    const node = ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(gain);

    const active: ActiveSource = {
      node,
      manuallyStopped: false,
      endAt: reachEnd ? null : end,
    };

    node.onended = () => {
      // 从跟踪集合移除
      activeSourcesRef.current.delete(active);
      try { node.disconnect(); } catch { /* noop */ }

      // 手动 stop（被 stopSource 触发）不在这里更新 UI 状态，由调用方处理
      if (active.manuallyStopped) return;
      // 已被新的播放替代（不再是 current）也不动 UI
      if (currentSourceRef.current !== active) return;

      currentSourceRef.current = null;
      previewEndRef.current = null;
      const finishedAt = active.endAt ?? buffer.duration;
      pausedAtRef.current = finishedAt >= buffer.duration ? 0 : finishedAt;
      setIsPlaying(false);
      setCurrentTime(Math.min(finishedAt, buffer.duration));
    };

    // 若到 buffer 末尾则不传 duration，让其自然结束
    if (reachEnd) {
      node.start(0, start);
    } else {
      node.start(0, start, dur);
    }

    activeSourcesRef.current.add(active);
    currentSourceRef.current = active;
    playStartCtxTimeRef.current = ctx.currentTime;
    playStartOffsetRef.current = start;
    pausedAtRef.current = start;
    previewEndRef.current = active.endAt;
    setCurrentTime(start);
    setIsPlaying(true);
  }, [stopSource]);

  const pausePlayback = useCallback(() => {
    const ctx = audioCtxRef.current;
    if (!ctx || !currentSourceRef.current) return;
    const elapsed = ctx.currentTime - playStartCtxTimeRef.current;
    const pos = Math.max(0, Math.min(playStartOffsetRef.current + elapsed, audioBufferRef.current?.duration ?? 0));
    pausedAtRef.current = pos;
    stopSource();
    previewEndRef.current = null;
    setCurrentTime(pos);
    setIsPlaying(false);
  }, [stopSource]);

  const togglePlay = useCallback(() => {
    if (!audioBufferRef.current) return;
    if (isPlaying) {
      pausePlayback();
    } else {
      const buffer = audioBufferRef.current;
      const from = pausedAtRef.current >= buffer.duration - 0.001 ? 0 : pausedAtRef.current;
      startPlayback(from);
    }
  }, [isPlaying, pausePlayback, startPlayback]);

  const seekTo = useCallback((t: number) => {
    const buffer = audioBufferRef.current;
    if (!buffer) return;
    const clamped = Math.max(0, Math.min(t, buffer.duration));
    previewEndRef.current = null;
    if (isPlaying) {
      startPlayback(clamped);
    } else {
      pausedAtRef.current = clamped;
      setCurrentTime(clamped);
    }
  }, [isPlaying, startPlayback]);

  const seekRelative = useCallback((delta: number) => {
    const buffer = audioBufferRef.current;
    if (!buffer) return;
    const ctx = audioCtxRef.current;
    let now = pausedAtRef.current;
    if (isPlaying && ctx) {
      now = playStartOffsetRef.current + (ctx.currentTime - playStartCtxTimeRef.current);
    }
    seekTo(now + delta);
  }, [isPlaying, seekTo]);

  // ─── Preview Segment (play from marker to next marker then stop) ─────────

  const previewSegment = useCallback((markerId: string) => {
    const buffer = audioBufferRef.current;
    if (!buffer) return;

    const sorted = [...markers].sort((a, b) => a.time - b.time);
    const idx = sorted.findIndex(m => m.id === markerId);
    if (idx === -1) return;

    const start = sorted[idx].time;
    const end = idx + 1 < sorted.length ? sorted[idx + 1].time : buffer.duration;
    startPlayback(start, end);
  }, [markers, startPlayback]);

  // ─── 通过 RAF 同步 currentTime（基于 ctx.currentTime） ────────────────────

  useEffect(() => {
    if (!isPlaying) return;
    let raf = 0;
    const tick = () => {
      const ctx = audioCtxRef.current;
      const buffer = audioBufferRef.current;
      if (ctx && buffer && currentSourceRef.current) {
        const t = playStartOffsetRef.current + (ctx.currentTime - playStartCtxTimeRef.current);
        setCurrentTime(Math.max(0, Math.min(t, buffer.duration)));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying]);

  // ─── Waveform Drawing ────────────────────────────────────────────────────

  const totalPx = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return 0;
    return canvas.width * zoom;
  }, [zoom]);

  const timeToPx = useCallback((t: number) => {
    if (!duration) return 0;
    return (t / duration) * totalPx() - scrollPx;
  }, [duration, totalPx, scrollPx]);

  const pxToTime = useCallback((px: number) => {
    if (!duration) return 0;
    return ((px + scrollPx) / totalPx()) * duration;
  }, [duration, totalPx, scrollPx]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const draw = () => {
      const W = container.clientWidth;
      const H = 180;
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d")!;

      // Background
      ctx.fillStyle = "#0f1117";
      ctx.fillRect(0, 0, W, H);

      // Grid lines
      ctx.strokeStyle = "rgba(255,255,255,0.04)";
      ctx.lineWidth = 1;
      const gridCount = 20;
      for (let i = 0; i <= gridCount; i++) {
        const x = (i / gridCount) * W;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
      }

      // Time ruler
      ctx.fillStyle = "rgba(255,255,255,0.3)";
      ctx.font = "10px 'JetBrains Mono', monospace";
      if (duration > 0) {
        const step = duration / 10;
        for (let i = 0; i <= 10; i++) {
          const t = i * step;
          const x = timeToPx(t);
          if (x < -50 || x > W + 50) continue;
          ctx.fillStyle = "rgba(255,255,255,0.15)";
          ctx.fillRect(x, 0, 1, 8);
          ctx.fillStyle = "rgba(255,255,255,0.4)";
          ctx.fillText(formatTime(t).split(".")[0], x + 3, 18);
        }
      }

      // Waveform
      if (waveData && waveData.length > 0) {
        const midY = H / 2 + 10;
        const amplitude = (H - 40) / 2;
        const total = totalPx();

        const gradient = ctx.createLinearGradient(0, midY - amplitude, 0, midY + amplitude);
        gradient.addColorStop(0, "rgba(34,211,238,0.9)");
        gradient.addColorStop(0.4, "rgba(34,211,238,0.7)");
        gradient.addColorStop(1, "rgba(6,182,212,0.1)");

        ctx.beginPath();
        ctx.moveTo(0, midY);

        for (let x = 0; x < W; x++) {
          const t = pxToTime(x);
          const idx = Math.floor((t / duration) * waveData.length);
          const v = waveData[Math.max(0, Math.min(idx, waveData.length - 1))] || 0;
          const y = midY - v * amplitude;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }

        for (let x = W - 1; x >= 0; x--) {
          const t = pxToTime(x);
          const idx = Math.floor((t / duration) * waveData.length);
          const v = waveData[Math.max(0, Math.min(idx, waveData.length - 1))] || 0;
          const y = midY + v * amplitude;
          ctx.lineTo(x, y);
        }

        ctx.closePath();
        ctx.fillStyle = gradient;
        ctx.fill();

        // Top line
        ctx.beginPath();
        ctx.strokeStyle = "rgba(34,211,238,0.8)";
        ctx.lineWidth = 1.5;
        for (let x = 0; x < W; x++) {
          const t = pxToTime(x);
          const idx = Math.floor((t / duration) * waveData.length);
          const v = waveData[Math.max(0, Math.min(idx, waveData.length - 1))] || 0;
          const y = midY - v * amplitude;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // Markers
      markers.forEach((marker) => {
        const x = timeToPx(marker.time);
        if (x < -20 || x > W + 20) return;

        const isSelected = marker.id === selectedMarkerId;

        // Line
        ctx.beginPath();
        ctx.strokeStyle = isSelected ? "#fbbf24" : "#f59e0b";
        ctx.lineWidth = isSelected ? 2 : 1.5;
        ctx.setLineDash([4, 3]);
        ctx.moveTo(x, 0);
        ctx.lineTo(x, H);
        ctx.stroke();
        ctx.setLineDash([]);

        // Triangle top
        ctx.beginPath();
        ctx.fillStyle = isSelected ? "#fbbf24" : "#f59e0b";
        ctx.moveTo(x - 6, 0);
        ctx.lineTo(x + 6, 0);
        ctx.lineTo(x, 10);
        ctx.closePath();
        ctx.fill();

        // Label
        ctx.fillStyle = isSelected ? "#fbbf24" : "#f59e0b";
        ctx.font = "bold 10px 'JetBrains Mono', monospace";
        const labelX = Math.min(x + 4, W - 40);
        ctx.fillText(marker.label, labelX, 26);
      });

      // Playhead
      if (duration > 0) {
        const px = timeToPx(currentTime);
        if (px >= -2 && px <= W + 2) {
          // Glow
          ctx.shadowColor = "rgba(255,255,255,0.6)";
          ctx.shadowBlur = 8;
          ctx.beginPath();
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2;
          ctx.moveTo(px, 0);
          ctx.lineTo(px, H);
          ctx.stroke();
          ctx.shadowBlur = 0;

          // Top triangle
          ctx.beginPath();
          ctx.fillStyle = "#ffffff";
          ctx.moveTo(px - 7, 0);
          ctx.lineTo(px + 7, 0);
          ctx.lineTo(px, 12);
          ctx.closePath();
          ctx.fill();

          // Bottom triangle
          ctx.beginPath();
          ctx.moveTo(px - 7, H);
          ctx.lineTo(px + 7, H);
          ctx.lineTo(px, H - 12);
          ctx.closePath();
          ctx.fill();
        }
      }
    };

    draw();
    rafRef.current = requestAnimationFrame(function loop() {
      draw();
      rafRef.current = requestAnimationFrame(loop);
    });

    return () => cancelAnimationFrame(rafRef.current);
  }, [waveData, currentTime, markers, selectedMarkerId, scrollPx, zoom, duration, timeToPx, pxToTime, totalPx]);

  // ─── Canvas Interactions ─────────────────────────────────────────────────

  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isDraggingRef.current) return;
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
    const x = e.clientX - rect.left;
    const t = pxToTime(x);
    seekTo(t);
  }, [pxToTime, seekTo]);

  const handleCanvasMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (e.button === 1) e.preventDefault();
    isDraggingRef.current = false;
    lastXRef.current = e.clientX;

    const onMove = (me: MouseEvent) => {
      const dx = me.clientX - lastXRef.current;
      if (Math.abs(dx) > 3) isDraggingRef.current = true;
      lastXRef.current = me.clientX;
      setScrollPx(prev => {
        const canvas = canvasRef.current;
        if (!canvas) return prev;
        const maxScroll = totalPx() - canvas.width;
        return Math.max(0, Math.min(prev - dx, maxScroll));
      });
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      setTimeout(() => { isDraggingRef.current = false; }, 50);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [totalPx]);

  const handleWheel = useCallback((e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // Zoom
      const delta = e.deltaY > 0 ? -0.3 : 0.3;
      setZoom(prev => Math.max(1, Math.min(prev + delta, 20)));
    } else {
      // Scroll
      setScrollPx(prev => {
        const canvas = canvasRef.current;
        if (!canvas) return prev;
        const maxScroll = totalPx() - canvas.width;
        return Math.max(0, Math.min(prev + e.deltaY * 2, maxScroll));
      });
    }
  }, [totalPx]);

  // ─── Markers ─────────────────────────────────────────────────────────────

  const addMarker = useCallback(() => {
    if (!audioBufferRef.current) {
      toast.error("请先加载音频文件");
      return;
    }
    const ctx = audioCtxRef.current;
    let t = pausedAtRef.current;
    if (isPlaying && ctx) {
      t = playStartOffsetRef.current + (ctx.currentTime - playStartCtxTimeRef.current);
    }
    t = Math.max(0, Math.min(t, audioBufferRef.current.duration));
    const newMarker: Marker = {
      id: nanoid(),
      time: t,
      label: `第${markers.length + 1}段`,
    };
    setMarkers(prev => [...prev, newMarker].sort((a, b) => a.time - b.time));
    toast.success(`已在 ${formatTime(t)} 添加标记`);
  }, [isPlaying, markers.length]);

  const deleteMarker = useCallback((id: string) => {
    setMarkers(prev => prev.filter(m => m.id !== id));
    if (selectedMarkerId === id) setSelectedMarkerId(null);
  }, [selectedMarkerId]);

  const updateMarkerTime = useCallback((id: string, timeStr: string) => {
    const t = parseTime(timeStr);
    if (t === null || t < 0 || t > duration) {
      toast.error("时间格式错误，请使用 分:秒.毫秒 格式");
      return false;
    }
    setMarkers(prev => prev.map(m => m.id === id ? { ...m, time: t } : m).sort((a, b) => a.time - b.time));
    return true;
  }, [duration]);

  const updateMarkerLabel = useCallback((id: string, label: string) => {
    setMarkers(prev => prev.map(m => m.id === id ? { ...m, label } : m));
  }, []);

  // ─── Keyboard Shortcuts ──────────────────────────────────────────────────

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      switch (e.code) {
        case "Space":
          e.preventDefault();
          togglePlay();
          break;
        case "KeyM":
          e.preventDefault();
          addMarker();
          break;
        case "ArrowLeft":
          e.preventDefault();
          seekRelative(e.shiftKey ? -5 : -1);
          break;
        case "ArrowRight":
          e.preventDefault();
          seekRelative(e.shiftKey ? 5 : 1);
          break;
        case "Delete":
        case "Backspace":
          if (selectedMarkerId) {
            e.preventDefault();
            deleteMarker(selectedMarkerId);
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePlay, addMarker, seekRelative, selectedMarkerId, deleteMarker]);

  // ─── Export ──────────────────────────────────────────────────────────────

  const exportSegments = useCallback(async () => {
    const buffer = audioBufferRef.current;
    if (!buffer || markers.length === 0) {
      toast.error("请先添加标记点");
      return;
    }

    setIsExporting(true);
    setExportProgress(0);

    const timeToSample = (t: number) =>
      Math.max(0, Math.min(Math.round(t * buffer.sampleRate), buffer.length));

    const segments: { start: number; end: number; label: string }[] = [];
    const sorted = [...markers].sort((a, b) => a.time - b.time);

    // First segment: from 0 to first marker
    if (sorted[0].time > 0.5) {
      segments.push({ start: 0, end: sorted[0].time, label: "片段0_开头" });
    }

    // Segments between markers
    for (let i = 0; i < sorted.length; i++) {
      const start = sorted[i].time;
      const end = i + 1 < sorted.length ? sorted[i + 1].time : buffer.duration;
      const label = sorted[i].label;
      segments.push({ start, end, label });
    }

    try {
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const startSample = timeToSample(seg.start);
        const endSample = timeToSample(seg.end);
        const length = endSample - startSample;

        if (length <= 0) continue;

        const offlineCtx = new OfflineAudioContext(
          buffer.numberOfChannels,
          length,
          buffer.sampleRate
        );
        const source = offlineCtx.createBufferSource();

        const segBuffer = offlineCtx.createBuffer(
          buffer.numberOfChannels,
          length,
          buffer.sampleRate
        );
        for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
          segBuffer.copyToChannel(buffer.getChannelData(ch).slice(startSample, endSample), ch);
        }
        source.buffer = segBuffer;
        source.connect(offlineCtx.destination);
        source.start();

        const rendered = await offlineCtx.startRendering();

        // Convert to WAV
        const wavBlob = audioBufferToWav(rendered);
        const url = URL.createObjectURL(wavBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${String(i + 1).padStart(2, "0")}_${seg.label}.wav`;
        a.click();
        URL.revokeObjectURL(url);

        setExportProgress(Math.round(((i + 1) / segments.length) * 100));
        await new Promise(r => setTimeout(r, 200));
      }
      toast.success(`已导出 ${segments.length} 个片段`);
    } catch (e) {
      toast.error("导出失败，请重试");
      console.error(e);
    } finally {
      setIsExporting(false);
      setExportProgress(0);
    }
  }, [markers]);

  // ─── Export Single Segment ─────────────────────────────────────────────────

  const exportSingleSegment = useCallback(async (markerId: string) => {
    const buffer = audioBufferRef.current;
    if (!buffer) { toast.error("请先加载音频文件"); return; }

    const timeToSample = (t: number) =>
      Math.max(0, Math.min(Math.round(t * buffer.sampleRate), buffer.length));

    const sorted = [...markers].sort((a, b) => a.time - b.time);
    const idx = sorted.findIndex(m => m.id === markerId);
    if (idx === -1) return;

    const start = sorted[idx].time;
    const end = idx + 1 < sorted.length ? sorted[idx + 1].time : buffer.duration;
    const label = sorted[idx].label;
    const segIndex = idx + 1;

    try {
      const startSample = timeToSample(start);
      const endSample = timeToSample(end);
      const length = endSample - startSample;
      if (length <= 0) { toast.error("片段时长为零，无法导出"); return; }

      const offlineCtx = new OfflineAudioContext(buffer.numberOfChannels, length, buffer.sampleRate);
      const segBuffer = offlineCtx.createBuffer(buffer.numberOfChannels, length, buffer.sampleRate);
      for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
        segBuffer.copyToChannel(buffer.getChannelData(ch).slice(startSample, endSample), ch);
      }
      const source = offlineCtx.createBufferSource();
      source.buffer = segBuffer;
      source.connect(offlineCtx.destination);
      source.start();
      const rendered = await offlineCtx.startRendering();

      const wavBlob = audioBufferToWav(rendered);
      const url = URL.createObjectURL(wavBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${String(segIndex).padStart(2, "0")}_${label}.wav`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(`已导出：${label}`);
    } catch (e) {
      toast.error("导出失败，请重试");
      console.error(e);
    }
  }, [markers]);

  // ─── Import/Export JSON ──────────────────────────────────────────────────

  const exportJSON = useCallback(() => {
    const data = JSON.stringify({ fileName, markers }, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fileName || "markers"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [fileName, markers]);

  const importJSON = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = JSON.parse(e.target?.result as string);
        if (Array.isArray(data.markers)) {
          setMarkers(data.markers);
          toast.success(`已导入 ${data.markers.length} 个标记点`);
        }
      } catch {
        toast.error("JSON 文件格式错误");
      }
    };
    reader.readAsText(file);
  }, []);

  // ─── Drag & Drop ─────────────────────────────────────────────────────────

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer.files[0];
    if (!file) return;
    if (file.name.endsWith(".json")) {
      importJSON(file);
    } else {
      loadFile(file);
    }
  }, [loadFile, importJSON]);

  // ─── Auto-scroll playhead ─────────────────────────────────────────────────

  useEffect(() => {
    if (!isPlaying || !duration) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const px = (currentTime / duration) * totalPx();
    const viewStart = scrollPx;
    const viewEnd = scrollPx + canvas.width;
    const margin = canvas.width * 0.2;
    if (px > viewEnd - margin) {
      setScrollPx(Math.min(px - margin, totalPx() - canvas.width));
    }
  }, [currentTime, isPlaying, duration, totalPx, scrollPx]);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div
      className="h-screen flex flex-col overflow-hidden"
      style={{ background: "#0f1117" }}
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
    >
      {/* Header */}
      <header
        className="flex items-center justify-between px-6 py-3 border-b"
        style={{ borderColor: "rgba(255,255,255,0.08)", background: "#1c1f2e" }}
      >
        <div className="flex items-center gap-3">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center"
            style={{ background: "linear-gradient(135deg, #22d3ee, #6366f1)" }}
          >
            <FileAudio className="w-4 h-4 text-white" />
          </div>
          <div>
            <h1 className="text-sm font-semibold text-white tracking-wide">MP3 打点分割工具</h1>
            <p className="text-xs" style={{ color: "rgba(255,255,255,0.4)" }}>
              {fileName || "拖拽或上传音频文件"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <>
              {markers.length > 0 && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={exportJSON}
                  className="text-xs h-7"
                  style={{ borderColor: "rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.7)" }}
                >
                  导出标记 JSON
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                className="text-xs h-7"
                style={{ borderColor: "rgba(255,255,255,0.15)", color: "rgba(255,255,255,0.7)" }}
                onClick={() => importJsonInputRef.current?.click()}
              >
                导入标记 JSON
              </Button>
              <input
                ref={importJsonInputRef}
                type="file"
                accept=".json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) importJSON(file);
                  e.target.value = "";
                }}
              />
            </>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Main area */}
        <main className="flex-1 flex flex-col overflow-hidden">
          {/* Upload zone */}
          {!hasAudio && (
            <div className="flex-1 flex items-center justify-center p-8">
              <label
                className="w-full max-w-lg aspect-video rounded-2xl border-2 border-dashed flex flex-col items-center justify-center gap-4 cursor-pointer transition-all"
                style={{
                  borderColor: "rgba(34,211,238,0.3)",
                  background: "rgba(34,211,238,0.03)",
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.borderColor = "rgba(34,211,238,0.6)";
                  (e.currentTarget as HTMLElement).style.background = "rgba(34,211,238,0.06)";
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.borderColor = "rgba(34,211,238,0.3)";
                  (e.currentTarget as HTMLElement).style.background = "rgba(34,211,238,0.03)";
                }}
              >
                <input
                  type="file"
                  accept="audio/*,.mp3,.wav,.m4a,.flac,.ogg"
                  className="hidden"
                  onChange={(e) => e.target.files?.[0] && loadFile(e.target.files[0])}
                />
                {isLoadingFile ? (
                  <Loader2 className="w-12 h-12 animate-spin" style={{ color: "#22d3ee" }} />
                ) : (
                  <>
                    <Upload className="w-12 h-12" style={{ color: "#22d3ee" }} />
                    <div className="text-center">
                      <p className="text-white font-medium">点击上传或拖拽音频文件</p>
                      <p className="text-sm mt-1" style={{ color: "rgba(255,255,255,0.4)" }}>
                        支持 MP3、WAV、M4A、FLAC 等格式
                      </p>
                    </div>
                  </>
                )}
              </label>
            </div>
          )}

          {/* Waveform area */}
          {hasAudio && (
            <>
              <div
                className="relative"
                ref={containerRef}
                style={{ background: "#0f1117", borderBottom: "1px solid rgba(255,255,255,0.06)" }}
              >
                <canvas
                  ref={canvasRef}
                  className="waveform-canvas"
                  style={{ height: 180 }}
                  onClick={handleCanvasClick}
                  onMouseDown={handleCanvasMouseDown}
                  onWheel={handleWheel}
                />
                {/* Zoom indicator */}
                <div
                  className="absolute top-2 right-3 font-mono text-xs px-2 py-0.5 rounded"
                  style={{ background: "rgba(0,0,0,0.5)", color: "rgba(255,255,255,0.4)" }}
                >
                  {zoom.toFixed(1)}x
                </div>
              </div>

              {/* Transport controls */}
              <div
                className="flex items-center gap-4 px-6 py-3"
                style={{ background: "#1c1f2e", borderBottom: "1px solid rgba(255,255,255,0.06)" }}
              >
                {/* Time display */}
                <div
                  className="font-mono text-sm tabular-nums"
                  style={{ color: "#22d3ee", minWidth: 100 }}
                >
                  {formatTime(currentTime)}
                </div>

                {/* Playback buttons */}
                <div className="flex items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="w-8 h-8"
                        onClick={() => seekRelative(-5)}
                        style={{ color: "rgba(255,255,255,0.7)" }}
                      >
                        <SkipBack className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>后退 5 秒 (Shift+←)</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        size="icon"
                        className="w-9 h-9 rounded-full"
                        onClick={togglePlay}
                        style={{ background: "#22d3ee", color: "#0f1117" }}
                      >
                        {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>播放/暂停 (Space)</TooltipContent>
                  </Tooltip>

                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="w-8 h-8"
                        onClick={() => seekRelative(5)}
                        style={{ color: "rgba(255,255,255,0.7)" }}
                      >
                        <SkipForward className="w-4 h-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>前进 5 秒 (Shift+→)</TooltipContent>
                  </Tooltip>
                </div>

                {/* Progress bar */}
                <div className="flex-1 mx-2">
                  <Slider
                    min={0}
                    max={duration || 1}
                    step={0.01}
                    value={[currentTime]}
                    onValueChange={([v]) => seekTo(v)}
                    className="w-full"
                  />
                </div>

                {/* Duration */}
                <div
                  className="font-mono text-sm tabular-nums"
                  style={{ color: "rgba(255,255,255,0.4)", minWidth: 100, textAlign: "right" }}
                >
                  {formatTime(duration)}
                </div>

                {/* Volume */}
                <div className="flex items-center gap-2 ml-2">
                  <Volume2 className="w-4 h-4" style={{ color: "rgba(255,255,255,0.4)" }} />
                  <Slider
                    min={0}
                    max={1}
                    step={0.01}
                    value={[volume]}
                    onValueChange={([v]) => setVolume(v)}
                    className="w-20"
                  />
                </div>

                {/* Mark button */}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      size="sm"
                      className="ml-2 gap-1.5"
                      onClick={addMarker}
                      style={{ background: "#f59e0b", color: "#0f1117", fontWeight: 600 }}
                    >
                      <MapPin className="w-3.5 h-3.5" />
                      打点 (M)
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>在当前位置添加分割标记</TooltipContent>
                </Tooltip>
              </div>

              {/* Zoom controls */}
              <div
                className="flex items-center gap-3 px-6 py-2"
                style={{ background: "#0f1117", borderBottom: "1px solid rgba(255,255,255,0.04)" }}
              >
                <span className="text-xs" style={{ color: "rgba(255,255,255,0.3)" }}>缩放</span>
                <Slider
                  min={1}
                  max={20}
                  step={0.1}
                  value={[zoom]}
                  onValueChange={([v]) => { setZoom(v); setScrollPx(0); }}
                  className="w-32"
                />
                <span className="text-xs font-mono" style={{ color: "rgba(255,255,255,0.4)" }}>
                  {zoom.toFixed(1)}x
                </span>
                <span className="text-xs ml-4" style={{ color: "rgba(255,255,255,0.2)" }}>
                  Ctrl+滚轮缩放 · 拖拽滚动
                </span>
              </div>
            </>
          )}

          {/* Keyboard shortcuts hint */}
          {!hasAudio && (
            <div
              className="mx-auto max-w-lg p-4 rounded-xl mt-4"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}
            >
              <div className="flex items-center gap-2 mb-3">
                <Keyboard className="w-4 h-4" style={{ color: "#22d3ee" }} />
                <span className="text-sm font-medium" style={{ color: "rgba(255,255,255,0.6)" }}>
                  快捷键
                </span>
              </div>
              <div className="grid grid-cols-2 gap-x-8 gap-y-1.5">
                {[
                  ["Space", "播放 / 暂停"],
                  ["M", "在当前位置打点"],
                  ["← / →", "前进/后退 1 秒"],
                  ["Shift+← / →", "前进/后退 5 秒"],
                  ["Del / Backspace", "删除选中标记"],
                  ["Ctrl+滚轮", "波形缩放"],
                ].map(([key, desc]) => (
                  <div key={key} className="flex items-center gap-2">
                    <kbd
                      className="font-mono text-xs px-1.5 py-0.5 rounded"
                      style={{ background: "rgba(255,255,255,0.08)", color: "#22d3ee" }}
                    >
                      {key}
                    </kbd>
                    <span className="text-xs" style={{ color: "rgba(255,255,255,0.4)" }}>
                      {desc}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>

        {/* Right panel: Markers list */}
        {hasAudio && (
          <aside
            className="w-72 flex flex-col border-l overflow-hidden"
            style={{ borderColor: "rgba(255,255,255,0.08)", background: "#1c1f2e" }}
          >
            {/* Panel header */}
            <div
              className="flex items-center justify-between px-4 py-3 border-b"
              style={{ borderColor: "rgba(255,255,255,0.08)" }}
            >
              <div className="flex items-center gap-2">
                <MapPin className="w-4 h-4" style={{ color: "#f59e0b" }} />
                <span className="text-sm font-semibold text-white">
                  标记点
                </span>
                <span
                  className="text-xs font-mono px-1.5 py-0.5 rounded"
                  style={{ background: "rgba(245,158,11,0.15)", color: "#f59e0b" }}
                >
                  {markers.length}
                </span>
              </div>
              {markers.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs h-6 gap-1"
                  style={{ color: "rgba(255,255,255,0.4)" }}
                  onClick={() => { setMarkers([]); setSelectedMarkerId(null); }}
                >
                  <Trash2 className="w-3 h-3" />
                  清空
                </Button>
              )}
            </div>

            {/* Markers list */}
            <div className="flex-1 overflow-y-auto">
              {markers.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-40 gap-2">
                  <MapPin className="w-8 h-8" style={{ color: "rgba(255,255,255,0.1)" }} />
                  <p className="text-xs text-center" style={{ color: "rgba(255,255,255,0.3)" }}>
                    播放音频后按 M 键<br />在当前位置添加标记
                  </p>
                </div>
              ) : (
                <div className="py-1">
                  {markers.map((marker, idx) => {
                    const isSelected = selectedMarkerId === marker.id;
                    const isCurrent = isPlaying && currentSegmentMarkerId === marker.id;
                    return (
                    <div
                      key={marker.id}
                      className="group flex items-center gap-2 px-3 py-2 cursor-pointer transition-all"
                      style={{
                        background: isSelected
                          ? "rgba(245,158,11,0.1)"
                          : isCurrent
                            ? "rgba(34,211,238,0.08)"
                            : "transparent",
                        borderLeft: isSelected
                          ? "2px solid #f59e0b"
                          : isCurrent
                            ? "2px solid #22d3ee"
                            : "2px solid transparent",
                      }}
                      onClick={() => {
                        setSelectedMarkerId(marker.id);
                        seekTo(marker.time);
                      }}
                    >
                      {/* Index — 正在播放时显示一个跳动的点 */}
                      <span
                        className="font-mono text-xs w-5 text-center shrink-0 relative"
                        style={{ color: isCurrent ? "#22d3ee" : "rgba(255,255,255,0.3)" }}
                      >
                        {isCurrent ? (
                          <span
                            className="inline-block w-1.5 h-1.5 rounded-full animate-pulse"
                            style={{ background: "#22d3ee" }}
                          />
                        ) : (
                          idx + 1
                        )}
                      </span>

                      {/* Label */}
                      {editingId === marker.id ? (
                        <input
                          autoFocus
                          className="flex-1 bg-transparent text-xs text-white outline-none border-b"
                          style={{ borderColor: "#22d3ee" }}
                          value={editingValue}
                          onChange={(e) => setEditingValue(e.target.value)}
                          onBlur={() => {
                            updateMarkerLabel(marker.id, editingValue);
                            setEditingId(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              updateMarkerLabel(marker.id, editingValue);
                              setEditingId(null);
                            }
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <span
                          className="flex-1 text-xs text-white truncate"
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            setEditingId(marker.id);
                            setEditingValue(marker.label);
                          }}
                          title="双击编辑标签"
                        >
                          {marker.label}
                        </span>
                      )}

                      {/* Time */}
                      {editingId === `time_${marker.id}` ? (
                        <input
                          autoFocus
                          className="font-mono text-xs w-24 bg-transparent outline-none border-b text-right"
                          style={{ borderColor: "#22d3ee", color: "#22d3ee" }}
                          value={editingValue}
                          onChange={(e) => setEditingValue(e.target.value)}
                          onBlur={() => {
                            if (updateMarkerTime(marker.id, editingValue)) {
                              setEditingId(null);
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              if (updateMarkerTime(marker.id, editingValue)) {
                                setEditingId(null);
                              }
                            }
                            if (e.key === "Escape") setEditingId(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <span
                          className="font-mono text-xs shrink-0"
                          style={{ color: "#22d3ee" }}
                          onDoubleClick={(e) => {
                            e.stopPropagation();
                            setEditingId(`time_${marker.id}`);
                            setEditingValue(formatTime(marker.time));
                          }}
                          title="双击编辑时间"
                        >
                          {formatTime(marker.time)}
                        </span>
                      )}

                      {/* Preview segment */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="w-5 h-5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                            style={{ color: "#4ade80" }}
                            onClick={(e) => {
                              e.stopPropagation();
                              previewSegment(marker.id);
                            }}
                          >
                            <Play className="w-3 h-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="left">试听此段</TooltipContent>
                      </Tooltip>

                      {/* Single export */}
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="w-5 h-5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                            style={{ color: "#22d3ee" }}
                            onClick={(e) => {
                              e.stopPropagation();
                              exportSingleSegment(marker.id);
                            }}
                          >
                            <Download className="w-3 h-3" />
                          </Button>
                        </TooltipTrigger>
                        <TooltipContent side="left">导出此段</TooltipContent>
                      </Tooltip>

                      {/* Delete */}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="w-5 h-5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                        style={{ color: "rgba(255,255,255,0.4)" }}
                        onClick={(e) => {
                          e.stopPropagation();
                          deleteMarker(marker.id);
                        }}
                      >
                        <Trash2 className="w-3 h-3" />
                      </Button>
                    </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Export button */}
            <div
              className="p-4 border-t"
              style={{ borderColor: "rgba(255,255,255,0.08)" }}
            >
              <Button
                className="w-full gap-2 font-semibold"
                disabled={isExporting || markers.length === 0}
                onClick={exportSegments}
                style={{
                  background: markers.length > 0 ? "linear-gradient(135deg, #22d3ee, #6366f1)" : undefined,
                  color: markers.length > 0 ? "white" : undefined,
                }}
              >
                {isExporting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    导出中 {exportProgress}%
                  </>
                ) : (
                  <>
                    <Download className="w-4 h-4" />
                    导出 {markers.length > 0 ? `${markers.length + 1} 个片段` : "（需先打点）"}
                  </>
                )}
              </Button>
              <p className="text-xs text-center mt-2" style={{ color: "rgba(255,255,255,0.25)" }}>
                导出为 WAV 格式，无损音质
              </p>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

// ─── WAV Encoder ──────────────────────────────────────────────────────────────

function audioBufferToWav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const format = 1; // PCM
  const bitDepth = 16;
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataLength = buffer.length * blockAlign;
  const wavBuffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(wavBuffer);

  function writeString(offset: number, str: string) {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  }

  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, "data");
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
      offset += 2;
    }
  }

  return new Blob([wavBuffer], { type: "audio/wav" });
}
