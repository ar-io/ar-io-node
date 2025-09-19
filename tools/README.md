# AR.IO Node Development Tools

This directory contains development and documentation tools for the AR.IO Node project.

## Tools

### `generate-architecture-review.ts`
Analyzes the repository structure and generates a comprehensive markdown document covering:
- Directory structure and file organization
- Type system analysis
- Database schemas and SQL statements
- Module relationships and dependencies
- API surface analysis
- Test coverage metrics
- Internal tools and AI configuration
- Repository statistics

**Usage:**
```bash
node --import ./register.js tools/generate-architecture-review.ts
```

**Output:** `architecture-review.md` in the project root

### `generate-architecture-pdf`
Converts the architecture review markdown into an e-reader optimized PDF using pandoc with typst as the PDF engine.

**Dependencies:** `pandoc` and `typst` (available in the project's Nix flake)

**Usage:**
```bash
./tools/generate-architecture-pdf

# Skip test coverage generation (use cached results)
SKIP_COVERAGE=true ./tools/generate-architecture-pdf
```

**Output:** `architecture-review.pdf` in the project root, optimized for Kindle and other e-readers

## Workflow

To generate a complete architecture review document:

1. Run the analysis script to generate markdown
2. Convert to PDF for e-reader consumption

```bash
# Generate both markdown and PDF
./tools/generate-architecture-pdf

# Quick generation for testing (skips coverage analysis)
SKIP_COVERAGE=true ./tools/generate-architecture-pdf

# Or run steps separately
node --import ./register.js tools/generate-architecture-review.ts
pandoc architecture-review.md -o architecture-review.pdf --pdf-engine=typst --variable=papersize:a5
```

The resulting PDF is optimized for 6-inch e-readers with appropriate margins, font sizes, and table of contents for easy navigation.