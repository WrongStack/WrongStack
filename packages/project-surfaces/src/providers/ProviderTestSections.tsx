import { ChevronRight, KeyRound } from 'lucide-react';
import { useAppTranslation } from '../lib/i18n';
import { cn } from '../lib/utils';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import type { SavedProvider, Step, TestResult } from './provider-test-model';

/** The provider → models → results progress strip. */
export function ProviderTestSteps({ step }: { step: Step }) {
  const { t } = useAppTranslation();
  return (
    <div className="grid grid-cols-3 gap-2 text-xs">
      {(['provider', 'models', 'results'] as const).map((item, index) => (
        <div
          key={item}
          className={cn(
            'rounded-lg border px-3 py-2',
            step === item
              ? 'border-primary/50 bg-primary/10 text-primary'
              : 'text-muted-foreground',
          )}
        >
          {index + 1}.{' '}
          {item === 'provider'
            ? t('activity:providerTest.stepProvider')
            : item === 'models'
              ? t('activity:providerTest.stepModels')
              : t('activity:providerTest.stepResults')}
        </div>
      ))}
    </div>
  );
}

/** Step 1: pick the saved provider account to test. */
export function ProviderTestProviderStep({
  providers,
  providerId,
  setProviderId,
  openModels,
}: {
  providers: SavedProvider[];
  providerId: string;
  setProviderId: (id: string) => void;
  openModels: () => void;
}) {
  const { t } = useAppTranslation();
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">{t('activity:providerTest.chooseProvider')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('activity:providerTest.chooseProviderHint')}
        </p>
      </div>
      {providers.length === 0 ? (
        <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          {t('activity:providerTest.noAccounts')}
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {providers.map((provider) => {
            const activeKey = provider.apiKeys.find((key) => key.isActive);
            return (
              <button
                key={provider.id}
                type="button"
                onClick={() => setProviderId(provider.id)}
                className={cn(
                  'rounded-xl border p-4 text-left transition-colors hover:bg-accent/50',
                  providerId === provider.id &&
                    'border-primary bg-primary/5 ring-1 ring-primary/30',
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium">{provider.id}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {provider.type && provider.type !== provider.id
                        ? `${provider.type} · ${provider.family ?? 'auto'}`
                        : (provider.family ?? provider.type ?? 'auto-detect')}
                    </div>
                  </div>
                  <KeyRound className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="mt-3 text-xs text-muted-foreground">
                  {activeKey
                    ? `${activeKey.label} · ${activeKey.maskedKey}`
                    : t('activity:providerTest.savedCredentials', {
                        count: provider.apiKeys.length,
                      })}
                </div>
              </button>
            );
          })}
        </div>
      )}
      <div className="flex justify-end">
        <Button disabled={!providerId} onClick={openModels}>
          {t('activity:providerTest.next')} <ChevronRight className="ml-1.5 h-4 w-4" />
        </Button>
      </div>
    </section>
  );
}

/** Confirmation before disabling the failed models picked from the results. */
export function ProviderTestDisableDialog({
  disableTargets,
  setDisableTargets,
  providerId,
  activeProvider,
  activeModel,
  confirmDisable,
}: {
  disableTargets: TestResult[];
  setDisableTargets: (targets: TestResult[]) => void;
  providerId: string;
  activeProvider: string;
  activeModel: string;
  confirmDisable: () => void;
}) {
  const { t } = useAppTranslation();
  return (
    <Dialog
      open={disableTargets.length > 0}
      onOpenChange={(open) => !open && setDisableTargets([])}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {disableTargets.length > 1
              ? t('activity:providerTest.disableTitleMany', {
                  count: disableTargets.length,
                })
              : t('activity:providerTest.disableTitleOne')}
          </DialogTitle>
          <DialogDescription>
            {disableTargets.length > 0
              ? t('activity:providerTest.disableBody', {
                  models: disableTargets
                    .map((target) => `${providerId}/${target.modelId}`)
                    .join(', '),
                })
              : ''}
            {disableTargets.some(
              (target) => providerId === activeProvider && target.modelId === activeModel,
            )
              ? t('activity:providerTest.disableActiveNote')
              : ''}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDisableTargets([])}>
            {t('activity:providerTest.cancel')}
          </Button>
          <Button variant="destructive" onClick={confirmDisable}>
            {t('activity:providerTest.disableModel')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
