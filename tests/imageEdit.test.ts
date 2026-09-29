import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts, degrees, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } from 'pdf-lib';
import { frameHit, frameOf, imagePlacements, removePlacement } from '@/lib/pdf/imageEdit';
import { analyzePageText } from '@/lib/pdf/textRemoval';

const JPG = new Uint8Array(Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64'));
// Display space for an unrotated 600 x 800 page: y down.
const toDisplay = (x: number, y: number): [number, number] => [x, 800 - y];

async function sample() {
  const d = await PDFDocument.create();
  const p = d.addPage([600, 800]);
  const font = await d.embedFont(StandardFonts.Helvetica);
  const img = await d.embedJpg(JPG);
  p.drawText('Caption stays', { x: 50, y: 700, size: 12, font });
  p.drawImage(img, { x: 100, y: 500, width: 200, height: 100 });
  p.drawImage(img, { x: 350, y: 200, width: 100, height: 50, rotate: degrees(30) });
  // A mirrored drawing (negative x scale).
  const name = p.node.newXObject('Mirror', img.ref);
  p.pushOperators(pushGraphicsState(), concatTransformationMatrix(-80, 0, 0, 40, 580, 50), drawObject(name), popGraphicsState());
  return PDFDocument.load(await d.save());
}

describe('editing pictures already in the PDF', () => {
  it('finds each drawing with its frame in display space', async () => {
    const doc = await sample();
    const page = doc.getPage(0);
    const pl = imagePlacements(doc, page);
    expect(pl).toHaveLength(3);
    const f0 = frameOf(pl[0].ctm, toDisplay)!;
    expect([f0.x, f0.y, f0.width, f0.height, f0.rotation].map((v) => Math.round(v))).toEqual([100, 200, 200, 100, 0]);
    expect(frameHit(f0, 150, 250)).toBe(true);
    expect(frameHit(f0, 150, 350)).toBe(false);
    // Rotated 30° counter-clockwise in PDF = -30° (clockwise positive) on screen.
    const f1 = frameOf(pl[1].ctm, toDisplay)!;
    expect(Math.round(f1.rotation)).toBe(-30);
    expect(Math.round(f1.width)).toBe(100);
    // Mirrored: not a plain box.
    expect(frameOf(pl[2].ctm, toDisplay)).toBeNull();
  });

  it('removes exactly one drawing and leaves the rest of the page', async () => {
    const doc = await sample();
    const page = doc.getPage(0);
    removePlacement(doc, page, imagePlacements(doc, page)[0].index);
    const again = await PDFDocument.load(await doc.save());
    const left = imagePlacements(again, again.getPage(0));
    expect(left).toHaveLength(2);
    expect(Math.round(frameOf(left[0].ctm, toDisplay)!.rotation)).toBe(-30);
    expect(analyzePageText(again, again.getPage(0)).text).toContain('Caption stays');
  });
});
