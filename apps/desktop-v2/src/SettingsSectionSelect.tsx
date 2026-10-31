/** One settings section as the navigation lists it. */
export interface SettingsSectionChoice {
  id: string;
  title: string;
  group: string;
}

/**
 * The settings sections in one picker, grouped like the list. A narrow window shows this in
 * place of the list, which would otherwise fill the screen above the section it opens.
 */
export function SettingsSectionSelect({
  sections,
  section,
  onSelect,
}: {
  sections: readonly SettingsSectionChoice[];
  section: string;
  onSelect: (id: string) => void;
}) {
  const listed = sections.some((item) => item.id === section);
  return (
    <select
      className="settings-section-select"
      aria-label="Settings section"
      value={listed ? section : ''}
      onChange={(e) => onSelect(e.target.value)}
    >
      {!listed && <option value="">Choose a section</option>}
      {[...new Set(sections.map((item) => item.group))].map((group) => (
        <optgroup key={group} label={group}>
          {sections
            .filter((item) => item.group === group)
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.title}
              </option>
            ))}
        </optgroup>
      ))}
    </select>
  );
}
