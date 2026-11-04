import type { ComposerFileReference } from './composer-resources-model';
import { useDesktopText } from './desktop-i18n';
import { FileWorkspace } from './FileWorkspace';
import { RuntimeGate } from './RuntimeGate';
import { SkillLibrary } from './SkillLibrary';
import { useProjectEngine } from './useEngine';

interface Props {
  projectId: string;
  projectRoot: string;
  view: 'files' | 'changes' | 'skills';
  initialPath: string;
  onOpenFile: (path: string) => void;
  onReview: (text: string) => void;
  onReference?: (ref: ComposerFileReference) => void;
  onError: (error: unknown) => void;
}
/** Project tools retain their owner even when opened beside a conversation. */
export function ProjectSessionTools(props: Props) {
  return (
    <RuntimeGate scope="project" projectId={props.projectId}>
      <ProjectToolsContent {...props} />
    </RuntimeGate>
  );
}
function ProjectToolsContent({
  projectId,
  projectRoot,
  view,
  initialPath,
  onOpenFile,
  onReview,
  onReference,
  onError,
}: Props) {
  const { t } = useDesktopText();
  const { state, send, command } = useProjectEngine(projectId, onError);
  if (!state.connected)
    return <div className="runtime-state">{t('sessionTools.openingProject')}</div>;
  return view === 'skills' ? (
    <SkillLibrary command={command} scope="project" projectId={projectId} onOpenFile={onOpenFile} />
  ) : (
    <FileWorkspace
      command={command}
      send={send}
      state={state}
      scopeKey={projectRoot}
      projectId={projectId}
      mode={view}
      initialPath={initialPath}
      onReview={onReview}
      {...(onReference ? { onReference } : {})}
    />
  );
}
