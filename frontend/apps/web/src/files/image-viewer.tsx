'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useFrontendTranslation } from '@clouddrive/i18n';
import { Action } from '@clouddrive/ui-adapter/action';
import { IconAction } from '@clouddrive/ui-adapter/icon-action';
import { RotateCw, ZoomIn, ZoomOut } from 'lucide-react';
import type { ImageSize } from './image-edit';
import { imageMetadataLimitMiB, readImageMetadata } from './image-metadata';
import type { ImageExifField } from './image-metadata.worker';

const zh = {
  info: '拍摄信息',
  zoomIn: '放大',
  zoomOut: '缩小',
  resetView: '重置视图',
  rotate: '旋转 90°',
  dimensions: '分辨率',
  format: '格式',
  loading: '正在读取拍摄信息…',
  empty: '此图片没有可显示的 EXIF 信息。',
  large: `图片超过 ${imageMetadataLimitMiB} MiB，已跳过 EXIF 解析。`,
  unavailable: '无法读取拍摄信息。',
  retry: '重试读取',
  showLocation: '显示拍摄位置',
  hideLocation: '隐藏拍摄位置',
  make: '相机厂商',
  model: '相机型号',
  lens: '镜头',
  captured: '拍摄时间',
  orientation: '方向',
  aperture: '光圈',
  exposure: '曝光时间',
  iso: 'ISO',
  focalLength: '焦距',
  bias: '曝光补偿',
  flash: '闪光灯',
  artist: '作者',
  copyright: '版权',
  software: '软件',
};
const en: typeof zh = {
  info: 'Photo information',
  zoomIn: 'Zoom in',
  zoomOut: 'Zoom out',
  resetView: 'Reset view',
  rotate: 'Rotate 90°',
  dimensions: 'Resolution',
  format: 'Format',
  loading: 'Reading photo information…',
  empty: 'This image has no EXIF information to display.',
  large: `EXIF reading was skipped because the image exceeds ${imageMetadataLimitMiB} MiB.`,
  unavailable: 'Could not read photo information.',
  retry: 'Retry reading',
  showLocation: 'Show capture location',
  hideLocation: 'Hide capture location',
  make: 'Camera manufacturer',
  model: 'Camera model',
  lens: 'Lens',
  captured: 'Taken at',
  orientation: 'Orientation',
  aperture: 'Aperture',
  exposure: 'Exposure time',
  iso: 'ISO',
  focalLength: 'Focal length',
  bias: 'Exposure compensation',
  flash: 'Flash',
  artist: 'Artist',
  copyright: 'Copyright',
  software: 'Software',
};

const photoAreaHeight = 'clamp(18rem, calc(100dvh - 11rem), 80dvh)';

function MetadataFields({ source, labels }: { source: Blob; labels: typeof zh }) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Awaited<ReturnType<typeof readImageMetadata>>>();
  const [locationVisible, setLocationVisible] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void readImageMetadata(source, controller.signal).then((response) => {
      if (!controller.signal.aborted) setResult(response);
    });
    return () => controller.abort();
  }, [source, attempt]);
  if (!result) return <p role="status">{labels.loading}</p>;
  if (result.state === 'large') return <p role="status">{labels.large}</p>;
  if (result.state !== 'ready')
    return (
      <>
        <p role="status">{labels.unavailable}</p>
        <Action
          size="sm"
          variant="quiet"
          onPress={() => {
            setResult(undefined);
            setAttempt((value) => value + 1);
          }}
        >
          {labels.retry}
        </Action>
      </>
    );
  const { fields, location } = result.metadata;
  const entries = Object.entries(fields) as [ImageExifField, string][];
  if (!entries.length && !location) return <p role="status">{labels.empty}</p>;
  return (
    <>
      {entries.length ? (
        <dl className="grid gap-2" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
          {entries.map(([field, value]) => (
            <div key={field}>
              <dt className="text-ink-muted">{labels[field]}</dt>
              <dd dir="auto">{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {location ? (
        <div className="space-y-2">
          <Action
            size="sm"
            variant="secondary"
            expanded={locationVisible}
            onPress={() => setLocationVisible((visible) => !visible)}
          >
            {locationVisible ? labels.hideLocation : labels.showLocation}
          </Action>
          {locationVisible ? (
            <p dir="ltr">
              {location.latitude.toFixed(6)}, {location.longitude.toFixed(6)}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

function QuickImageViewport({
  size,
  scale,
  rotation,
  children,
}: {
  size?: ImageSize;
  scale: number;
  rotation: number;
  children: ReactNode;
}) {
  const { t } = useFrontendTranslation();
  const viewport = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState<ImageSize>({ width: 0, height: 0 });
  useEffect(() => {
    const target = viewport.current;
    if (!target) return;
    const observer = new ResizeObserver(([region]) => {
      if (region) {
        const { width, height } = region.contentRect;
        setAvailable({ width, height });
      }
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, []);
  const turned = rotation % 180 !== 0;
  const rotatedWidth = (turned ? size?.height : size?.width) ?? 0;
  const rotatedHeight = (turned ? size?.width : size?.height) ?? 0;
  const fit =
    rotatedWidth && rotatedHeight
      ? Math.min(1, available.width / rotatedWidth, available.height / rotatedHeight)
      : 0;
  const magnification = fit * scale;
  /* eslint-disable jsx-a11y-x/no-noninteractive-tabindex -- 滚动区可在图片放大后用键盘平移。 */
  return (
    <div
      ref={viewport}
      className="relative min-h-0 min-w-0 flex-1 overflow-auto rounded-control"
      role="region"
      aria-label={t('files.mediaPreview')}
      tabIndex={0}
    >
      {!size ? (
        <p
          role="status"
          className="absolute inset-0 grid place-items-center text-sm text-ink-muted"
        >
          {t('files.mediaLoading')}
        </p>
      ) : null}
      <div
        className="relative min-h-full min-w-full"
        style={{ width: rotatedWidth * magnification, height: rotatedHeight * magnification }}
      >
        <div
          className="absolute left-1/2 top-1/2"
          style={{
            width: (size?.width ?? 0) * magnification,
            height: (size?.height ?? 0) * magnification,
            transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
  /* eslint-enable jsx-a11y-x/no-noninteractive-tabindex */
}

/** ImageViewer 将原件画布与按需拍摄信息并排，窄窗口会将信息移到画布下方。 */
export default function ImageViewer({
  source,
  size,
  editor,
  quick = false,
  children,
}: {
  source: Blob;
  size?: ImageSize;
  editor?: ReactNode;
  quick?: boolean;
  children: ReactNode;
}) {
  const { locale } = useFrontendTranslation();
  const labels = locale.startsWith('zh') ? zh : en;
  const [open, setOpen] = useState(false);
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const infoId = useId();
  return (
    <div className={quick ? 'flex min-h-0 flex-1 flex-col gap-2' : 'space-y-2'}>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div
          className={
            quick
              ? 'flex flex-wrap items-center gap-1.5 rounded-control bg-surface px-1'
              : 'flex flex-wrap items-center gap-1.5'
          }
        >
          <IconAction
            size="sm"
            label={labels.zoomOut}
            tooltip
            disabled={scale <= 0.5}
            onPress={() =>
              setScale((value) => Math.max(0.5, Math.round((value - 0.25) * 100) / 100))
            }
          >
            <ZoomOut className="size-4" />
          </IconAction>
          <Action
            size="sm"
            variant="quiet"
            onPress={() => {
              setScale(1);
              setRotation(0);
            }}
          >
            {Math.round(scale * 100)}%
          </Action>
          <IconAction
            size="sm"
            label={labels.zoomIn}
            tooltip
            disabled={scale >= 3}
            onPress={() => setScale((value) => Math.min(3, Math.round((value + 0.25) * 100) / 100))}
          >
            <ZoomIn className="size-4" />
          </IconAction>
          <IconAction
            size="sm"
            label={labels.rotate}
            tooltip
            onPress={() => setRotation((value) => (value + 90) % 360)}
          >
            <RotateCw className="size-4" />
          </IconAction>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={quick ? 'rounded-action bg-surface' : 'contents'}>
            <Action
              size="sm"
              variant="secondary"
              expanded={open}
              {...(open ? { controls: infoId } : {})}
              onPress={() => setOpen((value) => !value)}
            >
              {labels.info}
            </Action>
          </span>
          {editor}
        </div>
      </div>
      <div
        className={
          quick ? 'flex min-h-0 flex-1 flex-col gap-2 sm:flex-row' : 'flex flex-wrap gap-2'
        }
      >
        {quick ? (
          <QuickImageViewport {...(size ? { size } : {})} scale={scale} rotation={rotation}>
            {children}
          </QuickImageViewport>
        ) : (
          <div
            className="flex min-w-0 items-center justify-center overflow-auto rounded-control border border-border/60"
            style={{
              flex: '5 1 28rem',
              height: photoAreaHeight,
              backgroundColor: 'var(--color-surface-inset)',
            }}
          >
            <div
              className="flex items-center justify-center"
              style={{
                transform: `scale(${scale}) rotate(${rotation}deg)`,
                transformOrigin: 'center center',
                transition: 'transform var(--motion-duration-control) var(--ease-product)',
              }}
            >
              {children}
            </div>
          </div>
        )}
        {open ? (
          <section
            id={infoId}
            aria-label={labels.info}
            className={
              quick
                ? 'max-h-32 min-w-0 shrink-0 space-y-2 overflow-auto rounded-control bg-surface p-3 text-sm sm:max-h-full sm:w-52'
                : 'min-w-0 space-y-2 rounded-control p-3 text-sm'
            }
            style={{
              ...(quick ? {} : { flex: '1 1 17rem', maxHeight: photoAreaHeight, overflow: 'auto' }),
              overflowWrap: 'anywhere',
              border: '1px solid var(--color-border)',
            }}
          >
            <h3 className="font-semibold">{labels.info}</h3>
            <dl className="space-y-2">
              {size ? (
                <div>
                  <dt className="text-ink-muted">{labels.dimensions}</dt>
                  <dd>
                    {size.width} × {size.height} px
                  </dd>
                </div>
              ) : null}
              <div>
                <dt className="text-ink-muted">{labels.format}</dt>
                <dd>{source.type.split('/')[1]?.toUpperCase()}</dd>
              </div>
            </dl>
            <MetadataFields source={source} labels={labels} />
          </section>
        ) : null}
      </div>
    </div>
  );
}
