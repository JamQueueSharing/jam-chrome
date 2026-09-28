import QRCode from "qrcode";
import jsQR from "jsqr";

export function draw(canvas, invitation) {
  return QRCode.toCanvas(canvas, invitation, {
    width: 280,
    margin: 4,
    errorCorrectionLevel: "M",
  });
}

export function read(canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  return jsQR(pixels.data, pixels.width, pixels.height)?.data;
}
