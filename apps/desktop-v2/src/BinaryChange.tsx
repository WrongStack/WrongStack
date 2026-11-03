import { Columns2, Layers } from 'lucide-react';
import { type SyntheticEvent, useState } from 'react';
import { record } from './engine-values';
import './image-diff.css';

const IMAGE_URL = /^data:image\/(png|jpeg|gif|webp|avif|bmp);base64,/;
const image = (value: unknown) =>
  typeof value === 'string' && IMAGE_URL.test(value) ? value : undefined;

function bytes(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
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
  const versions = record(diff['image']);
  const before = image(versions['old']);
  const after = image(versions['new']);
  const both = Boolean(before && after);
  const [mode, setMode] = useState<'side' | 'onion'>('side');
  const [opacity, setOpacity] = useState(50);
  const [beforeSize, onBefore] = useNaturalSize();
  const [afterSize, onAfter] = useNaturalSize();
  return (
    <section className="image-diff" aria-label="Image changes">
      <header>
        <span>{!before ? 'New image' : !after ? 'Deleted image' : 'Changed image'}</span>
        {both && (
          <span className="image-diff-modes">
            {(
              [
                ['side', Columns2, 'Side by side'],
                ['onion', Layers, 'Onion skin'],
              ] as const
            ).map(([value, Icon, label]) => (
              <button
                type="button"
                key={value}
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
              >
                <Icon size={13} /> {label}
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
              alt={`${path} (Working tree)`}
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
              aria-label="Working tree opacity"
              onChange={(event) => setOpacity(Number(event.target.value))}
            />
            <span>Working tree</span>
          </label>
          <div className="image-diff-captions">
            <Caption label="HEAD" size={beforeSize} length={versions['oldBytes']} />
            <Caption label="Working tree" size={afterSize} length={versions['newBytes']} />
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
              <Caption label="Working tree" size={afterSize} length={versions['newBytes']} />
              <div>
                <img src={after} alt={`${path} (Working tree)`} onLoad={onAfter} />
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
  const versions = record(diff['image']);
  if (image(versions['old']) || image(versions['new']))
    return <ImageDiff diff={diff} path={path} />;
  return (
    <p className="file-quiet-state">
      {diff['tooLarge']
        ? 'File exceeds the text review limit.'
        : 'Binary file — text review is unavailable.'}
    </p>
  );
}
