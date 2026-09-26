## Symbol lookup

- Do not call `codebase-incoming-calls` on generic or overloaded symbol names such as `create` in WrongStack: the ref graph returns cross-file noise (91 same-named symbols) and its `file` filter cannot disambiguate methods of a single class.
- For those cases, grep instead, scoping the pattern to the receiver — e.g. `(sessionStore|store)\.create\(` over `packages/**/src` — and filter test files out by name.
- Reserve `codebase-incoming-calls` for distinctive, non-overloaded names where the graph can actually resolve the target; reach for grep whenever the symbol name is a common verb or appears on many classes.
