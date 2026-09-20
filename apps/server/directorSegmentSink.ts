/**
 * Where a stream's pieces go once the muxer has cut them.
 *
 * One muxer, many sinks: the archive stores the pieces, live delivery serves
 * them, and both see the same numbering on the same timeline. Two muxers would
 * give two timelines, and the audit trail — which records where on the clock
 * each direction landed — could then only describe one of them. Agreed with
 * RV-19, which implements the same shape for fMP4; this is the WebM twin.
 *
 * Sinks are called fire-and-forget and fail independently. A storage upload
 * that times out must not take the stream down, and nothing here is awaited
 * by the route that ends the paid session.
 */
export interface DirectorSegmentSink {
  /**
   * The container's initial header, once, with the video codec actually
   * negotiated rather than the one asked for. Everything downstream branches
   * on the real answer.
   */
  init(segment: Buffer, codec: string): Promise<void> | void;
  segment(
    index: number,
    bytes: Buffer,
    startSeconds: number,
    durationSeconds: number,
  ): Promise<void> | void;
  finish(): Promise<void> | void;
}
