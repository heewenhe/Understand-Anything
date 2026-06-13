# Dart language support

**Date:** 2026-06-13
**Status:** Approved — ready for implementation plan
**Scope:** `understand-anything-plugin/packages/core/{src/languages/configs,src/plugins/extractors,package.json}`

## Problem

Understand Anything currently ships 14 code-language configs (TypeScript,
JavaScript, Python, Go, Rust, Java, Ruby, PHP, Swift, Kotlin, Lua, C, C++, C#)
plus 25 non-code config-file parsers. **Dart is absent.** Any `.dart` file in a
scanned project is classified as `plaintext` by the language registry, gets no
structural analysis, and contributes no nodes or edges to the project knowledge
graph.

Dart is in widespread big-tech use (Google's Flutter — official cross-platform
mobile language; production codebases at BMW, Toyota, Alibaba, ByteDance) and
its absence is the single largest mobile/cross-platform gap in the current
language gallery. Flutter codebases analyzed today produce empty graphs even
though the project's whole point is to make codebases understandable.

## Goal

Add deep Dart support — `LanguageConfig` + tree-sitter WASM grammar +
`DartExtractor` + vitest coverage — at parity with the recently landed Kotlin
support (PR #347). After this change, `.dart` files in a scanned project must
produce structural nodes (functions, classes, mixins, extensions, enums) and
call-graph edges identical in shape to what Kotlin/Java/Go produce today.

## Non-Goals

- **No Flutter framework config.** The Flutter ecosystem (pubspec.yaml manifest
  detection, widget vs service vs model layer hints) is a follow-up. The language
  config alone unlocks structural analysis for both Flutter and non-Flutter Dart
  code; framework-level detection is a separate, additive PR against
  `frameworks/` and `framework-registry.ts`.
- **No schema extensions.** Mixins, extensions, and enums are folded into the
  existing `StructuralAnalysis.classes[]` bucket. Adding `mixins[]` / `extensions[]`
  as first-class fields would require coordinated changes to `types.ts`,
  `graph-builder.ts`, dashboard rendering, and every existing extractor's tests —
  out of scope here. Tracked as a future cross-cutting refactor.
- **No support for `part of` / `part` multi-file libraries.** Each `.dart` file
  is analyzed independently; cross-`part` relationships would need a second pass
  over the project. Tracked as a follow-up.
- **No first-class modeling of Dart records or pattern matching.** Both appear
  only inside function bodies and have no project-graph impact.
- **No dashboard changes.** The new language slots into the existing
  config-driven pipeline; the dashboard already renders whatever `classes[]` /
  `functions[]` the extractor produces.

## Approach (chosen)

Strictly parallel to the Kotlin add (PR #347): six file changes, no edits to
shared types, registries, plugin loader, graph builder, or dashboard. The
existing config-driven `TreeSitterPlugin` picks the new language up unchanged.

Alternative considered and rejected:

- **Shallow Swift-style stub** (LanguageConfig only, no tree-sitter wiring):
  smallest PR but produces no structural graph for `.dart` files — fails the
  goal. The existing 14-language gallery already covers the shallow tier; the
  user-visible win is the deep tier.
- **Schema-extension approach** (first-class `mixins[]` / `extensions[]`):
  more accurate Dart modeling but touches every existing extractor's tests and
  the dashboard. High review risk; better as a separate, scoped follow-up.

## File-level changes

| # | File | Change | Approx LOC |
|---|---|---|---|
| 1 | `understand-anything-plugin/packages/core/package.json` | Add `"tree-sitter-dart": "^1.0.0"` dependency | 1 |
| 2 | `.../languages/configs/dart.ts` | **New** — `LanguageConfig` with `treeSitter` field | ~35 |
| 3 | `.../languages/configs/index.ts` | Import + register `dartConfig` in the code-languages block (both `builtinLanguageConfigs` array and the named re-export block) | ~4 |
| 4 | `.../plugins/extractors/dart-extractor.ts` | **New** — `DartExtractor` class implementing `LanguageExtractor` | ~400 |
| 5 | `.../plugins/extractors/index.ts` | Import `DartExtractor`, re-export it, and add `new DartExtractor()` to `builtinExtractors` | ~3 |
| 6 | `.../plugins/extractors/__tests__/dart-extractor.test.ts` | **New** — ~22 vitest cases | ~370 |

`pnpm-lock.yaml` regenerates automatically via `pnpm install`.

## `dartConfig` shape

```ts
export const dartConfig = {
  id: "dart",
  displayName: "Dart",
  extensions: [".dart"],
  treeSitter: {
    wasmPackage: "tree-sitter-dart",
    wasmFile: "tree-sitter-dart.wasm",
  },
  concepts: [
    "null safety",
    "mixins",
    "extensions",
    "isolates",
    "async/await",
    "streams",
    "factory constructors",
    "named constructors",
    "records",
    "sealed classes",
  ],
  filePatterns: {
    entryPoints: ["lib/main.dart", "bin/*.dart"],
    barrels: ["lib/*.dart"],
    tests: ["test/**/*_test.dart"],
    config: ["pubspec.yaml", "analysis_options.yaml"],
  },
} satisfies LanguageConfig;
```

**Notes:**

- Single `.dart` extension; Flutter widgets share it.
- `entryPoints` covers both Flutter (`lib/main.dart`) and Dart CLI (`bin/*.dart`).
- `barrels` matches Dart's idiomatic top-level re-export files (`lib/foo.dart`
  re-exporting `lib/src/*.dart`).

## WASM grammar source

**Use `tree-sitter-dart@1.0.0`** (publisher: amaanq; the canonical Dart
tree-sitter fork). Verification performed during design:

- The npm tarball (`tree-sitter-dart-1.0.0.tgz`) ships a prebuilt
  `tree-sitter-dart.wasm` at the package root. Confirmed via `npm pack` + `tar
  tzf`.
- The grammar exposes 316 node types including `class_definition`,
  `function_signature`, `method_signature`, `mixin_declaration`,
  `extension_declaration`, `enum_declaration`, `library_import`,
  `import_or_export`, `mixin_application_class`.
- This matches the publishing shape the Kotlin PR relied on
  (`@tree-sitter-grammars/tree-sitter-kotlin` ships a prebuilt `.wasm` alongside
  native bindings); the existing `TreeSitterPlugin` loader resolves it via
  `require.resolve("tree-sitter-dart/tree-sitter-dart.wasm")` with no loader
  changes.
- `@tree-sitter-grammars/tree-sitter-dart` does not exist (404 on npm), and
  `@driftlog/tree-sitter-dart` ships only native bindings via `node-gyp-build`.
  `tree-sitter-dart` is the only WASM-shipping option on the registry.

Caveat: `tree-sitter-dart@1.0.0` was last published 2023-02-24 and the package
description ("Dart grammar attempt for tree-sitter") signals an early/community
status. Mitigation: the extractor's tests parse real Dart snippets through the
WASM grammar — any future grammar regression surfaces immediately. If the
grammar later proves unmaintained, swapping in a fork is a one-line change in
`dartConfig.treeSitter.wasmPackage`.

## `DartExtractor` — what it extracts

Implements the `LanguageExtractor` interface with `languageIds = ["dart"]`.
Walks the tree-sitter AST and produces `StructuralAnalysis` +
`CallGraphEntry[]`. Follows the existing convention used by `KotlinExtractor`
and `GoExtractor` of pushing class/mixin methods to BOTH `methods[]` and the
top-level `functions[]` array so the call graph can resolve them.

### Top-level AST nodes handled

| AST node | Maps to | Notes |
|---|---|---|
| `function_signature` (top-level) | `functions[]` | name, params, returnType, lineRange |
| `class_definition` | `classes[]` | walks `class_body` for methods + fields |
| `mixin_declaration` | `classes[]` | folded in per chosen approach |
| `extension_declaration` | `classes[]` | name may be absent → use target type name (`extension on Foo` → `"on Foo"`) so the entry isn't dropped |
| `enum_declaration` | `classes[]` | constants surfaced as `properties` |
| `import_or_export` / `library_import` | `imports[]` | strips quotes from URI string; `show` / `hide` clauses captured as `specifiers`; `as` prefix becomes the sole specifier |
| Top-level `export` directive | `exports[]` | URI as `name`, line number from the directive |
| `package_directive` / `library_name` | skipped | metadata, not graph members |

### Visibility rule (Dart-specific)

Dart has no `public` / `private` keywords — names starting with `_` are
file-private (library-private to be precise), everything else is exported. The
`isExported(name)` helper is a one-liner: `!name.startsWith("_")`. This is the
**opposite** of Kotlin (where the default is exported and the presence of a
modifier opts out). The Dart rule is name-based, not modifier-based, and
applies uniformly to top-level declarations AND class members.

An inline comment in the extractor must document this contrast explicitly,
because a reviewer comparing line-for-line against `KotlinExtractor` will
otherwise expect modifier inspection.

### Class body walking

Mirrors `KotlinExtractor.collectClassBody`:

- `method_signature` / `function_signature` inside `class_body` → push name to
  the class's `methods[]` AND append a full entry to top-level `functions[]`
  (matches Kotlin/Swift/Go convention; required for call-graph resolution).
- `field_declaration` → `properties[]`.
- Constructor naming follows the source spelling so call sites resolve in the
  call graph:
  - Unnamed constructor `Foo(...)` → method name `"Foo"`.
  - Named constructor `Foo.named(...)` → method name `"Foo.named"`.
  - Factory named constructor `factory Foo.fromJson(...)` → method name
    `"Foo.fromJson"`.

### Call graph

Reuses the recursive-walk + function-stack pattern from `KotlinExtractor`:

- Push on `function_signature` / `method_signature`; pop on exit.
- On any node representing an invocation, emit `{ caller, callee, lineNumber }`.
  Dart's grammar represents calls as `assignable_expression > selector >
  arguments`. The callee identifier is the named child immediately preceding
  the `arguments` node. Two shapes:
  - Bare call `foo(...)` → callee is the `identifier` child.
  - Method call `target.foo(...)` → callee is the last `identifier` in the
    `selector` chain (analogous to Kotlin's `navigation_expression` handling).

### Imports — three forms

- `import 'package:flutter/material.dart';` → `source =
  "package:flutter/material.dart"`, `specifiers = []`
- `import 'foo.dart' show Bar, Baz;` → `source = "foo.dart"`, `specifiers =
  ["Bar", "Baz"]`
- `import 'foo.dart' as f;` → `source = "foo.dart"`, `specifiers = ["f"]`

## Tests — `dart-extractor.test.ts`

~22 vitest cases, matching the bar set by `kotlin-extractor.test.ts` (22 cases,
364 lines). Each test parses a small Dart snippet through the real WASM grammar
(no mocks) and asserts on extractor output. Setup copies Kotlin's pattern
verbatim: `createRequire` + `Parser.init()` + `Language.load(wasmPath)` in
`beforeAll`, snippet-per-test parsing via a local `parse()` helper. The only
difference is the WASM path:
`require.resolve("tree-sitter-dart/tree-sitter-dart.wasm")`.

**Coverage matrix:**

| Bucket | Cases | Examples |
|---|---|---|
| Functions | 3 | simple `int add(int a, int b)`; no-args/no-return `void noop()`; async + generic `Future<T> fetch<T>(String id)` |
| Classes | 4 | plain class with fields + methods; class with named + factory constructors; abstract class; class with `extends` + `with` + `implements` |
| Mixins | 2 | `mixin Foo {...}`; `mixin Foo on Bar {...}` |
| Extensions | 2 | named `extension StringX on String {...}`; anonymous `extension on int {...}` |
| Enums | 2 | simple `enum Color { red, green, blue }`; enhanced enum with methods |
| Imports | 4 | `package:` URI; relative path; `show` clause; `as` prefix |
| Exports | 1 | top-level `export 'foo.dart';` directive |
| Visibility | 2 | underscore-prefixed name is NOT in `exports[]`; non-underscore IS exported; covers both top-level and class-member cases |
| Call graph | 2 | top-level fn calling another top-level fn; method calling another method (`a.b()` shape) |

Existing test that should keep passing: `tree-sitter-plugin.test.ts` (the
end-to-end pipeline test). No new assertions required there — Dart enters the
same code path; if structural analysis works for `.dart` files in unit tests,
the integration path will follow.

## Error handling

All inherited from the existing pipeline; no new failure modes are introduced:

- **WASM load failure** (package missing / corrupt): `TreeSitterPlugin.init()`
  already catches and logs a `console.debug` "skipping structural analysis"
  message; `.dart` files fall back to LLM-only analysis. Same path Swift uses
  today (Swift has a `LanguageConfig` but no `treeSitter` field, so the loader
  silently skips it).
- **Parse failure on a malformed `.dart` file**: tree-sitter returns a partial
  tree; the extractor walks what's present and returns whatever it found.
  Matches `KotlinExtractor` behavior.
- **Empty / `library` / `part` only files**: extractor returns
  `{ functions: [], classes: [], imports: [], exports: [] }`. Not an error.

## Edge cases handled in code

- **Anonymous extension** (`extension on Foo`): the class entry's `name` is
  set to `"on Foo"` rather than empty string. Without this, the entry would be
  dropped by the graph builder. WHY-comment required inline.
- **Constructor naming**: `factory Foo.fromJson(...)` → method name
  `"Foo.fromJson"` (not `"fromJson"`), so call sites like `Foo.fromJson(map)`
  resolve correctly in the call graph.
- **Underscore visibility on class members**: applied identically to top-level
  declarations and to declarations inside class/mixin/extension bodies. A
  `class _PrivateImpl` is not in `exports[]`. A `class Public` with a method
  `_helper()` has the class itself in `exports[]` but `_helper` is excluded.
  Non-underscore class members ARE pushed to `exports[]` alongside the class
  entry, matching `KotlinExtractor.collectClassBody`'s behavior of pushing
  exported members to the top-level `exports[]` array.

## Edge cases explicitly OUT of scope

Documented in code via short comments at the relevant walk site:

- Dart records `(int, String)` and pattern matching — function-local only.
- `part of` / `part` multi-file libraries — would require a second project-wide
  pass.

## Verification

Before marking the implementation complete, run all of:

```
pnpm install                                          # picks up tree-sitter-dart
pnpm --filter @understand-anything/core build         # tsc clean
pnpm --filter @understand-anything/core test          # all existing + 22 new Dart tests pass
pnpm --filter @understand-anything/skill build        # no regressions
pnpm lint                                             # clean
pnpm test                                             # full suite, no regressions
```

Plus a manual smoke test: run `/understand` against a small Flutter sample
repo, then inspect `.understand-anything/knowledge-graph.json` to confirm it
contains Dart-derived class/function nodes and call-graph edges.

## Open questions

None at design time. The two genuine unknowns (WASM availability + grammar
node-type coverage) were resolved during exploration:

- WASM ships with `tree-sitter-dart@1.0.0` — confirmed via `npm pack`.
- Grammar exposes all needed node types — confirmed via inspection of
  `node-types.json`.
