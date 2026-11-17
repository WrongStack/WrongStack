import { useDesktopText } from './desktop-i18n';

const en = {
  drag: 'Reorder {{name}}',
  hint: 'Drag to reorder, or press Alt + Up / Down',
  remove: 'Remove project {{name}}',
  title: 'Remove {{name}} from Desktop?',
  body: 'The project and its sessions leave Desktop. Files, history and drafts are kept. Running sessions keep working in the background. Add the folder again to restore it.',
  moved: '{{name}} moved.',
};
type Copy = typeof en;
const text: Record<string, Copy> = {
  en,
  tr: {
    drag: '{{name}} sırasını değiştir',
    hint: 'Sıralamak için sürükleyin veya Alt + Yukarı / Aşağı tuşlarına basın',
    remove: '{{name}} projesini kaldır',
    title: '{{name}} Desktop’tan kaldırılsın mı?',
    body: 'Proje ve oturumları Desktop’tan kaldırılır. Dosyalar, geçmiş ve taslaklar korunur. Çalışan oturumlar arka planda devam eder. Geri getirmek için klasörü tekrar ekleyin.',
    moved: '{{name}} taşındı.',
  },
  de: {
    drag: '{{name}} umordnen',
    hint: 'Zum Sortieren ziehen oder Alt + Auf / Ab drücken',
    remove: 'Projekt {{name}} entfernen',
    title: '{{name}} aus Desktop entfernen?',
    body: 'Das Projekt und seine Sitzungen verlassen Desktop. Dateien, Verlauf und Entwürfe bleiben erhalten. Laufende Sitzungen arbeiten im Hintergrund weiter. Fügen Sie den Ordner erneut hinzu, um ihn wiederherzustellen.',
    moved: '{{name}} verschoben.',
  },
  fr: {
    drag: 'Réorganiser {{name}}',
    hint: 'Faire glisser ou appuyer sur Alt + Haut / Bas pour réorganiser',
    remove: 'Retirer le projet {{name}}',
    title: 'Retirer {{name}} de Desktop ?',
    body: 'Le projet et ses sessions quittent Desktop. Les fichiers, l’historique et les brouillons sont conservés. Les sessions en cours continuent en arrière-plan. Ajoutez à nouveau le dossier pour le restaurer.',
    moved: '{{name}} déplacé.',
  },
  it: {
    drag: 'Riordina {{name}}',
    hint: 'Trascina per riordinare o premi Alt + Su / Giù',
    remove: 'Rimuovi il progetto {{name}}',
    title: 'Rimuovere {{name}} da Desktop?',
    body: 'Il progetto e le sue sessioni lasciano Desktop. File, cronologia e bozze vengono conservati. Le sessioni attive continuano in background. Aggiungi nuovamente la cartella per ripristinarlo.',
    moved: '{{name}} spostato.',
  },
  es: {
    drag: 'Reordenar {{name}}',
    hint: 'Arrastra para reordenar o pulsa Alt + Arriba / Abajo',
    remove: 'Quitar proyecto {{name}}',
    title: '¿Quitar {{name}} de Desktop?',
    body: 'El proyecto y sus sesiones dejan Desktop. Se conservan los archivos, el historial y los borradores. Las sesiones activas continúan en segundo plano. Añade la carpeta de nuevo para restaurarlo.',
    moved: '{{name}} movido.',
  },
  'pt-BR': {
    drag: 'Reordenar {{name}}',
    hint: 'Arraste para reordenar ou pressione Alt + Cima / Baixo',
    remove: 'Remover projeto {{name}}',
    title: 'Remover {{name}} do Desktop?',
    body: 'O projeto e suas sessões saem do Desktop. Arquivos, histórico e rascunhos são preservados. As sessões ativas continuam em segundo plano. Adicione a pasta novamente para restaurá-lo.',
    moved: '{{name}} movido.',
  },
};
/** Separate, bounded catalog for the sidebar responsibility, using the shell display language. */
export function useProjectMenuText() {
  const { i18n } = useDesktopText();
  const copy = text[i18n.resolvedLanguage ?? i18n.language] ?? en;
  return (key: keyof Copy, name = '') => copy[key].replaceAll('{{name}}', name);
}
