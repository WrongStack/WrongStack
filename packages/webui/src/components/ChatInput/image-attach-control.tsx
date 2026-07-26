import { ImagePlus } from 'lucide-react';
import type { RefObject } from 'react';
import { Button } from '../ui/button';

export function ImageAttachControl({
  imagePickerRef,
  disabled,
  title,
  addImageFiles,
}: {
  imagePickerRef: RefObject<HTMLInputElement | null>;
  disabled: boolean;
  title: string;
  addImageFiles: (files: File[]) => Promise<void>;
}) {
  return (
    <>
      <input
        ref={imagePickerRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) void addImageFiles(files);
          e.target.value = '';
        }}
      />
      <Button
        type="button"
        size="icon"
        variant="outline"
        disabled={disabled}
        onClick={() => imagePickerRef.current?.click()}
        className="h-[44px] w-[44px] shrink-0 rounded-md"
        title={title}
        data-testid="attach-images"
      >
        <ImagePlus className="h-4 w-4" />
      </Button>
    </>
  );
}
