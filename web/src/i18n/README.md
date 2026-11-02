# Interface localization

[한국어](README.ko.md)

English is the default. English, Korean and Simplified Chinese (`zh-Hans`) are shipped. The React provider restores an explicit preference after hydration, keeping the static English export and first client render consistent. Selection persists in `scopeweaver.locale` localStorage and the `scopeweaver_locale` cookie. API transport reads the stored preference even before hydration finishes; unavailable localStorage falls back to the cookie. No OS/browser language is selected automatically.

## Adding a language

1. Add a reviewed canonical ID, native name, Intl locale and aliases to `locale/definitions.json`, the declaration imported by the frontend and embedded by Go. Add accepted and rejected examples to `locale/matching-vectors.json`. Extend the frontend `Locale` type and backend language constants as needed; their completeness checks must agree with the declaration. Do not change historical EN/KO aliases.
2. Author every current English key in all six namespaces. English defines `MessageKey` typing and meaning. Register the new typed namespace tables in `catalog.ts`; never ship English copies or rely on runtime fallback to hide missing translations. `messages/zh-Hans.ts` demonstrates a separate resource checked against each English namespace. Keep interpolation field names and paired rich tags, including repeated tags, compatible. Technical identifiers, code and protocol strings remain unchanged.
3. Add the date-fns object to `calendar.ts`. Native selector labels and Intl formats come from the shared declaration; `Calendar` and range labels use the centralized date-fns map. A supplied calendar locale or formatter still wins.
4. Supply the backend language-keyed catalogs and every external production registration. `locale.Register(key, en, ko)` remains compatible, but additional languages use `locale.RegisterAll(map[string]map[locale.Lang]string{key: {locale.En: en, locale.Ko: ko, locale.ZhHans: zh}})`. Check raw registrations rather than `Lookup`, which retains English/key fallback for unknown or incomplete caller registrations. That runtime compatibility fallback does **not** satisfy release completeness.
5. Add focused normalization, integrity, state and browser scenarios. Run frontend tests, typecheck and static export, backend catalog/registration tests and the required repository checks in [CONTRIBUTING.md](../../../CONTRIBUTING.md). Document translation-review concerns and resolution. Independent review must not be described as native-speaker approval unless verified. Keep English/Korean feature documentation paired; additional-language documentation does not replace that requirement.

Matching is case-insensitive and accepts underscore regional forms. Bare `zh`, `zh-CN` and `zh-SG` explicitly map to `zh-Hans`; `zh-Hans` plus a region also matches. An explicit script wins the region, so `zh-Hans-TW` is Simplified Chinese. Traditional inputs (`zh-Hant`, `zh-TW`, `zh-HK`, `zh-MO`, including `zh-Hant-CN`) remain unsupported and fall through to the next preference or default. They never normalize to Simplified Chinese. Future reviewed script catalogs can be registered without removing this safety policy.

## Runtime boundaries

Use `useI18n().t` in components and `translate` in non-React helpers. Shipped catalogs contain every key; unknown frontend keys display themselves. Pass user values as interpolation parameters. Never translate user-entered text, persisted reports, raw evidence, identifiers, API field names, credentials or protocol values. Existing Chinese mention wire labels and historical parser aliases remain compatible with the backend; visible labels localize independently.

The `interface` namespace contains migrated interface and authored demo messages with stable IDs. The `english` namespace covers pre-existing English labels. New features use descriptive keys in an appropriate namespace. Static configuration objects expose localized labels through getters. Consumers subscribe to the locale; memoized derived labels include it as a dependency. Switching language does not remount the application or clear drafts.

`localizedFetch` adds locale headers and query parameters while retaining explicit caller overrides and authentication. SSE URLs use `sseUrl`, which adds the locale query parameter. Use `getIntlLocale` or `fmt` for dates and numbers.

`prepareDemoFixture` runs only on authored initial fixtures. Editing replaces the accessor with an ordinary writable value; `cloneDemoFixture` preserves that distinction. Custom values stay unchanged even when they equal a translation.

## Verification

Run `npm test` from `web`, `npx tsc --noEmit`, and `npm run build:static`. Tests cover every shipped catalog, missing/empty/placeholder/rich-tag negative fixtures, shared locale vectors, persistence/hydration, API/SSE transport, editable fixtures, legacy mentions, Intl/date-fns formatting and caller overrides. The AST Han guard exempts only direct string values in the six Chinese resource objects; code in that file, ordinary UI source and source/config comments remain guarded. A new resource needs an equally narrow reviewed allowance, never a directory-wide exemption. EN/KO catalogs retain untranslated-Han checks.

The mandatory `e2e` smoke uses a same-checkout embedded binary and fresh disposable database. It preserves EN/KO checks and adds Chinese setup/login/task/settings/chat drafts, preference restore, first API transport and SSE reconnect/filter checks. The existing dashboard-token regression remains part of `npm run smoke`. The range picker currently has no mounted production caller, so date-fns/range and explicit calendar override behavior have focused pure tests; do not report browser calendar proof without mounting and exercising a real caller.
