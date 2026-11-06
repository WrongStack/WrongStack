import { Columns2, Layers } from 'lucide-react';
import { type SyntheticEvent, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import { record } from './engine-values';
import './image-diff.css';
import { displayDecimal } from './display-dates';

const IMAGE_URL = /^data:image\/(png|jpeg|gif|webp|avif|bmp);base64,/;
const image = (value: unknown) =>
  typeof value === 'string' && IMAGE_URL.test(value) ? value : undefined;

function bytes(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${displayDecimal(value / 1024, 1)} KB`;
  return `${displayDecimal(value / (1024 * 1024), 1)} MB`;
}

function useNaturalSize(): [string, (event: SyntheticEvent<HTMLImageElement>) => void] {
  const [size, setSize] = useState('');
  return [
    size,
    (event) => setSize(`${event.currentTarget.naturalWidth}×${event.currentTarget.naturalHeight}`),
  ];
}

function Caption({ label, size, length }: { label: string; size: string; length: unknown }) {
  return (
    <figcaption>
      <strong>{label}</strong>
      {size && <span>{size}</span>}
      {bytes(length) && <span>{bytes(length)}</span>}
    </figcaption>
  );
}

/**
 * A changed image, as the WebUI's Changes view shows it: the HEAD version beside the working
 * tree's, or the two stacked with a slider that fades between them (onion skin). Each side gives
 * its pixel and file size; an added or deleted image shows its one side.
 */
function ImageDiff({ diff, path }: { diff: Record<string, unknown>; path: string }) {
  const { t } = useDesktopText();
  const versions = record(diff['image']);
  const before = image(versions['old']);
  const after = image(versions['new']);
  const both = Boolean(before && after);
  const [mode, setMode] = useState<'side' | 'onion'>('side');
  const [opacity, setOpacity] = useState(50);
  const [beforeSize, onBefore] = useNaturalSize();
  const [afterSize, onAfter] = useNaturalSize();
  return (
    <section className="image-diff" aria-label={t('imageDiff.label')}>
      <header>
        <span>
          {!before ? t('imageDiff.new') : !after ? t('imageDiff.deleted') : t('imageDiff.changed')}
        </span>
        {both && (
          <span className="image-diff-modes">
            {(
              [
                ['side', Columns2],
                ['onion', Layers],
              ] as const
            ).map(([value, Icon]) => (
              <button
                type="button"
                key={value}
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
              >
                <Icon size={13} /> {t(`imageDiff.${value}`)}
              </button>
            ))}
          </span>
        )}
      </header>
      {mode === 'onion' && both ? (
        <div className="image-diff-onion">
          <div className="image-diff-stack">
            <img src={before} alt={`${path} (HEAD)`} onLoad={onBefore} />
            <img
              src={after}
              alt={`${path} (${t('fileView.workingTree')})`}
              onLoad={onAfter}
              style={{ opacity: opacity / 100 }}
            />
          </div>
          <label>
            <span>HEAD</span>
            <input
              type="range"
              min={0}
              max={100}
              value={opacity}
              aria-label={t('imageDiff.opacity')}
              onChange={(event) => setOpacity(Number(event.target.value))}
            />
            <span>{t('fileView.workingTree')}</span>
          </label>
          <div className="image-diff-captions">
            <Caption label="HEAD" size={beforeSize} length={versions['oldBytes']} />
            <Caption
              label={t('fileView.workingTree')}
              size={afterSize}
              length={versions['newBytes']}
            />
          </div>
        </div>
      ) : (
        <div className="image-diff-side">
          {before && (
            <figure>
              <Caption label="HEAD" size={beforeSize} length={versions['oldBytes']} />
              <div>
                <img src={before} alt={`${path} (HEAD)`} onLoad={onBefore} />
              </div>
            </figure>
          )}
          {after && (
            <figure>
              <Caption
                label={t('fileView.workingTree')}
                size={afterSize}
                length={versions['newBytes']}
              />
              <div>
                <img src={after} alt={`${path} (${t('fileView.workingTree')})`} onLoad={onAfter} />
              </div>
            </figure>
          )}
        </div>
      )}
    </section>
  );
}

/** A change the text diff cannot show: an image's two versions, or why there is no review. */
export function BinaryChange({ diff, path }: { diff: Record<string, unknown>; path: string }) {
  const { t } = useDesktopText();
  const versions = record(diff['image']);
  if (image(versions['old']) || image(versions['new']))
    return <ImageDiff diff={diff} path={path} />;
  return (
    <p className="file-quiet-state">
      {diff['tooLarge'] ? t('imageDiff.tooLarge') : t('imageDiff.binary')}
    </p>
  );
}
