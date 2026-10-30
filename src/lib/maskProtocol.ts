// Messages between the UI thread (useWaterMask) and maskWorker.ts.

export type MaskRequest =
    | {
          type: "setImage";
          imageId: number;
          width: number;
          height: number;
          /** RGBA bytes, transferred (the sender loses access). */
          rgba: ArrayBuffer;
      }
    | {
          type: "segment";
          imageId: number;
          jobId: number;
          refHue: number;
          tolerance: number;
      }
    | { type: "clear" };

export type MaskResponse =
    | {
          type: "imageReady";
          imageId: number;
          width: number;
          height: number;
          /** Copy of the hue channel (0..179, 255 = ineligible), transferred. */
          hue: ArrayBuffer;
          eligibleCount: number;
          ms: number;
      }
    | {
          type: "segmented";
          imageId: number;
          jobId: number;
          refHue: number;
          tolerance: number;
          /** Int32Array buffer: label per pixel, boundary pixels negated. */
          labels: ArrayBuffer;
          /** Int32Array buffer: areas[label]. */
          areas: ArrayBuffer;
          ms: number;
      }
    | {
          type: "error";
          imageId: number | null;
          jobId: number | null;
          message: string;
      };
