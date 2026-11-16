/**
 * Turns scans into images a local vision model can read. Claude reads PDFs natively; local
 * models need one image per page, and phone photos must be scaled down to keep the number of
 * image tokens (and GPU memory) reasonable.
 */
import { getDocumentProxy, renderPageAsImage } from "unpdf";
import type { RuntimeImage } from "./runtimes/types.js";

const canvasImport = () => import("@napi-rs/canvas");

export async function pdfToImages(pdfBase64: string, opts: { maxPages: number; width: number }): Promise<{ images: RuntimeImage[]; totalPages: number }> {
  const pdf = await getDocumentProxy(new Uint8Array(Buffer.from(pdfBase64, "base64")));
  const total = pdf.numPages;
  const images: RuntimeImage[] = [];
  for (let p = 1; p <= Math.min(total, opts.maxPages); p++) {
    const png = await renderPageAsImage(pdf, p, { canvasImport, width: opts.width });
    images.push({ base64: Buffer.from(png).toString("base64"), mime: "image/png" });
  }
  return { images, totalPages: total };
}

/** Scale an image so its longest side is at most maxSide and re-encode it as JPEG. */
export async function normalizeImage(base64: string, maxSide: number): Promise<RuntimeImage> {
  const { createCanvas, loadImage } = await canvasImport();
  const img = await loadImage(Buffer.from(base64, "base64"));
  const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; // transparent PNGs would otherwise turn black in JPEG
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const jpeg = await canvas.encode("jpeg", 90);
  return { base64: jpeg.toString("base64"), mime: "image/jpeg" };
}
