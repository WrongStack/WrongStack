## Chimera — project addendum (reviewer)

### Scope
Applies only when reviewing changes under `packages/tui/src/**`.

### Type-narrowing on array index lookups
- Reject any `as SomeType` cast applied directly to an `array[index]` lookup. Force the reviewer (and the author) to verify the element type from the source array instead of papering over it with a cast.
- Concrete failure mode to guard against: `THEME_OPTIONS` in `packages/tui/src/theme.ts` is typed as `ThemePickerOption[]`, so consumers must read fields like `?.id`. A cast on the index lookup lets a `ThemePickerOption` object slip into APIs expecting a primitive (e.g. `setActiveTheme`) — the cast typechecks but is semantically wrong.
- When the diff only shows the cast, still trace back to the array's element type and the downstream consumer; reject until both ends match.

### Reducer / consumer contract
- Treat a reducer case that defines a `selected` (or similarly named) index into a module-level options array and its Enter/confirm consumer as a single contract. Review them in one pass, even when only the reducer case is in the diff.
- For each such `selected` index: confirm the array's element type, confirm the consumer reads the same field shape (e.g. `?.id`), and confirm no `as SomeType` cast bridges the two. If any link is missing or forced via cast, request the fix in the consumer (or both files), not just the reducer.

### Review checklist
- Every new/changed `array[index] as T` in `packages/tui/src/**` → reject and request a type guard or direct typed access.
- Every new/changed `selected` (or equivalent) index in a reducer case → locate the confirm/Enter consumer in the same pass; flag mismatches in element type or field access.
- Cross-check against the module's options array (e.g. `THEME_OPTIONS`) to confirm the consumer reads the right field (e.g. `?.id`) and passes it to the correct sink (e.g. `setActiveTheme`).
