/** Views pinned in the project navigation; every other project view lives in "More tools". */
const PINNED = new Set(['Files', 'Changes', 'Memory', 'Kanban']);

export async function revealProjectTools(page, project) {
  const navigation = page.getByRole('navigation', { name: `${project.name} workspace` });
  await navigation.waitFor();
  const launcher = navigation.getByRole('button', { name: 'Project tools', exact: true });
  if ((await launcher.getAttribute('aria-expanded')) !== 'true') await launcher.click();
}

/** Open one project view by its label, through the tools launcher when it is not pinned. */
export async function openProjectView(page, project, label) {
  if (!PINNED.has(label)) await revealProjectTools(page, project);
  await page
    .getByRole('navigation', { name: `${project.name} workspace` })
    .getByRole('button', { name: label, exact: true })
    .click();
}
