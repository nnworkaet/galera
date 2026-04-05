import type { Settings } from "./config";

export class WhisperClient {
  private url: string;
  private language: string;
  private enabled: boolean;

  constructor(settings: Settings) {
    this.url = settings.whisper.url;
    this.language = settings.whisper.language;
    this.enabled = settings.whisper.enabled;
  }

  async transcribe(filePath: string): Promise<string | null> {
    if (!this.enabled) return null;

    try {
      const formData = new FormData();
      const file = Bun.file(filePath);
      formData.append("audio_file", file);

      const url = `${this.url}?output=json&task=transcribe&language=${this.language}`;
      const response = await fetch(url, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        console.error(`[Whisper] HTTP ${response.status}: ${await response.text()}`);
        return null;
      }

      const data = await response.json() as { segments: Array<{ text: string }> };
      const text = data.segments.map((s) => s.text.trim()).join(" ");
      return text || null;
    } catch (err) {
      console.error("[Whisper] Transcription failed:", err);
      return null;
    }
  }
}
