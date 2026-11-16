# OnBud 0.2.5

A minor update to 0.2.4 (2026-11-16): files, pages and choices. Apple silicon, macOS 26 or later, Apple
Intelligence on.

## Changes
- **Choices instead of guesses.** When a skill cannot decide (two files with the same name, an ambiguous PDF
  page, several LaTeX documents, documents that match equally, similar Shortcuts), the panel shows the options as
  buttons (⌘1…⌘9). A reply by number or label works too.
- **Image size targets:** "under 5MB" (in the same decimal MB Finder shows), compression plus a format ("…but
  jpg") at that target, and follow-ups ("smaller") work on the file just made. Every answer shows the size before
  and after.
- **PDF merges your way:** the order you name ("b.pdf를 a.pdf 뒤에", "c first", reverse, by name); pages left out
  or picked per file ("3쪽 빼고", "1~3쪽만", "the last two pages", odd/even pages, "page 3 of the merged file");
  a file inserted after a page; page edits on one PDF ("a.pdf에서 2, 4쪽 삭제"); images as pages. Every page of
  the result is checked against the page it came from.
- **Path questions** ("절대 경로 알려줘", "full path of notes.md") answer the absolute path, and a bare file name
  is found in subfolders.

Measured: npm test 237/237, skill eval 63/63.

## Upgrade
Homebrew: `brew upgrade --cask onbud`. DMG: replace OnBud.app with the one below, then Settings > Backend >
**Update…** to copy the new controller (the PDF helper is rebuilt on first use). Upgrading from 0.1.0 (then
called OpenAFM): see the 0.2.0 release notes.

## License
MIT. Third-party notices: THIRD_PARTY_NOTICES.md.
