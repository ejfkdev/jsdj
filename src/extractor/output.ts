/**
 * Output rendering.
 *
 * The Markdown layout is reproduced
 * section for section, because the CLI's output is the tool's primary interface
 * and scripts may match against it.
 */

import type { OutputFormat, ScanResult } from './types.js';

/** Render a scan result in the requested format. */
export function formatOutput(
  format: OutputFormat,
  result: ScanResult,
): string {
  switch (format) {
    case 'json':
      return formatJson(result);
    case 'md':
      return formatMarkdown(result);
    case 'text':
    default:
      return formatText(result);
  }
}

/** Bare URL list, one per line. */
export function formatText(result: ScanResult): string {
  return result.jsUrls.join('\n');
}

/** Indented JSON. */
export function formatJson(result: ScanResult): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Markdown report.
 *
 * Sections: Summary, JS URLs, JS Provenance, Cache Directories,
 * Output Directories, HTML Entries.
 */
export function formatMarkdown(result: ScanResult): string {
  const lines: string[] = [];

  lines.push('## Summary');
  lines.push(`- **JS files**: ${result.summary.jsCount}`);
  if (result.summary.sourceMapCount > 0) {
    lines.push(`- **Source maps**: ${result.summary.sourceMapCount} (found)`);
  } else {
    lines.push('- **Source maps**: 0 (not found)');
  }
  if (result.summary.sourceCount > 0) {
    lines.push(
      `- **Restored sources**: ${result.summary.sourceCount} files (restored)`,
    );
  } else {
    lines.push('- **Restored sources**: 0 (not restored)');
  }

  lines.push('');
  lines.push('## JS URLs');
  for (const url of result.jsUrls) {
    lines.push(`- ${url}`);
  }

  if (result.jsDetails.length > 0) {
    lines.push('');
    lines.push('## JS Provenance');
    lines.push('| JS | discovered by | from | inline |');
    lines.push('|----|---------------|------|--------|');
    for (const detail of result.jsDetails) {
      const from = detail.fromUrl ?? '—';
      const inline = detail.isInline ? 'yes' : '';
      lines.push(
        `| ${detail.url} | ${detail.fromPlugin ?? ''} | ${from} | ${inline} |`,
      );
    }
  }

  lines.push('');
  lines.push('## Cache Directories');
  if (!result.cacheDirs) {
    lines.push('- cache disabled');
  } else {
    const dirs = result.cacheDirs;
    if (dirs.html) {
      lines.push(`- **html**: ${dirs.html}`);
    }
    if (dirs.js) {
      lines.push(`- **js**: ${dirs.js}`);
    }
    if (dirs.sourceMap) {
      lines.push(`- **sourceMap**: ${dirs.sourceMap}`);
    }
    if (dirs.source) {
      lines.push(`- **sources**: ${dirs.source}`);
    }
  }

  if (result.outputDirs) {
    lines.push('');
    lines.push('## Output Directories');
    const dirs = result.outputDirs;
    if (dirs.html) {
      lines.push(`- **html**: ${dirs.html}`);
    }
    if (dirs.js) {
      lines.push(`- **js**: ${dirs.js}`);
    }
    if (dirs.sourceMap) {
      lines.push(`- **sourceMap**: ${dirs.sourceMap}`);
    }
    if (dirs.source) {
      lines.push(`- **sources**: ${dirs.source}`);
    }
  }

  if (result.htmlEntries.length > 0) {
    lines.push('');
    lines.push('## HTML Entries');
    for (const entry of result.htmlEntries) {
      const from = entry.fromUrl ?? '—';
      lines.push(
        `- ${entry.url}  *(discovered by=${entry.fromPlugin ?? ''}, from=${from})*`,
      );
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Trailing summary for `-f text`.
 *
 * URLs are streamed as they are found and this block is appended at the end. Here
 * the URLs are collected and printed together, but the summary text is kept
 * identical so the two outputs remain comparable.
 */
export function formatTextSummary(result: ScanResult): string {
  const lines: string[] = [];

  lines.push('');
  lines.push('--- Summary ---');
  lines.push(`JS files: ${result.summary.jsCount}`);

  if (result.summary.sourceMapCount > 0) {
    lines.push(`Source maps: ${result.summary.sourceMapCount} (found)`);
  } else {
    lines.push('Source maps: 0 (not found)');
  }

  if (result.summary.sourceCount > 0) {
    lines.push(
      `Restored sources: ${result.summary.sourceCount} files (restored)`,
    );
  } else {
    lines.push('Restored sources: 0 (not restored)');
  }

  if (result.cacheDirs) {
    if (result.cacheDirs.sourceMap) {
      lines.push(`Source map dir: ${result.cacheDirs.sourceMap}`);
    }
    if (result.cacheDirs.source) {
      lines.push(`Sources dir: ${result.cacheDirs.source}`);
    }
  }

  if (result.outputDirs) {
    if (result.outputDirs.sourceMap) {
      lines.push(`Output source map dir: ${result.outputDirs.sourceMap}`);
    }
    if (result.outputDirs.source) {
      lines.push(`Output sources dir: ${result.outputDirs.source}`);
    }
  }

  return lines.join('\n') + '\n';
}