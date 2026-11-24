import { z } from 'zod';
import { FilesError } from '@clouddrive/surface/files';
import {
  annotationColors,
  annotationWidths,
  annotationOpacities,
  annotationTextSizes,
  annotationImageSizes,
  annotationImageAngles,
  annotationLimits,
} from './image-annotation';
import { imageFilterNames, watermarkColors, watermarkPositions } from './image-appearance';
import {
  encodeImage,
  validImageCrop,
  validImageSize,
  type ImageEdit,
  type ImageSize,
} from './image-edit';
import { imageOverlayLimit, readImageOverlay, type ImageOverlayAsset } from './image-overlay';
import { editableImageType } from './image-format';
import { rasterType } from './media-signatures';

const size = z.object({ width: z.number().int().positive(), height: z.number().int().positive() });
const point = z.object({ x: z.number(), y: z.number() });
const asset = z.object({
  id: z.number().int().positive(),
  name: z.string().max(255),
  file: z.instanceof(File).refine((file) => file.size <= imageOverlayLimit.mebibytes * 1024 * 1024),
});
const mark = z.object({
  id: z.number().int().positive(),
  style: z.object({
    color: z.enum(annotationColors),
    width: z.literal(annotationWidths),
    opacity: z.literal(annotationOpacities),
    fill: z.boolean(),
    textSize: z.literal(annotationTextSizes),
  }),
});
const annotation = z.discriminatedUnion('kind', [
  mark.extend({
    kind: z.enum(['rectangle', 'ellipse', 'line', 'arrow', 'pen', 'polygon']),
    points: z.array(point).max(annotationLimits.pathPoints),
  }),
  mark.extend({
    kind: z.literal('text'),
    anchor: point,
    text: z.string().max(annotationLimits.textLength),
  }),
  mark.extend({
    kind: z.literal('image'),
    anchor: point,
    asset,
    fitScale: z.number().positive(),
    sizePercent: z.literal(annotationImageSizes),
    angleDegrees: z.literal(annotationImageAngles),
  }),
]);
const watermark = z.object({
  position: z.enum(watermarkPositions),
  opacityPercent: z.number().min(0).max(100),
  sizePercent: z.number().min(0).max(100),
});
const imageDraftSchema = z.object({
  source: z.instanceof(Blob),
  edit: z.object({
    crop: size.extend({ x: z.number().int().nonnegative(), y: z.number().int().nonnegative() }),
    turns: z.number().int().min(0).max(3),
    flipX: z.boolean(),
    flipY: z.boolean(),
    resize: size.optional(),
    annotations: z.array(annotation).max(annotationLimits.count),
    appearance: z.object({
      tone: z.object({
        brightness: z.number().min(-100).max(100),
        contrast: z.number().min(-100).max(100),
        saturation: z.number().min(-100).max(100),
        hue: z.number().min(-180).max(180),
        warmth: z.number().min(-100).max(100),
        exposure: z.number().min(-2).max(2),
      }),
      filter: z.enum(imageFilterNames),
      filterPercent: z.number().min(0).max(100),
      watermark: watermark
        .extend({ text: z.string().max(100), color: z.enum(watermarkColors) })
        .nullable(),
      logo: watermark.extend({ asset }).nullable(),
    }),
  }),
});

export function imageDraftPayload(source: Blob, edit: ImageEdit) {
  const pack = ({ id, name, file }: ImageOverlayAsset) => ({ id, name, file });
  return imageDraftSchema.parse({
    source,
    edit: {
      ...edit,
      annotations: edit.annotations.map((item) =>
        item.kind === 'image' ? { ...item, asset: pack(item.asset) } : item,
      ),
      appearance: {
        ...edit.appearance,
        logo: edit.appearance.logo
          ? { ...edit.appearance.logo, asset: pack(edit.appearance.logo.asset) }
          : null,
      },
    },
  });
}

async function restoreImageEdit(
  stored: z.infer<typeof imageDraftSchema>['edit'],
  source: ImageSize,
  signal: AbortSignal,
): Promise<{ edit: ImageEdit; assets: readonly ImageOverlayAsset[] }> {
  if (!validImageCrop(stored.crop, source) || (stored.resize && !validImageSize(stored.resize)))
    throw new FilesError('invalid');
  const assets = new Map<number, ImageOverlayAsset>();
  async function recover(item: z.infer<typeof asset>) {
    const existing = assets.get(item.id);
    if (existing) return existing;
    if (assets.size >= annotationLimits.imageAssets + 1) throw new FilesError('large');
    const result = await readImageOverlay(item.file, signal);
    if ('error' in result) throw new FilesError('invalid');
    const value = { ...item, bitmap: result.bitmap };
    assets.set(item.id, value);
    return value;
  }
  try {
    const annotations: ImageEdit['annotations'][number][] = [];
    for (const item of stored.annotations)
      annotations.push(
        item.kind === 'image' ? { ...item, asset: await recover(item.asset) } : item,
      );
    const logo = stored.appearance.logo;
    const { resize, ...edit } = stored;
    return {
      edit: {
        ...edit,
        ...(resize ? { resize } : {}),
        annotations,
        appearance: {
          ...stored.appearance,
          logo: logo ? { ...logo, asset: await recover(logo.asset) } : null,
        },
      },
      assets: [...assets.values()],
    };
  } catch (error) {
    for (const item of assets.values()) item.bitmap.close();
    throw error;
  }
}

export async function recoverImageDraft(
  payload: unknown,
  bitmap: ImageBitmap,
  signal: AbortSignal,
) {
  return restoreImageEdit(imageDraftSchema.parse(payload).edit, bitmap, signal);
}

export async function exportImageDraft(payload: unknown, maxBytes: number, signal: AbortSignal) {
  const { source, edit } = imageDraftSchema.parse(payload);
  const type = await rasterType(source);
  if (source.size > maxBytes || !type || !editableImageType(type)) throw new FilesError('invalid');
  const bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
  try {
    signal.throwIfAborted();
    if (!validImageSize(bitmap)) throw new FilesError('large');
    const restored = await restoreImageEdit(edit, bitmap, signal);
    try {
      const output = await encodeImage(bitmap, restored.edit, 'image/png');
      signal.throwIfAborted();
      if (!output || output.size > maxBytes) throw new FilesError('large');
      return output;
    } finally {
      for (const item of restored.assets) item.bitmap.close();
    }
  } finally {
    bitmap.close();
  }
}
