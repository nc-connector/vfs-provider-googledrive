# Translations

The add-on uses WebExtension localization files below
`src/_locales/<locale>/messages.json`. German is the default locale.

## Available locales

| Locale folder | Language |
|---|---|
| `cs` | Čeština |
| `de` | Deutsch (default) |
| `en` | English |
| `es` | Español |
| `fr` | Français |
| `hu` | Magyar |
| `it` | Italiano |
| `ja` | 日本語 |
| `nl` | Nederlands |
| `pl` | Polski |
| `pt_BR` | Português (Brasil) |
| `pt_PT` | Português (Portugal) |
| `ru` | Русский |
| `zh_CN` | 简体中文 |
| `zh_TW` | 繁體中文 |

## Updating localized text

1. Add or change the message in `src/_locales/en/messages.json`.
2. Apply the same key to every locale listed above.
3. Keep placeholders and their names aligned across all translations.
4. Use `browser.i18n` messages for every user-visible string.
5. Run `npm run test:review` to check locale coverage and message parity.

Do not leave English fallback text, temporary markers, or empty messages in a
non-English locale.
