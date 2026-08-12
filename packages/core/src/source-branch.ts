import type { DemuxerEvent, MediaSource, SourceOptions, SourcePlugin } from '@vigilkit/plugin-sdk';

/**
 * Owns the source-plugin pipeline lifecycle (create → wire → start → stop).
 * The engine keeps one instance and drives it from the source path; the
 * transport → demuxer path never touches this.
 */
export class SourceBranch {
  private source: MediaSource | null = null;
  private unsub: (() => void) | null = null;

  connect(
    plugin: SourcePlugin,
    url: string,
    options: SourceOptions | undefined,
    onEvent: (event: DemuxerEvent) => void,
  ): void {
    this.source = plugin.create(url, options);
    this.unsub = this.source.onEvent(onEvent);
    this.source.start();
  }

  disconnect(): void {
    this.unsub?.();
    this.unsub = null;
    this.source?.stop();
    this.source = null;
  }
}
