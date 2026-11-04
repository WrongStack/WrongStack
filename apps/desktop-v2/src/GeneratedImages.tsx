import { ImageOff, LoaderCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useDesktopText } from './desktop-i18n';
import type { EngineCommand } from './engine-operations';
import './generated-images.css';

type Picture =
  | { path: string; status: 'loading' }
  | { path: string; status: 'ready'; dataUrl: string; bytes?: number | undefined }
  | { path: string; status: 'unavailable'; reason: 'tooLarge' | 'notImage' | 'unreadable' };

/** The saved files an `image_generate` result lists; none when it is not one. */
function generatedImagePaths(output: string): string[] {
  try {
    const parsed = JSON.parse(output) as { files?: Array<{ path?: unknown }> };
    return (parsed.files ?? [])
      .map((file) => file.path)
      .filter((path): path is string => typeof path === 'string' && path.length > 0);
  } catch {
    return [];
  }
}

const size = (bytes: number | undefined) =>
  bytes === undefined
    ? ''
    : bytes < 1024
      ? ` · ${bytes} B`
      : bytes < 1024 * 1024
        ? ` · ${(bytes / 1024).toFixed(1)} KiB`
        : ` · ${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

/**
 * The pictures an `image_generate` call saved, shown with its result as the WebUI's tool card
 * shows them. Each is read from the project (`files.image`), one after another; a picture
 * toggles between a thumbnail and full width.
 */
export function GeneratedImages({ output, command }: { output: string; command: EngineCommand }) {
  const { t } = useDesktopText();
  const [paths] = useState(() => generatedImagePaths(output));
  const [pictures, setPictures] = useState<Picture[]>(() =>
    paths.map((path) => ({ path, status: 'loading' })),
  );
  const [large, setLarge] = useState('');
  useEffect(() => {
    if (!paths.length) return;
    let live = true;
    void (async () => {
      for (const path of paths) {
        let next: Picture;
        try {
          const reply = await command('files.image', { filePath: path }, ['files.image']);
          const dataUrl = reply['dataUrl'];
          next =
            typeof dataUrl === 'string' &&
            /^data:image\/(png|jpeg|gif|webp|avif|bmp);base64,/.test(dataUrl)
              ? {
                  path,
                  status: 'ready',
                  dataUrl,
                  bytes: typeof reply['bytes'] === 'number' ? reply['bytes'] : undefined,
                }
              : {
                  path,
                  status: 'unavailable',
                  reason:
                    reply['tooLarge'] === true
                      ? 'tooLarge'
                      : reply['notImage'] === true
                        ? 'notImage'
                        : 'unreadable',
                };
        } catch {
          next = { path, status: 'unavailable', reason: 'unreadable' };
        }
        if (!live) return;
        setPictures((old) => old.map((picture) => (picture.path === path ? next : picture)));
      }
    })();
    return () => {
      live = false;
    };
  }, [command, paths]);
  if (!pictures.length) return null;
  return (
    <section className="generated-images" aria-label={t('generatedImages.label')}>
      {pictures.map((picture) =>
        picture.status === 'ready' ? (
          <figure key={picture.path}>
            <button
              type="button"
              title={
                large === picture.path
                  ? t('generatedImages.smaller')
                  : t('generatedImages.fullWidth')
              }
              onClick={() => setLarge(large === picture.path ? '' : picture.path)}
            >
              <img
                src={picture.dataUrl}
                alt={picture.path}
                className={large === picture.path ? 'large' : undefined}
              />
            </button>
            <figcaption title={picture.path}>
              {picture.path}
              {size(picture.bytes)}
            </figcaption>
          </figure>
        ) : (
          <div key={picture.path} className="generated-image-placeholder" title={picture.path}>
            {picture.status === 'loading' ? (
              <LoaderCircle size={14} className="spin" />
            ) : (
              <>
                <ImageOff size={14} />
                <small>{t(`generatedImages.${picture.reason}`)}</small>
              </>
            )}
          </div>
        ),
      )}
    </section>
  );
}
