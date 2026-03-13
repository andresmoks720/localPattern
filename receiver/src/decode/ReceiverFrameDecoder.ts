import jsQR, { type QRCode } from 'jsqr';

export interface Point {
  x: number;
  y: number;
}

export interface DecodeGeometry {
  corners: [Point, Point, Point, Point];
}

export interface DecodeResult {
  payload: Uint8Array;
  geometry: DecodeGeometry | null;
}

export interface ReceiverFrameDecoder {
  decode(imageData: Uint8ClampedArray, width: number, height: number): DecodeResult | null;
}

function extractGeometry(result: QRCode): DecodeGeometry | null {
  if (!result.location) return null;
  return {
    corners: [
      result.location.topLeftCorner,
      result.location.topRightCorner,
      result.location.bottomRightCorner,
      result.location.bottomLeftCorner
    ]
  };
}

export class JsQrFrameDecoder implements ReceiverFrameDecoder {
  public decode(imageData: Uint8ClampedArray, width: number, height: number): DecodeResult | null {
    const result = jsQR(imageData, width, height);
    if (!result?.binaryData?.length) return null;
    return {
      payload: Uint8Array.from(result.binaryData),
      geometry: extractGeometry(result)
    };
  }
}
