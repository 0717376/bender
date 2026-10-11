import { useCallback, useRef, useState } from "react";
import { transcribeAudio } from "./api";
import { t } from "./i18n";

/** Voice input: record → transcribe via backend ASR → hand text back. Ported from the wiki. */
export default function MicButton({ onTranscription }: { onTranscription: (text: string) => void }) {
  const [state, setState] = useState<"idle" | "recording" | "transcribing">("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const waveCleanupRef = useRef<(() => void) | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const handleTranscribe = useCallback(async (blob: Blob) => {
    setState("transcribing");
    try {
      const text = await transcribeAudio(blob);
      if (text) onTranscription(text);
    } catch (err) {
      console.error("Transcription failed:", err);
    } finally {
      setState("idle");
    }
  }, [onTranscription]);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        waveCleanupRef.current?.();
        waveCleanupRef.current = null;
        handleTranscribe(new Blob(chunksRef.current, { type: "audio/webm" }));
      };
      recorder.start();
      recorderRef.current = recorder;
      setState("recording");
      if (canvasRef.current) waveCleanupRef.current = createWaveform(stream, canvasRef.current);
    } catch (err) {
      console.error("Mic access denied:", err);
    }
  }, [handleTranscribe]);

  const toggle = useCallback(() => {
    if (state === "recording") recorderRef.current?.stop();
    else if (state === "idle") startRecording();
  }, [state, startRecording]);

  const cls = "mic-btn" + (state === "recording" ? " recording" : "") + (state === "transcribing" ? " transcribing" : "");

  return (
    <button type="button" className={cls} aria-label={t("voice_input")} onClick={toggle}>
      <svg className="mic-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="9" y="1" width="6" height="12" rx="3" />
        <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
        <line x1="12" y1="22" x2="12" y2="18" />
      </svg>
      <canvas ref={canvasRef} className="mic-wave" width={28} height={28} />
      <div className="mic-stop"><div /></div>
      <div className="mic-spinner" />
    </button>
  );
}

function createWaveform(stream: MediaStream, canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext("2d")!;
  const audioCtx = new AudioContext();
  const analyser = audioCtx.createAnalyser();
  const source = audioCtx.createMediaStreamSource(stream);
  analyser.fftSize = 32;
  analyser.smoothingTimeConstant = 0.6;
  source.connect(analyser);

  const data = new Uint8Array(analyser.frequencyBinCount);
  const bars = 5;
  let running = true;

  function draw() {
    if (!running) return;
    requestAnimationFrame(draw);
    analyser.getByteFrequencyData(data);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const barW = 3, gap = 2;
    const total = bars * barW + (bars - 1) * gap;
    let x = (canvas.width - total) / 2;
    for (let i = 0; i < bars; i++) {
      const idx = Math.floor((i / bars) * data.length * 0.6);
      const level = data[idx] / 255;
      const h = 4 + Math.round(level * 14);
      const y = (canvas.height - h) / 2;
      ctx.fillStyle = "#9a9a9a";
      ctx.beginPath();
      ctx.roundRect(x, y, barW, h, 1.5);
      ctx.fill();
      x += barW + gap;
    }
  }
  draw();

  return () => { running = false; audioCtx.close(); };
}
