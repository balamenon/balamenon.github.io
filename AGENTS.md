# Project Agents Guide

## Boundaries & Exclusions
- **Ignore Directory:** Do not read, index, or reference any files within `node_modules/`.
- **Ignore Directory:** Do not process `dist/`, `build/`, or `.next/` folders.
- **File Types:** Ignore all `.log`, `.lock`, and binary files.
- **Context Management:** If a file is longer than 500 lines, provide a summary of the structure before reading specific blocks.