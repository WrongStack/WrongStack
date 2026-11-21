import {
  type AppLocaleCode,
  normalizeLocale,
  SUPPORTED_LNGS,
} from '@wrongstack/project-surfaces/lib/languages';

const searchWords = {
  en: { clear: 'Clear settings search', empty: 'No settings found. Try a different search.' },
  tr: { clear: 'Ayar aramasını temizle', empty: 'Ayar bulunamadı. Farklı bir arama deneyin.' },
  de: {
    clear: 'Einstellungssuche leeren',
    empty: 'Keine Einstellungen gefunden. Versuche einen anderen Suchbegriff.',
  },
  fr: {
    clear: 'Effacer la recherche de paramètres',
    empty: 'Aucun paramètre trouvé. Essayez une autre recherche.',
  },
  it: {
    clear: 'Cancella la ricerca delle impostazioni',
    empty: 'Nessuna impostazione trovata. Prova un’altra ricerca.',
  },
  es: {
    clear: 'Borrar la búsqueda de ajustes',
    empty: 'No se encontraron ajustes. Prueba otra búsqueda.',
  },
  'pt-BR': {
    clear: 'Limpar a busca de configurações',
    empty: 'Nenhuma configuração encontrada. Tente outra busca.',
  },
} satisfies Record<AppLocaleCode, { clear: string; empty: string }>;

export function settingsSearchWords(language: string) {
  const locale = normalizeLocale(language);
  return searchWords[SUPPORTED_LNGS.find((supported) => supported === locale) ?? 'en'];
}
