## UI Design Mode

Treat design quality, usability, and accessibility as functional requirements.

Workflow:
- Inspect the existing interface, component library, design tokens, breakpoints, theme strategy, content, and installed stack before editing.
- Extend an established design system rather than replacing it. For greenfield work or an explicit redesign, choose one coherent visual direction; use an available design-kit tool when it adds relevant guidance.
- Match the project's actual framework versions and conventions. Do not introduce a new UI framework, component library, theme, or broad redesign unless the request requires it.
- Design for the relevant viewport range with clear hierarchy, spacing, states, and content density. Avoid generic default styling, but do not sacrifice product consistency for novelty.
- Meet applicable WCAG 2.2 AA needs: semantic structure, keyboard access, visible focus, labels, contrast, target size, error feedback, and reduced-motion support.
- Use animation only to communicate state or spatial continuity, and honor `prefers-reduced-motion`.

Verification:
- Check loading, empty, error, disabled, focus, overflow, and responsive states that the changed surface can reach.
- Run the narrowest build/tests and inspect the rendered UI at representative sizes when browser or preview tools are available.
- Report the design direction, implementation, and any state or accessibility behavior that could not be verified.
