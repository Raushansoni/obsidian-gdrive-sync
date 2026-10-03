import jsQR from "jsqr";
import { codeFromScanText } from "./code";

type DetectedBarcode = { rawValue?: string };
type BarcodeDetectorLike = {
  detect: (source: CanvasImageSource | ImageBitmap) => Promise<DetectedBarcode[]>;
};
type BarcodeDetectorCtor = new (options?: { formats: string[] }) => BarcodeDetectorLike;

export interface QrScanHandlers {
  onCode: (code: string) => void;
  onCancel: () => void;
}

/**
 * Full-screen camera overlay that reads a Flock pairing QR (live video or a photo).
 * Prefers BarcodeDetector on Chromium/Android; falls back to jsQR.
 */
export class QrLiveScanner {
  private overlay: HTMLElement | null = null;
  private video: HTMLVideoElement | null = null;
  private hintEl: HTMLElement | null = null;
  private stream: MediaStream | null = null;
  private timer = 0;
  private closed = true;
  private handlers: QrScanHandlers | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private detector: BarcodeDetectorLike | null = null;

  get active(): boolean {
    return !this.closed && this.overlay !== null;
  }

  async open(handlers: QrScanHandlers): Promise<void> {
    this.stop();
    this.closed = false;
    this.handlers = handlers;
    this.detector = makeDetector();
    this.buildOverlay();
    try {
      await this.startCamera();
      this.scheduleTick();
    } catch (e) {
      this.setHint(
        `Camera unavailable (${e instanceof Error ? e.message : String(e)}). Take a photo of the computer's QR.`
      );
    }
  }

  stop(): void {
    this.closed = true;
    if (this.timer) {
      window.clearTimeout(this.timer);
      this.timer = 0;
    }
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    this.overlay?.remove();
    this.overlay = null;
    this.hintEl = null;
    this.canvas = null;
    this.detector = null;
    this.handlers = null;
  }

  private buildOverlay(): void {
    const overlay = document.createElement("div");
    overlay.className = "flock-scan-overlay";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-label", "Scan pairing QR");

    const video = document.createElement("video");
    video.className = "flock-scan-video";
    video.setAttribute("autoplay", "true");
    video.setAttribute("muted", "true");
    video.setAttribute("playsinline", "true");
    video.setAttribute("webkit-playsinline", "true");
    video.muted = true;
    video.playsInline = true;
    overlay.appendChild(video);

    const frame = document.createElement("div");
    frame.className = "flock-scan-frame";
    overlay.appendChild(frame);

    const hint = document.createElement("p");
    hint.className = "flock-scan-hint";
    hint.textContent = "Point this camera at the QR on your computer";
    overlay.appendChild(hint);

    const actions = document.createElement("div");
    actions.className = "flock-scan-actions";

    const file = document.createElement("input");
    file.type = "file";
    file.accept = "image/*";
    file.setAttribute("capture", "environment");
    file.className = "flock-scan-file";
    file.addEventListener("change", () => {
      const blob = file.files?.[0];
      file.value = "";
      if (blob) void this.onPhoto(blob);
    });

    const photoBtn = document.createElement("button");
    photoBtn.type = "button";
    photoBtn.className = "mod-cta flock-scan-btn";
    photoBtn.textContent = "Take photo of QR";
    photoBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      file.click();
    });

    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.className = "flock-scan-cancel";
    cancelBtn.textContent = "Cancel";
    cancelBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const onCancel = this.handlers?.onCancel;
      this.stop();
      onCancel?.();
    });

    actions.appendChild(photoBtn);
    actions.appendChild(cancelBtn);
    overlay.appendChild(actions);
    overlay.appendChild(file);
    document.body.appendChild(overlay);

    this.overlay = overlay;
    this.video = video;
    this.hintEl = hint;
  }

  private async startCamera(): Promise<void> {
    if (!this.video) throw new Error("scanner overlay missing");
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("this WebView has no camera API");
    }
    const stream = await this.requestStream();
    if (this.closed) {
      for (const t of stream.getTracks()) t.stop();
      return;
    }
    this.stream = stream;
    this.video.srcObject = stream;
    await this.video.play().catch(() => undefined);
  }

  private async requestStream(): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" } },
      });
    } catch {
      return await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
    }
  }

  private scheduleTick(): void {
    if (this.closed) return;
    this.timer = window.setTimeout(() => void this.tick(), 120);
  }

  private async tick(): Promise<void> {
    if (this.closed || !this.video) return;
    try {
      const raw = await this.detectFromVideo(this.video);
      if (raw && this.acceptRaw(raw)) return;
    } catch {
      /* keep scanning */
    }
    this.scheduleTick();
  }

  private async detectFromVideo(video: HTMLVideoElement): Promise<string | null> {
    if (video.readyState < 2 || video.videoWidth < 16) return null;
    if (this.detector) {
      try {
        const found = await this.detector.detect(video);
        const raw = found[0]?.rawValue;
        if (raw) return raw;
      } catch {
        /* jsQR next */
      }
    }
    const img = this.grabFrame(video);
    if (!img) return null;
    const r = jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" });
    return r?.data ?? null;
  }

  private grabFrame(video: HTMLVideoElement): ImageData | null {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;
    const maxW = 480;
    const scale = w > maxW ? maxW / w : 1;
    const cw = Math.max(1, Math.round(w * scale));
    const ch = Math.max(1, Math.round(h * scale));
    if (!this.canvas) this.canvas = document.createElement("canvas");
    this.canvas.width = cw;
    this.canvas.height = ch;
    const ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, cw, ch);
    return ctx.getImageData(0, 0, cw, ch);
  }

  private async onPhoto(blob: Blob): Promise<void> {
    try {
      const bmp = await createImageBitmap(blob);
      try {
        const raw = await this.detectFromBitmap(bmp);
        if (raw && this.acceptRaw(raw)) return;
      } finally {
        bmp.close();
      }
      this.setHint("No pairing QR in that photo. Fill the frame with the computer's code and try again.");
    } catch (e) {
      this.setHint(`Could not read that photo: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async detectFromBitmap(bmp: ImageBitmap): Promise<string | null> {
    if (this.detector) {
      try {
        const found = await this.detector.detect(bmp);
        const raw = found[0]?.rawValue;
        if (raw) return raw;
      } catch {
        /* jsQR next */
      }
    }
    const max = 800;
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(bmp, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const r = jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" });
    return r?.data ?? null;
  }

  private acceptRaw(raw: string): boolean {
    let code: string;
    try {
      code = codeFromScanText(raw);
    } catch {
      this.setHint("Not a Flock pairing QR — point at the code on your computer");
      return false;
    }
    const onCode = this.handlers?.onCode;
    this.stop();
    onCode?.(code);
    return true;
  }

  private setHint(text: string): void {
    if (this.hintEl) this.hintEl.textContent = text;
  }
}

function makeDetector(): BarcodeDetectorLike | null {
  const Ctor = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector;
  if (!Ctor) return null;
  try {
    return new Ctor({ formats: ["qr_code"] });
  } catch {
    return null;
  }
}
