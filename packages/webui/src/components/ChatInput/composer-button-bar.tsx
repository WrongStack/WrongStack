import { Bell, ListPlus, Mic, MicOff, RotateCw, Send, Sparkles } from 'lucide-react';
import type React from 'react';
import { cn } from '@/lib/utils';
import { useLocalPrefs } from '@/stores/local-prefs';
import { ImageAttachControl } from './image-attach-control.js';
import type { ImageAttachment } from './image-attachments.js';
import { StopControls } from './stop-controls.js';
import { Button } from '../ui/button.js';

export interface ComposerButtonBarProps {
  imagePickerRef: React.RefObject<HTMLInputElement | null>;
  disabled: boolean;
  topicCheckBusy: boolean;
  clientConnected: boolean;
  isLoading: boolean;
  chatStarted: boolean;
  input: string;
  pendingImages: ImageAttachment[];
  addImageFiles: (files: File[]) => Promise<void>;
  handleStopAndEdit: () => void;
  handleAbort: () => void;
  handleBtw: () => void;
  handleSteer: () => void;
  handleAddQueue: () => void;
  updatePrefs: (prefs: { enhanceEnabled: boolean }) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
  isListening?: boolean;
  isSpeechSupported?: boolean;
  onToggleSpeech?: () => void;
}

export function ComposerButtonBar({
  imagePickerRef,
  disabled,
  topicCheckBusy,
  clientConnected,
  isLoading,
  chatStarted,
  input,
  pendingImages,
  addImageFiles,
  handleStopAndEdit,
  handleAbort,
  handleBtw,
  handleSteer,
  handleAddQueue,
  updatePrefs,
  t,
  isListening,
  isSpeechSupported,
  onToggleSpeech,
}: ComposerButtonBarProps) {
  const enhanceEnabled = useLocalPrefs((s) => s.enhanceEnabled);

  return (
    <div className="flex w-full justify-end gap-1 overflow-x-auto no-scrollbar sm:w-auto sm:overflow-visible">
      <ImageAttachControl
        imagePickerRef={imagePickerRef}
        disabled={disabled}
        title={t('chat:input.attachImagesTitle')}
        addImageFiles={addImageFiles}
      />
      {isLoading && chatStarted ? (
        <StopControls
          stopEditTitle={t('chat:input.stopEditTitle')}
          abortTitle={t('chat:input.abortTitle')}
          onStopAndEdit={handleStopAndEdit}
          onAbort={handleAbort}
        />
      ) : (
        <Button
          type="button"
          size="icon"
          variant={enhanceEnabled ? 'default' : 'outline'}
          disabled={disabled}
          onClick={() => {
            const next = !enhanceEnabled;
            useLocalPrefs.getState().set({ enhanceEnabled: next });
            updatePrefs({ enhanceEnabled: next });
          }}
          className={cn(
            'h-[44px] w-[44px] shrink-0 rounded-md transition-colors',
            enhanceEnabled &&
              'bg-warning/20 hover:bg-warning/30 text-warning border-warning/50',
          )}
          title={
            enhanceEnabled
              ? t('chat:input.refineEnabledTitle')
              : t('chat:input.refineDisabledTitle')
          }
        >
          <Sparkles className="h-4 w-4" />
        </Button>
      )}

      {isSpeechSupported && (
        <Button
          type="button"
          size="icon"
          variant={isListening ? 'destructive' : 'outline'}
          disabled={disabled}
          onClick={onToggleSpeech}
          className={cn(
            'h-[44px] w-[44px] shrink-0 rounded-md transition-all',
            isListening && 'animate-pulse bg-destructive text-destructive-foreground',
          )}
          title={
            isListening
              ? t('chat:input.stopListening', { defaultValue: 'Listening... (Click to stop)' })
              : t('chat:input.startListening', { defaultValue: 'Voice input (Speech to text)' })
          }
        >
          {isListening ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
        </Button>
      )}

      {/* Send button — visible both before and after chat has started. */}
      <Button
        type="submit"
        size="icon"
        variant="default"
        disabled={
          topicCheckBusy ||
          (!input.trim() && pendingImages.length === 0) ||
          !clientConnected
        }
        className="h-[44px] w-[44px] shrink-0 rounded-md"
        title={t('chat:sendTitle')}
        data-testid="send-submit"
      >
        <Send className="h-4 w-4" />
      </Button>

      {chatStarted && (
        <>
          <Button
            type="button"
            size="icon"
            variant="default"
            disabled={
              topicCheckBusy ||
              (!input.trim() && pendingImages.length === 0) ||
              !clientConnected
            }
            onClick={handleBtw}
            className="h-[44px] w-[44px] shrink-0 rounded-md"
            title={isLoading ? t('chat:input.btwRunningTitle') : t('chat:input.btwIdleTitle')}
            data-testid="send-btw"
          >
            <Bell className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="outline"
            disabled={
              topicCheckBusy ||
              (!input.trim() && pendingImages.length === 0) ||
              !clientConnected
            }
            onClick={handleSteer}
            className="h-[44px] w-[44px] shrink-0 rounded-md border-warning/50 text-warning hover:bg-warning/10"
            title={
              isLoading ? t('chat:input.steerRunningTitle') : t('chat:input.steerIdleTitle')
            }
            data-testid="send-steer"
          >
            <RotateCw className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="outline"
            disabled={
              topicCheckBusy ||
              (!input.trim() && pendingImages.length === 0) ||
              !clientConnected
            }
            onClick={handleAddQueue}
            className="h-[44px] w-[44px] shrink-0 rounded-md border-info/50 text-info hover:bg-info/10"
            title={t('chat:input.addQueueTitle')}
            data-testid="send-queue"
          >
            <ListPlus className="h-4 w-4" />
          </Button>
        </>
      )}
    </div>
  );
}
